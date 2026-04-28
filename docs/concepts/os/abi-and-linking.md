# ABI、链接与动态库

> 程序与程序之间是如何"说话"的？函数调用跨越了库的边界，变量名怎么变成了内存地址，LD_PRELOAD 为什么能劫持函数调用——这些都涉及 ABI、链接器和动态库的工作机制。

## 前置知识

- 了解 CPU 寄存器和函数调用的基本概念
- 知道 ELF 文件格式（代码段、数据段等）
- 了解虚拟内存的基本概念

## 你将学到

- ABI（应用二进制接口）是什么，为什么重要
- 静态链接与动态链接的区别和权衡
- PLT/GOT：动态链接的"蹦床"机制
- LD_PRELOAD 劫持的原理和限制
- 符号（symbol）是什么，nm/objdump 怎么查看

---

## 1. ABI：程序间的"合同"

### API vs ABI

你可能熟悉 **API**（Application Programming Interface），比如"调用 `open(path, flags)` 打开文件"。API 是源代码层面的约定。

**ABI**（Application Binary Interface，应用二进制接口）是更底层的约定：在机器码层面，函数调用是如何进行的？

> 💡 **ABI 规定了**：
> - 函数参数用哪些寄存器传递
> - 返回值放在哪个寄存器
> - 调用者/被调用者各自需要保存哪些寄存器
> - 栈如何对齐
> - 数据结构在内存中如何排列

**类比**：API 是"公司官方文件说可以打这个电话号码办事"，ABI 是"电话要怎么拨、要按什么键、什么格式说话"。两者都是约定，但层次不同。

### x86-64 System V AMD64 ABI（Linux 的函数调用约定）

这是 Linux x86-64 上 C 程序使用的标准 ABI：

```
函数参数传递（整数/指针类型，按顺序）：
  第 1 个参数 → RDI
  第 2 个参数 → RSI
  第 3 个参数 → RDX
  第 4 个参数 → RCX
  第 5 个参数 → R8
  第 6 个参数 → R9
  第 7 个及以后 → 通过栈传递（从右到左压栈）

返回值：
  64位整数/指针 → RAX
  128位值     → RAX（低64位）+ RDX（高64位）
  浮点数      → XMM0

调用者保存的寄存器（caller-saved，可被被调用函数随意修改）：
  RAX, RCX, RDX, RSI, RDI, R8, R9, R10, R11

被调用者保存的寄存器（callee-saved，函数返回前必须恢复）：
  RBX, RBP, R12, R13, R14, R15

栈对齐：
  调用 CALL 指令前，RSP 必须是 16 字节对齐的
```

### 为什么 ABI 稳定性很重要

如果 ABI 改变（比如"以后用 RBX 传第一个参数而不是 RDI"），那么所有已编译的库（.so 文件）都需要重新编译——因为它们假设了特定的调用约定。

Linux 的 C 语言 ABI 非常稳定，20 年来基本没变过。这意味着你今天编译的程序可以链接到 10 年前编译的 libc.so，完全兼容。

---

## 2. 静态链接 vs 动态链接

当你的程序调用 `printf`，这段代码在哪里？是打包进你的可执行文件，还是在一个单独的 `.so` 文件里？

### 静态链接（Static Linking）

链接器（`ld`）把所有用到的库代码直接**复制**进可执行文件：

```
静态链接的可执行文件：

┌─────────────────────────────────────────────┐
│           my_app（静态链接）                  │
│                                             │
│  .text:                                     │
│  ┌─────────────────────────────────┐        │
│  │ main() 的机器码                  │        │
│  ├─────────────────────────────────┤        │
│  │ printf() 的机器码（从 libc 复制）│        │
│  ├─────────────────────────────────┤        │
│  │ malloc() 的机器码（从 libc 复制）│        │
│  ├─────────────────────────────────┤        │
│  │ … 其他用到的函数 …               │        │
│  └─────────────────────────────────┘        │
│                                             │
│  文件大小：大（包含所有依赖的代码）            │
│  运行时：完全独立，不依赖任何外部 .so          │
└─────────────────────────────────────────────┘
```

