# 第四章：基本指令

> 汇编指令是汇编语言的"词汇"。本章系统介绍 x86-64 最常用的指令，每条指令都配有等价的 C 代码和具体例子，帮助你建立从 C 代码到汇编的映射直觉。

## 4.1 指令格式

x86-64 汇编指令的基本格式：

```
操作码  目标操作数,  源操作数
```

例如：
```asm
mov  rax, 42    ; 把立即数 42 放入 rax（目标 ← 源）
add  rax, rbx   ; rax = rax + rbx（目标 ← 目标 + 源）
```

> **Intel 语法 vs AT&T 语法**：本章使用 Intel 语法（目标在左，源在右）。Linux 默认工具（如 `as`、`objdump`）使用 AT&T 语法（源在左，目标在右）。两种语法我们在第七章详细对比。

### 操作数的三种类型

| 类型 | 写法示例 | 含义 |
|------|---------|------|
| 立即数（Immediate）| `42`, `0xFF`, `-1` | 常量数字，直接写在指令里 |
| 寄存器（Register）| `rax`, `ebx`, `cl` | 寄存器中的值 |
| 内存（Memory）| `[rax]`, `[rbp-8]`, `[rax+rcx*4]` | 内存地址处的值 |

内存寻址格式：`[基址寄存器 + 变址寄存器*比例因子 + 位移]`，可以灵活组合：

```asm
[rbp - 8]           ; rbp - 8 处的内存（局部变量）
[rax]               ; rax 存储的地址处的内存（指针解引用）
[rax + rcx*4]       ; 数组访问：rax + rcx*4 处（int 数组，每元素4字节）
[rip + 0x100]       ; 相对于当前指令地址的位移（常用于全局变量）
```

等价的 C 代码对照：
```c
*(int *)(rbp - 8)      // [rbp-8]
*rax                   // [rax]
rax[rcx]               // [rax + rcx*4]（如果 rax 是 int 数组）
```

---

## 4.2 数据移动指令

### `mov`：移动数据

`mov` 是汇编中最常用的指令。它把一个值**复制**到目标（不是"移动"，原值不变）。

```asm
; 语法：mov 目标, 源

mov rax, 42          ; rax = 42
mov rbx, rax         ; rbx = rax（复制寄存器值）
mov rax, [rbp-8]     ; rax = 内存地址 (rbp-8) 处的值（读内存）
mov [rbp-8], rax     ; 内存地址 (rbp-8) = rax（写内存）
mov rax, [rbx+rcx*8] ; rax = 内存地址 (rbx + rcx*8) 处的值
```

等价 C 代码：
```c
rax = 42;
rbx = rax;
rax = *((long *)(rbp - 8));  // 读内存
*((long *)(rbp - 8)) = rax;  // 写内存
rax = arr[rcx];               // 数组访问
```

**限制**：`mov` 不能直接内存到内存（必须经过寄存器中转）：
```asm
; 错误（x86-64 不允许）：
; mov [addr1], [addr2]

; 正确：
mov rax, [addr2]
mov [addr1], rax
```

### 带符号/零扩展的 `mov`

当把小尺寸值放入大尺寸寄存器时，需要扩展高位：

```asm
; movzx：零扩展（高位填0，用于无符号数）
movzx rax, al        ; rax = al（零扩展到64位）
movzx eax, BYTE PTR [rbx]  ; eax = *rbx（读1字节，零扩展到32位）

; movsx：符号扩展（高位填符号位，用于有符号数）
movsx rax, eax       ; rax = eax（符号扩展到64位）
movsx eax, BYTE PTR [rbx]  ; eax = *(char *)rbx（读1字节，符号扩展）
```

等价 C 代码：
```c
unsigned char c = *rbx;
unsigned long rax = c;   // movzx：隐式零扩展

signed char sc = *rbx;
long rax = sc;           // movsx：隐式符号扩展
```

### `lea`：加载有效地址（Load Effective Address）

`lea` 计算一个地址表达式的值，但**不访问内存**，只把计算结果放入寄存器。

```asm
lea rax, [rbp-8]      ; rax = rbp - 8（地址本身，不读内存）
lea rax, [rbx+rcx*4]  ; rax = rbx + rcx*4（计算数组元素地址）
lea rax, [rax*3]      ; rax = rax * 3（利用 lea 做乘法！）
lea rax, [rax+rax*2]  ; rax = rax * 3（另一种写法）
```

等价 C 代码：
```c
rax = (long *)(rbp - 8);    // 取地址（指针运算）
rax = &arr[rcx];             // 数组元素地址
rax = rax * 3;               // lea 常被编译器用来做快速乘法
```

**`lea` 常见用途**：
1. 计算局部变量的地址（`&x`）
2. 编译器用来做 2-9 倍的快速乘法（因为 `imul` 更慢）
3. 同时做加法和乘法（用地址计算语法来做算术）

