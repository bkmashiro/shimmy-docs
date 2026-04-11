# 第三章：系统调用

> 系统调用（syscall）是用户程序与 Linux 内核之间的**唯一合法接口**。理解系统调用，是理解整个沙箱技术的关键。

## 3.1 什么是系统调用

前两章建立了一个关键事实：

- 用户程序运行在 Ring 3（受限），不能直接访问硬件
- 内核运行在 Ring 0（特权），掌管所有资源
- 程序需要读文件、建立网络连接、创建进程——这些都需要内核的参与

**系统调用**（System Call，syscall）就是 Ring 3 程序请求 Ring 0 内核服务的机制。每一次文件读写、网络连接、进程创建，背后都有系统调用。

可以把系统调用想象成程序与内核之间的"公文窗口"：

```
                    ┌─────────────────────────────────┐
用户空间 (Ring 3)  │                                 │
                   │  你的程序                        │
                   │  ┌─────────────────────────────┐ │
                   │  │ open("/etc/passwd", O_RDONLY)│ │
                   │  └────────────┬────────────────┘ │
                   │               │                  │
                   ├───────────────┼──────────────────┤
                   │           syscall 指令            │ ← 唯一的门
                   ├───────────────┼──────────────────┤
                   │               │                  │
内核空间 (Ring 0)  │  ┌────────────▼────────────────┐ │
                   │  │ sys_open: 验证权限            │ │
                   │  │           打开文件            │ │
                   │  │           返回文件描述符      │ │
                   │  └─────────────────────────────┘ │
                   └─────────────────────────────────┘
```

## 3.2 x86-64 系统调用 ABI

**ABI**（Application Binary Interface，应用二进制接口）定义了调用约定——寄存器如何使用，参数如何传递。

在 x86-64 Linux 上，系统调用的约定如下：

| 寄存器 | 用途 |
|--------|------|
| **RAX** | 系统调用号（输入）/ 返回值（输出） |
| **RDI** | 第 1 个参数 |
| **RSI** | 第 2 个参数 |
| **RDX** | 第 3 个参数 |
| **R10** | 第 4 个参数（注意：不是 RCX！） |
| **R8**  | 第 5 个参数 |
| **R9**  | 第 6 个参数 |

调用步骤：
1. 把系统调用号放入 RAX
2. 把参数依次放入 RDI, RSI, RDX, R10, R8, R9
3. 执行 `syscall` 指令
4. CPU 切换到 Ring 0，跳转到内核的系统调用处理程序
5. 内核完成操作，把返回值放入 RAX
6. CPU 切换回 Ring 3，程序继续执行

出错时，返回值是负数（负的错误码），比如 `-ENOENT`（-2）表示文件不存在，`-EPERM`（-1）表示权限不足。

## 3.3 用汇编语言直接发起系统调用

让我们用纯汇编写一个 `write(1, "hello\n", 6)` 系统调用——向 stdout（fd=1）写入 6 个字节：

```asm
; write.asm - 用汇编直接调用系统调用
; 系统调用号: write = 1
; 原型: ssize_t write(int fd, const void *buf, size_t count)

section .data
    msg db "hello", 0x0A   ; "hello\n" (0x0A = 换行符)
    msglen equ 6

section .text
    global _start

_start:
    ; write(1, msg, 6)
    mov rax, 1          ; RAX = 1 (write 的系统调用号)
    mov rdi, 1          ; RDI = 1 (fd: stdout)
    mov rsi, msg        ; RSI = msg 的地址 (buf)
    mov rdx, msglen     ; RDX = 6 (count: 字节数)
    syscall             ; 陷入内核！

    ; exit(0)
    mov rax, 60         ; RAX = 60 (exit 的系统调用号)
    xor rdi, rdi        ; RDI = 0 (退出码)
    syscall
```

这段汇编没有引入任何库，没有 main 函数，直接用两条 `syscall` 指令与内核交互。

### 用 C 的 syscall() 函数

C 语言提供了 `syscall()` 函数，让你在 C 代码中直接调用系统调用（绕过 glibc 的高级封装）：

