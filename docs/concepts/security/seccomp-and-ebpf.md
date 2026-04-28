# seccomp 与 eBPF

**前置知识**：理解系统调用的概念（指南第三章）；了解基本的 C 语法（会读不会写也可以）。

**你将学到**：
- seccomp 是什么，以及它如何过滤系统调用
- seccomp-strict 和 seccomp-BPF 的区别
- BPF 程序怎么写（有 C + libbpf 的简单例子）
- eBPF 在 seccomp 基础上扩展了什么
- seccomp 的根本局限：只能看调用号，看不透参数语义
- 违规时发生什么：SIGSYS 和 SECCOMP_RET_KILL

---

## 1. 为什么需要 seccomp

Linux 内核提供了约 330 个系统调用。一个典型的 Python Web 应用，正常运行时只会用到其中的 30~50 个；一个做数值计算的 C 程序可能只需要 10 个。

但在没有任何限制的情况下，程序可以随时调用任意一个系统调用——包括那些极其危险的：

```
execve("/bin/sh", ...)    ← 弹出 Shell
socket + connect          ← 建立网络连接外泄数据
fork × 10000              ← Fork 炸弹
open("/etc/shadow", ...)  ← 读取系统密码哈希
```

**seccomp**（**Sec**ure **Comp**uting Mode，安全计算模式）就是为了解决这个问题：限制程序只能使用它"应该"用到的系统调用。

> 💡 **seccomp（Secure Computing Mode）**
> Linux 内核 2.6.12（2005 年）引入的安全机制，允许程序主动限制自己（或子进程）可以使用的系统调用。一旦安装了 seccomp 过滤器，限制不可逆——进程无法取消它。

类比：seccomp 就像在公司门口安装的"访问控制列表"。员工（程序）进门时，守卫（内核）会核对工作证上的权限——这个员工只被授权使用打印机和会议室，想进机房？对不起，没有权限。

## 2. seccomp-strict：最严格的模式

最早的 seccomp 只有一种模式：**strict 模式**，也叫 `SECCOMP_SET_MODE_STRICT`。

strict 模式极度简单粗暴：进程开启后，只能使用 **4 个系统调用**：
- `read(0)`：只能从已打开的文件描述符读
- `write(1)` / `write(2)`：只能写 stdout 或 stderr
- `_exit()`：退出
- `sigreturn()`：从信号处理函数返回

```c
// 开启 seccomp strict 模式
#include <sys/prctl.h>
#include <linux/seccomp.h>

prctl(PR_SET_SECCOMP, SECCOMP_MODE_STRICT);

// 之后任何其他系统调用都会导致进程被 SIGKILL 杀死
open("/etc/passwd", O_RDONLY);  // → 进程立即被杀死！
```

strict 模式的应用场景非常有限：比如一个密码学库，读入密钥（`read`），完成计算，写出结果（`write`），然后退出——整个生命周期里确实只需要这 4 个调用。

对于任何真实的应用，strict 模式太严格了，几乎不可用。

## 3. seccomp-BPF：可编程的过滤器

2012 年，Linux 3.5 引入了 **seccomp-BPF**（`SECCOMP_SET_MODE_FILTER`）。

seccomp-BPF 允许你安装一个自定义的 **BPF 程序**（稍后详解）来过滤系统调用。这个程序运行在内核内部，对每个系统调用做决策：允许、拒绝、发送信号，还是通知监控进程。

```
程序发出 syscall 指令
         │
         ▼
    内核入口
         │
         ▼
  ┌─────────────────────────────────────────────────────┐
  │         seccomp-BPF 过滤器（内核内执行）             │
  │                                                     │
  │  输入（seccomp_data 结构体）：                       │
  │    .nr   = 系统调用号（如 2 = open）                  │
  │    .arch = 处理器架构（如 AUDIT_ARCH_X86_64）         │
  │    .args[0..5] = 前 6 个参数的值                    │
  │                                                     │
  │  BPF 程序决策（返回以下之一）：                        │
  │    SECCOMP_RET_ALLOW  → 允许执行                    │
  │    SECCOMP_RET_ERRNO  → 返回指定 errno              │
  │    SECCOMP_RET_KILL   → 杀死进程                    │
  │    SECCOMP_RET_TRAP   → 发送 SIGSYS                 │
  │    SECCOMP_RET_TRACE  → 通知 ptrace 追踪者           │
  └─────────────────────────────────────────────────────┘
         │
         ▼
  根据决策执行（或不执行）
```

## 4. BPF 是什么

> 💡 **BPF（Berkeley Packet Filter）**
> 最初（1992 年）设计用于高效过滤网络数据包的内核内小型虚拟机。它有自己的指令集（不是 x86），可以在内核里安全地执行用户定义的逻辑，而不需要加载内核模块。

