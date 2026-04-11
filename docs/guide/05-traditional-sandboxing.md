# 第五章：传统沙箱机制

> 本章深入讲解四种主流沙箱技术：seccomp-bpf、ptrace、Linux 命名空间（namespaces）、chroot 和 Landlock。理解它们的工作原理和局限，是理解为什么 Shimmy Sandbox 需要另辟蹊径的基础。

## 5.1 沙箱的基本思路

**沙箱**（sandbox）的核心目标：让程序在一个受限环境中运行，即使程序有恶意行为，也无法对外部系统造成伤害。

沙箱的实现策略通常有两类：

1. **过滤/拦截**：让程序运行，但拦截危险的系统调用（seccomp、ptrace、DynamoRIO）
2. **隔离/虚拟化**：给程序一个假的、受限的环境（namespaces、chroot、VM）

这两种策略可以叠加——Shimmy Sandbox 同时使用了两者。

## 5.2 seccomp-bpf：内核级系统调用过滤

**seccomp**（Secure Computing Mode）是 Linux 内核提供的系统调用过滤机制。**seccomp-bpf** 是其增强版，允许程序安装一个 BPF 过滤程序来决定每个系统调用的命运。

### 什么是 BPF（Berkeley Packet Filter）

**BPF**（Berkeley Packet Filter）最初设计用于网络数据包过滤，是一个在内核中运行的小型虚拟机。它有自己的指令集（不是 x86），可以执行简单的数学运算、比较和跳转。

BPF 程序的特点：
- 在内核内部执行（Ring 0），性能极高
- 有严格的验证器（verifier）：不能有死循环、不能访问任意内存
- 功能有限：只能做基本的比较和跳转，不能调用任意函数

seccomp-bpf 把 BPF 用在系统调用上：每当程序发起系统调用，内核先运行 BPF 程序检查，根据结果决定是否允许。

### seccomp-bpf 的工作原理

```
程序发起系统调用
       │
       ▼
内核接收系统调用（Ring 0）
       │
       ▼
运行 seccomp BPF 过滤程序
  BPF 程序检查:
  - 系统调用号（RAX）
  - 前两个参数（RDI, RSI）（不能检查指针指向的内存！）
  - 进程架构
       │
       ├── SECCOMP_RET_ALLOW  → 允许执行
       ├── SECCOMP_RET_ERRNO  → 返回指定错误码
       ├── SECCOMP_RET_KILL   → 立即杀死进程（SIGSYS）
       ├── SECCOMP_RET_TRAP   → 发送 SIGSYS，允许进程自行处理
       └── SECCOMP_RET_TRACE  → 通知 ptrace 追踪者（如有）
```

### 安装 seccomp 过滤器的 C 代码示例