```c
#include <sys/syscall.h>
#include <unistd.h>

int main() {
    // write(1, "hello\n", 6) — 直接系统调用
    long ret = syscall(SYS_write, 1, "hello\n", 6);
    // SYS_write = 1

    // 等价于:
    write(1, "hello\n", 6);
    // 但 write() 是 glibc 封装，最终也会调用 SYS_write

    return 0;
}
```

## 3.4 strace：追踪系统调用

**`strace`** 是 Linux 上最强大的调试工具之一：它使用 ptrace 追踪一个进程的所有系统调用，并打印出来。

看看 `cat /etc/hostname` 背后发生了什么：

```bash
$ strace cat /etc/hostname 2>&1 | head -30
execve("/usr/bin/cat", ["cat", "/etc/hostname"], ...) = 0
brk(NULL)                               = 0x562ef4a43000
mmap(NULL, 8192, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0x7f8b2d4c9000
access("/etc/ld.so.preload", R_OK)      = -1 ENOENT (No such file or directory)
openat(AT_FDCWD, "/etc/ld.so.cache", O_RDONLY|O_CLOEXEC) = 3
fstat(3, {st_mode=S_IFREG|0644, ...})  = 0
mmap(NULL, 162069, PROT_READ, MAP_PRIVATE, 3, 0) = 0x7f8b2d4a1000
close(3)                                = 0
openat(AT_FDCWD, "/lib/x86_64-linux-gnu/libc.so.6", O_RDONLY|O_CLOEXEC) = 3
...（加载动态库）
openat(AT_FDCWD, "/etc/hostname", O_RDONLY) = 3   ← 打开目标文件
fstat(3, {st_mode=S_IFREG|0644, ...})  = 0
fadvise64(3, 0, 0, POSIX_FADV_SEQUENTIAL) = 0
mmap(NULL, 139264, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0x7f8b2d47e000
read(3, "myserver\n", 131072)           = 9        ← 读取内容
write(1, "myserver\n", 9)              = 9         ← 写到 stdout
read(3, "", 131072)                    = 0        ← EOF
close(3)                               = 0
exit_group(0)                          = ?
```

注意几点：
- 一个简单的 `cat` 命令背后发生了几十个系统调用
- 程序启动时会先加载动态库（多次 openat/mmap）
- 真正的业务逻辑只有 openat + read + write 三个调用

strace 揭示了所有系统调用——这正是沙箱系统需要审查的全部内容。

## 3.5 重要系统调用一览

x86-64 Linux 定义了约 330+ 个系统调用。以下是最常见的一些：

```
系统调用号  名称          原型                                     用途
──────────  ────────────  ───────────────────────────────────────  ──────────────────
0           read          read(fd, buf, count)                     从 fd 读取数据
1           write         write(fd, buf, count)                    向 fd 写入数据
2           open          open(path, flags, mode)                  打开文件（已废弃）
3           close         close(fd)                                关闭文件描述符
4           stat          stat(path, statbuf)                      获取文件元信息
9           mmap          mmap(addr, len, prot, flags, fd, off)   内存映射
10          mprotect      mprotect(addr, len, prot)               修改内存保护属性
11          munmap        munmap(addr, len)                        解除内存映射
12          brk           brk(addr)                                堆顶指针（malloc用）
39          getpid        getpid()                                 获取当前进程 PID
41          socket        socket(domain, type, proto)              创建网络套接字
42          connect       connect(fd, addr, addrlen)               连接到远程地址
56          clone         clone(flags, stack, ...)                 创建线程/进程
57          fork          fork()                                   创建子进程
59          execve        execve(path, argv, envp)                 执行程序（替换当前）
60          exit          exit(status)                             进程退出
62          kill          kill(pid, sig)                           发送信号
72          fcntl         fcntl(fd, cmd, arg)                      文件控制操作
89          readlink      readlink(path, buf, size)               读取符号链接
101         ptrace        ptrace(req, pid, addr, data)            进程追踪（调试器）
157         prctl         prctl(option, arg2, ...)                进程控制（安全配置）
281         epoll_wait    epoll_wait(epfd, events, maxevents, to) 高效 I/O 多路复用
425         io_uring_setup io_uring_setup(entries, params)         异步 I/O 环形缓冲区
```

其中特别值得关注的是：

