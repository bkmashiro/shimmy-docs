# 信号与异常

> 当你的程序访问了空指针，屏幕上出现"Segmentation fault"——是谁告诉程序发生了问题？这背后是 Linux 的信号机制和 CPU 的异常机制在协作工作。本文解释它们是什么、如何协作，以及为什么它们是沙箱技术的基础设施。

## 前置知识

- 了解进程和内核的基本概念
- 知道 CPU 特权级（Ring 0/Ring 3）
- 最好已读过《内核态与用户态》

## 你将学到

- 信号（signal）是什么，Linux 信号系统如何工作
- 最重要的几个信号：SIGSEGV、SIGKILL、SIGTERM、SIGTRAP、SIGFPE
- 信号处理器（signal handler）的工作原理
- CPU 异常（exception）与信号的关系
- 为什么 seccomp 违规发送 SIGSYS，ptrace 怎么用 SIGTRAP

---

## 1. 什么是信号

> 💡 **信号**（signal）是 Linux 进程间通信的最简单形式：一个整数，从内核（或另一个进程）发送给目标进程，告诉它"发生了某件事"。

信号就像给进程发的**紧急通知**。

```
类比：手机通知
    ┌────────────────────────────────────────────────────────┐
    │  "你有一条新消息"  ← 这是 SIGUSR1（用户自定义信号）    │
    │  "你的电量不足"    ← 这是 SIGTERM（请求退出）          │
    │  "来电话了"        ← 这是 SIGINT（Ctrl+C 中断）        │
    │  "强制关机"        ← 这是 SIGKILL（无法拒绝的终止）    │
    └────────────────────────────────────────────────────────┘
```

每个信号都有一个编号和一个名字（约定以 SIG 开头）：

```bash
$ kill -l
 1) SIGHUP    2) SIGINT    3) SIGQUIT   4) SIGILL    5) SIGTRAP
 6) SIGABRT   7) SIGBUS    8) SIGFPE    9) SIGKILL  10) SIGUSR1
11) SIGSEGV  12) SIGUSR2  13) SIGPIPE  14) SIGALRM  15) SIGTERM
16) SIGSTKFLT 17) SIGCHLD 18) SIGCONT  19) SIGSTOP  20) SIGTSTP
21) SIGTTIN  22) SIGTTOU  23) SIGURG   24) SIGXCPU  25) SIGXFSZ
26) SIGVTALRM 27) SIGPROF 28) SIGWINCH 29) SIGIO   30) SIGPWR
31) SIGSYS   34) SIGRTMIN ...
```

---

## 2. 重要的信号详解

### SIGSEGV（11）—— 段错误

**SIGSEGV**（Segmentation Violation）是最常见的程序崩溃原因。

**触发原因**：
```c
int *ptr = NULL;
*ptr = 42;          // 访问 NULL 地址 → SIGSEGV

int arr[5];
arr[100] = 1;       // 越界访问（可能 → SIGSEGV，取决于地址是否映射）

int *p = (int *)0xDEADBEEF;
*p = 1;             // 访问未映射地址 → SIGSEGV
```

**触发路径**：
```
程序访问非法地址
    ↓
MMU 发现该虚拟地址没有映射（或权限不对）
    ↓
CPU 触发"页错误"异常（#PF, Page Fault），进入内核态
    ↓
内核页错误处理程序检查：
    ├── 是合法的惰性分配（堆/栈扩张）？→ 分配物理页，返回用户态，重试
    └── 不合法？→ 向进程发送 SIGSEGV
    ↓
进程收到 SIGSEGV
    ├── 有自定义处理器？→ 调用处理器
    └── 没有（默认）？→ 产生 core dump + 进程终止
```

### SIGKILL（9）—— 不可抗拒的终止

**SIGKILL** 是唯一**不可被捕获、不可被忽略、不可被阻塞**的信号。

```bash
kill -9 1234    # 强制终止 PID 1234，进程无法阻止
```

为什么需要不可拦截的信号？想象一个恶意程序捕获了所有信号并忽略它们——没有 SIGKILL，就无法终止它。内核保证：收到 SIGKILL 的进程必定终止（除非进程处于不可中断的睡眠状态，如等待 I/O）。

> 💡 **不可中断睡眠**（Uninterruptible Sleep，状态 D）：进程正在等待 I/O（如等待 NFS 磁盘），此时连 SIGKILL 都不能立即生效，必须等 I/O 完成。这也是"D 状态进程"难以清理的原因。

### SIGTERM（15）—— 礼貌的终止请求

**SIGTERM** 是默认的 `kill` 命令发送的信号，是"请你退出"的礼貌请求。进程可以捕获并做清理工作：

```c
#include <signal.h>
#include <stdio.h>
#include <unistd.h>

void cleanup_handler(int sig) {
    printf("收到 SIGTERM，正在清理资源...\n");
    // 关闭文件、刷新缓冲区、解锁资源等
    // ...
    _exit(0);   // 注意：在信号处理器中用 _exit 而不是 exit
}

int main() {
    signal(SIGTERM, cleanup_handler);  // 注册处理器
    while (1) pause();                 // 等待信号
}
```

