# 第五章：调用约定（ABI）

> 函数调用看起来很简单，但背后有一套严格的规则——参数怎么传？返回值放哪里？哪些寄存器必须保留？这套规则叫做"调用约定"，也是 ABI（应用程序二进制接口）的核心。

## 5.1 什么是调用约定，为什么需要它

想象一个场景：你写了一个函数 `add(a, b)`，你的朋友要调用它。问题来了：

- `a` 和 `b` 放在哪里传给你？放在寄存器里？哪个寄存器？还是放在栈上？
- 你的计算结果放在哪里返回给调用者？
- 你可以随意修改 `rax`、`rbx` 的值吗？还是调用者期望某些寄存器的值不被破坏？

如果每个人都有自己的规则，两段代码就无法互相调用。**调用约定**（Calling Convention）就是这套共同遵守的规则。

**调用约定**定义了：
1. **参数如何传递**：哪些寄存器用于传递参数？超出的参数怎么处理？
2. **返回值放在哪里**：哪个寄存器存放函数的返回值？
3. **哪些寄存器必须保留**：函数返回后，哪些寄存器的值必须与调用前相同？
4. **栈的维护责任**：谁负责清理栈上的参数？

**ABI**（Application Binary Interface，应用程序二进制接口）是比调用约定更广泛的概念，还包括数据类型大小、内存对齐要求、系统调用约定等。

---

## 5.2 如果没有调用约定会怎样

来看一个"无规则世界"的混乱例子：

```c
// 假设 add 函数的作者约定：参数放在 rbx 和 rcx，结果放在 rdx
// 但 main 的作者不知道这个约定，按自己的理解调用

// add 函数作者的实现：
// 取 rbx 和 rcx，结果放 rdx

// main 作者的调用：
// 参数放到 rdi 和 rsi（因为他以为应该这样），从 rax 取结果
// 结果：add 读到的是垃圾值，返回值也放在了 main 不会看的地方
```

混乱！所以需要一个所有人都遵守的标准。

在 Linux x86-64 下，这个标准是 **System V AMD64 ABI**（通常简称 "System V ABI" 或 "x86-64 Linux ABI"）。

---

## 5.3 System V AMD64 ABI：参数传递

### 整数/指针参数（按顺序传递）

| 参数位置 | 寄存器 |
|---------|--------|
| 第 1 个 | `rdi`  |
| 第 2 个 | `rsi`  |
| 第 3 个 | `rdx`  |
| 第 4 个 | `rcx`  |
| 第 5 个 | `r8`   |
| 第 6 个 | `r9`   |
| 第 7 个及以后 | 从右到左压入栈 |

助记口诀：**"老地鼠挖红色八九洞"** → rdi, rsi, rdx, rcx, r8, r9

（或者英文助记：**"Dungeons, Somewhere, Deep, Contains, R8, R9"**）

### 浮点参数

浮点数/SIMD 参数依次使用 `xmm0` 到 `xmm7`（8个），超出的压栈。

### 返回值

| 返回类型 | 寄存器 |
|---------|--------|
| 整数/指针（≤64位）| `rax` |
| 整数（>64位，≤128位）| `rdx:rax`（高位在 rdx）|
| 浮点数 | `xmm0` |
| 结构体（小的）| `rax` + `rdx` |
| 结构体（大的）| 调用者在栈上准备空间，rdi传入地址 |

---

## 5.4 调用者保存 vs 被调用者保存寄存器

这是调用约定中最容易混淆的概念。我们用一个比喻来解释：

想象你借用朋友的房间写作业（调用一个函数）。有两种可能：
- **你必须在离开前把房间恢复原样**（被调用者保存）：你（被调用的函数）有责任在返回前恢复这些寄存器
- **你进去之前自己先记下东西放哪了**（调用者保存）：你（调用函数的人）需要在调用前自己保存这些寄存器的值

### 被调用者保存寄存器（Callee-Saved Registers）

函数**必须**在返回前恢复这些寄存器的值（如果用了就要先保存、后恢复）：

`rbx`, `rbp`, `r12`, `r13`, `r14`, `r15`

**助记**：这些寄存器调用前后值保持不变，调用者可以"放心存数据"。

### 调用者保存寄存器（Caller-Saved Registers）

函数**可能会修改**这些寄存器，调用者不能期望它们被保留：

`rax`, `rcx`, `rdx`, `rsi`, `rdi`, `r8`, `r9`, `r10`, `r11`

**助记**：这些寄存器在调用后**可能已经被改了**，调用者需要自己事先保存。

### 两种类型对比

```
调用者保存（Caller-Saved）        被调用者保存（Callee-Saved）
─────────────────────────        ────────────────────────────
rax（返回值，必然被改）            rbx
rcx（第4参数）                    rbp（帧指针）
rdx（第3参数）                    r12
rsi（第2参数）                    r13
rdi（第1参数）                    r14
r8（第5参数）                     r15
r9（第6参数）
r10（临时）
r11（临时，syscall 破坏）
```