**优点**：
- 运行时无依赖，一个文件搞定一切
- 不受系统库版本影响（"它在我机器上能跑"）
- 启动稍快（不需要加载动态库）

**缺点**：
- 文件体积大
- 100 个静态链接的程序，内存里有 100 份 printf 的代码
- 库有安全补丁时，所有程序都需要重新编译

Go 程序默认静态链接，这就是为什么一个 "Hello World" Go 程序可能有几 MB 大。

### 动态链接（Dynamic Linking）

可执行文件只包含"我需要 `printf`，它在 `libc.so.6` 里"这样的引用，不包含实际代码：

```
动态链接的可执行文件 + 共享库：

my_app（动态链接，只有 50KB）    /lib/libc.so.6（10MB）
┌────────────────────┐           ┌───────────────────────┐
│ .text:             │           │ .text:                │
│   main() 的代码    │   运行时   │   printf() 的实现     │
│   [需要 printf]    │ ─────────►│   malloc() 的实现     │
│   [需要 malloc]    │  动态链接  │   很多其他函数...      │
│                    │           │                       │
│ .dynamic:          │           │ 1000 个程序共享一份！  │
│   需要 libc.so.6   │           └───────────────────────┘
│   printf @ offset? │
└────────────────────┘
```

运行时，**动态链接器**（`/lib64/ld-linux-x86-64.so.2`，也叫 `ld.so`）负责：
1. 读取 ELF 的 `.dynamic` 节，找出所有依赖的 `.so` 文件
2. 用 `mmap` 把这些 `.so` 文件加载到进程的地址空间
3. 解析所有符号引用（`printf` 在哪个地址？）
4. 填入跳转地址（修补 GOT 表）

这一切发生在 `main()` 被调用之前，用户程序不感知。

---

## 3. PLT/GOT：动态链接的蹦床机制

动态链接有一个难题：`.so` 文件被加载到进程地址空间的什么位置，编译时不知道（每次可能都不同，因为 ASLR）。所以 `printf` 的实际地址，直到运行时才确定。

**PLT/GOT** 是解决这个问题的机制：

> 💡 **PLT**（Procedure Linkage Table，过程链接表）：一个间接跳转表，每个需要动态链接的函数对应一个条目（一段小型代码，称为"蹦床"）。
>
> 💡 **GOT**（Global Offset Table，全局偏移表）：一个指针数组，存储动态链接函数的实际运行时地址。

```
你的代码调用 printf：

my_app 中：
   call printf          实际上是：
                             │
                             ▼
                    PLT 中的 printf@plt（蹦床）：
                         jmp *[printf@GOT]  ← 间接跳转
                             │
                  第一次调用：│ GOT 里还没有真实地址
                             ▼
                    动态链接器（惰性绑定）
                         找到 libc.so 中 printf 的真实地址
                         把地址写入 printf@GOT
                             │
                  以后调用：  │ GOT 里已有地址
                             ▼
                    直接跳转到 libc.so 中的 printf
```

```
内存布局示意：

my_app 的地址空间                    libc.so 的地址空间
───────────────────                  ──────────────────
.text:                               .text:
  call printf@plt          ┌────────►  printf() 实现
                           │
.plt:                      │
  printf@plt:              │
    jmp *[GOT+offset]  ────┘
                        ↑
.got.plt:               │
  printf 的地址 ─────────┘
  (第一次调用前是指向 ld.so 的地址，
   第一次调用后变为 printf 真实地址)
```

这个机制叫**惰性绑定**（Lazy Binding）：函数地址在第一次被调用时才解析，而不是程序启动时全部解析，加快了启动时间。

可以用 `LD_BIND_NOW=1` 环境变量强制启动时全量绑定，或用 `-z now` 链接选项。

---

## 4. LD_PRELOAD 劫持：函数拦截的利器