- **`fork(57)`**：创建子进程。恶意代码可以用它进行 fork 炸弹。
- **`execve(59)`**：执行新程序（常用来弹出 shell）。
- **`socket(41)` + `connect(42)`**：建立网络连接（泄露数据、反弹 shell）。
- **`mmap(9)` with `PROT_EXEC`**：映射可执行内存（JIT 编译器用，但也可绕过权限检查）。
- **`prctl(157)`**：配置进程安全属性（包括 seccomp——但 Lambda 中会返回 EPERM）。
- **`io_uring_setup(425)`**：异步 I/O——可绕过系统调用拦截（第八章详述）。

## 3.6 glibc 封装层

程序员通常不直接写汇编。C 标准库（**glibc**）为每个系统调用提供了对应的 C 函数封装。

以 `open()` 为例，glibc 的实现大致是：

```c
// glibc 内部的 open() 实现（简化版）
int open(const char *pathname, int flags, ...) {
    // 处理可变参数 mode
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = va_arg(ap, mode_t);
        va_end(ap);
    }

    // 实际上调用 openat 系统调用（open 的现代版本）
    // openat(AT_FDCWD, pathname, flags, mode)
    // 等价于 open(pathname, flags, mode)
    int ret;
    __asm__ volatile (
        "syscall"
        : "=a" (ret)
        : "0" (SYS_openat),   // RAX = 257 (openat)
          "D" (AT_FDCWD),     // RDI = -100
          "S" (pathname),     // RSI = 路径指针
          "d" (flags),        // RDX = 标志
          "r" (mode)          // R10 = 模式
        : "memory", "rcx", "r11"
    );

    if (ret < 0) {
        errno = -ret;    // 把负的错误码转为 errno
        return -1;
    }
    return ret;
}
```

**glibc 封装层的意义**：
- 提供类型安全的 C 接口
- 处理平台差异（不同架构系统调用号不同）
- 把负返回值转为 `errno` 错误码
- 提供一些优化（如 VDSO）

## 3.7 VDSO：无需进入内核的系统调用

**VDSO**（Virtual Dynamic Shared Object，虚拟动态共享对象）是一个内核注入到每个进程地址空间的小型共享库，包含少数频繁使用的系统调用的用户态实现。

为什么需要 VDSO？因为 `syscall` 指令的模式切换开销相当可观（约 100ns+），对于极高频率调用的操作不划算。

```bash
$ cat /proc/self/maps | grep vdso
7ffce4e2d000-7ffce4e2f000 r-xp 00000000 00:00 0   [vdso]
```

内核通过 VDSO 为以下调用提供用户态实现：
- `gettimeofday()` / `clock_gettime()`：读取当前时间（不进入内核，直接读内核映射的时间结构体）
- `getcpu()`：获取当前运行的 CPU 编号
- `getpid()`：某些情况下缓存 PID

## 3.8 LD_PRELOAD 的局限：为什么不能依赖库层面拦截

**LD_PRELOAD** 是一个环境变量，设置后动态链接器会在加载任何其他库之前先加载你指定的 `.so` 文件。你可以用它覆盖 glibc 中的函数：

```c
// my_open.c — 用 LD_PRELOAD 拦截 open()
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <errno.h>

int open(const char *pathname, int flags, ...) {
    printf("[拦截] open(\"%s\")\n", pathname);

    if (strcmp(pathname, "/etc/passwd") == 0) {
        errno = EPERM;
        return -1;    // 阻断！
    }

    // 调用真正的 open
    int (*real_open)(const char *, int, ...) = dlsym(RTLD_NEXT, "open");
    return real_open(pathname, flags);
}
```

```bash
$ gcc -shared -fPIC -o my_open.so my_open.c -ldl
$ LD_PRELOAD=./my_open.so cat /etc/passwd
[拦截] open("/etc/passwd")
cat: /etc/passwd: Operation not permitted
```

表面上看，LD_PRELOAD 能拦截 `open()`。但这有三个致命漏洞：

### 漏洞 1：静态链接程序完全绕过

