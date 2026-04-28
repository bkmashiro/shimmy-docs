# 第七章：读懂反汇编输出

> 在现实中，你通常没有源代码，只能看机器码或汇编输出。本章教你使用 `objdump` 和 `gdb` 查看汇编，理解 Intel 和 AT&T 两种语法格式，以及识别编译器生成的常见代码模式。

## 7.1 为什么需要读反汇编

### 场景一：分析没有源码的二进制程序

安全研究、逆向工程、恶意软件分析——这些场景下你只有二进制文件。反汇编是看清程序行为的必要工具。

### 场景二：验证编译器做了什么

你以为编译器会优化这段代码，但真的优化了吗？用 `objdump` 确认。

### 场景三：调试底层问题

程序崩溃了，`gdb` 停在了一个奇怪的地址，你需要看当前执行的汇编指令才能理解发生了什么。

### 场景四：理解沙箱/系统安全论文

zpoline、lazypoline 的论文里充满了汇编指令引用。不懂反汇编，就看不懂这些技术细节。

---

## 7.2 Intel 格式 vs AT&T 格式

同一段机器码，可以用两种不同的语法表示。这两种格式的存在常常让初学者困惑。

### 主要区别

| 特征 | Intel 格式 | AT&T 格式 |
|------|-----------|----------|
| 操作数顺序 | `目标, 源`（左边是目标）| `源, 目标`（右边是目标）|
| 寄存器前缀 | 无 | `%`（如 `%rax`）|
| 立即数前缀 | 无 | `$`（如 `$42`）|
| 内存引用 | `[rbp - 4]` | `-4(%rbp)` |
| 指令大小后缀 | 无（或用 DWORD PTR 等）| `q/l/w/b`（如 `movq`）|
| 比例因子 | `[rax + rcx*4]` | `(%rax, %rcx, 4)` |

### 同一条指令的两种写法

```asm
; Intel 格式（NASM、MASM、Godbolt 默认）：
mov rax, 42               ; rax = 42
mov rax, QWORD PTR [rbp-8]; rax = *(rbp-8)（64位读）
add eax, DWORD PTR [rbx]  ; eax += *(int *)rbx
lea rdi, [rip + 0x100]    ; rdi = rip + 0x100

; AT&T 格式（GAS、objdump、gdb 默认）：
movq $42, %rax            ; 注意：源在左，目标在右！
movq -8(%rbp), %rax       ; 内存引用格式不同
addl (%rbx), %eax         ; l 后缀表示 32位（long word）
leaq 0x100(%rip), %rdi    ; q 后缀表示 64位（quadword）
```

### 记忆诀窍

- **Intel**：目标在**左**（和大多数编程语言赋值方向一致，`x = 5`）
- **AT&T**：目标在**右**（和 Unix 管道方向一致，数据从左流向右）

AT&T 格式的大小后缀：
- `b` = byte（8位）
- `w` = word（16位）
- `l` = long（32位）—— 注意 Linux 上 long 是 64 位，但汇编后缀 `l` 是 32 位
- `q` = quadword（64位）

### 切换 objdump 显示格式

```bash
# 默认 AT&T 格式
objdump -d program

# 切换到 Intel 格式（推荐，更易读）
objdump -d -M intel program

# 在 GDB 里切换
(gdb) set disassembly-flavor intel   # 或 att
```

本章后续内容使用 **Intel 格式**（更接近大多数教材）。

---

## 7.3 使用 `objdump` 查看汇编

### 基本用法

```bash
# 编译一个简单的 C 程序
cat > example.c << 'EOF'
#include <stdio.h>

int add(int a, int b) {
    return a + b;
}

int main() {
    int result = add(3, 4);
    printf("%d\n", result);
    return 0;
}
EOF

gcc -O0 -g -o example example.c

# 反汇编整个程序（包含所有 section）
objdump -d -M intel example

# 只看 .text 段（代码段）
objdump -d -M intel --section=.text example

# 显示源代码和汇编对照（需要 -g 编译）
objdump -d -M intel -S example
```

### objdump 输出解读