**LD_PRELOAD** 是一个环境变量，告诉动态链接器在加载任何其他库之前先加载指定的 `.so` 文件。如果你的 `.so` 里有和 libc 同名的函数，你的版本会**覆盖** libc 的版本。

### 示例：劫持 malloc 统计分配次数

```c
// my_malloc.c
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>

static int malloc_count = 0;

void *malloc(size_t size) {
    malloc_count++;

    // 调用真正的 malloc（通过 RTLD_NEXT 查找下一个同名函数）
    void *(*real_malloc)(size_t) = dlsym(RTLD_NEXT, "malloc");
    return real_malloc(size);
}

// 在 atexit 时打印统计
__attribute__((destructor))
void print_stats() {
    fprintf(stderr, "malloc 被调用了 %d 次\n", malloc_count);
}
```

```bash
# 编译为共享库
gcc -shared -fPIC -o my_malloc.so my_malloc.c -ldl

# 用 LD_PRELOAD 注入到任意程序
LD_PRELOAD=./my_malloc.so python3 -c "x = [0]*1000"
# 输出：malloc 被调用了 83 次
```

### LD_PRELOAD 的工作原理

```
程序启动时，ld.so 的加载顺序：

1. LD_PRELOAD 指定的 .so（最高优先级！）
2. 可执行文件 .dynamic 节中列出的 .so
3. /etc/ld.so.cache 中的库
4. 默认库路径（/lib、/usr/lib 等）

符号解析：找到第一个匹配的定义。
→ LD_PRELOAD 的库排在最前面 → 它的函数覆盖了 libc 的函数
```

### LD_PRELOAD 的限制（安全相关）

1. **静态链接程序免疫**：Go/Rust 等静态链接的程序不经过 ld.so，LD_PRELOAD 完全无效。

2. **setuid 程序忽略 LD_PRELOAD**：为防止特权提升攻击，Linux 对 setuid 程序忽略 LD_PRELOAD。

3. **可被绕过**：恶意代码可以直接用汇编发 SYSCALL，完全跳过 libc，LD_PRELOAD 拦截不到。

4. **不能拦截信号处理、内核回调等**：LD_PRELOAD 只能在函数调用级别工作。

这正是 shimmy 不依赖 LD_PRELOAD 的原因——它需要在更底层（机器码/SYSCALL 指令级别）进行拦截。

---

## 5. 符号（Symbol）：名字到地址的映射

### 什么是符号

**符号**（symbol）是 ELF 文件中名字到地址的映射条目。函数名、全局变量名都是符号。

```
ELF 符号表示例：

名字       类型    绑定   地址          大小
─────────────────────────────────────────────────────
main       FUNC    GLOBAL 0x0000000000401060  45
printf     FUNC    GLOBAL (未定义，在 libc 里)
my_var     OBJECT  LOCAL  0x0000000000404010  4
_start     FUNC    GLOBAL 0x0000000000401030  30
```

符号分类：
- **已定义**（defined）：此 ELF 文件里有这个函数/变量的实现
- **未定义**（undefined）：此文件引用了这个符号，但实现在其他 .so 里
- **全局**（GLOBAL）：可以被其他文件引用
- **局部**（LOCAL）：只在本文件内部可见（对应 C 中的 `static`）

### 用 nm 查看符号

`nm` 工具列出 ELF 文件中的符号：

```bash
$ nm /bin/ls | head -20
0000000000006b10 T main          # T = .text（代码）中的全局符号
                 U printf@GLIBC_2.2.5   # U = 未定义（需要动态链接）
0000000000036090 D completed.0   # D = .data（数据）中的符号
0000000000036098 B optind        # B = .bss（BSS）中的符号

# 常见的符号类型字母：
# T = text（代码）
# D = data（已初始化数据）
# B = BSS（未初始化数据）
# U = undefined（需要外部定义）
# t, d, b = 同上但是 LOCAL（小写 = 局部符号）
```

### 用 objdump 反汇编

`objdump` 可以反汇编 ELF 文件，显示机器码对应的汇编指令：

