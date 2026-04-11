# 第六章：AWS Lambda 与 Firecracker

> 本章剖析 Shimmy Sandbox 的运行环境：AWS Lambda 和其底层的 Firecracker 微虚拟机。理解这个环境的每一个约束，才能理解沙箱设计的每一个决策。

## 6.1 什么是无服务器计算（Serverless Computing）

**无服务器计算**（Serverless Computing）是一种云计算模式：开发者只需上传函数代码，云平台负责在请求到来时运行它，按实际执行时间计费，无需管理服务器。

传统部署 vs 无服务器：

```
传统部署:                          无服务器 (Lambda):

你的职责:                          你的职责:
  ✓ 配置服务器                       ✓ 编写函数代码
  ✓ 安装操作系统
  ✓ 配置网络
  ✓ 处理扩缩容
  ✓ 监控和维护
  ✓ 24/7 付费

AWS 的职责:                        AWS 的职责:
  ✓ 提供硬件                         ✓ 提供硬件
                                    ✓ 操作系统
                                    ✓ 网络配置
                                    ✓ 自动扩缩容
                                    ✓ 只有在函数运行时才收费
```

**AWS Lambda** 是亚马逊的无服务器函数平台，用户上传代码，Lambda 在请求时运行，按 100ms 精度计费。

## 6.2 虚拟机、容器与微虚拟机

要理解 Lambda 的隔离层次，需要先区分三个概念：

### 完整虚拟机（Full VM）

```
物理机
└── Hypervisor (KVM/VMware/Hyper-V)
    ├── 虚拟机 A
    │   ├── 完整操作系统内核（Linux/Windows）
    │   ├── 所有设备驱动
    │   └── 用户程序
    └── 虚拟机 B
        ├── 完整操作系统内核
        └── ...
```

- **隔离强**：每个 VM 有独立内核，互不影响
- **启动慢**：30~60 秒（需要启动完整 OS）
- **资源占用高**：每个 VM 需要几百 MB 内存仅用于 OS 本身

### 容器（Container，如 Docker）

```
物理机
└── Linux 内核（共享！）
    ├── 容器 A（命名空间 + cgroup 隔离）
    │   └── 进程（用 namespaces 看到隔离视图）
    └── 容器 B
        └── 进程
```

- **隔离弱**：所有容器共享同一个内核，内核漏洞可跨容器攻击
- **启动快**：毫秒级
- **资源占用低**：只是进程，不是 OS

### 微虚拟机（MicroVM，Firecracker）

```
物理机
└── Firecracker Hypervisor（基于 KVM）
    ├── 微虚拟机 A
    │   ├── 最小化 Linux 内核（5.10）
    │   ├── 只有 virtio-net, virtio-block 两种设备
    │   └── Lambda 函数代码
    └── 微虚拟机 B
        └── ...
```

- **隔离强**：每个微虚拟机有独立内核（类似完整 VM）
- **启动快**：125ms（Firecracker 的关键优化）
- **资源占用低**：内核裁剪到极致，最小约 5MB 内存

**Firecracker** 是 AWS 开源的 KVM 超轻量虚拟机监控器（VMM），专为 Lambda 和 Fargate 设计。

## 6.3 Firecracker 的架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    AWS 物理服务器                                 │
│                                                                  │
│  Linux Kernel (宿主机)   +   KVM (内核虚拟化模块)               │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Firecracker 进程 (用户态 VMM)                 │  │
│  │                                                            │  │
│  │  虚拟设备模型:                                             │  │
│  │  • virtio-net: 虚拟网卡（单网络接口）                      │  │
│  │  • virtio-block: 虚拟块设备                                │  │
│  │  • virtio-vsock: 主机-客户机通信                           │  │
│  │  （无 USB, 无 GPU, 无 PCI 热插拔）                         │  │
│  │                                                            │  │
│  │  ┌────────────────────────────────────────────────────┐   │  │
│  │  │            微虚拟机（客户机）                       │   │  │
│  │  │                                                    │   │  │
│  │  │  Linux Kernel 5.10（精简版）                       │   │  │
│  │  │                                                    │   │  │
│  │  │  ┌──────────────────────────────────────────────┐ │   │  │
│  │  │  │  Lambda 函数运行时环境                        │ │   │  │
│  │  │  │                                              │ │   │  │
│  │  │  │  用户: sbx_user1051 (uid=993)                │ │   │  │
│  │  │  │  工作目录: /var/task                         │ │   │  │
│  │  │  │  临时存储: /tmp (512MB, 跨调用持久化！)      │ │   │  │
│  │  │  │                                              │ │   │  │
│  │  │  │  [你的 Lambda 函数代码]                      │ │   │  │
│  │  │  └──────────────────────────────────────────────┘ │   │  │
│  │  └────────────────────────────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Firecracker 的安全设计决策

