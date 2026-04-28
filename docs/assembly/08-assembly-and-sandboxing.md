# 第八章：汇编与沙箱技术的联系

> 本章将前七章的汇编知识与沙箱技术连接起来。我们会看到 zpoline 和 lazypoline 如何在汇编层面工作，理解 trampoline（蹦床）技术的本质，以及 nop sled 等底层概念。

## 8.1 回顾：为什么需要在汇编层面操作

在第六章，我们学到了系统调用是用户程序影响外部世界的唯一途径。拦截系统调用 = 控制程序行为。

但问题是：**如何拦截系统调用？**

方案一：在内核层面拦截（如 seccomp-BPF）——有效，但需要在每个进程启动时配置，且 BPF 程序能力有限。

方案二：在用户空间拦截——速度更快（不用每次都进内核两次），但实现起来需要在汇编层面动手术。

zpoline 和 lazypoline 选择了方案二，而它们的工作原理，只有理解了汇编才能真正领会。

---

## 8.2 `syscall` 指令的机器码

让我们复习一个关键事实：`syscall` 指令的机器码是 **2 个字节**：

```
0F 05
```

可以验证：

```bash
# 写一个包含 syscall 的 C 文件（内联汇编）
echo 'void f() { __asm__("syscall"); }' > t.c
gcc -c -o t.o t.c
objdump -d t.o
```

输出：
```
0000000000000000 <f>:
   0:   55                      push   rbp
   1:   48 89 e5                mov    rbp,rsp
   4:   0f 05                   syscall
   6:   90                      nop
   7:   5d                      pop    rbp
   8:   c3                      ret
```

确认了：`syscall` = `0F 05`，2 个字节。

---

## 8.3 `callq *%rax` 的机器码

在 AT&T 语法中，`callq *%rax` 表示"调用 rax 中存储的地址处的函数"（间接调用）。

Intel 语法：`call rax`

机器码：**`FF D0`**，也是 **2 个字节**。

```bash
echo 'void f() { __asm__("callq *%%rax" ::: "memory"); }' > t2.c
gcc -c -o t2.o t2.c
objdump -d t2.o | grep "ff d0"
# 输出：ff d0    callq *%rax
```

**这是 zpoline 能工作的关键**：`syscall`（`0F 05`）和 `call rax`（`FF D0`）恰好都是 2 个字节，可以完美互换，不影响周围指令的地址。

---

## 8.4 zpoline 的工作原理

zpoline（发音：zero-poline）是 2023 年 USENIX ATC 论文中提出的技术。

### 核心思想

```
原始代码                         替换后的代码
──────────                       ────────────
mov rax, 1    (write)            mov rax, 1
mov rdi, 1                       mov rdi, 1
...                              ...
syscall                    →     call rax   ← rax = 1，跳到地址 1！
                                               ↓
                                 ┌─────────────────────────────────┐
                                 │ 地址 0 附近：蹦床代码（trampoline）│
                                 │ 地址 1 处：处理 write 系统调用    │
                                 │   → 检查 / 监控 / 真正 syscall   │
                                 └─────────────────────────────────┘
```

### 实现步骤

#### 第一步：把地址 0 附近映射为可执行内存

```c
// zpoline 在进程启动时执行
void *addr = mmap(NULL, 0x1000,         // addr=NULL 意味着从地址 0 开始
                  PROT_READ | PROT_WRITE | PROT_EXEC,
                  MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED,
                  -1, 0);
// 地址 0~4095 现在是可执行的！（通常这是非法地址，被 OS 保护）
// zpoline 通过特殊配置绕过这个限制
```

#### 第二步：在地址 0 处写入蹦床代码

蹦床代码的作用：保存所有寄存器，调用真正的系统调用处理函数，然后恢复寄存器。

```asm
; 地址 0 处的蹦床代码（伪代码）：
0x00:   push rdi              ; 保存所有参数寄存器
        push rsi
        push rdx
        push r10
        push r8
        push r9
        push rax              ; 系统调用号也保存
        ...
        ; 调用系统调用处理函数（C 写的，负责检查/监控）
        call syscall_handler  ; 传入系统调用号和参数
        ...
        ; 恢复寄存器
        pop r9
        ...
        ; 如果允许这次系统调用，真正执行 syscall
        syscall
        ret
```

**为什么蹦床从地址 0 开始？**

当 `call rax` 执行时，`rax` 的值就是系统调用号（如 1 = write，0 = read，60 = exit）。`call rax` 跳转到**地址等于系统调用号的地方**。

系统调用号都很小（几百以内），所以实际跳转目标是地址 1、0、60……这些地址都在 `mmap` 到地址 0 的 4KB 区域内！