```
SIGKILL vs SIGTERM：
SIGTERM ──► 进程可以捕获 ──► 执行清理 ──► 优雅退出
SIGKILL ──► 内核直接终止，进程毫不知情
```

### SIGTRAP（5）—— 调试陷阱

**SIGTRAP** 由以下情况触发：
- 执行 `INT3` 指令（软件断点，单字节指令 `0xCC`）
- 硬件单步执行（EFLAGS 的 TF 位置 1）
- ptrace 触发

```
调试器（如 gdb）的工作原理：

1. 调试器调用 ptrace(PTRACE_ATTACH, pid)，成为被调试进程的 tracer
2. 设置断点：把目标地址的第一个字节替换为 0xCC（INT3 指令）
3. 被调试程序运行到断点：
   执行 0xCC → CPU 触发 #BP 异常 → 内核发送 SIGTRAP → 
   因为有 ptrace tracer，信号被拦截 → 通知调试器
4. 调试器暂停被调试程序，读取寄存器，显示给用户
5. 用户说"继续"，调试器恢复执行：
   把 0xCC 改回原始字节 → 继续运行
```

> 💡 **INT3 指令**（机器码 `0xCC`）是 x86 专门为软件断点设计的单字节指令，触发调试异常（#BP），然后内核发送 SIGTRAP。gdb 设置断点时，就是把那个位置的第一个字节临时改成 `0xCC`。

### SIGFPE（8）—— 浮点/算术异常

**SIGFPE**（Floating Point Exception，尽管名字里有"浮点"，整数错误也会触发）：

```c
int x = 1 / 0;        // 整数除零 → CPU 触发 #DE 异常 → SIGFPE
int y = INT_MIN / -1; // 整数溢出（在某些情况下）→ SIGFPE
```

浮点数除以零通常**不会**触发 SIGFPE（IEEE 754 规定结果为 Inf），除非开启了严格浮点异常模式。

### SIGINT（2）—— 键盘中断

```
你按下 Ctrl+C
    ↓
终端驱动程序（tty）检测到 ^C 字符
    ↓
向前台进程组发送 SIGINT
    ↓
默认行为：终止进程
```

这也是为什么 `python3 script.py` 按 Ctrl+C 会退出——Python 收到 SIGINT，默认终止。

---

## 3. 信号处理器（Signal Handler）

进程可以为大多数信号注册自定义处理函数。有三种处理方式：

| 处理方式 | 效果 |
|---------|------|
| **默认**（SIG_DFL）| 使用内核默认行为（通常是终止进程） |
| **忽略**（SIG_IGN）| 信号被丢弃，进程不知情 |
| **自定义处理器** | 执行你提供的函数 |

```c
#include <signal.h>

void my_handler(int signum) {
    // 在这里处理信号
    // 警告：只能调用"异步信号安全"的函数！
    // 安全：write(), _exit(), kill(), signal()
    // 不安全：printf(), malloc(), free()（可能死锁）
}

int main() {
    // 注册处理器
    struct sigaction sa;
    sa.sa_handler = my_handler;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;
    sigaction(SIGINT, &sa, NULL);   // 捕获 Ctrl+C

    // 忽略某个信号
    signal(SIGPIPE, SIG_IGN);       // 忽略管道断裂

    // ...程序运行...
}
```

### 信号处理器的执行时机

信号不是立即执行的，它是**异步**的，在合适的时机才被处理：

```
进程执行普通代码
    ↓
内核在进程的"pending signals"队列中记录信号
    ↓（在下一次从内核态返回用户态时检查）
内核检查有未处理的信号
    ↓
内核在用户态栈上构造一个"假的调用帧"
    ↓
跳转到信号处理器函数执行
    ↓
处理器返回（sigreturn 系统调用）
    ↓
恢复被中断的代码，继续执行
```

```
用户栈的变化：

信号到来前：          信号处理中：          处理完成后：
┌──────────┐         ┌──────────┐          ┌──────────┐
│ 正常代码  │         │ 正常代码  │          │ 正常代码  │
│ 的栈帧   │         │ 的栈帧   │          │ 的栈帧   │
│          │         ├──────────┤          │          │
│          │   RSP→  │ 保存的上  │          │          │
│          │         │ 下文信息  │          │          │
│          │         ├──────────┤          │          │
│          │         │ 信号处理  │          │          │
│          │         │ 器的栈帧  │          │          │
└──────────┘  RSP→   └──────────┘   RSP→   └──────────┘
```

---

## 4. CPU 异常与信号的关系

CPU 异常（Exception）和 Linux 信号的关系：