Firecracker 的 VMM 本身是用 Rust 编写的，并安装了 seccomp 过滤器，只允许约 30 个必要的系统调用。这保护了宿主机不被客户机内核逃逸攻击。

然而，这个安全设计也带来了一个矛盾：**Firecracker 使用 seccomp 保护自己，却阻止了客户机内使用 seccomp**。

## 6.4 Lambda 环境的完整约束清单

以下是在 Lambda 函数（Firecracker 微虚拟机内）中经过实际测试的能力和限制：

### 可用的能力

| 能力 | 说明 |
|------|------|
| `setrlimit()` | 可以设置资源限制（CPU、内存、文件数等）|
| `fork()` + `exec()` | 基本进程创建可用 |
| `/proc` | procfs 完全可访问（危险！）|
| `mprotect(PROT_EXEC)` | 可以标记内存为可执行（DynamoRIO 需要）|
| 读写 `/tmp` | 临时文件存储（512MB 限制）|
| 环境变量读取 | `/proc/self/environ` 可读 |
| 普通文件 I/O | 读写 `/var/task`、`/opt` 等 |
| 网络连接 | TCP/UDP 连接到外部（默认可用）|

### 被阻断的能力

| 操作 | 错误 | 原因 |
|------|------|------|
| `prctl(PR_SET_NO_NEW_PRIVS, 1)` | EPERM | Firecracker 阻断 |
| `seccomp(SECCOMP_SET_MODE_FILTER)` | EPERM | 无 `PR_SET_NO_NEW_PRIVS` |
| `ptrace(PTRACE_TRACEME)` | EPERM | Firecracker 禁止 |
| `clone(CLONE_NEWPID)` | EPERM | 命名空间被禁 |
| `clone(CLONE_NEWNET)` | EPERM | 命名空间被禁 |
| `clone(CLONE_NEWUSER)` | EPERM | 用户命名空间被禁 |
| `unshare(CLONE_NEWNS)` | EPERM | 挂载命名空间被禁 |
| `chroot("/path")` | EPERM | 无 `CAP_SYS_CHROOT` |
| `/dev/kvm` | 不存在 | 嵌套虚拟化不可用 |
| `bpf(BPF_PROG_LOAD)` | EPERM | 无 `CAP_BPF` |

验证脚本（可以在 Lambda 中运行）：

```python
# check_capabilities.py
import ctypes
import os
import errno

libc = ctypes.CDLL("libc.so.6", use_errno=True)

tests = [
    # (名称, 系统调用测试函数)
]

# 测试 prctl(PR_SET_NO_NEW_PRIVS)
PR_SET_NO_NEW_PRIVS = 38
result = libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
err = ctypes.get_errno()
print(f"prctl(PR_SET_NO_NEW_PRIVS): {result}, errno={errno.errorcode.get(err, err)}")
# 输出: prctl(PR_SET_NO_NEW_PRIVS): -1, errno=EPERM

# 测试 ptrace
import subprocess
result = subprocess.run(
    ["strace", "-e", "trace=none", "true"],
    capture_output=True
)
print(f"strace: {'OK' if result.returncode == 0 else 'FAILED'}")
# 输出: strace: FAILED (ptrace 被禁止)
```

## 6.5 Lambda 的用户模型

Lambda 函数以 `sbx_user1051` 用户运行：