只要这 4KB 蹦床区域内每个字节偏移处的代码都能正确处理对应的调用，就没问题。实践中，蹦床的开头放一段通用的跳转代码，跳到真正的处理函数。

#### 第三步：扫描并替换 `syscall` 指令

```c
// 遍历进程中所有可执行的内存段
// 在每个代码段中寻找 0F 05（syscall）字节序列
// 把每个 0F 05 替换为 FF D0（call rax）
for each executable memory region:
    for each byte pair (b1, b2):
        if b1 == 0x0F && b2 == 0x05:
            *b1 = 0xFF
            *b2 = 0xD0
```

实际上还需要处理一些细节（比如暂时让代码段可写、处理指令对齐等），但核心逻辑就是这样。

### 为什么不直接用 seccomp？

比较 zpoline 和 seccomp-BPF：

| 比较项 | seccomp-BPF | zpoline |
|--------|------------|---------|
| 拦截位置 | 内核内部 | 用户空间 |
| 每次 syscall 开销 | 内核上下文切换 + BPF 执行 | 用户空间函数调用（快！）|
| 能执行的操作 | 受限（BPF 不图灵完备）| 任意 C/C++ 代码 |
| 需要特权 | 是（部分功能）| 否 |
| 可以修改返回值 | 有限 | 完全可以 |

---

## 8.5 什么是 Trampoline（蹦床）

**Trampoline**（蹦床）这个词在汇编/系统编程中指的是一小段"中转代码"——当直接跳转不可行时，先跳到一个中间地址（蹦床），蹦床再跳到真正目标。

### 为什么叫"蹦床"？

想象在地板上跳到一个高台：如果跳不直接够到，你可以先跳到一个蹦床上，借助蹦床的弹力再跳到高台。代码蹦床也类似：

```
原始跳转目标：无法直接达到（地址太远、需要额外处理）
       ↓
蹦床：一小段中转代码，在这里做额外处理
       ↓
真正目标：实际要执行的代码
```

### Trampoline 的常见应用场景

#### 场景一：地址范围限制

x86 的相对跳转指令（`jmp rel32`）只能跳转到前后 2GB 范围内的地址。如果目标太远，就需要用蹦床：

```asm
; 近跳转（32位偏移）：
jmp near_target      ; 只能跳 ±2GB

; 需要跳转到很远的地址时：
jmp trampoline_for_far_target   ; 先跳到蹦床

trampoline_for_far_target:
    mov rax, 0xFFFF000000001234  ; 64位绝对地址
    jmp rax                      ; 再跳到真正目标
```

#### 场景二：zpoline 的蹦床

把系统调用重定向到处理函数（如上节所述）。

#### 场景三：动态链接（PLT）

Linux 的 PLT（Procedure Linkage Table）也是一种蹦床：

```asm
; 第一次调用 printf 时，PLT 项类似：
printf@plt:
    jmp [printf@got.plt]     ; 跳到 GOT 表中的地址
    ; 第一次调用时，GOT 表里存的是下面这条指令的地址
    push 0                   ; 把 printf 的索引压栈
    jmp _dl_runtime_resolve  ; 跳到动态链接器，它会解析真正的 printf 地址
    ; 解析后，GOT 表被更新，以后 jmp [printf@got.plt] 直接跳到真正的 printf
```

这就是为什么第一次调用某个库函数比之后慢一点——第一次需要动态解析地址（lazypoline 的名字就来自这种"懒解析"思想）。

---

## 8.6 lazypoline：蹦床的改进版

lazypoline（2024 年 DSN）是对 zpoline 的改进，解决了 zpoline 的一些限制。

### zpoline 的问题

zpoline 需要**提前扫描所有代码**替换 `syscall` 指令。但如果代码是**运行时动态加载**的（JIT 编译、dlopen 加载的库），zpoline 可能错过这些代码中的 `syscall`。

### lazypoline 的解决方案

lazypoline 采用**懒惰（lazy）** 策略：

1. 不提前替换，而是**在第一次执行时**才拦截
2. 用信号处理机制（SIGSEGV/SIGFPE）来触发拦截
3. 第一次处理后，把那个位置的代码替换为直接跳转蹦床的代码

这类似于动态链接器的"懒解析"——第一次调用时做一次慢处理，之后直接走快路径。

```
第一次执行 syscall：
  syscall 触发 → lazypoline 拦截 → 分析/处理 → 替换为直接蹦床跳转

第二次执行同一个 syscall：
  直接跳蹦床（没有额外开销）
```