```c
// seccomp_example.c
// 演示如何安装 seccomp 过滤器

#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <errno.h>

// BPF 宏（简化版）
#define ALLOW_SYSCALL(name) \
    BPF_JUMP(BPF_JMP+BPF_JEQ+BPF_K, SYS_##name, 0, 1), \
    BPF_STMT(BPF_RET+BPF_K, SECCOMP_RET_ALLOW)

#define BLOCK_SYSCALL(name) \
    BPF_JUMP(BPF_JMP+BPF_JEQ+BPF_K, SYS_##name, 0, 1), \
    BPF_STMT(BPF_RET+BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA))

int main() {
    // 步骤 1: 设置 no-new-privileges
    // 这告诉内核：此进程及其子进程永远不会获得比现在更多的权限
    // 这是安装 seccomp 的前提条件（或者需要 CAP_SYS_ADMIN）
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == -1) {
        perror("prctl(PR_SET_NO_NEW_PRIVS)");  // ← 在 Lambda 中返回 EPERM！
        exit(1);
    }

    // 步骤 2: 定义 BPF 过滤程序
    struct sock_filter filter[] = {
        // 检查系统调用架构（防止 32 位系统调用绕过）
        BPF_STMT(BPF_LD+BPF_W+BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP+BPF_JEQ+BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET+BPF_K, SECCOMP_RET_KILL),

        // 加载系统调用号
        BPF_STMT(BPF_LD+BPF_W+BPF_ABS, offsetof(struct seccomp_data, nr)),

        // 允许必要的系统调用
        ALLOW_SYSCALL(read),
        ALLOW_SYSCALL(write),
        ALLOW_SYSCALL(exit),
        ALLOW_SYSCALL(exit_group),
        ALLOW_SYSCALL(mmap),
        ALLOW_SYSCALL(munmap),
        ALLOW_SYSCALL(brk),
        ALLOW_SYSCALL(fstat),
        ALLOW_SYSCALL(close),

        // 阻断危险系统调用
        BLOCK_SYSCALL(fork),
        BLOCK_SYSCALL(execve),
        BLOCK_SYSCALL(socket),
        BLOCK_SYSCALL(connect),
        BLOCK_SYSCALL(open),    // 阻断 open！
        BLOCK_SYSCALL(openat),  // 阻断 openat！

        // 默认：允许其他所有调用（生产环境应该改为 KILL）
        BPF_STMT(BPF_RET+BPF_K, SECCOMP_RET_ALLOW),
    };

    struct sock_fprog prog = {
        .len = sizeof(filter) / sizeof(filter[0]),
        .filter = filter,
    };

    // 步骤 3: 安装过滤器
    if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog) == -1) {
        perror("seccomp");
        exit(1);
    }

    printf("seccomp 安装成功！\n");

    // 现在 fork() 会失败
    if (fork() == -1) {
        perror("fork");  // 应该打印 "Operation not permitted"
    }

    return 0;
}
```

### seccomp-bpf 的重大局限性

**局限 1：只能检查寄存器值，不能读取指针指向的内存**

```c
// 这个过滤策略被 TOCTOU 攻击绕过：
// BPF 过滤程序检查 RDI（open 的 path 参数）
// 但 RDI 是一个指针，BPF 不能解引用它！

// 攻击：用多线程在 BPF 检查后、内核执行前修改路径字符串
// (Time-Of-Check Time-Of-Use, TOCTOU)

char path[] = "/tmp/safe.txt";  // BPF 检查时看到的是这个
// 另一个线程: memcpy(path, "/etc/passwd", 12); // 检查后立即替换
// 内核执行时看到的是 /etc/passwd！
```

**局限 2：在 AWS Lambda 中完全无法使用**

`prctl(PR_SET_NO_NEW_PRIVS, 1)` 在 Lambda 的 Firecracker 微虚拟机中返回 `EPERM`：

```
prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) = -1 EPERM (Operation not permitted)
```

这是因为 Firecracker 的 KVM 配置限制了这个 prctl 选项。没有 `PR_SET_NO_NEW_PRIVS`，也没有 `CAP_SYS_ADMIN`，seccomp 过滤器就无法安装。

**局限 3：白名单难以维护**

允许 Python 解释器运行所需的所有系统调用的完整列表超过 50 个，而且随着 Python 版本更新还会变化。过于严格的过滤会导致合法程序崩溃。

## 5.3 ptrace：调试器的原理

**ptrace**（Process Trace）是 Linux 的进程追踪接口，是 `gdb`、`strace` 的基础。通过 ptrace，一个进程（调试器/tracer）可以完全控制另一个进程（被追踪者/tracee）。

### ptrace 的工作方式

```c
// 用 ptrace 拦截系统调用

#include <sys/ptrace.h>
#include <sys/wait.h>
#include <sys/user.h>
#include <stdio.h>
#include <unistd.h>

int main() {
    pid_t child = fork();

    if (child == 0) {
        // 子进程：成为被追踪者
        ptrace(PTRACE_TRACEME, 0, NULL, NULL);
        execve("/bin/ls", NULL, NULL);  // 执行要监控的程序
    }

    // 父进程：追踪者
    int status;
    struct user_regs_struct regs;

    while (1) {
        wait(&status);
        if (WIFEXITED(status)) break;

        // PTRACE_SYSCALL: 在每次 syscall 进入/退出时停止
        ptrace(PTRACE_SYSCALL, child, NULL, NULL);
        wait(&status);
        if (WIFEXITED(status)) break;

        // 读取子进程的寄存器
        ptrace(PTRACE_GETREGS, child, NULL, &regs);

        long sysnum = regs.orig_rax;  // 系统调用号
        printf("系统调用: %ld\n", sysnum);

        // 阻断 open 系统调用
        if (sysnum == SYS_open || sysnum == SYS_openat) {
            // 修改系统调用号为无效值，内核返回 ENOSYS
            regs.orig_rax = -1;
            ptrace(PTRACE_SETREGS, child, NULL, &regs);
        }

        // 让子进程继续到下一个 syscall
        ptrace(PTRACE_SYSCALL, child, NULL, NULL);
    }

    return 0;
}
```

