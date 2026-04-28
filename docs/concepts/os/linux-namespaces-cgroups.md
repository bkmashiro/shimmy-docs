# Linux 命名空间与 cgroups

> Docker 是怎么实现的？"容器"和虚拟机有什么区别？答案就藏在两个 Linux 内核特性里：命名空间（namespace）和控制组（cgroups）。本文从第一原理出发解释这两个机制。

## 前置知识

- 了解进程和进程 ID（PID）
- 知道文件系统、网络的基本概念
- 了解"内核态与用户态"的区别

## 你将学到

- 命名空间（namespace）的概念及六种类型
- cgroups 如何限制进程的资源使用
- 这两者合在一起如何构成容器技术的基础
- 通过 `unshare` 命令演示 namespace 的实际效果

---

## 1. 为什么需要隔离

假设你在同一台机器上运行多个用户的代码（比如云服务商）。你希望：

1. 用户 A 的进程不能看到用户 B 的进程
2. 用户 A 不能通过网络访问用户 B 的服务
3. 用户 A 对文件系统的修改不影响用户 B
4. 用户 A 不能消耗光所有 CPU 或内存，让用户 B 的程序饿死

传统的 Unix 权限模型（uid/gid）解决了部分问题，但不够彻底。虚拟机可以彻底隔离，但启动慢、开销大。

**解决方案**：命名空间（轻量级隔离）+ cgroups（资源限制）= 容器。

---

## 2. 命名空间（Namespace）：给进程一个私人视图

> 💡 **核心概念**：命名空间是内核的一项技术，让一组进程拥有对某类全局系统资源的**私有视图**。不同命名空间里的进程看到不同的"世界"。

Linux 目前有 **8 种命名空间**，最常用的 6 种：

```
┌─────────────────────────────────────────────────────────────────┐
│                      Linux 命名空间类型                          │
│                                                                  │
│  ┌─────────────┬─────────────────────────────────────────────┐  │
│  │ 类型        │ 隔离的内容                                   │  │
│  ├─────────────┼─────────────────────────────────────────────┤  │
│  │ PID         │ 进程 ID 空间（进程树）                       │  │
│  │ Network     │ 网络接口、路由表、防火墙规则                  │  │
│  │ Mount       │ 文件系统挂载点视图                           │  │
│  │ UTS         │ 主机名（hostname）和 NIS 域名               │  │
│  │ IPC         │ System V IPC 和 POSIX 消息队列              │  │
│  │ User        │ 用户 ID 和组 ID 映射                        │  │
│  │ Time*       │ 系统时钟（Linux 5.6+）                      │  │
│  │ Cgroup*     │ cgroup 根目录视图                           │  │
│  └─────────────┴─────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### PID 命名空间：你以为你是 PID 1

> 💡 **类比**：PID 命名空间就像一个独立剧院。剧院里的演员（进程）有自己的编号体系（1号、2号……），但在更大的城市（宿主系统）里，他们有完全不同的编号。

在一个新的 PID 命名空间里：
- 第一个进程的 PID = **1**（像 init 进程一样）
- 它只能看到同命名空间及子命名空间的进程
- 宿主系统可以看到容器里所有进程（以宿主的 PID 表示），但容器里的进程看不到宿主

```
宿主系统视图：                   容器内视图：
PID 1: systemd                  PID 1: bash (← 实际上是宿主 PID 8432)
PID 2: kthreadd                 PID 2: myapp (← 实际上是宿主 PID 8433)
...
PID 8432: bash (容器init)
PID 8433: myapp
```

### Network 命名空间：拥有独立的网络栈

每个 Network 命名空间有：
- 独立的网络接口（`lo`、`eth0` 等）
- 独立的路由表
- 独立的 iptables 规则
- 独立的端口空间（容器 A 和容器 B 都可以监听 :80）

```
宿主机                    容器 A                    容器 B
eth0: 192.168.1.100      eth0: 172.17.0.2          eth0: 172.17.0.3
lo: 127.0.0.1            lo: 127.0.0.1             lo: 127.0.0.1
端口 80: nginx（宿主）   端口 80: app-A (隔离！)   端口 80: app-B (隔离！)
```

### Mount 命名空间：文件系统的私人视图

Mount 命名空间隔离了 **挂载点**。容器里可以有：
- 独立的根文件系统（`/`）
- 对宿主文件系统的只读视图
- 完全不同的 `/proc`、`/sys`

Docker 的镜像层（layer）机制正是利用 Mount 命名空间 + overlayfs 实现的。

### UTS 命名空间：主机名隔离

UTS（UNIX Time-sharing System）命名空间允许容器有独立的 `hostname`：

```bash
# 宿主机
$ hostname
host-machine-01

