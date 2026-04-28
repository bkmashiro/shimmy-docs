# 系统调用深度解析

> 每次你的 Python 脚本读一个文件、每次 C 程序调用 printf，背后都经历了一次从用户态到内核态的旅程。本文带你完整走一遍这段路，并解释为什么掌控这条路就掌控了沙箱的一切。

## 前置知识

- 了解 CPU 特权级（Ring 0 / Ring 3）
- 知道寄存器是什么（RAX、RDI 等）
- 最好已读过《内核态与用户态》

## 你将学到

- syscall 从发起到返回的完整执行路径
- syscall 表是什么，里面有什么
- 常用系统调用的分类和用途
- 如何用 strace 工具观察程序的 syscall
- 为什么 syscall 拦截是所有沙箱技术的核心

---

## 1. 一个 syscall 的完整生命周期

以 `write(1, "hello\n", 6)`（向 stdout 写 6 字节）为例，跟踪它从用户程序到硬件再回来的完整旅程：

```
                    用户态（Ring 3）
┌────────────────────────────────────────────────────────────┐
│                                                            │
│  C 代码：                                                  │
│    write(1, "hello\n", 6);                                 │
│         │                                                  │
│         ▼                                                  │
│  libc 的 write() 包装函数：                                │
│    MOV  RAX, 1        ; syscall 号：write = 1              │
│    MOV  RDI, 1        ; 参数 1：fd = 1 (stdout)            │
│    MOV  RSI, msg_ptr  ; 参数 2：缓冲区地址                  │
│    MOV  RDX, 6        ; 参数 3：字节数                     │
│    SYSCALL            ; ← 触发特权级切换！                  │
│                                                            │
└────────────────────────────┬───────────────────────────────┘
                             │ CPU 自动执行：
                             │ 1. RIP → RCX（保存返回地址）
                             │ 2. RFLAGS → R11
                             │ 3. 从 MSR 加载内核入口地址
                             │ 4. CPL = 0（进入 Ring 0）
                             ▼
                    内核态（Ring 0）
┌────────────────────────────────────────────────────────────┐
│                                                            │
│  内核入口点（entry_SYSCALL_64）：                           │
│    保存用户寄存器到内核栈（pt_regs 结构体）                 │
│    RSP 切换到内核栈                                         │
│         │                                                  │
│         ▼                                                  │
│  查系统调用表（sys_call_table）：                           │
│    RAX = 1 → sys_call_table[1] = sys_write                 │
│         │                                                  │
│         ▼                                                  │
│  执行 sys_write(fd=1, buf=..., count=6)：                   │
│    ① 验证 fd 有效（fd 1 是 stdout，合法）                   │
│    ② 检查权限                                              │
│    ③ 验证用户态缓冲区地址合法（可读）                       │
│    ④ 调用文件系统/驱动层写入                               │
│    ⑤ 字节最终流向终端驱动 → 屏幕上显示 "hello"             │
│    ⑥ 返回值：写入的字节数 = 6                              │
│         │                                                  │
│         ▼                                                  │
│  返回路径：                                                │
│    RAX = 6（返回值）                                       │
│    恢复用户寄存器（pt_regs → 寄存器）                       │
│    SYSRET 指令：                                           │
│         RCX → RIP（跳回用户代码）                           │
│         R11 → RFLAGS                                       │
│         CPL = 3（回到 Ring 3）                              │
│                                                            │
└────────────────────────────┬───────────────────────────────┘
                             │
                             ▼
                    用户态（Ring 3）
┌────────────────────────────────────────────────────────────┐
│  libc write() 包装函数继续：                               │
│    RAX = 6 → 返回给调用者                                  │
│                                                            │
│  C 代码继续执行 write() 调用之后的语句                      │
└────────────────────────────────────────────────────────────┘
```

**全程耗时**：约 100-300 纳秒（在现代 x86-64 处理器上）。

---