```
CPU 异常
    │
    ▼ 进入内核态（Ring 0）
内核异常处理程序
    │
    ├── 可恢复（如惰性内存分配）→ 修复后返回，重新执行指令
    │
    └── 不可恢复 → 转换为信号，发给用户进程
                      │
              ┌───────┴──────────────────────┐
              │                              │
        CPU 异常                          对应信号
        #PF（页错误，非法访问）     →    SIGSEGV
        #GP（一般保护异常）         →    SIGSEGV
        #DE（除零）                 →    SIGFPE
        #UD（非法指令）             →    SIGILL
        #BP（断点 INT3）            →    SIGTRAP
        #OF（溢出 INTO）            →    SIGSEGV
```

这个转换是"内核翻译"：硬件说的语言（异常号）被翻译成进程能理解的语言（信号）。

---

## 5. SIGSYS：seccomp 的专属信号

**SIGSYS**（31）是 Linux 3.5+ 引入的信号，当进程被 seccomp 过滤器**拒绝一个系统调用**时，可以选择向进程发送 SIGSYS，而不是直接 SIGKILL。

```
进程发起 syscall
    ↓
seccomp-BPF 过滤器运行（内核态）
    ↓（过滤器返回 SECCOMP_RET_TRAP）
内核向进程发送 SIGSYS
    ↓
进程的 SIGSYS 处理器运行：
    ├── 可以检查是哪个 syscall 被拒绝了
    ├── 可以记录日志
    ├── 可以用替代方式处理（用户态模拟）
    └── 可以优雅退出
```

这与 `SECCOMP_RET_KILL`（直接杀死进程）相比更灵活，允许进程有机会做清理或错误报告。

```c
// seccomp 违规处理器示例
void sigsys_handler(int sig, siginfo_t *info, void *ctx) {
    fprintf(stderr, "被 seccomp 拒绝的 syscall 号: %d\n",
            info->si_syscall);
    // 可以在这里实现用户态 syscall 模拟
    _exit(1);
}
```

---

## 6. SIGTRAP 与 ptrace 沙箱

ptrace 是 Linux 的进程跟踪接口，调试器（gdb、strace）都依赖它。在沙箱场景中：

```
ptrace 沙箱的工作流程：

tracer 进程（沙箱）              tracee 进程（被沙箱的代码）
─────────────────────            ─────────────────────────────
ptrace(PTRACE_SEIZE, pid)  ──►  被跟踪，系统调用触发停止
                                ...
                                执行 SYSCALL 指令
                                    ↓
                                内核检测到 ptrace 跟踪
                                    ↓
                           ◄──  内核暂停 tracee，通知 tracer
                                    │
读取 tracee 的寄存器              等待（暂停）
检查 RAX（syscall 号）              │
决定是否允许                        │
ptrace(PTRACE_CONT, ...)  ──►  恢复执行
                                    ↓
                                进入内核执行 syscall
                                ...
```

每次 syscall 都要经过：
- tracee 暂停（发送 SIGTRAP 通知）
- 内核通知 tracer
- tracer 调度运行（一次上下文切换！）
- tracer 读取 tracee 寄存器（一次 ptrace 调用）
- tracer 发送继续指令（另一次 ptrace 调用）
- tracee 恢复（另一次上下文切换）

这就是 ptrace 沙箱极慢的原因：**每个 syscall 约 4-6 次上下文切换**。

---

## 小结

```
信号系统：
  内核 / 其他进程  →  发送信号（整数）  →  目标进程
  进程可以：捕获信号（自定义处理器）、忽略信号、使用默认行为

关键信号：
  SIGSEGV  内存访问错误（最常见的崩溃原因）
  SIGKILL  强制终止（不可捕获）
  SIGTERM  优雅退出请求（可捕获）
  SIGTRAP  断点/调试陷阱（ptrace 使用）
  SIGFPE   算术异常（整数除零等）
  SIGSYS   seccomp 违规通知

CPU 异常 → 内核翻译 → Linux 信号：
  #PF → SIGSEGV
  #BP → SIGTRAP
  #DE → SIGFPE
```

**核心要点**：
1. 信号是内核向进程传递事件通知的机制，类似异步通知
2. SIGKILL 是唯一不可阻止的信号，保证系统可以终止任何进程
3. CPU 异常经内核翻译后以信号的形式传递给用户进程
4. ptrace 利用 SIGTRAP 机制实现调试，但每次 syscall 都要往返用户态，代价极高
5. seccomp 用 SIGSYS 通知进程 syscall 被拒绝，比直接 SIGKILL 更灵活

## 与沙箱技术的联系

信号机制在 shimmy 相关技术中有两处关键应用：

**1. seccomp 的 SIGSYS 通知**：shimmy 可以配置 seccomp 在违规时发送 SIGSYS 而不是直接杀进程，允许 shimmy 在用户态处理"意外的 syscall"，实现更细粒度的控制和更友好的错误报告。

**2. ptrace 的性能问题**：论文中反复提到 ptrace 沙箱"慢到无法在生产中使用"，正是因为每个 syscall 都触发 SIGTRAP 风格的往返。shimmy 的二进制插桩方案完全绕开了 ptrace，不产生任何 SIGTRAP，从而实现了数量级的性能提升。

理解信号的异步性和代价，是理解沙箱设计权衡的重要背景。