# 容器内
$ hostname
my-container
```

### IPC 命名空间：进程间通信隔离

隔离 System V IPC（共享内存段、消息队列、信号量）和 POSIX 消息队列。不同 IPC 命名空间的进程不能通过这些机制通信。

### User 命名空间：UID 重映射

> 💡 **User 命名空间**是最强大也最复杂的一种，它允许在命名空间内"假装自己是 root"，但在宿主系统上只是普通用户。

```
容器内看到：        宿主系统实际：
UID 0 (root)   →   UID 1000 (普通用户 alice)
UID 1 (daemon) →   UID 1001
...
```

这让**无 root 容器**（rootless container）成为可能：容器内程序以为自己是 root，但出了容器什么都做不了。

---

## 3. 用 unshare 命令演示命名空间

`unshare` 是一个命令行工具，允许你创建新的命名空间并在其中运行命令。

### 演示 PID 命名空间

```bash
# 在一个新的 PID 命名空间中运行 bash
# （需要 root 或 user namespace 支持）
$ sudo unshare --pid --fork --mount-proc bash

# 新 bash 里：
$ echo $$      # 当前进程的 PID
1              # ← 它认为自己是 PID 1！

$ ps aux
USER       PID %CPU %MEM   COMMAND
root         1  0.0  0.0   bash    # ← 只看到自己和 ps
root         2  0.0  0.0   ps aux
# 看不到宿主系统的任何其他进程！
```

### 演示 UTS 命名空间（无需 root）

```bash
# 创建新的 UTS + User 命名空间
$ unshare --uts --user --map-root-user bash

# 在新命名空间内修改 hostname（不影响宿主！）
$ hostname container-test
$ hostname
container-test

# 在宿主的另一个终端：
$ hostname
original-hostname   # ← 宿主不受影响
```

### 演示 Network 命名空间

```bash
# 创建新的网络命名空间
$ sudo unshare --net bash

# 查看网络接口
$ ip link show
1: lo: <LOOPBACK> mtu 65536 ...
# 只有 loopback，没有 eth0！
# 这个命名空间是完全隔离的网络环境

# 退出
$ exit
```

### 演示 Mount 命名空间

```bash
# 在新的 mount 命名空间中挂载 tmpfs 到 /mnt
$ sudo unshare --mount bash
$ mount -t tmpfs tmpfs /mnt
$ ls /mnt    # 空目录（新的 tmpfs）

# 在宿主的另一个终端：
$ ls /mnt    # 宿主看到的还是原来的内容，不受影响
```

---

## 4. cgroups：资源限制的硬约束

命名空间解决了"能看到什么"，但没有限制"能用多少"。cgroups（control groups）解决资源限制问题。

> 💡 **cgroups**（control groups）是 Linux 内核的一个特性，允许将进程分组，并对每组进程施加资源限制、资源追踪和优先级控制。

### cgroups 可以控制什么

| 子系统（subsystem） | 控制内容 | 示例限制 |
|-------------------|---------|---------|
| **cpu** | CPU 使用份额和配额 | 最多使用 1 个核心的 50% |
| **cpuset** | 绑定到特定 CPU 核心 | 只能用核心 2 和 3 |
| **memory** | 内存用量上限 | 最多使用 512 MB |
| **blkio** | 磁盘 I/O 带宽 | 每秒最多读 10 MB |
| **network** | 网络带宽（通过 tc）| 每秒最多发送 1 Mbps |
| **pids** | 进程数量上限 | 最多创建 100 个进程 |
| **devices** | 允许访问的设备 | 只允许 /dev/null |

### cgroups v2 的使用示例

cgroups 通过一个特殊的虚拟文件系统（`/sys/fs/cgroup/`）进行管理：

```bash
# 查看当前 cgroup 层级
$ ls /sys/fs/cgroup/
cgroup.controllers  memory.pressure
cgroup.max.depth    memory.stat
cpu.pressure        system.slice/
io.pressure         user.slice/
...

# 创建一个新的 cgroup（分组）
$ sudo mkdir /sys/fs/cgroup/mygroup

# 限制内存最多 100 MB
$ echo "104857600" | sudo tee /sys/fs/cgroup/mygroup/memory.max
104857600