```bash
$ id
uid=993(sbx_user1051) gid=990(sbx_group1051) groups=990(sbx_group1051)

$ cat /proc/self/status | grep Cap
CapInh: 0000000000000000  # 可继承能力: 无
CapPrm: 0000000000000000  # 允许能力: 无
CapEff: 0000000000000000  # 有效能力: 无
CapBnd: 0000000000000000  # 边界能力: 无
CapAmb: 0000000000000000  # 环境能力: 无
```

所有 Capabilities 全部为 0——这个用户什么特权都没有，就是一个彻底的普通用户。

## 6.6 嵌套沙箱的悖论

Shimmy Sandbox 想在 Lambda 内部再建一个沙箱。这产生了一个经典的"嵌套沙箱悖论"：

```
AWS 想用 Lambda/Firecracker 保护 AWS 的基础设施
    ↓
为此 AWS 限制了所有可用于逃逸的内核原语
    ↓
这些内核原语（seccomp, ptrace, namespaces）
恰好也是构建内部沙箱所需要的！
    ↓
Shimmy 无法使用传统工具
```

就像是：你被关在一个安全的房间里（Lambda = 安全），
但你想在房间里再建一个保险箱（内部沙箱），
而保险箱需要的工具（seccomp 等）都被没收了。

**解决方案**：使用不需要内核特权的用户态机制——这正是 DynamoRIO 的思路。

## 6.7 暖启动（Warm Start）安全问题

Lambda 的一个重要优化是**暖启动**（warm start）：函数处理完一次请求后，运行时环境不立即销毁，而是保留一段时间（几分钟到几小时），以便快速处理下一次请求，省去重新初始化的时间。

```
请求 1 (Alice):               请求 2 (Bob, 复用同一容器):
  Lambda 初始化                 Lambda 直接复用
  Python 解释器启动              Python 解释器已就绪
  Alice 代码运行                Bob 代码运行
  写入 /tmp/result.txt          可以读取 /tmp/result.txt！
  （未清理）
```

**安全风险**：
1. **文件残留**：上一次调用写入 `/tmp` 的文件对下一次调用可见
2. **内存状态**：全局变量的值在调用间持久化（Python 全局变量）
3. **打开的连接**：未关闭的数据库连接或网络连接可能被复用

**Shimmy Sandbox 的解决方案**：
- 为每次调用创建唯一的会话目录：`/tmp/dr-sandbox/<UUID>/`
- 调用结束后（无论成功/失败）立即清理该目录
- 不在全局变量中存储敏感的调用状态

```go
// 在 Go 代码中，每次调用创建新会话
func handleRequest(ctx context.Context, event Event) (Response, error) {
    // 生成唯一会话 ID
    sessionID := uuid.New().String()
    sessionDir := filepath.Join("/tmp/dr-sandbox", sessionID)

    // 创建会话目录
    os.MkdirAll(sessionDir, 0700)

    // 确保调用结束时清理
    defer func() {
        os.RemoveAll(sessionDir)
    }()

    // 运行沙箱
    return runSandbox(sessionDir, event.Code)
}
```

## 6.8 Lambda 层（Lambda Layers）

**Lambda 层**（Lambda Layers）是一种将共享代码和依赖打包、复用的机制。层会被挂载到 `/opt` 目录（只读）。

Shimmy Sandbox 打包为一个 Lambda 层：

```
shimmy-layer.zip
└── /opt/
    ├── bin/
    │   ├── drrun              ← DynamoRIO 的运行器（约 5MB）
    │   └── shimmy-sandbox     ← Go 编写的协调器（约 8MB）
    ├── lib/
    │   ├── libdynamorio.so    ← DynamoRIO 核心库
    │   └── libdrpreload.so    ← DynamoRIO 预加载库
    └── dr-clients/
        └── shimmy_client.so  ← Shimmy 的 DynamoRIO 插件（含拦截逻辑）
```

用户的 Lambda 函数只需引用这个层：

```yaml
# serverless.yml
functions:
  grader:
    handler: handler.grade
    layers:
      - arn:aws:lambda:us-east-1:123456789:layer:shimmy-sandbox:3
    environment:
      SHIMMY_ENABLED: "true"
```

## 6.9 环境变量泄露：为什么需要清理

Lambda 通过环境变量向函数传递 AWS 凭证：