### 直觉

- **参数寄存器**（rdi/rsi/rdx/rcx/r8/r9）都是调用者保存的——函数当然会"消耗"参数，不需要保留
- **返回值寄存器**（rax）也是调用者保存的——调用后你从这里读返回值，函数自然会改它
- **`rbx`, `r12-r15`** 是被调用者保存的——它们是"安全"的临时寄存器，编译器喜欢把重要数据存这里

---

## 5.5 完整演示：`int add(int a, int b)`

让我们完整追踪 `main` 调用 `add(3, 4)` 的全过程。

### C 代码

```c
int add(int a, int b) {
    return a + b;
}

int main() {
    int x = add(3, 4);
    printf("%d\n", x);
    return 0;
}
```

### `main` 的汇编（调用者视角）

```asm
main:
    push    rbp
    mov     rbp, rsp
    sub     rsp, 16           ; 为局部变量分配空间
    
    ; 准备调用 add(3, 4)
    mov     edi, 3            ; 第1个参数 a = 3，放入 edi（rdi 的低32位）
    mov     esi, 4            ; 第2个参数 b = 4，放入 esi（rsi 的低32位）
    call    add               ; 调用 add
    ; 调用返回后，返回值在 eax 中
    
    mov     DWORD PTR [rbp-4], eax  ; int x = 返回值
    
    ; 调用 printf("%d\n", x)
    mov     esi, DWORD PTR [rbp-4]  ; 第2个参数 x
    lea     rdi, [rip + fmt_str]    ; 第1个参数：格式字符串的地址
    mov     eax, 0                  ; xmm 参数数量（浮点参数个数，这里0个）
    call    printf
    
    mov     eax, 0            ; return 0
    leave
    ret
```

### `add` 的汇编（被调用者视角）

```asm
add:
    push    rbp               ; 保存调用者的 rbp（被调用者保存！）
    mov     rbp, rsp
    
    ; 参数在 edi（a）和 esi（b）中
    mov     DWORD PTR [rbp-4], edi   ; 把参数 a 存入局部变量（-O0 风格）
    mov     DWORD PTR [rbp-8], esi   ; 把参数 b 存入局部变量
    
    ; return a + b
    mov     eax, DWORD PTR [rbp-4]  ; eax = a
    add     eax, DWORD PTR [rbp-8]  ; eax = a + b
    ; 返回值在 eax 中
    
    pop     rbp               ; 恢复调用者的 rbp（被调用者保存的职责！）
    ret
```

开启 `-O2` 优化后，`add` 会被简化为：

```asm
add:
    ; 优化版本：直接使用参数寄存器，不需要栈
    lea     eax, [edi + esi]  ; eax = a + b（一条指令！）
    ret
```

或者更简单：

```asm
add:
    mov     eax, edi          ; eax = a
    add     eax, esi          ; eax += b
    ret
```

---

## 5.6 超过 6 个参数怎么办？

当函数有超过 6 个整数参数时，多余的参数**从右到左**压入栈：

```c
int many_args(int a, int b, int c, int d, int e, int f, int g, int h) {
    return a + b + c + d + e + f + g + h;
}

// 调用：many_args(1, 2, 3, 4, 5, 6, 7, 8)
```

调用方的汇编：

```asm
    ; 前6个参数用寄存器
    mov edi, 1    ; a
    mov esi, 2    ; b
    mov edx, 3    ; c
    mov ecx, 4    ; d
    mov r8d, 5    ; e
    mov r9d, 6    ; f
    
    ; 第7、8个参数压栈（从右到左）
    push 8        ; h（第8个）先压
    push 7        ; g（第7个）后压
    
    call many_args
    
    add rsp, 16   ; 调用后清理栈上的2个参数（调用者负责）
```

在函数内，栈上的参数可通过 `rbp + 偏移` 访问：

```asm
many_args:
    push rbp
    mov  rbp, rsp
    
    ; 寄存器参数：edi=a, esi=b, edx=c, ecx=d, r8d=e, r9d=f
    ; 栈上参数：
    ; [rbp+16] = g（第7个，在返回地址和旧rbp之上）
    ; [rbp+24] = h（第8个）
    ; （[rbp+0]=旧rbp, [rbp+8]=返回地址）
```

注意：栈上参数的访问地址 = `rbp + 16 + (n-7)*8`（n 是参数的序号，从 1 开始）。

---

## 5.7 一个使用被调用者保存寄存器的例子

有时候函数需要在调用其他函数后仍然保留某些值。这时就需要用到被调用者保存寄存器：

```c
long compute(long x, long y) {
    long a = helper1(x);   // 调用 helper1 后，rdi/rsi 可能被改
    long b = helper2(y);   // 调用 helper2 后，rdi/rsi 又被改
    return a + b;
}
```

