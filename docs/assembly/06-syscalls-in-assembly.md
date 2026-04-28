# 第六章：用汇编发起系统调用

> 系统调用是用户程序请求操作系统服务的唯一方式。本章用纯汇编实现完整的程序，直接调用内核，不借助任何 C 库——这是理解操作系统边界的最直接方式。

## 6.1 回顾：什么是系统调用

你的 Python/C 程序运行在**用户空间**（User Space），和内核隔离。当程序需要做"特权操作"（读写文件、分配内存、创建进程……），必须通过**系统调用**（System Call / Syscall）请求内核代劳。

```
用户空间                     内核空间
──────────────              ──────────────────────
你的程序
  printf("Hello")
    ↓ 调用 libc
  write(1, "Hello", 5)      ←← 这里才真正进入内核
    ↓ syscall 指令              内核执行 write 逻辑
  ←←←←←←←←←←←←←←←         内核完成，返回用户空间
  继续执行
```

**`syscall` 指令**是 x86-64 下进入内核的特权指令。执行 `syscall` 时：
1. CPU 保存当前的 `rip`（返回地址）到 `rcx`，保存 `rflags` 到 `r11`
2. CPU 切换到内核模式（Ring 0）
3. 跳转到内核的系统调用入口点
4. 内核执行对应的操作，把结果放入 `rax`
5. `sysret` 指令（内核执行）恢复用户态，从 `rcx` 恢复 `rip`

---

## 6.2 Linux syscall 调用约定

在 Linux x86-64 上，系统调用的约定：

| 寄存器 | 作用 |
|--------|------|
| `rax` | **系统调用号**（指定要调用哪个系统调用）|
| `rdi` | 第 1 个参数 |
| `rsi` | 第 2 个参数 |
| `rdx` | 第 3 个参数 |
| `r10` | 第 4 个参数（注意：不是 `rcx`！）|
| `r8`  | 第 5 个参数 |
| `r9`  | 第 6 个参数 |
| `rax` | **返回值**（系统调用完成后）|
| `rcx`, `r11` | 被 `syscall` 指令破坏（内核用于保存用户态上下文）|

**关键**：系统调用完成后，`rax` 里是返回值。如果发生错误，`rax` 是一个**负数**（`-errno`），范围在 -1 到 -4095 之间。

### 为什么第 4 个参数用 `r10` 而不是 `rcx`？

因为 `syscall` 指令本身用 `rcx` 存储返回地址。如果第 4 个参数放在 `rcx`，内核刚进入时 `rcx` 就被覆盖了。所以内核 ABI 用 `r10` 替代 `rcx` 传递第 4 个参数。

---

## 6.3 常见系统调用号

Linux 在 `x86_64` 架构下的常用系统调用：

| 系统调用号 | 函数名 | 参数 | 用途 |
|-----------|--------|------|------|
| 0 | `read` | fd, buf, count | 从文件描述符读数据 |
| 1 | `write` | fd, buf, count | 写数据到文件描述符 |
| 2 | `open` | filename, flags, mode | 打开文件 |
| 3 | `close` | fd | 关闭文件描述符 |
| 9 | `mmap` | addr, len, prot, flags, fd, off | 内存映射 |
| 11 | `munmap` | addr, len | 解除内存映射 |
| 39 | `getpid` | — | 获取当前进程 ID |
| 57 | `fork` | — | 创建子进程 |
| 59 | `execve` | filename, argv, envp | 执行程序 |
| 60 | `exit` | status | 退出当前线程 |
| 231 | `exit_group` | status | 退出整个进程（推荐用这个）|