### ptrace 的特点与局限

**优点**：
- 可以读取和修改被追踪进程的内存（解决 TOCTOU 问题）
- 不需要特殊权限（父进程追踪子进程即可）
- 功能极其强大（可以完全控制另一个进程）

**致命缺点：性能**

ptrace 的工作方式是：每次系统调用，内核都要：
1. 暂停子进程
2. 唤醒父进程（调度切换）
3. 父进程读取/修改子进程状态
4. 父进程让子进程继续
5. 再次调度切换回子进程

每次系统调用需要**两次上下文切换**（进入系统调用 + 退出系统调用），实际测量开销约为原来的 **10×**（900%-1000% 开销）。

**其他缺点**：
- 每个进程只能有一个 ptrace 追踪者
- 如果子进程 fork 出孙子进程，需要追踪所有后代（复杂）
- 实现正确的多线程追踪极其困难

## 5.4 Linux 命名空间（Namespaces）

**命名空间**（namespaces）是 Linux 内核提供的隔离机制——在同一个内核上，给不同进程呈现不同的"视图"。Docker 容器正是大量使用命名空间来实现隔离的。

Linux 7 种命名空间类型：

| 命名空间 | 标志 | 隔离的资源 |
|---------|------|-----------|
| **PID** | CLONE_NEWPID | 进程 ID 空间（容器内 PID 1 ≠ 宿主机 PID 1）|
| **NET** | CLONE_NEWNET | 网络接口、路由表、iptables 规则 |
| **MNT** | CLONE_NEWNS | 挂载点（文件系统视图）|
| **UTS** | CLONE_NEWUTS | 主机名和域名 |
| **IPC** | CLONE_NEWIPC | System V IPC、POSIX 消息队列 |
| **USER** | CLONE_NEWUSER | 用户 ID 和组 ID 映射 |
| **CGROUP** | CLONE_NEWCGROUP | cgroup 根目录视图 |

### 创建隔离环境：命令行演示

```bash
# 创建一个新的 PID + NET + MNT 命名空间
# 这需要 CAP_SYS_ADMIN 或 USER 命名空间（非特权）

sudo unshare --pid --net --mount --fork bash

# 现在在新的命名空间中：
$ ps aux
PID   USER   COMMAND
1     root   bash          ← 这个 shell 的 PID 变成了 1！
# 看不到宿主机的其他进程

$ ip link
# 没有网络接口（NET 命名空间隔离）

# 挂载新的 proc
$ mount -t proc none /proc
$ ps
PID  COMM
1    bash
```

### 用户命名空间（User Namespace）：非特权隔离

**用户命名空间**（user namespace）是最特殊的：它允许非特权用户在新命名空间内拥有"假 root"权限。

```bash
# 非特权用户也可以这样做！
unshare --user --map-root-user bash
whoami  # → root（在命名空间内）

# 但这个"root"对宿主机没有真正的特权
# 可以结合其他命名空间实现隔离
unshare --user --map-root-user --pid --net --mount --fork bash
```

### 为什么命名空间在 Lambda 中失效

在 AWS Lambda 中：

```bash
$ unshare --pid --fork bash
unshare: unshare failed: Operation not permitted

$ clone(CLONE_NEWPID|CLONE_NEWNET, ...) → -EPERM
```