---

## 4.3 算术指令

### `add`：加法

```asm
; 语法：add 目标, 源   （目标 = 目标 + 源）

add rax, rbx         ; rax = rax + rbx
add rax, 5           ; rax = rax + 5
add DWORD PTR [rbp-4], 1  ; (*ptr)++ （内存中的值加1）
```

等价 C 代码：
```c
rax += rbx;
rax += 5;
(*ptr)++;
```

`add` 会更新 `rflags`：如果结果为零，`ZF=1`；如果产生进位，`CF=1`；如果有符号溢出，`OF=1`。

### `sub`：减法

```asm
; 语法：sub 目标, 源   （目标 = 目标 - 源）

sub rax, rbx         ; rax = rax - rbx
sub rsp, 16          ; rsp -= 16（为局部变量分配栈空间）
```

等价 C 代码：
```c
rax -= rbx;
// sub rsp, 16 就是在栈上"分配"16字节空间
```

### `inc` 和 `dec`：自增/自减

```asm
inc rax    ; rax++
dec rcx    ; rcx--
```

等价 C 代码：
```c
rax++;
rcx--;
```

### `imul`：有符号乘法

```asm
; 两操作数形式：目标 = 目标 * 源
imul rax, rbx        ; rax = rax * rbx
imul rax, rbx, 5     ; rax = rbx * 5（三操作数）

; 一操作数形式（结果放在 rdx:rax）
imul rbx             ; rdx:rax = rax * rbx（128位结果）
```

等价 C 代码：
```c
rax *= rbx;
rax = rbx * 5;
// __int128 result = (__int128)rax * rbx; 对应一操作数形式
```

### `idiv`：有符号除法

```asm
; 除法前，被除数必须放在 rdx:rax（128位）
; 通常先用 cqo 把 rax 符号扩展到 rdx:rax
cqo                  ; 把 rax 符号扩展到 rdx:rax（rdx = rax 的符号位扩展）
idiv rbx             ; rax = rdx:rax / rbx（商）
                     ; rdx = rdx:rax % rbx（余数）
```

等价 C 代码：
```c
long quotient  = rax / rbx;  // 结果在 rax
long remainder = rax % rbx;  // 余数在 rdx
```

### `neg`：取负

```asm
neg rax    ; rax = -rax
```

等价 C 代码：
```c
rax = -rax;
```

---

## 4.4 位运算指令

### `and`：按位与

```asm
and rax, rbx         ; rax = rax & rbx
and rax, 0xFF        ; rax = rax & 0xFF（只保留低8位）
and rax, 0xFFFFFFF0  ; 清除低4位（对齐操作）
```

等价 C 代码：
```c
rax &= rbx;
rax &= 0xFF;
rax &= ~0xF;  // 清除低4位
```

**常见用途**：提取某些位、对齐地址（如 `and rsp, -16` 让 rsp 对齐到 16 字节边界）。

### `or`：按位或

```asm
or rax, rbx          ; rax = rax | rbx
or rax, 0x1          ; 设置最低位为1
```

等价 C 代码：
```c
rax |= rbx;
rax |= 1;
```

### `xor`：按位异或

```asm
xor rax, rbx         ; rax = rax ^ rbx
xor rax, rax         ; rax = 0（最常见的寄存器清零方式！）
```

**`xor rax, rax` 为什么比 `mov rax, 0` 常见？**  
因为 `xor reg, reg` 的机器码更短（3字节 vs 7字节），且 CPU 对这个模式有专门优化（能识别这是寄存器清零，消除假数据依赖）。这是编译器最喜欢的优化之一。

等价 C 代码：
```c
rax ^= rbx;
rax = 0;
```

### `not`：按位取反

```asm
not rax    ; rax = ~rax
```

等价 C 代码：
```c
rax = ~rax;
```

### `shl` / `shr`：逻辑左移/右移（无符号）

```asm
shl rax, 1       ; rax = rax << 1（左移1位 = 乘以2）
shl rax, 4       ; rax = rax << 4（乘以16）
shl rax, cl      ; rax = rax << cl（移位数在 cl 中）

shr rax, 2       ; rax = rax >> 2（右移2位 = 除以4，高位补0）
```

等价 C 代码：
```c
rax <<= 1;   // 等价于 rax *= 2（对整数）
rax <<= 4;   // 等价于 rax *= 16
rax >>= 2;   // 无符号右移（注意：C 里对有符号数的右移行为是实现定义的）
```

**移位和乘除法的关系**：
- 左移 n 位 = 乘以 2ⁿ
- 逻辑右移 n 位 = 无符号除以 2ⁿ（高位填0）
- 算术右移 n 位 = 有符号除以 2ⁿ（高位填符号位）