## 2. 系统调用表（syscall table）

### 什么是系统调用表

**系统调用表**是内核中一个全局的函数指针数组：

```c
// 简化示意（实际代码在 arch/x86/entry/syscall_64.c）
const sys_call_ptr_t sys_call_table[] = {
    [0]  = sys_read,
    [1]  = sys_write,
    [2]  = sys_open,
    [3]  = sys_close,
    [4]  = sys_stat,
    ...
    [57] = sys_fork,
    [59] = sys_execve,
    [60] = sys_exit,
    ...
    [231]= sys_exit_group,
    ...
};
```

当 SYSCALL 指令执行时，内核以 RAX 的值作为索引，在这个数组里查找处理函数并调用。

> 💡 **系统调用号**（syscall number）是一个整数，标识要请求哪种内核服务。这个数字与架构相关——x86-64 和 ARM64 的 syscall 号完全不同。

### 在哪里找 syscall 号

```bash
# 查看 x86-64 的 syscall 号定义
cat /usr/include/asm/unistd_64.h | head -30

# 输出示例：
#define __NR_read                0
#define __NR_write               1
#define __NR_open                2
#define __NR_close               3
#define __NR_stat                4
#define __NR_fstat               5
#define __NR_lstat               6
#define __NR_poll                7
#define __NR_lseek               8
#define __NR_mmap                9
#define __NR_mprotect           10
...
#define __NR_fork               57
#define __NR_execve             59
#define __NR_exit               60
#define __NR_wait4              61
...
```

也可以用专门的工具查：

```bash
# ausyscall 工具（可能需要安装 auditd）
ausyscall --dump | grep write

# 或者直接在线查：
# https://syscalls.mebeim.net/
```

---

## 3. 常用 syscall 分类

x86-64 Linux 共有约 **340+ 个系统调用**。按功能分为以下几大类：

### 文件 I/O 类

```
open(path, flags, mode) → fd        # 打开文件
read(fd, buf, count) → bytes_read   # 读取
write(fd, buf, count) → bytes_written # 写入
close(fd)                           # 关闭
stat(path, statbuf)                 # 获取文件元数据
unlink(path)                        # 删除文件
rename(old, new)                    # 重命名
mkdir(path, mode)                   # 创建目录
openat(dirfd, path, ...)            # 相对目录打开（更安全）
```

### 进程管理类

```
fork() → pid        # 创建子进程（复制当前进程）
clone(flags, ...) → pid  # 更灵活的进程/线程创建
execve(path, argv, envp) # 用新程序替换当前进程
exit(code)          # 进程退出
wait4(pid, ...)     # 等待子进程结束
kill(pid, sig)      # 向进程发送信号
getpid() → pid      # 获取当前进程 PID
getuid() → uid      # 获取用户 ID
```

### 内存管理类

```
mmap(addr, len, prot, flags, fd, off) → ptr  # 内存映射
munmap(ptr, len)                              # 解除映射
mprotect(ptr, len, prot)                      # 修改内存权限
brk(addr) → new_brk                          # 调整堆大小
madvise(ptr, len, advice)                     # 内存使用建议
```

### 网络类

```
socket(domain, type, proto) → fd   # 创建套接字
bind(fd, addr, addrlen)             # 绑定地址
listen(fd, backlog)                 # 监听连接
accept(fd, ...) → new_fd            # 接受连接
connect(fd, addr, addrlen)          # 发起连接
sendto / recvfrom                   # 发送/接收数据
```

### 时间与信号类

```
nanosleep(req, rem)                 # 精确睡眠
clock_gettime(clkid, tp)            # 获取时间
sigaction(sig, act, oldact)         # 注册信号处理器
rt_sigprocmask(how, set, oldset)    # 修改信号掩码
```

### 安全与沙箱类（与 shimmy 直接相关）