BPF 程序由一系列**指令**组成，每条指令是一个 `sock_filter` 结构体：

```c
struct sock_filter {
    __u16 code;   // 操作码
    __u8  jt;     // 条件为真时跳转的指令数
    __u8  jf;     // 条件为假时跳转的指令数
    __u32 k;      // 通用常数值
};
```

这比汇编还底层，但 Linux 提供了宏来简化编写：

### 4.1 用 C 宏写一个简单的 seccomp-BPF 过滤器

```c
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>

// 便利宏：允许某个系统调用
#define ALLOW(name) \
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_##name, 0, 1), \
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW)

// 便利宏：阻断某个系统调用，返回 EPERM
#define DENY(name) \
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_##name, 0, 1), \
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO | EPERM)

// 便利宏：遇到某个系统调用直接杀死进程
#define KILL(name) \
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_##name, 0, 1), \
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS)

void install_seccomp_filter() {
    struct sock_filter filter[] = {
        // Step 1: 检查架构，防止用 32 位 syscall 号绕过
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,
                 offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS),

        // Step 2: 加载系统调用号到 BPF 累加器
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,
                 offsetof(struct seccomp_data, nr)),

        // Step 3: 逐一匹配，决定允许或拒绝
        ALLOW(read),
        ALLOW(write),
        ALLOW(close),
        ALLOW(fstat),
        ALLOW(mmap),
        ALLOW(munmap),
        ALLOW(brk),
        ALLOW(exit),
        ALLOW(exit_group),

        // 阻断危险调用
        KILL(execve),       // 禁止执行新程序
        KILL(fork),         // 禁止 fork
        KILL(clone),        // 禁止创建线程/进程
        DENY(socket),       // 禁止网络（返回 EPERM）
        DENY(connect),
        DENY(open),
        DENY(openat),

        // 默认：允许（生产环境应改为 KILL）
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
    };

    struct sock_fprog prog = {
        .len    = sizeof(filter) / sizeof(filter[0]),
        .filter = filter,
    };

    // 必须先设置 no-new-privs（除非有 CAP_SYS_ADMIN）
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
        perror("prctl(PR_SET_NO_NEW_PRIVS)");
        exit(1);
    }

    // 安装过滤器（不可逆！子进程也会继承）
    if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog) < 0) {
        perror("seccomp");
        exit(1);
    }

    printf("seccomp 过滤器已安装。\n");
}

int main() {
    install_seccomp_filter();

    // 这将失败，因为 open 被 DENY 了
    int fd = open("/etc/passwd", O_RDONLY);
    if (fd < 0) {
        perror("open");  // 打印: open: Operation not permitted
    }

    // 这将直接杀死进程，因为 fork 被 KILL 了
    // fork();  // ← 取消注释会让进程立即死亡

    return 0;
}
```

### 4.2 BPF 程序的执行流程

上面的过滤器逻辑可以可视化为：

```
收到 syscall 号 N
      │
      ▼
   arch 是 x86_64？
   ├── 否 → KILL_PROCESS
   └── 是 ↓
      加载 N 到累加器
      │
      ▼
   N == read(0)？
   ├── 是 → ALLOW
   └── 否 ↓
   N == write(1)？
   ├── 是 → ALLOW
   └── 否 ↓
   ...（逐一匹配）...
      │
      ▼
   N == execve(59)？
   ├── 是 → KILL_PROCESS
   └── 否 ↓
   N == fork(57)？
   ├── 是 → KILL_PROCESS
   └── 否 ↓
   N == socket(41)？
   ├── 是 → ERRNO(EPERM)
   └── 否 ↓
      默认 → ALLOW
```

## 5. eBPF：BPF 的现代扩展

> 💡 **eBPF（extended BPF）**
> Linux 3.18（2014 年）引入的 BPF 扩展版本。"e" 代表 "extended"。eBPF 保留了 BPF 在内核内安全执行用户代码的核心思想，但大幅扩展了能力：更多指令、更大内存、可以挂载到内核的几十个"钩子点"上。

经典 BPF（现在叫 **cBPF**）只能用于 seccomp 和网络过滤。eBPF 可以挂载到：

```
eBPF 可以挂载的钩子点：

  系统调用入口/出口       ← 比 seccomp 更灵活
  网络数据包（kprobe）    ← 比 iptables 更强大
  内核函数（kprobe）      ← 任意内核函数的入口/出口
  用户态函数（uprobe）    ← 用户程序的任意函数
  性能事件（perf）        ← CPU 采样、缓存失效等
  LSM 钩子               ← 安全策略实施
  XDP（eXpress Data Path）← 在驱动层处理网络包，极快
```

### 5.1 eBPF 和 seccomp 的关系

它们是**不同的**机制：