理解 lazypoline 需要知道：
- `syscall` 指令的字节是 `0F 05`
- 蹦床的跳转机制
- Linux 信号处理（信号是如何传递到用户空间的）
- 栈帧和寄存器保存（拦截后如何恢复执行状态）

---

## 8.7 NOP Sled（NOP 滑道）

**NOP**（`0x90`，No Operation）是一条不做任何事的单字节指令：

```asm
nop   ; 什么都不做，消耗一个时钟周期，IP 移动到下一条指令
```

**NOP Sled**（有时也叫 NOP slide 或 nop 雪橇）是一长串连续的 `nop` 指令：

```
90 90 90 90 90 90 90 90 90 90 ... [真正的 shellcode]
```

### NOP Sled 的用途

#### 用途一：缓冲区溢出攻击

在经典的缓冲区溢出攻击中，攻击者需要把返回地址覆盖为 shellcode 的地址。但由于 ASLR（地址空间布局随机化），精确猜测 shellcode 的地址很难。

**NOP Sled 的作用**：在 shellcode 前面放一大片 `nop`，只需要把返回地址指向这片 nop 中的**任意位置**，CPU 会"滑"过所有的 nop，最终到达 shellcode：

```
栈内容：
┌──────────────────────────────────────────────────┐
│ nop nop nop nop nop nop ... nop │  shellcode   │
│  〈────────────── nop sled ──────〉             │
└──────────────────────────────────────────────────┘
     ↑                              ↑
     │   攻击者只需命中这片区域      │ 真正想执行的代码
     └── 而不需要精确猜到 shellcode 的地址
```

#### 用途二：代码对齐填充

编译器有时在函数之间插入 `nop` 指令，确保下一个函数从 16 字节对齐的地址开始（提升缓存性能）：

```
...f: c3      ret
...0: 90 90   nop; nop   ← 填充，让下一个函数从 0x10 对齐的地址开始
...2: nop
...4: nop
010: 55       push rbp   ← 下一个函数
011: 48 89 e5 mov rbp, rsp
```

#### 用途三：代码补丁（Hot Patching）

在生产系统中，有时需要在**不重启程序**的情况下修改某段代码（热补丁）。提前在函数入口处放几个 `nop`，打补丁时把 nop 替换为跳转指令。

---

## 8.8 `callq *%rax` 在 zpoline 中的作用详解

让我们深入分析 `callq *%rax`（即 `call rax`）这条指令：

### 指令解码

```
FF D0

FF：  Opcode，表示"间接调用/跳转"组
D0：  ModRM 字节
      D0 = 11 010 000
           ↑↑  ↑↑↑  ↑↑↑
           mod reg  r/m
           11  010  000
           寄存器  操作=CALL  寄存器=rax（编号0）
```

`ModRM = 11 010 000`：
- `11`：操作数是寄存器（不是内存）
- `010`：这个 FF 指令的子操作码 2 = CALL（间接调用）
- `000`：寄存器编号 0 = `rax`

所以 `FF D0` = "间接调用 rax 中存储的地址"。

### 为什么 `rax` 刚好是系统调用号

在 syscall 约定中，`rax` 在执行 `syscall` 前就已经被设置为系统调用号。而我们把 `syscall` 替换成了 `call rax`——这时 `rax` 还没有被修改，仍然是系统调用号！

```asm
; 用户代码中的典型系统调用序列：
mov rax, 1    ; rax = 系统调用号（write）
mov rdi, 1    ; 参数
lea rsi, [msg]
mov rdx, 14
syscall       ; ← zpoline 把这里替换为 call rax
              ; 此时 rax = 1，所以 call rax 跳转到地址 1
              ; 地址 1 在 mmap 的蹦床区域内
```

### 蹦床如何知道是哪个系统调用

当蹦床代码被调用时（通过 `call rax`，rax = 1）：
- 这是一个普通的 `call` 指令，把**返回地址**压入了栈
- 蹦床代码可以从**调用时 rax 的值**知道是哪个系统调用
- 但等等——蹦床是被 `call` 进去的，所以它是一个函数调用，蹦床执行完后需要 `ret` 返回，继续执行 `call rax` 之后的用户代码

这意味着蹦床要：
1. 保存所有寄存器（因为系统调用约定规定 `rcx` 和 `r11` 会被破坏，但用户代码可能需要它们）
2. 真正执行 `syscall`（或决定拒绝）
3. 把 `syscall` 的返回值放回 `rax`
4. 恢复其他寄存器
5. `ret`（返回到用户代码）

---

## 8.9 把它们串联起来：从汇编知识到读懂 zpoline 论文

现在你有了足够的背景知识来真正读懂 zpoline 论文中的关键段落。

### 论文原文中的关键句子（配解读）