```
000000000000114d <add>:
    114d:   55                      push   rbp
    114e:   48 89 e5                mov    rbp,rsp
    1151:   89 7d fc                mov    DWORD PTR [rbp-0x4],edi
    1154:   89 75 f8                mov    DWORD PTR [rbp-0x8],esi
    1157:   8b 45 fc                mov    eax,DWORD PTR [rbp-0x4]
    115a:   03 45 f8                add    eax,DWORD PTR [rbp-0x8]
    115d:   5d                      pop    rbp
    115e:   c3                      ret
```

每行格式：
```
地址:   机器码字节（十六进制）          汇编指令
114d:   55                            push   rbp
```

- **地址**（`114d`）：这条指令在进程地址空间中的偏移量
- **机器码**（`55`）：CPU 实际执行的字节序列
- **汇编**（`push rbp`）：机器码的人类可读形式

### 查看特定函数

```bash
# 用 nm 找函数地址
nm example | grep add

# 或者用 grep 过滤 objdump 输出
objdump -d -M intel example | grep -A 20 "<add>"
```

---

## 7.4 使用 GDB 查看汇编

GDB（GNU Debugger）是调试二进制程序的利器，可以在运行时查看汇编和寄存器状态。

### 基本 GDB 调试流程

```bash
# 启动 gdb
gdb ./example

# 在 main 函数设断点
(gdb) break main
# 或用地址：break *0x114d

# 运行程序
(gdb) run

# 查看当前位置的汇编（前/后10条指令）
(gdb) disassemble
(gdb) disassemble /m        # 带源码对照
(gdb) disassemble add       # 反汇编指定函数

# 查看当前 rip 附近的指令
(gdb) x/10i $rip            # 显示 rip 处的 10 条指令

# 单步执行（执行一条汇编指令）
(gdb) stepi    # 或 si
(gdb) nexti    # 或 ni（不进入函数调用）

# 查看所有寄存器
(gdb) info registers
(gdb) info registers rax rbx rcx    # 只看特定寄存器

# 查看栈
(gdb) info stack     # 调用栈
(gdb) x/8gx $rsp     # 显示 rsp 开始的 8 个 8字节值（十六进制）

# 退出
(gdb) quit
```

### GDB 命令速查

```
b main      — 在 main 设断点
b *0x1234   — 在地址设断点
r           — run（运行）
c           — continue（继续）
si          — stepi（单步一条汇编指令，进入函数）
ni          — nexti（单步一条汇编指令，不进入函数）
p $rax      — 打印 rax 的值
p/x $rax    — 以十六进制打印
x/10i $rip  — 显示 rip 处的 10 条指令
info reg    — 显示所有寄存器
bt          — backtrace（调用栈）
q           — quit
```

---

## 7.5 常见编译器生成的汇编模式

掌握以下"模式"，你就能快速读懂大部分编译器生成的汇编。

### 函数序言（Function Prologue）

每个函数开头几乎都是：

```asm
push    rbp           ; 保存调用者的 rbp
mov     rbp, rsp      ; 建立新的栈帧
sub     rsp, 32       ; 为局部变量分配空间（大小是 16 的倍数）
```

有时还会有：
```asm
push    rbx           ; 如果函数要用到 rbx（被调用者保存寄存器）
push    r12           ; 同理
```

### 函数尾声（Function Epilogue）

```asm
pop     rbx           ; 恢复之前保存的寄存器（如果有）
mov     rsp, rbp      ; 恢复 rsp
pop     rbp           ; 恢复 rbp
ret                   ; 返回

; 或者用 leave 指令简化：
leave
ret
```

### 局部变量访问

局部变量通常通过 `rbp` 加负偏移访问：

```asm
; int a = 10;
mov     DWORD PTR [rbp-4], 10     ; a 在 rbp-4

; int b = 20;
mov     DWORD PTR [rbp-8], 20     ; b 在 rbp-8

; int c = a + b;
mov     eax, DWORD PTR [rbp-4]    ; eax = a
add     eax, DWORD PTR [rbp-8]    ; eax += b
mov     DWORD PTR [rbp-12], eax   ; c = eax
```

### `if-else` 结构

```c
if (x > 0) { ... } else { ... }
```