```
prctl(option, ...)                  # 进程控制（设置 seccomp 等）
seccomp(op, flags, uargs)           # 设置 seccomp 过滤器
ptrace(request, pid, addr, data)    # 进程跟踪（调试器基础）
```

---

## 4. strace：用肉眼看 syscall

**strace** 是一个用 `ptrace` 机制实现的工具，可以拦截并打印一个程序发出的所有系统调用。

### 基本用法

```bash
# 跟踪一个命令的所有 syscall
$ strace ls /tmp

# 输出示例（截选）：
execve("/bin/ls", ["ls", "/tmp"], 0x7fff... /* 23 vars */) = 0
brk(NULL)                                = 0x55a2b4c18000
openat(AT_FDCWD, "/etc/ld.so.cache", O_RDONLY|O_CLOEXEC) = 3
fstat(3, {st_mode=S_IFREG|0644, st_size=89765, ...}) = 0
mmap(NULL, 89765, PROT_READ, MAP_PRIVATE, 3, 0) = 0x7f8c3a2e0000
close(3)                                 = 0
openat(AT_FDCWD, "/lib/x86_64-linux-gnu/libc.so.6", ...) = 3
mmap(NULL, ..., MAP_PRIVATE|MAP_DENYWRITE, 3, 0) = 0x7f8c3a0e2000
...
openat(AT_FDCWD, "/tmp", O_RDONLY|O_DIRECTORY|O_CLOEXEC) = 3
getdents64(3, /* 5 entries */, 32768)    = 168
write(1, "file1.txt  file2.txt\n", 21)  = 21
close(3)                                 = 0
exit_group(0)                            = ?
```

### 常用 strace 选项

```bash
# 统计每个 syscall 的调用次数和耗时
strace -c ls /tmp

# 只看特定 syscall（比如只看文件相关）
strace -e trace=openat,read,write,close ls /tmp

# 跟踪已运行的进程（需要 root 或 ptrace 权限）
strace -p 1234

# 输出到文件
strace -o /tmp/trace.log ./myprogram

# 显示每个 syscall 的时间戳
strace -t ls /tmp
```

### 一个典型的 strace 输出解读

```bash
$ strace -c python3 -c "print('hello')"

# 输出：
hello
% time     seconds  usecs/call     calls    errors syscall
─────── ─────────── ─────────── ──────── ──────── ────────────
 30.52    0.000821          54       15           mmap
 19.32    0.000520          40       13           read
 15.67    0.000421          35       12           openat
  8.99    0.000242          30        8           fstat
  7.45    0.000200          40        5           mprotect
  4.21    0.000113          57        2           write
  ...
Total: 85 calls in ~2.7ms
```

就算是一行 `print('hello')`，Python 也发出了 85 次系统调用！大部分是启动时加载动态库。

---

## 5. libc 封装与直接 syscall

你平时写 C 代码调用的 `write()`、`open()` 等函数，不是直接发起 syscall——它们是 **libc 的封装函数**（wrapper），在内部做一些参数处理后再触发实际的 SYSCALL 指令。

```
你的代码：write(1, buf, len)
    │
    ▼
libc 的 write() 封装：
    ├── 检查参数合法性
    ├── 设置寄存器（RAX=1, RDI=1, RSI=buf, RDX=len）
    ├── SYSCALL 指令
    ├── 如果 RAX < 0：设置 errno，返回 -1
    └── 否则返回 RAX（成功写入的字节数）
    │
    ▼
内核 sys_write()
```

可以用汇编完全绕过 libc，直接触发 SYSCALL：

```asm
; x86-64 汇编：直接 syscall，不经过 libc
; write(1, "hello\n", 6)
section .data
    msg db "hello", 0x0A
section .text
    global _start
_start:
    mov rax, 1       ; SYS_write
    mov rdi, 1       ; fd = stdout
    lea rsi, [msg]   ; buf
    mov rdx, 6       ; count
    syscall          ; 触发！
    ; 返回值在 RAX（应为 6）
```