```
# Lambda 函数看到的典型环境变量（通过 /proc/self/environ）
AWS_ACCESS_KEY_ID=ASIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
AWS_SESSION_TOKEN=AQoDYXdzEJr...（很长）
AWS_REGION=us-east-1
AWS_DEFAULT_REGION=us-east-1
AWS_LAMBDA_FUNCTION_NAME=shimmy-grader
AWS_LAMBDA_FUNCTION_VERSION=$LATEST
AWS_LAMBDA_FUNCTION_MEMORY_SIZE=256
LAMBDA_TASK_ROOT=/var/task
_HANDLER=handler.grade
```

Shimmy Sandbox 的解决方案：在启动沙箱化的子进程之前，**清除所有敏感环境变量**，或者替换为无意义的假值：

```go
// 在 Go 中清理环境变量
func sanitizeEnv() []string {
    // 危险的环境变量列表
    dangerous := map[string]bool{
        "AWS_ACCESS_KEY_ID":      true,
        "AWS_SECRET_ACCESS_KEY":  true,
        "AWS_SESSION_TOKEN":      true,
        "AWS_SECURITY_TOKEN":     true,
        "AWS_DELEGATION_TOKEN":   true,
        // 也清除 /proc 相关信息
        "LD_PRELOAD":             true,
        "LD_LIBRARY_PATH":        true,
    }

    var clean []string
    for _, kv := range os.Environ() {
        key := strings.SplitN(kv, "=", 2)[0]
        if !dangerous[key] {
            clean = append(clean, kv)
        }
    }

    // 添加安全的替代值
    clean = append(clean, "AWS_ACCESS_KEY_ID=FAKE_KEY_SANDBOXED")
    clean = append(clean, "AWS_SECRET_ACCESS_KEY=FAKE_SECRET_SANDBOXED")

    return clean
}
```

即使这样，恶意代码仍然可能通过 `connect()` 访问 IMDS（169.254.169.254）获取新凭证。因此 DynamoRIO 层必须同时阻断网络连接（或限制目标地址）。

## 6.10 可用资源限制一览

Lambda 为函数提供的资源：

| 资源 | 默认值 | 最大值 |
|------|--------|--------|
| 内存 | 128MB | 10,240MB |
| CPU | 按内存比例（128MB→0.08 vCPU）| 10,240MB→6 vCPU |
| 临时存储（/tmp）| 512MB | 10,240MB |
| 执行超时 | 3 秒 | 15 分钟 |
| 环境变量总大小 | - | 4KB |
| 部署包大小 | - | 250MB（解压后）|
| 并发执行数 | 1000 | 可申请提高 |

Shimmy Sandbox 推荐的 Lambda 配置：
- **内存**：256MB（足够 Python + DynamoRIO）
- **超时**：30 秒（学生代码最长执行时间 + 5 秒 DynamoRIO 开销）
- **临时存储**：512MB（默认，包含 DynamoRIO 缓存）

## 小结

```
AWS Lambda 环境的关键特性:

可用:
  ✓ setrlimit（资源限制）
  ✓ fork/exec（进程创建）
  ✓ mprotect(PROT_EXEC)（可执行内存，DynamoRIO 需要）
  ✓ /proc 完全可访问（危险）
  ✓ /tmp（暖启动跨调用持久化）

不可用（全部返回 EPERM）:
  ✗ seccomp / prctl(PR_SET_NO_NEW_PRIVS)
  ✗ ptrace
  ✗ 所有命名空间类型
  ✗ chroot
  ✗ eBPF / /dev/kvm

安全挑战:
  • 环境变量含 AWS 凭证（需要清理）
  • /proc/self/environ 泄露凭证
  • 暖启动导致跨调用 /tmp 数据残留
  • 169.254.169.254 IMDS 端点可访问

解决方案路径:
  → 环境变量清理（Proto A+）
  → rlimits（Proto A）
  → DynamoRIO（Proto D）：用户态机器码级拦截
```

下一章开始进入 Shimmy Sandbox 的核心技术：二进制插桩——一种完全在用户态运行、不需要任何特殊内核权限的系统调用拦截技术。