```bash
# 反汇编 main 函数（AT&T 语法）
$ objdump -d /bin/ls | grep -A 20 "<main>"

# Intel 语法（更易读）
$ objdump -d -M intel /bin/ls | grep -A 20 "<main>"

# 查看动态重定位表（需要动态链接的符号）
$ objdump -R /bin/ls
```

### 用 ldd 查看动态依赖

```bash
# 查看一个程序依赖哪些 .so 文件
$ ldd /bin/ls
        linux-vdso.so.1 (0x00007ffd8c7fe000)
        libselinux.so.1 => /lib/x86_64-linux-gnu/libselinux.so.1
        libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6
        /lib64/ld-linux-x86-64.so.2

# Go 程序（静态链接）：
$ ldd ./hello-go
        not a dynamic executable     # ← 静态链接，无依赖！
```

---

## 6. 链接过程全景

从源代码到运行，链接经历的步骤：

```
源代码文件：
  main.c     ──► main.o
  util.c     ──► util.o

静态链接阶段（ld）：
  main.o + util.o + libc.a（如果静态链接）
  ──► 解析符号引用（main.o 里的 printf 引用 → libc.a 里的定义）
  ──► 合并各节（.text + .text → 一个大 .text）
  ──► 重定位（为每个符号分配最终地址）
  ──► 生成可执行文件 my_app

运行时（ld.so，动态链接器）：
  读取 my_app 的 .dynamic 节 → 找出依赖的 .so
  mmap 加载 libc.so.6 到地址空间的某个位置（ASLR！）
  填充 GOT 表（把 printf 的运行时地址填入 GOT）
  调用初始化函数（.init_array 里的函数）
  跳转到 _start → main()
```

---

## 小结

```
ABI：
  机器码层面的调用约定（用哪些寄存器传参数、返回值）
  x86-64 Linux: RDI, RSI, RDX, RCX, R8, R9 传参，RAX 返回

链接：
  静态链接：把库代码复制进可执行文件（大、独立）
  动态链接：运行时由 ld.so 加载 .so 文件（小、依赖系统库）

PLT/GOT（蹦床机制）：
  动态链接函数调用 → PLT（蹦床）→ GOT（实际地址）
  第一次调用时惰性绑定实际地址

LD_PRELOAD：
  在所有库之前加载自定义 .so，覆盖同名函数
  局限：只对动态链接程序有效，可被直接 SYSCALL 绕过

符号工具：
  nm      → 查看符号表
  objdump → 反汇编、查看各节内容
  ldd     → 查看动态库依赖
  readelf → 查看 ELF 头和节表
```

**核心要点**：
1. ABI 是机器码层面的约定，比 API 更底层，稳定性决定兼容性
2. 动态链接通过 PLT/GOT 间接跳转实现运行时符号解析
3. LD_PRELOAD 可以劫持函数调用，但只对动态链接程序有效
4. 静态链接（Go/Rust）完全绕过 LD_PRELOAD 拦截
5. nm/objdump 是逆向工程和调试的基础工具

## 与沙箱技术的联系

理解 ABI 和链接，直接解释了 shimmy 面对的一个核心挑战：

**为什么 LD_PRELOAD 沙箱不够用？**

很多早期沙箱方案用 LD_PRELOAD 拦截 `open()`、`execve()` 等危险函数。这对动态链接的 Python/Node.js 程序有效，但对 Go 等静态链接语言完全失效——go 程序不用 libc，直接用汇编发 SYSCALL 指令。

**为什么 PLT/GOT 可以被利用**：

二进制插桩工具（包括 DynamoRIO）理解 ELF 的 PLT/GOT 结构，在分析代码时会识别通过 PLT 的间接调用并正确处理，确保插桩代码不会干扰动态链接机制。

shimmy 的设计选择是在 **SYSCALL 指令** 这一层拦截——这比 LD_PRELOAD 更底层，比 ptrace 更轻量，能同时处理静态链接和动态链接的程序。