Firecracker 的 KVM 配置以及 Lambda 的 seccomp 配置（Lambda 自己安装了 seccomp 来保护其容器）阻止了 `clone()` 携带 `CLONE_NEW*` 标志。

用户命名空间通常也被阻断：
```bash
$ unshare --user bash
unshare: unshare failed: Operation not permitted
```

## 5.5 chroot：伪造根文件系统

**chroot**（Change Root）改变进程看到的文件系统根目录，使进程无法访问新根目录之外的文件。

```bash
# 创建一个最小的 rootfs
mkdir -p /tmp/myrootfs/{bin,lib,lib64,etc}
cp /bin/bash /tmp/myrootfs/bin/
# 复制 bash 依赖的所有共享库...
ldd /bin/bash | grep "=> /" | awk '{print $3}' | while read lib; do
    cp "$lib" /tmp/myrootfs/lib/
done
cp /lib64/ld-linux-x86-64.so.2 /tmp/myrootfs/lib64/

# 以 /tmp/myrootfs 为根运行 bash
chroot /tmp/myrootfs /bin/bash

# 现在在 chroot 环境中：
$ ls /           # 只能看到 bin, lib, lib64, etc
$ cat /etc/passwd  # → 失败（/tmp/myrootfs/etc/passwd 不存在）
$ cd /../../etc/   # → 还是在 /tmp/myrootfs 的根，无法逃逸
```

### chroot 的局限性

**局限 1：需要 `CAP_SYS_CHROOT` 权限**（Lambda 中不可用）

**局限 2：经典的 chroot 逃逸**

具有 `CAP_SYS_CHROOT` 的进程可以再次调用 `chroot()` 来逃逸：

```c
// chroot_escape.c（需要 root 权限）
mkdir("escape", 0755);
chdir("escape");
chroot("..");     // 把根设置为父目录
chdir("../../../"); // 现在可以超出 chroot 边界了！
```

**局限 3：不隔离网络、进程、IPC**

chroot 只隔离文件系统视图，进程仍然可以看到其他进程、建立网络连接、访问 `/proc`（因为 `/proc` 在 chroot 中还在，除非重新挂载）。

## 5.6 Landlock LSM：最新的文件系统访问控制

**Landlock** 是 Linux 5.13 引入的 Linux 安全模块（LSM），提供了不需要任何特权的文件系统访问控制。这是一个真正的突破——普通用户程序可以主动限制自己的文件系统访问权限。

### Landlock 的工作原理

```c
// landlock_example.c
// 限制程序只能读取 /tmp 目录，无法访问其他路径

#include <linux/landlock.h>
#include <sys/syscall.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

// Landlock 的系统调用号（内核 5.13+）
#define landlock_create_ruleset(attr, size, flags) \
    syscall(__NR_landlock_create_ruleset, attr, size, flags)
#define landlock_add_rule(fd, type, attr, flags) \
    syscall(__NR_landlock_add_rule, fd, type, attr, flags)
#define landlock_restrict_self(fd, flags) \
    syscall(__NR_landlock_restrict_self, fd, flags)

int main() {
    // 步骤 1: 创建 Landlock 规则集
    struct landlock_ruleset_attr ruleset_attr = {
        // 指定要处理的访问类型
        .handled_access_fs =
            LANDLOCK_ACCESS_FS_READ_FILE |
            LANDLOCK_ACCESS_FS_WRITE_FILE |
            LANDLOCK_ACCESS_FS_READ_DIR |
            LANDLOCK_ACCESS_FS_MAKE_REG |
            LANDLOCK_ACCESS_FS_REMOVE_FILE |
            LANDLOCK_ACCESS_FS_EXECUTE,
    };

    int ruleset_fd = landlock_create_ruleset(
        &ruleset_attr, sizeof(ruleset_attr), 0);
    if (ruleset_fd < 0) {
        perror("landlock_create_ruleset");
        // 内核 < 5.13 或不支持 Landlock 时失败
        return 1;
    }

    // 步骤 2: 添加规则：允许读写 /tmp
    int tmp_fd = open("/tmp", O_PATH | O_DIRECTORY);
    struct landlock_path_beneath_attr path_attr = {
        .allowed_access =
            LANDLOCK_ACCESS_FS_READ_FILE |
            LANDLOCK_ACCESS_FS_WRITE_FILE |
            LANDLOCK_ACCESS_FS_READ_DIR |
            LANDLOCK_ACCESS_FS_MAKE_REG |
            LANDLOCK_ACCESS_FS_REMOVE_FILE,
        .parent_fd = tmp_fd,
    };

    landlock_add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH,
                      &path_attr, 0);
    close(tmp_fd);

    // 步骤 3: 应用约束（不可逆！）
    // 同样需要 PR_SET_NO_NEW_PRIVS
    prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
    landlock_restrict_self(ruleset_fd, 0);
    close(ruleset_fd);

    printf("Landlock 已激活！\n");

    // 现在：
    open("/etc/passwd", O_RDONLY);  // → EACCES
    open("/tmp/test.txt", O_RDWR|O_CREAT, 0644);  // → 成功！

    return 0;
}
```