> "We replace the 2-byte `syscall` instruction with the 2-byte `callq *%rax` instruction."

**解读**：两者都是 2 字节（`syscall`=`0F 05`，`callq *%rax`=`FF D0`），所以替换后不影响周围指令的对齐和地址。

> "The kernel sets the system call number in `%rax` before executing the `syscall` instruction, and our modification causes this to be used as the call target."

**解读**：系统调用约定规定 `rax` = 系统调用号。替换后，`call rax` 以系统调用号作为跳转地址，而这些小数字（0-500以内）都落在 mmap 到地址 0 的蹦床区域内。

> "We allocate an executable page at address 0 containing a trampoline."

**解读**：通常地址 0 是不可访问的（nullptr dereference 的保护）。zpoline 特殊地 mmap 地址 0，把它变成可执行的蹦床代码区。

这段话如果你不理解 `mmap`、地址空间布局、指令编码，根本不知道在说什么。现在你明白了。

---

## 8.10 沙箱技术的汇编知识需求图

```
理解沙箱论文所需的汇编知识

                    ┌──────────────────────────────┐
                    │    zpoline / lazypoline        │
                    │    seccomp-BPF / ptrace        │
                    └──────────────────────────────┘
                                  ↑
            需要理解                │
     ┌──────────────────────────────────────────┐
     │  系统调用：syscall 指令、约定、syscall 号  │ ← 第六章
     │  指令编码：syscall=0F05, callq=FFD0       │ ← 第七章
     │  内存布局：mmap、地址空间               │ ← 第三章
     │  调用约定：rax/rdi/rsi/rdx...           │ ← 第五章
     │  Trampoline：蹦床、间接跳转             │ ← 本章
     │  寄存器：rax 在 syscall 前存调用号       │ ← 第二章
     └──────────────────────────────────────────┘
```

恭喜你！学完本章节，你已经具备了理解系统安全和沙箱领域核心论文的汇编基础。

---

## 8.11 推荐的下一步

### 阅读论文

现在你可以去读本文档 **Papers** 章节中的以下论文，能真正看懂汇编相关的部分：

- **zpoline（USENIX ATC 2023）**：核心技术就是本章介绍的 syscall 替换
- **lazypoline（DSN 2024）**：zpoline 的改进，加入了懒加载机制
- **seccomp-BPF（arXiv 2023）**：另一种系统调用拦截方式，内核层面的 BPF 过滤

### 动手实验

```bash
# 实验1：看你的 Python 程序发起了哪些系统调用
strace python3 -c "print('hello')" 2>&1

# 实验2：编译并反汇编一个简单程序
cat > test.c << 'EOF'
int add(int a, int b) { return a + b; }
int main() { return add(1, 2); }
EOF
gcc -O0 -o test test.c
objdump -d -M intel test

# 实验3：用 gdb 单步追踪函数调用
gdb test
(gdb) break add
(gdb) run
(gdb) stepi
(gdb) info registers

# 实验4：写一个纯汇编程序
# 参考第六章的 hello.asm 例子
```

---

## 小结

- **zpoline** 的核心是把 2 字节的 `syscall`（`0F 05`）替换为同样 2 字节的 `call rax`（`FF D0`），利用系统调用号在 `rax` 中这一事实，把调用重定向到地址 0 处的蹦床代码
- **Trampoline（蹦床）**：无法直接跳转时的中转代码，在安全、动态链接、代码补丁等领域广泛使用
- **lazypoline** 对 zpoline 的改进：懒惰替换策略，处理 JIT 代码等动态场景
- **NOP Sled**：连续的 `nop` 指令，在攻击和代码填充中都有应用
- 系统调用拦截是沙箱技术的核心，而理解拦截机制必须深入到汇编/机器码层面
- 学完本章节，你已经能够读懂 zpoline、lazypoline 等论文中的汇编相关描述

---

## 延伸阅读

- **zpoline 论文**：本文档 Papers 章节 → zpoline (ATC 2023)
- **lazypoline 论文**：本文档 Papers 章节 → lazypoline (DSN 2024)
- **《Hacking: The Art of Exploitation》（Jon Erickson）**：深入讲解缓冲区溢出、shellcode、nop sled
- **Shellcode 数据库（shell-storm.org）**：大量真实的 shellcode 例子，帮助理解汇编攻击技术
- **Intel® 64 Architecture Manual 第 3 卷**：系统编程指南，包含 `syscall`/`sysret` 指令的完整描述
- **Linux 内核源码 `arch/x86/entry/entry_64.S`**：内核的 x86-64 入口汇编代码，看 `syscall` 指令进入内核后真正发生了什么