```asm
cmp     DWORD PTR [rbp-4], 0      ; 比较 x 和 0
jle     else_branch               ; if (x <= 0) 跳转到 else
; then 分支
...
jmp     end_if
else_branch:
; else 分支
...
end_if:
```

模式：`cmp` + 条件跳转（跳过 then 分支，去 else） + then 代码 + `jmp`（跳过 else） + else 代码

### `for` 循环

```c
for (int i = 0; i < n; i++) { ... }
```

```asm
; 初始化
mov     DWORD PTR [rbp-4], 0      ; i = 0

; 跳转到条件检查
jmp     loop_check

; 循环体（在条件检查之前）
loop_body:
...
add     DWORD PTR [rbp-4], 1      ; i++

; 条件检查
loop_check:
mov     eax, DWORD PTR [rbp-4]   ; eax = i
cmp     eax, DWORD PTR [rbp-8]   ; 比较 i 和 n
jl      loop_body                 ; if (i < n) 继续循环
; 循环结束，继续
```

### `while` 循环

```c
while (x > 0) { x--; }
```

```asm
loop_top:
cmp     DWORD PTR [rbp-4], 0     ; 比较 x 和 0
jle     loop_end                  ; if (x <= 0) 退出
sub     DWORD PTR [rbp-4], 1     ; x--
jmp     loop_top

loop_end:
```

---

## 7.6 `-O0` vs `-O2`：优化前后的汇编对比

这是理解编译器的绝佳练习。来看同一段 C 代码的两个版本：

### C 代码

```c
int sum(int n) {
    int result = 0;
    for (int i = 1; i <= n; i++) {
        result += i;
    }
    return result;
}
```

### `-O0`（无优化）

```bash
gcc -O0 -S -masm=intel -o sum_O0.s sum.c
```

生成的汇编（精简注释版）：

```asm
sum:
    push    rbp
    mov     rbp, rsp
    
    ; int result = 0;
    mov     DWORD PTR [rbp-4], 0    ; result 在 rbp-4
    
    ; int i = 1;
    mov     DWORD PTR [rbp-8], 1    ; i 在 rbp-8
    jmp     .L2                      ; 跳到循环条件
    
.L3:  ; 循环体
    ; result += i;
    mov     eax, DWORD PTR [rbp-8]  ; eax = i
    add     DWORD PTR [rbp-4], eax  ; result += i
    ; i++
    add     DWORD PTR [rbp-8], 1    ; i++
    
.L2:  ; 循环条件
    ; i <= n
    mov     eax, DWORD PTR [rbp-8]  ; eax = i
    cmp     eax, DWORD PTR [rbp-12] ; 比较 i 和 n（n 在 rbp-12）
    jle     .L3                      ; if (i <= n) 继续

    ; return result;
    mov     eax, DWORD PTR [rbp-4]  ; 返回值 = result
    pop     rbp
    ret
```

特点：
- 每个变量都存在栈上，每次访问都是内存读写
- 非常啰嗦，但逻辑清晰，一一对应源码
- 共约 15 条指令

### `-O2`（标准优化）

```bash
gcc -O2 -S -masm=intel -o sum_O2.s sum.c
```

生成的汇编（精简）：

```asm
sum:
    ; 参数 n 在 edi 中
    test    edi, edi
    jle     .L4              ; if (n <= 0) 返回 0
    
    lea     eax, [rdi-1]     ; eax = n-1
    lea     ecx, [rdi-2]     ; ecx = n-2
    imul    rax, rcx         ; rax = (n-1)*(n-2)
    shr     rax              ; rax /= 2（逻辑右移1位）
    lea     eax, [rax+rdi]   ; eax = n*(n-1)/2 + n
    ret
    
.L4:
    xor     eax, eax         ; return 0
    ret
```

惊不惊喜？编译器发现这个 for 循环其实是**等差数列求和**，直接套公式 `S = n*(n+1)/2`，把整个循环消除了！

（实际 GCC -O2 可能生成略不同的代码，但通常会做大量优化。）