```c
// bypass_static.c — Go 和 Rust 默认编译成这种形式
// 静态链接程序不依赖 glibc，直接内嵌所有函数

// 编译: gcc -static bypass_static.c -o bypass_static
#include <sys/syscall.h>
#include <unistd.h>
#include <fcntl.h>

int main() {
    // 使用内嵌的 open()，不经过动态链接器
    int fd = open("/etc/passwd", O_RDONLY);
    // LD_PRELOAD 对这里完全无效！
}
```

### 漏洞 2：内联汇编直接调用 syscall 指令

```c
// bypass_asm.c — 直接用 syscall 指令，完全绕过任何库
#include <sys/syscall.h>
#include <fcntl.h>

int main() {
    int fd;
    __asm__ volatile (
        "syscall"
        : "=a" (fd)
        : "0" (SYS_open),
          "D" ("/etc/passwd"),
          "S" (O_RDONLY),
          "d" (0)
        : "memory", "rcx", "r11"
    );
    // LD_PRELOAD 的 open() 根本没被调用！
}
```

### 漏洞 3：JIT 生成的机器码

JIT 编译器（如 V8 的 JavaScript 引擎）在运行时生成新的机器码。这些代码：
- 直接包含 `syscall` 指令
- 没有经过动态链接器
- 完全绕过 LD_PRELOAD

**结论**：LD_PRELOAD 只能拦截通过 glibc 发起的系统调用。任何绕过 glibc 的方法——静态链接、内联汇编、JIT 生成代码——都能轻松躲过它。

这正是 Shimmy Sandbox 需要在更底层（机器码层面）拦截 `syscall` 指令本身的原因。

## 3.9 系统调用的完整执行路径

为了完整理解，来追踪一次 `open("/etc/passwd", O_RDONLY)` 系统调用从开始到结束的全路径：

```
[用户程序]
    │
    │  调用 glibc open()
    ▼
[glibc open()]
    │  设置 RAX=257(openat), RDI=-100, RSI="路径指针", RDX=标志
    │  执行 syscall 指令
    │
    │──── CPU 切换到 Ring 0 ────────────────────────────────────────┐
    │                                                               │
    ▼                                                            [内核]
[内核 entry_SYSCALL_64]                                            │
    │  保存用户态寄存器到内核栈                                     │
    │  根据 RAX=257 跳转到 sys_openat()                             │
    │                                                               │
    ▼                                                               │
[sys_openat()]                                                      │
    │  用 getname() 把路径字符串从用户内存复制到内核内存             │
    │  调用 do_sys_open()                                           │
    │                                                               │
    ▼                                                               │
[do_sys_open()]                                                     │
    │  调用 security_file_open()（LSM 钩子，如 SELinux/AppArmor）   │
    │  调用 path_openat()（路径解析，符号链接跟踪）                  │
    │  调用 vfs_open()（虚拟文件系统层）                             │
    │  调用具体文件系统驱动（ext4/tmpfs 等）                         │
    │  分配文件描述符号                                              │
    │  返回 fd 号                                                   │
    │                                                               │
    ▼──── CPU 切换回 Ring 3 ────────────────────────────────────────┘
    │
    │  RAX = fd 号（或负错误码）
    ▼
[glibc open()]
    │  如果 RAX < 0: errno = -RAX; return -1
    │  否则: return RAX
    ▼
[用户程序]
    │  fd = open(...) 返回
```

整个过程中，**`syscall` 指令是唯一的跨越 Ring 3/Ring 0 边界的机制**。DynamoRIO 的核心思想就是拦截所有 `syscall` 指令——无论它藏在代码的哪个角落。

## 小结

```
系统调用 = Ring 3 程序访问内核服务的唯一合法接口

调用约定:
  RAX = 系统调用号
  RDI/RSI/RDX/R10/R8/R9 = 参数
  syscall 指令触发进入 Ring 0

glibc = 封装层（不是必须的！）
VDSO = 部分调用无需进入内核的优化

LD_PRELOAD 局限:
  ✗ 静态链接绕过
  ✗ 内联汇编绕过
  ✗ JIT 代码绕过

→ 必须在机器码层面拦截 syscall 指令本身
```

下一章：我们用具体的 C 代码展示，一个恶意学生程序能用这些系统调用做什么——读取 AWS 凭证、发起网络攻击、炸毁整个服务器。