如果 `a` 只存在 `rax` 中（调用者保存），调用 `helper2` 后 `rax` 就被覆盖了！

解决方案：把 `a` 存入被调用者保存的寄存器（如 `rbx`）：

```asm
compute:
    push    rbp
    mov     rbp, rsp
    push    rbx             ; 保存 rbx（因为我们要用它，但它是被调用者保存的）
    push    r12             ; 保存 r12（同理）
    
    mov     r12, rsi        ; 保存 y（rdi 被第一次调用用掉了）
    
    ; 调用 helper1(x)
    ; rdi 已经是 x，不需要额外设置
    call    helper1
    mov     rbx, rax        ; 保存 a = 返回值（rbx 不会被 helper2 破坏！）
    
    ; 调用 helper2(y)
    mov     rdi, r12        ; 第1个参数 = y
    call    helper2
    ; rax = b
    
    add     rax, rbx        ; rax = a + b（rbx 的值还在！）
    
    pop     r12             ; 恢复 r12
    pop     rbx             ; 恢复 rbx（我们保存了它，必须恢复）
    pop     rbp
    ret
```

这就是为什么 `rbx`、`r12-r15` 被设计为被调用者保存的——它们是"跨函数调用"的安全暂存器。

---

## 5.8 为什么调用约定对理解系统调用很重要

**系统调用也是一种"函数调用"**，只不过目标是内核而不是用户空间的函数。

Linux x86-64 的系统调用约定与 System V ABI **非常相似但有区别**：

| 项目 | System V ABI（函数调用）| Linux syscall 约定 |
|------|----------------------|-------------------|
| 调用指令 | `call` | `syscall` |
| 功能号 | 函数地址（由链接器确定）| `rax`（系统调用号） |
| 第1参数 | `rdi` | `rdi` |
| 第2参数 | `rsi` | `rsi` |
| 第3参数 | `rdx` | `rdx` |
| 第4参数 | `rcx` | `r10`（注意！不是 rcx）|
| 第5参数 | `r8` | `r8` |
| 第6参数 | `r9` | `r9` |
| 返回值 | `rax` | `rax` |
| 破坏的寄存器 | 调用者保存的那些 | `rcx`, `r11`（内核用）|

关键区别：
- **第 4 个参数用 `r10` 而不是 `rcx`**：这是因为 `syscall` 指令本身会把返回地址存在 `rcx`，所以 `rcx` 不能用来传参数
- **`syscall` 会破坏 `rcx` 和 `r11`**：内核用这两个寄存器保存用户态的 `rip`（返回地址）和 `rflags`

我们在下一章会用汇编写完整的系统调用例子。

---

## 5.9 调用约定总结图

```
调用 foo(a, b, c, d, e, f, g, h) 的完整流程：

调用前（调用者负责）：
  1. 把第 7、8 个参数压栈（从右到左：先 h，后 g）
  2. rdi = a, rsi = b, rdx = c, rcx = d, r8 = e, r9 = f
  3. 如果调用后还要用 rax/rcx/rdx/rsi/rdi/r8/r9/r10/r11，先保存它们
  4. call foo

函数内（被调用者负责）：
  1. push rbp; mov rbp, rsp（建立栈帧）
  2. 如果要用 rbx/r12-r15，先保存它们
  3. 执行函数体
  4. 把返回值放入 rax
  5. 恢复之前保存的 rbx/r12-r15
  6. pop rbp; ret

调用后（调用者负责）：
  1. 如果有栈上的参数，add rsp, n*8 清理
  2. 从 rax 读取返回值
```

---

## 小结

- **调用约定**是调用者和被调用者之间的协议，规定参数传递方式、返回值位置、寄存器保存责任
- **System V AMD64 ABI**（Linux/macOS x86-64）：前6个参数用 rdi/rsi/rdx/rcx/r8/r9，返回值在 rax
- **被调用者保存**（Callee-Saved）：`rbx`, `rbp`, `r12-r15`——函数必须在返回前恢复它们
- **调用者保存**（Caller-Saved）：参数寄存器和 rax/r10/r11——函数可以随意修改，调用者不能依赖它们
- **系统调用约定**与 ABI 类似，但第4个参数用 `r10`，功能号放在 `rax`
- 理解调用约定是读懂函数交互汇编代码的关键

---

## 延伸阅读

- **System V AMD64 ABI 规范**：搜索 "System V AMD64 ABI" 找到官方 PDF（psABI-x86_64.pdf）
- **CSAPP 第 3.7 节**：调用约定和栈帧的详细讲解
- **Godbolt**：编译带函数调用的 C 代码，观察参数如何被放入寄存器
- **Windows x64 调用约定**：与 System V ABI 不同（用 rcx/rdx/r8/r9 而不是 rdi/rsi/rdx/rcx），如果你也接触 Windows 开发需要了解