### `sar`：算术右移（有符号）

```asm
sar rax, 1   ; 算术右移1位，高位填符号位（用于有符号除以2）
```

等价 C 代码：
```c
rax >>= 1;  // 对 signed long 的右移（符号位保持）
```

---

## 4.5 比较与跳转指令

### `cmp`：比较

`cmp` 执行减法，**只更新标志位，不保存结果**。

```asm
cmp rax, rbx    ; 计算 rax - rbx，更新 ZF/SF/CF/OF，但不改变 rax/rbx
cmp rax, 0      ; 检查 rax 是否为0
```

等价的逻辑（只看效果）：
```c
// 临时计算 rax - rbx，只用来设置标志
// 标志位反映这次"虚拟减法"的结果
```

### `test`：测试

`test` 执行按位与，**只更新标志位，不保存结果**。

```asm
test rax, rax    ; 检查 rax 是否为0（如果是，ZF=1）
test rax, 1      ; 检查 rax 最低位是否为1（奇偶检查）
```

常见用途：
```asm
test rax, rax
jz   is_null     ; if (rax == 0) goto is_null;  (即 if (rax == NULL))
```

### 无条件跳转 `jmp`

```asm
jmp label        ; 无条件跳转到 label
jmp rax          ; 跳转到 rax 中存储的地址（间接跳转）
```

等价 C 代码：
```c
goto label;
// 函数指针调用类似间接跳转
```

### 条件跳转

条件跳转指令检查标志寄存器，决定是否跳转：

| 指令 | 全称 | 条件 | 等价 C（有符号）|
|------|------|------|----------------|
| `je` / `jz` | Jump if Equal / Zero | ZF=1 | `==` |
| `jne` / `jnz` | Jump if Not Equal | ZF=0 | `!=` |
| `jl` / `jnge` | Jump if Less | SF≠OF | `<`（有符号）|
| `jle` / `jng` | Jump if Less or Equal | ZF=1 或 SF≠OF | `<=`（有符号）|
| `jg` / `jnle` | Jump if Greater | ZF=0 且 SF=OF | `>`（有符号）|
| `jge` / `jnl` | Jump if Greater or Equal | SF=OF | `>=`（有符号）|
| `jb` / `jnae` | Jump if Below | CF=1 | `<`（无符号）|
| `jbe` / `jna` | Jump if Below or Equal | CF=1 或 ZF=1 | `<=`（无符号）|
| `ja` / `jnbe` | Jump if Above | CF=0 且 ZF=0 | `>`（无符号）|
| `jae` / `jnb` | Jump if Above or Equal | CF=0 | `>=`（无符号）|
| `js` | Jump if Sign | SF=1 | 结果为负 |
| `jns` | Jump if Not Sign | SF=0 | 结果非负 |

**有符号 vs 无符号跳转**：
- 比较有符号整数（`int`, `long`）后，用 `jl`/`jg`/`jle`/`jge`
- 比较无符号整数（`unsigned int`, 指针）后，用 `jb`/`ja`/`jbe`/`jae`

### 完整的条件判断例子

```c
// C 代码
if (x > 0) {
    result = x * 2;
} else {
    result = -x;
}
```

对应的汇编（假设 x 在 rdi，result 在 rax）：

```asm
    ; 假设 x 在 edi（32位有符号整数）
    cmp  edi, 0          ; 比较 x 和 0
    jle  else_branch     ; if (x <= 0) 跳转到 else
    
    ; then 分支：result = x * 2
    mov  eax, edi        ; eax = x
    imul eax, eax, 2     ; eax = x * 2
    jmp  end_if          ; 跳过 else 分支
    
else_branch:
    ; else 分支：result = -x
    neg  edi             ; edi = -x
    mov  eax, edi        ; eax = -x
    
end_if:
    ; result 在 eax 中
```

---

## 4.6 循环的汇编实现

C 的循环在汇编中就是**条件跳转 + 向前跳**：

### `for` 循环

```c
// C 代码
int sum = 0;
for (int i = 0; i < 10; i++) {
    sum += i;
}
```

对应的汇编：

```asm
    xor  eax, eax        ; sum = 0（eax 用作 sum）
    xor  ecx, ecx        ; i = 0（ecx 用作 i）

loop_start:
    cmp  ecx, 10         ; 比较 i 和 10
    jge  loop_end        ; if (i >= 10) 退出循环

    add  eax, ecx        ; sum += i

    inc  ecx             ; i++
    jmp  loop_start      ; 回到循环开始

loop_end:
    ; sum 在 eax 中
```

### `x86` 专用循环指令 `loop`

x86 有个专用的循环指令（较少见，编译器不常生成）：