**分析**：
- `lea eax, [rdi-1]` 相当于 `eax = n - 1`，利用 `lea` 做减法
- `imul rax, rcx` 计算 `(n-1)*(n-2)`（中间步骤，具体公式可能有变体）
- `shr rax` 是除以 2
- 最终合并得到 `n*(n+1)/2`

这就是为什么说"看汇编能深入理解编译器行为"。

### 另一个 -O2 优化例子：循环展开

```c
int dot_product(int *a, int *b, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {
        sum += a[i] * b[i];
    }
    return sum;
}
```

`-O2` 下，GCC 可能生成使用 SSE/AVX SIMD 指令的代码：

```asm
; 这里会出现 xmm0, xmm1, ymm0 等 SIMD 寄存器
; 一次处理 4 个或 8 个整数的并行乘加
```

即使你现在还看不懂 SIMD，知道"编译器会做这种优化"本身就是有价值的知识。

---

## 7.7 实战练习：分析一段未知代码

来看一段"神秘的"汇编，不看 C 代码，推断它做了什么：

```asm
mystery:
    xor     eax, eax          ; (1)
    test    edi, edi           ; (2)
    jle     .done              ; (3)
    
.loop:
    add     eax, 1             ; (4)
    sub     edi, 1             ; (5)
    test    edi, edi           ; (6)
    jg      .loop              ; (7)
    
.done:
    ret                        ; (8)
```

逐行分析：
1. `xor eax, eax`：清零 `eax`（等同于 `result = 0`）
2. `test edi, edi`：检查参数 `edi`（第一个参数）是否为 0
3. `jle .done`：如果 `edi <= 0`，跳到结束返回 0
4. `add eax, 1`：`result++`
5. `sub edi, 1`：`edi--`（第一个参数自减）
6. `test edi, edi`：再次检查
7. `jg .loop`：如果 `edi > 0`，继续循环
8. 返回（返回值在 `eax` 中）

结论：这个函数接受一个整数 `n`，如果 `n <= 0` 返回 0，否则从 1 循环加到 n 次，返回 n。等价于：

```c
int mystery(int n) {
    int result = 0;
    if (n <= 0) return 0;
    while (n > 0) {
        result++;
        n--;
    }
    return result;
}
// 等价于：return (n > 0) ? n : 0;
```

其实就是返回 `max(n, 0)`！编译器把一个简单的函数编译成了循环（因为这是 `-O0`），而 `-O2` 可能直接生成 `test/cmovg` 一两行代码。

---

## 7.8 使用 Compiler Explorer（godbolt.org）

Compiler Explorer 是在线工具，实时显示 C/C++/Rust 代码对应的汇编，是学习汇编的神器。

**使用方法**：
1. 访问 [godbolt.org](https://godbolt.org)
2. 左侧输入 C 代码
3. 右侧选择编译器（GCC x86-64）和选项（如 `-O0` 或 `-O2`）
4. 右侧实时显示汇编输出，每行 C 代码与汇编行用颜色对应

**推荐设置**：
- Compiler：`x86-64 gcc (latest)`
- Options：`-O0 -masm=intel` 或 `-O2 -masm=intel`

---

## 小结

- **objdump** 用于查看二进制文件的汇编：`objdump -d -M intel program`
- **gdb** 用于运行时调试：`disassemble`、`stepi`、`info registers`
- **Intel 格式**（目标在左）比 AT&T 格式（目标在右，`%rax`，`$42`）更易读；用 `-M intel` 切换
- 学会识别**函数序言/尾声**、`if-else`、循环等常见模式
- **`-O0` vs `-O2`**：无优化时每个变量都存在栈上；优化后编译器会消除不必要的内存访问甚至消除整个循环
- **Godbolt.org** 是学习"C 到汇编"映射的最佳在线工具

---

## 延伸阅读

- **Compiler Explorer（godbolt.org）**：必须收藏，随手可用
- **`man objdump`**：完整参数说明
- **GDB 官方文档**：https://www.sourceware.org/gdb/documentation/
- **pwndbg 插件**：让 GDB 更好用的扩展，专为安全研究设计
- **IDA Free / Ghidra**：专业的逆向工程工具，Ghidra 免费开源（NSA 开发）
- **CSAPP 第 3 章**：大量 C 代码到汇编的对照分析