# 限制 CPU 使用（每 100ms 周期内最多使用 50ms）
$ echo "50000 100000" | sudo tee /sys/fs/cgroup/mygroup/cpu.max
50000 100000

# 把一个进程放入这个 cgroup
$ echo $$ | sudo tee /sys/fs/cgroup/mygroup/cgroup.procs
12345

# 现在这个 shell 进程（及其子进程）就被限制在 100MB 内存、50% CPU 以内
```

### 用 systemd 的 cgroup 功能

现代 Linux 发行版通常通过 systemd 管理 cgroup：

```bash
# 限制一个服务的内存
$ systemctl set-property nginx.service MemoryMax=512M

# 运行一个临时的受限命令
$ systemd-run --scope -p MemoryMax=100M -p CPUQuota=50% myprogram
```

---

## 5. Namespace + cgroups = 容器

把这两个技术叠加，就是 Docker 容器的基本原理：

```
Docker 容器 = 一堆命名空间 + 一组 cgroup 限制

命名空间提供隔离（能看到什么）：
  ├── PID namespace    → 进程树隔离
  ├── Network namespace→ 独立网络栈
  ├── Mount namespace  → 独立文件系统视图
  ├── UTS namespace    → 独立主机名
  ├── IPC namespace    → 独立 IPC
  └── User namespace   → UID 映射（可选）

cgroups 提供资源限制（能用多少）：
  ├── memory.max       → 内存上限
  ├── cpu.max          → CPU 配额
  ├── pids.max         → 进程数上限
  └── io.max           → 磁盘 I/O 上限
```

这解释了容器与虚拟机的本质区别：

```
虚拟机：                              容器：
┌─────────────────────────────┐       ┌────────────────────────┐
│ 客户操作系统内核（独立）     │       │ 宿主内核（共享！）      │
│ ┌─────────────────────────┐ │       │ ┌──────────────────┐   │
│ │ 你的应用程序             │ │       │ │ 你的应用程序      │   │
│ └─────────────────────────┘ │       │ └──────────────────┘   │
└─────────────────────────────┘       └────────────────────────┘
│ 虚拟化层（Hypervisor）      │       │（命名空间 + cgroups）   │
└─────────────────────────────┘       └────────────────────────┘
│ 宿主操作系统内核            │       宿主内核
└─────────────────────────────┘

启动时间：几秒到几分钟                 启动时间：几毫秒
内存开销：几百 MB（含客户内核）        内存开销：几 MB（无额外内核）
隔离强度：强（内核隔离）               隔离强度：中（共享内核）
```

**关键区别**：容器共享宿主内核，因此如果内核有漏洞，容器可能被逃逸；虚拟机有独立内核，隔离更强。这也是 Firecracker（AWS 用于 Lambda 的技术）选择 MicroVM 而不是容器的原因——安全性更高。

---

## 小结

```
命名空间（Namespace）：
    每种 NS 隔离一类资源的"视图"
    ├── PID NS → 进程树
    ├── Net NS → 网络栈
    ├── Mnt NS → 文件系统
    ├── UTS NS → 主机名
    ├── IPC NS → 进程间通信
    └── User NS → UID/GID 映射

cgroups：
    资源用量的硬限制
    ├── 内存上限
    ├── CPU 配额
    ├── 进程数上限
    └── I/O 带宽

容器 = Namespace + cgroups（+ overlayfs 文件系统）
```

**核心要点**：
1. 命名空间给进程一个私有的系统资源视图（隔离能看到的）
2. cgroups 限制进程实际能使用的资源量（限制能用多少）
3. 容器共享宿主内核，比 VM 轻量但隔离性稍弱
4. `unshare` 命令可以在不安装 Docker 的情况下演示这些概念

## 与沙箱技术的联系

命名空间和 cgroups 是"系统级"沙箱工具，AWS Lambda 和 Firecracker 都大量使用它们。

但 shimmy 面对的场景有所不同：它需要在**同一个进程内部**隔离不同的代码（被测程序和框架代码）。命名空间只能在**进程级别**隔离，对进程内部无能为力。

因此 shimmy 不依赖 namespace/cgroups，而是使用更细粒度的技术：
- **seccomp-BPF**：在 syscall 层面过滤（比 namespace 更细）
- **内存权限（mprotect/MPK）**：在内存页级别隔离
- **二进制插桩**：在指令级别拦截

理解 namespace 和 cgroups 的边界，正好能帮你理解为什么 shimmy 需要在更底层的层面工作。