| 特性 | seccomp-BPF（cBPF） | eBPF |
|------|---------------------|------|
| BPF 版本 | 经典 BPF | 扩展 BPF |
| 安装方式 | `prctl` / `syscall(SYS_seccomp, ...)` | `bpf()` 系统调用 |
| 需要权限 | `PR_SET_NO_NEW_PRIVS` | `CAP_BPF` / `CAP_SYS_ADMIN` |
| 钩子点 | 只有系统调用 | 几十个内核钩子 |
| 能访问什么 | `seccomp_data` 结构体 | 内核内存、map、helper 函数 |
| 用途 | 进程级系统调用过滤 | 可观测性、网络、安全、tracing |

### 5.2 用 libbpf 写一个简单的 eBPF 程序

eBPF 程序用受限的 C 语言编写，由 Clang 编译到 eBPF 字节码：

```c
// trace_open.bpf.c — 追踪所有 openat 系统调用
// 编译: clang -O2 -target bpf -c trace_open.bpf.c -o trace_open.bpf.o

#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

// 这个宏定义一个 tracepoint 程序，挂载到 sys_enter_openat
SEC("tracepoint/syscalls/sys_enter_openat")
int trace_openat(struct trace_event_raw_sys_enter *ctx) {
    // 获取进程 ID 和进程名
    __u64 pid = bpf_get_current_pid_tgid() >> 32;
    char comm[16];
    bpf_get_current_comm(&comm, sizeof(comm));

    // 获取文件路径（第一个参数，在 ctx->args[1]）
    const char *filename = (const char *)ctx->args[1];

    // 打印到 /sys/kernel/debug/tracing/trace_pipe
    bpf_printk("PID %d (%s) openat: %s\n", pid, comm, filename);

    return 0;
}

char _license[] SEC("license") = "GPL";
```

加载这个 eBPF 程序的用户态代码：

```c
// loader.c — 加载 eBPF 程序
#include <bpf/libbpf.h>
#include <stdio.h>
#include <unistd.h>

int main() {
    // 加载并验证 eBPF 对象文件
    struct bpf_object *obj = bpf_object__open("trace_open.bpf.o");

    // 加载到内核
    bpf_object__load(obj);

    // 找到 trace_openat 程序
    struct bpf_program *prog = bpf_object__find_program_by_name(
        obj, "trace_openat");

    // 附加到 tracepoint
    struct bpf_link *link = bpf_program__attach(prog);

    printf("eBPF 程序已加载。监听 openat 调用...\n");
    printf("查看输出: sudo cat /sys/kernel/debug/tracing/trace_pipe\n");

    // 保持运行
    pause();

    bpf_link__destroy(link);
    bpf_object__close(obj);
    return 0;
}
```

运行后，每当任何程序调用 `openat`，eBPF 程序就会在内核里截获并打印日志——开销极小，不需要修改被监控的程序。

## 6. seccomp 的根本局限

### 6.1 只能看系统调用号，看不透参数内容

这是 seccomp-BPF 最大的限制。考虑 `openat` 系统调用：

```c
// openat(AT_FDCWD, path, flags, mode)
int fd = openat(AT_FDCWD, "/etc/passwd", O_RDONLY, 0);
```

seccomp-BPF 的 `seccomp_data.args[1]` 存放的是指向路径字符串的**指针值**（一个整数），而不是字符串本身。

BPF 程序**不能解引用指针**——它无法读取指针指向的内存内容。

```
BPF 程序能看到：
  nr   = 257 (openat 的系统调用号)
  args[0] = -100 (AT_FDCWD)
  args[1] = 0x7fff1234abcd  ← 这只是个地址！
  args[2] = 0 (O_RDONLY)

BPF 程序看不到：
  地址 0x7fff1234abcd 处存放的字符串 "/etc/passwd"
         ↑ 没有权限读取用户内存
```

这意味着：**seccomp 无法按文件路径过滤**，只能允许或禁止整个 `openat` 调用。

### 6.2 TOCTOU 漏洞

即使 seccomp 能读取参数，也存在 **TOCTOU**（Time-Of-Check Time-Of-Use，检查时间与使用时间不一致）漏洞：

```
线程 A:                          线程 B:
  open("/tmp/safe.txt")
  ← seccomp 检查路径 ✓
                                  // 检查完之后、内核使用之前
                                  rename("/etc/passwd", "/tmp/safe.txt")
  ← 内核打开 /tmp/safe.txt ← 实际上打开了 /etc/passwd！
```

多线程程序可以在检查完成后、内核实际使用参数前，偷偷修改参数的内容，从而绕过过滤。

### 6.3 无法识别调用序列的语义

seccomp 只能对单个系统调用做判断，无法识别调用序列的整体意图：

```
允许 socket()  + 允许 connect() + 允许 write()
= 允许建立网络连接并发送数据！

但你也许只是想允许"Unix domain socket 进程间通信"
                和"写入本地文件"
```

## 7. 违规时发生什么