这对沙箱设计很重要：**检测 syscall 不能依赖 libc 调用链**，必须在 SYSCALL 指令层面拦截，因为恶意代码可以完全绕过 libc。

---

## 6. 为什么 syscall 拦截是沙箱的核心

沙箱的目标是：让被沙箱的代码无法做有害的事——读取敏感文件、发起网络连接、创建子进程、修改自身内存为可执行……

这些"有害的事"**全部**需要通过系统调用来完成：

```
恶意操作 → 必须使用的 syscall
────────────────────────────────────────────────
读取 /etc/shadow（密码文件）→ openat + read
建立反弹 shell 连接        → socket + connect + execve
向内存写入 shellcode       → mmap + mprotect
创建子进程逃逸沙箱         → fork / clone / execve
读取环境变量（含 AWS key） → read（/proc/self/environ）
```

**如果能在每个 syscall 到达内核之前检查并决定是否允许，就能完整控制被沙箱代码的行为。**

这就是沙箱设计的核心逻辑：

```
被沙箱代码：... → SYSCALL 指令 → ???
                                   ↓
                          拦截！检查这个 syscall：
                          ├── 是否在白名单中？
                          ├── 参数是否合法？
                          └── 是否触及敏感资源？
                                   │
                        允许 ◄────┤├────► 拒绝（SIGSYS/返回 EPERM）
                                   ↓
                             内核正常处理
```

不同的拦截位置决定了沙箱的性能和能力：

| 拦截机制 | 拦截位置 | 代价/syscall | 典型延迟 |
|---------|---------|-------------|---------|
| ptrace | 内核（每次通知 tracer） | 极高（2次进程切换） | ~10 μs |
| seccomp-BPF | 内核（BPF 过滤器） | 中（内核态执行 BPF） | ~200 ns |
| LD_PRELOAD | libc 封装层（用户态） | 低（函数调用） | ~5 ns |
| 二进制插桩（shimmy）| SYSCALL 指令前（用户态）| 低（跳转指令） | ~20 ns |

> 💡 **LD_PRELOAD 的局限**：只能拦截通过 libc 的调用。恶意代码可以直接用汇编发 SYSCALL，绕过 libc，LD_PRELOAD 完全无效。这是 shimmy 必须在指令级别拦截的原因。

---

## 小结

```
syscall 执行路径：
  用户代码 → libc 封装 → 设置寄存器 → SYSCALL 指令
      → CPU 自动切换 Ring 0
      → 内核入口点 → 查 syscall 表 → 执行处理函数
      → SYSRET → 回到 Ring 3
      → libc 封装处理返回值 → 返回给用户代码

工具：
  strace = 用 ptrace 观察 syscall 流
  /usr/include/asm/unistd_64.h = 查 syscall 号

沙箱核心：
  控制 SYSCALL 指令 = 控制程序能做的一切
```

**核心要点**：
1. 每个 syscall 都有唯一编号（RAX 传入），内核用它查表找处理函数
2. libc 是 syscall 的封装层，但恶意代码可以绕过 libc 直接发 SYSCALL
3. strace 用 ptrace 观察 syscall，但本身会大幅降低程序性能
4. 拦截 syscall 的位置越靠近用户态，代价越低，但也越容易被绕过

## 与沙箱技术的联系

shimmy 的核心技术选择就是在**用户态、SYSCALL 指令级别**拦截系统调用。具体方法（zpoline/lazypoline）是利用二进制插桩，在每条 SYSCALL 指令执行前插入一个跳转，跳到 shimmy 的检查函数。

这样既避免了 ptrace 的高代价，又不像 LD_PRELOAD 那样容易被绕过（因为是在机器码层面拦截的，被沙箱代码无法感知或规避）。

理解 syscall 的完整执行路径，是理解为什么 shimmy 的设计能同时做到"安全"和"高效"的关键前提。