### Landlock 相比其他方案的优势

| 特性 | seccomp | ptrace | chroot | Landlock |
|------|---------|--------|--------|----------|
| 需要特权 | `PR_SET_NO_NEW_PRIVS` | 否（父追踪子）| `CAP_SYS_CHROOT` | `PR_SET_NO_NEW_PRIVS` |
| 基于路径 | 否（只看 fd） | 是（可读内存） | 是 | **是** |
| 性能开销 | 低 (~5%) | 高 (~10x) | 低 | 低 (~2%) |
| 隔离粒度 | 系统调用级 | 系统调用级 | 文件系统级 | **路径级** |

**关键局限：Landlock 需要 Linux 5.13+**

AWS Lambda 使用 Linux 5.10 内核，Landlock 在 5.10 上不存在。这是未来改进的方向（见第十二章）。

## 5.7 各方案在 Lambda 中的适用性总结

```
沙箱机制         Lambda 中可用？  原因
─────────────────────────────────────────────────────────────
seccomp-bpf      ✗               prctl(PR_SET_NO_NEW_PRIVS) → EPERM
ptrace           ✗               ptrace(PTRACE_TRACEME) → EPERM
                                  (Firecracker 阻断 ptrace)
PID namespace    ✗               clone(CLONE_NEWPID) → EPERM
NET namespace    ✗               clone(CLONE_NEWNET) → EPERM
USER namespace   ✗               clone(CLONE_NEWUSER) → EPERM
chroot           ✗               需要 CAP_SYS_CHROOT，无此能力
Landlock         ✗               需要 Linux 5.13+，Lambda 用 5.10
eBPF             ✗               需要 CAP_BPF / CAP_SYS_ADMIN

rlimits (setrlimit)  ✓           setrlimit() 可以正常调用
fork/exec            ✓           基础的进程创建可以工作
mprotect             ✓           内存保护可以修改
/proc                ✓（危险）   /proc 完全可访问
```

这个表格揭示了问题的严峻性：几乎所有主流沙箱技术在 Lambda 中都不可用。这正是 Shimmy Sandbox 需要 DynamoRIO 这样的非常规方案的原因。

## 小结

```
传统沙箱技术对比:

seccomp-bpf:
  ✓ 内核内部过滤，性能好（~5% 开销）
  ✗ 只看寄存器值（TOCTOU 漏洞）
  ✗ Lambda 中: prctl() → EPERM

ptrace:
  ✓ 可读写被追踪进程内存
  ✗ 10× 性能开销
  ✗ Lambda 中: ptrace() → EPERM

namespaces:
  ✓ 强力隔离（Docker 基础）
  ✗ Lambda 中: clone(CLONE_NEW*) → EPERM

chroot:
  ✓ 文件系统隔离
  ✗ 需要 CAP_SYS_CHROOT
  ✗ 存在逃逸技术

Landlock:
  ✓ 无需特权的路径级控制
  ✗ 需要 Linux 5.13+（Lambda 用 5.10）

→ 下一章: Lambda + Firecracker 的具体限制
→ 第七、八章: DynamoRIO 如何绕过这些限制
```