### 7.1 SECCOMP_RET_KILL 和 SECCOMP_RET_KILL_PROCESS

```
┌──────────────────────────────────────────────────────────────┐
│  SECCOMP_RET_KILL （Linux < 4.14 的默认）                    │
│                                                              │
│  → 只杀死发出违规系统调用的那个**线程**                       │
│  → 其他线程继续运行                                          │
│  → 进程可能处于不一致状态（危险！）                           │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  SECCOMP_RET_KILL_PROCESS （Linux 4.14+，推荐）              │
│                                                              │
│  → 立即杀死**整个进程**（所有线程）                           │
│  → 进程收到 SIGSYS 信号，退出码反映 seccomp 违规              │
│  → 无法被信号处理函数捕获（类似 SIGKILL）                     │
└──────────────────────────────────────────────────────────────┘
```

### 7.2 SIGSYS：Syscall 违规信号

`SECCOMP_RET_TRAP` 会向进程发送 **SIGSYS** 信号（Signal: Bad System Call）。

如果进程安装了 SIGSYS 的信号处理函数，可以捕获这个信号并做自定义处理：

```c
#include <signal.h>
#include <stdio.h>
#include <sys/ucontext.h>

// SIGSYS 信号处理函数
void sigsys_handler(int sig, siginfo_t *info, void *ucontext) {
    ucontext_t *uc = (ucontext_t *)ucontext;

    // 从 siginfo 中获取违规的系统调用号
    int syscall_nr = info->si_syscall;
    printf("违规系统调用: %d\n", syscall_nr);
    printf("调用地址: %p\n", (void *)uc->uc_mcontext.gregs[REG_RIP]);

    // 可以在这里记录日志、清理资源，然后退出
    // 或者：修改返回值，让程序以为调用成功了（危险！）
    uc->uc_mcontext.gregs[REG_RAX] = -EPERM;
    // 从信号处理函数返回，程序继续执行
}

// 安装 SIGSYS 处理函数
struct sigaction sa = {
    .sa_sigaction = sigsys_handler,
    .sa_flags = SA_SIGINFO,
};
sigaction(SIGSYS, &sa, NULL);
```

> ⚠️ **注意**：允许程序自己处理 SIGSYS 有安全风险——恶意程序可能利用这个机制绕过 seccomp（通过修改 `RAX` 寄存器伪造成功）。在高安全场景下，应优先使用 `SECCOMP_RET_KILL_PROCESS`。

### 7.3 strace 观察违规行为

```bash
# 运行一个被 seccomp 过滤的程序并观察
$ strace -e trace=seccomp ./my_sandboxed_program 2>&1

# 或者查看内核日志中的 seccomp 违规记录
$ dmesg | grep "seccomp"
[12345.678] audit: type=1326 audit(...): auid=... uid=...
            pid=... comm="my_prog" exe="/path/to/my_prog"
            sig=31 arch=c000003e syscall=59 compat=0
            ip=0x7f... code=0x80000000
            # syscall=59 → execve 被阻断
            # sig=31 → SIGSYS
```

## 小结

```
seccomp = Linux 内核的系统调用过滤机制

两种模式：
  strict   → 只允许 read/write/exit/sigreturn，几乎不可用
  BPF      → 可编程过滤，允许精细控制

BPF 过滤器：
  输入：秘密调用号 + 前 6 个参数的"原始值"
  输出：ALLOW / ERRNO / KILL / TRAP / TRACE

eBPF = 扩展 BPF：
  可以挂载到几十个内核钩子（不止 seccomp）
  需要 CAP_BPF 权限（比 seccomp 要求更高）

根本局限：
  只能看系统调用号和参数的寄存器值
  无法读取指针指向的内存（无法按文件名过滤）
  无法理解调用序列的组合语义

违规处理：
  KILL / KILL_PROCESS → 杀死线程/进程
  TRAP → 发 SIGSYS，可被捕获
```

## 与 Shimmy/沙箱设计的联系

Shimmy Sandbox 运行在 AWS Lambda 的 Firecracker microVM 中，其中 `prctl(PR_SET_NO_NEW_PRIVS)` 调用被 Firecracker 的配置阻断，因此 seccomp-BPF 完全不可用。

但 seccomp 的设计思想启发了 Shimmy 的核心逻辑：在**尽可能低的层次**（系统调用入口）拦截程序的行为。seccomp 在内核层做这件事，而 Shimmy 在用户态通过 DynamoRIO 做相同的事——代价是需要 JIT 编译所有代码，但换来了不依赖内核特权的好处。

此外，seccomp 的"只能看调用号，看不透参数语义"这个局限，也是 Shimmy 使用 DBI（可以读取指针内容）而不是 seccomp 的原因之一：DynamoRIO 拦截 `syscall` 时可以读取完整的参数值，包括解引用指针。