完整的系统调用表：查看 `/usr/include/asm/unistd_64.h` 或在线：[syscalls.mebeim.net](https://syscalls.mebeim.net/?arch=x86/64)

**文件描述符约定**：
- `0` = 标准输入（stdin）
- `1` = 标准输出（stdout）
- `2` = 标准错误（stderr）

---

## 6.4 完整例子：纯汇编 Hello World

现在我们用**纯汇编**写一个 Hello World 程序，不调用 libc 的任何函数（`printf`、`puts` 等），直接使用 `syscall` 指令与内核通信。

### 程序功能

1. 调用 `write(1, "Hello, World!\n", 14)` — 向标准输出写字符串
2. 调用 `exit(0)` — 正常退出

### 汇编代码（NASM 语法，Intel 格式）

```asm
; hello.asm - 纯汇编 Hello World（Linux x86-64）
; 使用 NASM 汇编器

section .data
    ; 定义字符串数据，在数据段
    msg db "Hello, World!", 10  ; 字符串 + 换行符（ASCII 10）
    msg_len equ $ - msg         ; 字符串长度（$ 是当前地址，减去 msg 的起始地址）

section .text
    global _start               ; 声明入口点，让链接器能找到它

_start:
    ; ── 系统调用 1：write(1, msg, msg_len) ──
    mov rax, 1          ; 系统调用号 1 = write
    mov rdi, 1          ; 第1参数：文件描述符 1 = stdout
    lea rsi, [rel msg]  ; 第2参数：字符串的地址（rel 表示相对寻址）
    mov rdx, msg_len    ; 第3参数：字节数 = 14
    syscall             ; 发起系统调用，进入内核

    ; syscall 返回后：
    ; rax = 实际写入的字节数（成功时是 14），或负数（错误）
    ; rcx, r11 被破坏（内核用了）

    ; ── 系统调用 2：exit(0) ──
    mov rax, 60         ; 系统调用号 60 = exit
    mov rdi, 0          ; 第1参数：退出状态码 0（正常退出）
    syscall             ; 进入内核，不再返回
```

### 编译和运行

```bash
# 安装 NASM（如果没有）
apt-get install nasm

# 汇编：生成目标文件 (.o)
nasm -f elf64 -o hello.o hello.asm

# 链接：生成可执行文件
ld -o hello hello.o

# 运行
./hello
# 输出：Hello, World!

# 查看文件大小（非常小！没有 C 运行时）
ls -la hello
# 大约 1000 字节
```

### 与 C 版本的对比

用 C 语言的 `printf` 写的 Hello World：
```c
#include <stdio.h>
int main() {
    printf("Hello, World!\n");
    return 0;
}
```

编译后：`gcc -o hello_c hello.c`，文件大小约 16KB（包含链接的 C 运行时代码）。

纯汇编版本约 1KB——差了 16 倍，因为没有 C 库的开销。

---

## 6.5 另一个例子：读取用户输入并回显

```asm
; echo.asm - 读取一行输入，回显到标准输出

section .bss
    buffer resb 128     ; 在 BSS 段预留 128 字节的缓冲区（未初始化）

section .text
    global _start

_start:
    ; ── read(0, buffer, 128) ── 从标准输入读最多128字节
    mov rax, 0                  ; 系统调用号 0 = read
    mov rdi, 0                  ; 文件描述符 0 = stdin
    lea rsi, [rel buffer]       ; 缓冲区地址
    mov rdx, 128                ; 最多读取字节数
    syscall
    ; rax = 实际读取的字节数

    ; 如果读取失败（rax <= 0），直接退出
    test rax, rax
    jle exit_program

    ; ── write(1, buffer, bytes_read) ── 把读到的内容写到标准输出
    mov rdx, rax                ; 第3参数：写入字节数 = 刚才读到的字节数
    mov rax, 1                  ; 系统调用号 1 = write
    mov rdi, 1                  ; 文件描述符 1 = stdout
    lea rsi, [rel buffer]       ; 同一个缓冲区
    syscall

exit_program:
    ; ── exit(0) ──
    mov rax, 60
    xor rdi, rdi                ; 退出状态 0（xor 清零，比 mov rdi, 0 更紧凑）
    syscall
```

### 编译运行：

```bash
nasm -f elf64 -o echo.o echo.asm
ld -o echo echo.o
echo "Hello from shell" | ./echo
# 输出：Hello from shell
```

---

## 6.6 用 GAS（GNU Assembler）语法

如果你用 `gcc` 或者直接用 Linux 的 `as` 汇编器，语法稍有不同（AT&T 格式）：

```asm
# hello_gas.s - 用 GAS（AT&T 语法）写的 Hello World

    .section .data
msg:
    .ascii "Hello, World!\n"
msg_len = . - msg               # 计算字符串长度

    .section .text
    .global _start

_start:
    # write(1, msg, msg_len)
    movq $1, %rax               # AT&T：立即数前加 $，寄存器前加 %
    movq $1, %rdi
    leaq msg(%rip), %rsi        # 相对于 rip 的地址
    movq $msg_len, %rdx
    syscall

    # exit(0)
    movq $60, %rax
    xorq %rdi, %rdi
    syscall
```

编译：
```bash
as -o hello.o hello_gas.s
ld -o hello hello.o
```

---

## 6.7 用 C 内联汇编调用 syscall

在 C 代码中，也可以用内联汇编直接发起系统调用：

```c
#include <stddef.h>

// 用内联汇编实现 write syscall
ssize_t my_write(int fd, const void *buf, size_t count) {
    ssize_t ret;
    __asm__ volatile (
        "syscall"
        : "=a" (ret)              // 输出：rax → ret
        : "0" (1),                // 输入：rax = 1（write 的系统调用号）
          "D" (fd),               // rdi = fd
          "S" (buf),              // rsi = buf
          "d" (count)             // rdx = count
        : "rcx", "r11", "memory" // 被破坏的寄存器
    );
    return ret;
}

int main() {
    const char msg[] = "Hello from inline asm!\n";
    my_write(1, msg, sizeof(msg) - 1);
    // 注意：这里的 exit 仍然调用了 libc，因为我们链接了 C 运行时
    return 0;
}
```

编译：
```bash
gcc -o inline_asm inline_asm.c
./inline_asm
```

---

## 6.8 为什么 syscall 是沙箱的关键拦截点

这是本章最重要的一节，也是整个汇编章节的点睛之笔。

### 系统调用 = 用户程序能做的一切

一个用户空间的程序，无论多复杂，它对外部世界的所有影响，**全部**通过系统调用产生。不调用系统调用，程序不能：

- 读写文件
- 网络通信
- 分配/释放内存（`mmap`/`munmap`）
- 创建进程
- 与硬件交互

这意味着：**如果你能拦截并过滤所有系统调用，你就能完全控制一个程序能做什么**。这正是沙箱的核心思想！

### 不同的拦截方式

| 技术 | 拦截位置 | 原理 |
|------|---------|------|
| **ptrace** | 内核内 | 调试接口，每次 syscall 都通知父进程；极慢 |
| **seccomp-BPF** | 内核内，BPF 过滤器 | 内核执行 BPF 程序决定是否允许；快，但 BPF 能力有限 |
| **zpoline** | 用户空间，指令替换 | 把所有 `syscall` 指令替换为间接调用；拦截在用户空间完成 |
| **ptrace + SIGTRAP** | 内核/用户空间边界 | 通过信号通知用户空间处理器；有延迟 |

### zpoline 的工作原理（需要理解汇编才能看懂）

`syscall` 指令在 x86-64 下的机器码是 **2 个字节**：`0F 05`。

`callq *%rax`（AT&T 语法，Intel 语法是 `call rax`，即间接调用 rax 中的地址）在 x86-64 下也是 **2 个字节**：`FF D0`。

zpoline 的核心技巧：
1. 在程序启动后，扫描所有加载的代码段
2. 把每个 `syscall` 指令（`0F 05`）替换为 `callq *%rax`（`FF D0`）
3. 把虚拟地址 `0` 映射为一段"蹦床"代码（trampoline），蹦床负责把调用转发给真正的系统调用处理器

为什么这样能拦截系统调用？
- 原来：`syscall` → 直接进内核
- 替换后：`call rax`（rax 此时存有系统调用号，如 1/0/60）→ 跳转到地址 `rax` 处的代码 → 地址 1、0、60 等都落在 `mmap` 到地址 0 的蹦床区域内 → 蹦床代码检查系统调用号，决定允许/拒绝/监控

```
原始代码：                      替换后：
┌──────────────┐               ┌──────────────┐
│ mov rax, 1   │               │ mov rax, 1   │
│ mov rdi, 1   │               │ mov rdi, 1   │
│ ...          │               │ ...          │
│ syscall      │  →替换为→     │ call [rax]   │  ← 跳转到地址 1
└──────────────┘               └──────────────┘
                                       ↓
                               ┌──────────────────────┐
                               │ 地址 0~4095: 蹦床代码 │
                               │ 地址 1 处：           │
                               │   检查系统调用号      │
                               │   允许/拒绝/监控      │
                               │   真正发起 syscall    │
                               └──────────────────────┘
```

这个设计的精妙之处：
- `callq *%rax` 和 `syscall` 都是 2 字节，替换不影响周围指令的地址
- `rax` 里本来就是系统调用号，恰好可以作为跳转地址
- 蹦床在地址 0 附近，利用了 x86-64 的小地址空间

不理解汇编指令和机器码，就看不懂这个巧妙的设计。

---

## 6.9 strace：观察真实程序的系统调用

`strace` 是 Linux 下查看程序系统调用的工具：

```bash
# 追踪 ls 命令的所有系统调用
strace ls /tmp 2>&1 | head -30

# 只看 write 系统调用
strace -e trace=write ls /tmp

# 追踪一个 Python 程序
strace python3 -c "print('hello')" 2>&1 | grep -E "write|open"
```

典型输出（精简）：
```
execve("/bin/ls", ["ls", "/tmp"], ...) = 0
brk(NULL) = 0x55d8a3b00000
openat(AT_FDCWD, "/etc/ld.so.cache", O_RDONLY|O_CLOEXEC) = 3
mmap(NULL, 4096, ...) = 0x7f3b2c000000
write(1, "file1.txt  file2.txt\n", 21) = 21
exit_group(0) = ?
```

这里每一行都是一个系统调用——这就是你的 `ls` 命令真正执行的事情！

---

## 小结

- **`syscall` 指令**是 x86-64 用户程序进入内核的唯一方式
- **syscall 约定**：系统调用号放 `rax`，参数用 `rdi/rsi/rdx/r10/r8/r9`，返回值在 `rax`；`rcx` 和 `r11` 被破坏
- 常用系统调用：`read(0)`, `write(1)`, `exit(60)`, `exit_group(231)`
- 纯汇编的 Hello World：只需两次 `syscall`，不需要 libc
- **沙箱的核心**：所有对外部世界的影响都通过系统调用进行，拦截系统调用就能控制程序行为
- **zpoline** 把 `syscall`（`0F 05`）替换为 `call rax`（`FF D0`），借助两者都是 2 字节这一巧合实现无侵入的系统调用拦截

---

## 延伸阅读

- **`man syscall`**：syscall 的 Linux 手册页
- **`man syscalls`**：Linux 所有系统调用的列表
- **Linux 内核源码 `arch/x86/entry/syscalls/syscall_64.tbl`**：系统调用号的权威来源
- **zpoline 论文（USENIX ATC 2023）**：本文档 Papers 章节有详细讲解
- **`strace` 工具**：观察真实程序的系统调用，极其有用的调试/学习工具
- **`seccomp-bpf` 手册**：`man seccomp`，了解另一种系统调用拦截机制