```asm
    mov  rcx, 10         ; 循环计数器

loop_start:
    ; 循环体...
    loop loop_start      ; rcx--; if (rcx != 0) jmp loop_start
```

`loop` 隐式使用 `rcx` 作为计数器，每次自减，直到归零。但现代编译器几乎不用它（性能不如 `dec`+`jnz`）。

---

## 4.7 函数调用指令

### `call`：调用函数

```asm
call printf          ; 调用 printf 函数
call rax             ; 调用 rax 中存储的地址的函数（间接调用）
call [rbx]           ; 调用 rbx 指向的地址处存储的函数指针
```

`call` 等价于：
```asm
push rip + 指令长度   ; 把返回地址压栈
jmp  目标地址         ; 跳转到函数
```

### `ret`：从函数返回

```asm
ret     ; 从栈顶弹出地址，跳转（无参数）
ret 16  ; 弹出地址后再把 rsp 加 16（用于清理栈上的参数，Windows 调用约定）
```

`ret` 等价于：
```asm
pop  rip   ; 从栈顶弹出返回地址，跳转
```

---

## 4.8 完整例子：一个简单函数

让我们看一个包含多种指令的完整例子：

### C 代码

```c
// 计算数组中所有元素的和
// arr: 指向 int 数组的指针
// n: 数组长度
long sum_array(int *arr, int n) {
    long sum = 0;
    for (int i = 0; i < n; i++) {
        sum += arr[i];
    }
    return sum;
}
```

### 对应的汇编（`-O0`，未优化）

```asm
sum_array:
    ; 函数序言
    push    rbp
    mov     rbp, rsp
    
    ; 参数：rdi = arr（指针），esi = n
    ; 保存参数到栈上（-O0 风格）
    mov     QWORD PTR [rbp-8],  rdi   ; arr 保存到 [rbp-8]
    mov     DWORD PTR [rbp-12], esi   ; n 保存到 [rbp-12]
    
    ; long sum = 0;
    mov     QWORD PTR [rbp-24], 0     ; sum = 0，[rbp-24] 是 sum
    
    ; int i = 0;
    mov     DWORD PTR [rbp-28], 0     ; i = 0，[rbp-28] 是 i
    
    ; for 循环判断
loop_check:
    mov     eax, DWORD PTR [rbp-28]  ; eax = i
    cmp     eax, DWORD PTR [rbp-12]  ; 比较 i 和 n
    jge     loop_end                  ; if (i >= n) 退出

    ; sum += arr[i]
    mov     rax, QWORD PTR [rbp-8]   ; rax = arr（指针）
    mov     ecx, DWORD PTR [rbp-28]  ; ecx = i
    movsx   rcx, ecx                  ; 把 i 符号扩展为64位
    mov     edx, DWORD PTR [rax+rcx*4] ; edx = arr[i]（每个 int 4字节）
    movsx   rdx, edx                  ; 符号扩展 arr[i] 为64位
    add     QWORD PTR [rbp-24], rdx  ; sum += arr[i]
    
    ; i++
    add     DWORD PTR [rbp-28], 1    ; i++
    jmp     loop_check                ; 回到循环判断

loop_end:
    ; return sum;
    mov     rax, QWORD PTR [rbp-24]  ; 返回值放入 rax
    
    ; 函数尾声
    pop     rbp
    ret
```

这段代码虽然冗长（编译器 `-O0` 时把所有变量都存在栈上），但逻辑清晰，每行对应关系一目了然。

在第七章，我们会看到同样的代码用 `-O2` 优化后，会变得多么精简。

---

## 小结

- **`mov`**：最常用的指令，在寄存器、内存、立即数之间复制数据
- **`lea`**：计算地址但不读内存，常被编译器用于快速乘法和指针计算
- **算术指令**：`add`, `sub`, `imul`, `idiv`, `inc`, `dec`, `neg`
- **位运算**：`and`, `or`, `xor`, `not`, `shl`, `shr`, `sar`；`xor reg, reg` 是清零寄存器的惯用法
- **`cmp` 和 `test`**：执行减法/按位与，只更新标志位，不保存结果
- **条件跳转**：根据标志寄存器决定是否跳转；有符号比较用 `jl`/`jg`，无符号用 `jb`/`ja`
- 汇编中的 `if`、`for`、`while` 全都是"比较 + 条件跳转"的组合

---

## 延伸阅读

- **Intel® 64 and IA-32 Architectures Software Developer's Manual，第2卷**：所有指令的权威参考（内容极多，用来查询）
- **Compiler Explorer（godbolt.org）**：强烈推荐——随便写一段 C，立刻看到对应的汇编
- **CSAPP 第 3.5~3.6 节**：算术运算和控制流的汇编实现
- **x86asm.net/coder32.html**：x86 指令速查表（在线）
