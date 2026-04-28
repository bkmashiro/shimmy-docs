# 动态二进制插桩（DBI）

**前置知识**：了解程序、机器码、系统调用的基本概念（指南第一、二、三章）；知道 CPU 执行指令的基本流程。

**你将学到**：
- 什么是"插桩"：在程序运行时"注入"额外代码是什么意思
- 静态插桩 vs 动态插桩的区别
- 主流 DBI 框架（Pin、DynamoRIO、Valgrind）是如何工作的
- 经典应用：影子栈、污点追踪
- DBI 为什么慢：性能代价的来源
- 在沙箱场景下用 DBI 拦截系统调用的原理和挑战

---

## 1. 什么是插桩

**插桩**（instrumentation）这个词来自测量仪器（instrument）——给程序加上"仪器"，让程序在跑的时候顺带测量、记录或修改自己的行为。

类比：假设你是一个工厂质检员，想检查每条流水线上生产出的每件产品。你有两种方法：

1. **停工改造**：先停下生产线，在每个工位安装摄像头（静态插桩），然后重新开工。
2. **派驻监工**：不停工，派一个监工跟着流水线跑，在产品经过时检查（动态插桩）。

对程序而言：
- **静态插桩**：在程序编译或链接时插入额外代码
- **动态插桩**：程序运行期间，实时在机器码里注入额外逻辑

> 💡 **插桩（Instrumentation）**
> 在程序的某个执行点插入额外代码，以便观察或修改程序的行为。插桩代码可以记录日志、统计性能、检查安全约束等。

## 2. 静态插桩 vs 动态插桩

### 2.1 静态插桩

静态插桩在程序运行之前完成：

```
源代码 / 二进制文件
       │
       ▼
 插桩工具处理
  (修改源代码 / 改写二进制)
       │
       ▼
插桩后的二进制文件
       │
       ▼
    正常运行
（插桩代码已经嵌入）
```

**例子 1：编译器插桩（Coverage 统计）**

```c
// 原始代码
int add(int a, int b) {
    return a + b;
}

// GCC -fprofile-arcs 后的效果（大致）：
int add(int a, int b) {
    __gcov_arc_count[0]++;  // ← 编译器自动插入的计数器
    return a + b;
}
```

**例子 2：二进制改写（Binary Rewriting）**

工具如 `BOLT`、`Dyninst` 可以在不修改源码的情况下，直接改写已有的二进制文件，插入额外的指令。

**静态插桩的局限**：
- 需要源码（或能改写的二进制）
- 无法应对动态生成的代码（JIT 编译器生成的代码）
- 必须在运行前完成，不够灵活

### 2.2 动态插桩（DBI）

动态二进制插桩（**D**ynamic **B**inary **I**nstrumentation）在程序运行期间实时拦截并改写代码：

```
真实程序                      DBI 框架
┌─────────────────┐           ┌──────────────────────┐
│ 原始机器码      │           │                      │
│  mov rax, 1    │ ─────────►│  1. 取出一段原始代码   │
│  syscall       │           │  2. 分析/改写          │
│  ret           │           │  3. 插入监控逻辑       │
│  ...           │           │  4. 存入代码缓存        │
└─────────────────┘           │  5. 执行缓存中的代码   │
                              └──────────────────────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │ 改写后的代码（执行版）│
                              │  mov rax, 1          │
                              │  call my_hook_fn     │ ← 插入的监控
                              │  syscall             │
                              │  ret                 │
                              └──────────────────────┘
```

> 💡 **代码缓存（Code Cache）**
> DBI 框架把改写后的代码存在一个特殊的内存区域（代码缓存）。程序实际上执行的是代码缓存里的代码，而不是原始的代码。这让 DBI 框架可以控制每一条指令的执行。

## 3. 主流 DBI 框架

### 3.1 Intel Pin

由英特尔开发，是学术界研究最广泛的 DBI 框架之一。

**工作原理**：

```
程序启动
   │
   ▼
Pin 接管（通过 ptrace 或 LD_PRELOAD）
   │
   ▼
Pin 以"trace"为单位处理代码：
  trace = 从某个入口到第一个无条件跳转为止的指令序列
   │
   ▼
用户的 Pintool（分析工具）处理 trace
  可以在 trace 里任意位置插入回调函数
   │
   ▼
Pin JIT 编译并执行修改后的 trace
```

**Pin 的 API 示例**：

```cpp
// 一个简单的 Pintool：统计指令数
#include "pin.H"
#include <iostream>

UINT64 icount = 0;

// 分析函数：每条指令执行时调用
VOID docount() { icount++; }

// 插桩函数：在每条指令前插入 docount 调用
VOID Instruction(INS ins, VOID *v) {
    INS_InsertCall(ins, IPOINT_BEFORE, (AFUNPTR)docount, IARG_END);
}

// 程序结束时打印结果
VOID Fini(INT32 code, VOID *v) {
    std::cerr << "指令总数: " << icount << std::endl;
}

int main(int argc, char * argv[]) {
    PIN_Init(argc, argv);
    INS_AddInstrumentFunction(Instruction, 0);
    PIN_AddFiniFunction(Fini, 0);
    PIN_StartProgram();  // 永不返回
    return 0;
}
```

### 3.2 DynamoRIO

DynamoRIO（Dynamic Runtime Optimization Infrastructure）是 Shimmy Sandbox 使用的 DBI 框架。

相比 Pin，DynamoRIO 更注重性能和对底层的控制，特别适合沙箱和安全研究场景。

**DynamoRIO 的架构**：

```
用户的 DynamoRIO 扩展（Drext）
         │ 注册回调
         ▼
┌──────────────────────────────────────────────────────┐
│                  DynamoRIO 核心                       │
│                                                      │
│  代码发现  →  代码分析  →  代码改写  →  代码缓存执行  │
│  (Decode)     (Analyze)   (Transform)  (Execute)     │
│                                                      │
│  核心组件：                                           │
│  - Decoder：将机器码解码为 IR（内部表示）              │
│  - Optimizer：对代码做局部优化                        │
│  - Encoder：将 IR 重新编码为机器码                    │
│  - Code Cache：存放插桩后的代码                       │
│  - Dispatcher：控制执行流，处理 trace 边界             │
└──────────────────────────────────────────────────────┘
```

**拦截系统调用的 DynamoRIO 扩展**：

```c
// 简化的 DynamoRIO syscall 拦截示例
#include "dr_api.h"
#include "drmgr.h"

// 系统调用进入时的回调
static bool syscall_filter(void *drcontext, int sysnum) {
    // 在这里检查系统调用号
    if (sysnum == SYS_execve) {
        dr_printf("拦截到 execve！阻断。\n");
        return false;  // 返回 false = 不执行这个系统调用
    }
    if (sysnum == SYS_socket) {
        dr_printf("拦截到 socket！阻断。\n");
        return false;
    }
    return true;  // 允许其他系统调用
}

// 系统调用前的详细检查
static bool pre_syscall_event(void *drcontext, int sysnum) {
    // 可以读取参数（DynamoRIO 有权读取用户内存！）
    if (sysnum == SYS_openat) {
        // 读取第二个参数（文件路径）
        const char *path = (const char *)dr_syscall_get_param(drcontext, 1);
        dr_printf("openat: %s\n", path);

        // 按路径内容过滤（seccomp 做不到！）
        if (strstr(path, "/etc/") != NULL) {
            dr_printf("阻断访问 /etc/\n");
            return false;
        }
    }
    return true;
}

DR_EXPORT void dr_client_main(client_id_t id, int argc, const char *argv[]) {
    dr_register_filter_syscall_event(syscall_filter);
    drmgr_register_pre_syscall_event(pre_syscall_event);
}
```

注意这里的关键优势：**DynamoRIO 可以读取指针指向的内存**（如文件路径字符串），而 seccomp-BPF 做不到。

### 3.3 Valgrind

Valgrind 是最著名的 DBI 框架，主要用于内存错误检测（Memcheck 工具）。

```
$ valgrind --leak-check=full ./my_program
==12345== HEAP SUMMARY:
==12345==   in use at exit: 40 bytes in 1 blocks
==12345==   total heap usage: 3 allocs, 2 frees, 1,064 bytes allocated
==12345==
==12345== 40 bytes in 1 block are definitely lost in loss record 1 of 1
==12345==    at 0x4C2FB0F: malloc (in /usr/lib/valgrind/vgpreload_memcheck.so)
==12345==    by 0x400540: main (main.c:8)
```

Valgrind 通过 DBI 拦截所有内存分配/释放操作（`malloc`、`free`、`new`、`delete`），维护一张"影子内存"来追踪每块内存的状态。

**Valgrind 的架构特点**：
- 运行在一个非常保守的"VEX IR"中间表示上
- 所有内存访问都被插桩（不仅仅是系统调用）
- 这导致了极大的性能开销

## 4. 经典应用

### 4.1 影子栈（Shadow Stack）

**目标**：防止栈上的返回地址被覆盖（缓冲区溢出攻击的常见手法）。

```
正常栈                    影子栈（DBI 维护）
┌───────────────┐         ┌───────────────┐
│  局部变量     │         │  只存返回地址 │
│  ...          │         │               │
│  返回地址 A   │    →    │  返回地址 A   │
│  上层栈帧     │         │               │
└───────────────┘         └───────────────┘

当函数返回时：
  DBI 拦截 ret 指令
  比较：正常栈上的返回地址 vs 影子栈上的返回地址
  如果不匹配 → 发出警告/终止程序（可能被攻击了！）
```

攻击者即使通过缓冲区溢出覆盖了正常栈上的返回地址，也无法修改 DBI 维护的影子栈（因为影子栈在程序不知道的地方），从而被检测到。

### 4.2 污点追踪（Taint Tracking）

**目标**：追踪不可信数据（"污点"）在程序中的流动，防止注入攻击。

```
程序从网络读取输入 → 标记为"污点"数据
                         │
                         ▼
              数据参与运算（污点传播）
              a = tainted_input + 1  → a 也是污点
              b = a * 2              → b 也是污点
                         │
                         ▼
              数据被用于敏感操作？
              execve(tainted_data, ...)  → 警告！
              SQL 查询包含污点数据       → 警告！
```

DBI 框架追踪每个字节的"是否受污染"状态，实时检测污点数据是否到达了不应到达的地方。

### 4.3 其他经典应用

- **代码覆盖率统计**（AFL fuzzer、lcov）：记录每条路径被执行的次数
- **内存访问监控**（Valgrind Memcheck）：追踪每次内存读写
- **函数调用追踪**（Callgrind）：分析函数调用图和 CPU 周期分布
- **地址消毒剂（AddressSanitizer）**：检测越界访问（编译时插桩）

## 5. DBI 的性能代价

Valgrind 会让程序慢 **10~50 倍**。为什么？

### 5.1 代码翻译开销

每段代码第一次执行时，DBI 框架必须：
1. 读取原始机器码
2. 解码成内部表示（IR）
3. 分析并插入监控逻辑
4. 重新编码成机器码
5. 存入代码缓存

这个过程对每个新的"代码块"只做一次，但初始化阶段（程序刚启动时）会有大量的翻译开销。

### 5.2 间接跳转开销

原来的一条 `jmp rax` 指令，在 DBI 框架下变成：

```asm
; 原来
  jmp rax         ; 直接跳到 rax 存的地址

; DBI 框架下
  push rax
  call dr_lookup  ; 查找 rax 对应的代码缓存入口
  ; dr_lookup 内部：
  ;   在哈希表里查 rax 是否有缓存
  ;   如果没有 → 翻译原始代码，存入缓存
  ;   跳到缓存中的代码
```

每次间接跳转（`jmp reg`、`call reg`、`ret`）都可能触发一次哈希表查找，这在循环密集的代码里开销显著。

### 5.3 插桩代码本身的开销

如果在每条指令前都插入一个回调函数调用：

```asm
; 原来：1 条指令
  add rax, rbx

; DBI 插桩后：N 条指令
  pushfq           ; 保存 flags
  push rax         ; 保存寄存器
  push rbx
  call my_callback ; 调用分析函数
  pop rbx          ; 恢复寄存器
  pop rax
  popfq
  add rax, rbx     ; 原始指令
```

指令数量膨胀了 7 倍，加上函数调用的固定开销，这就是 Valgrind 的 10~50x 开销的来源。

### 5.4 DynamoRIO 的优化

DynamoRIO 通过多种优化手段减少开销：

```
优化策略：

1. Inline analysis（内联分析）
   把简单的分析代码内联到被插桩代码中，避免函数调用开销

2. Trace linking（trace 链接）
   把经常一起执行的 trace 直接链接起来，避免经过 dispatcher

3. Register liveness（寄存器活跃性分析）
   只保存分析函数真正需要的寄存器，减少保存/恢复操作

4. 代码缓存（Code Cache）
   同一段代码只翻译一次，热路径几乎无额外开销
```

经过优化，DynamoRIO 的基础开销（仅加载框架，不插任何逻辑）约为 **10~30%**。Shimmy Sandbox 的测量结果是约 **2~3 倍**（包含系统调用拦截和安全检查逻辑）。

### 5.5 各框架的性能对比

```
框架                  开销（相对原生）
─────────────────────────────────────
无插桩（基准）         1×
DynamoRIO（空载）      1.1~1.3×
Pin（空载）            1.2~1.5×
Shimmy（DynamoRIO）    ~2~3×
Valgrind（Memcheck）   10~50×

注：开销取决于程序特性（系统调用频率、分支密度等）
    系统调用密集型程序（如 web 服务器）开销更高
    计算密集型程序（如矩阵乘法）开销更低
```

## 6. 在沙箱场景下使用 DBI

### 6.1 DBI 拦截系统调用的完整流程

```
程序发出 syscall 指令
         │
         │（DynamoRIO 已提前扫描这段代码）
         ▼
DynamoRIO 代码缓存里的对应代码：
  [原始指令 1..N]    ← 正常执行
  call dr_syscall_hook  ← 插入的钩子！
    │
    ▼
dr_syscall_hook（Shimmy 的安全检查逻辑）：
  1. 读取 RAX（系统调用号）
  2. 读取参数（RDI、RSI 等，可以解引用指针！）
  3. 对照安全策略
  4. 允许 → 执行真正的 syscall 指令
     拒绝 → 修改 RAX 为 -EPERM 并返回
         │
         ▼
程序继续执行（以为调用成功/失败了）
```

### 6.2 DBI 方案的独特优势

相比 seccomp，DBI 沙箱有一个秘密武器：**可以读取指针内容**。

```
seccomp 看到的：
  openat(AT_FDCWD, 0x7fff1234, O_RDONLY, 0)
                   ^^^^^^^^^^^
                   只是个数字，看不到路径

DynamoRIO 看到的：
  openat(AT_FDCWD, "/etc/passwd", O_RDONLY, 0)
                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^
                   可以解引用，看到真实路径！
```

这允许实现真正的"路径白名单"：只允许访问 `/tmp`，拒绝其他所有路径。

### 6.3 挑战：自修改代码和 JIT

DBI 的最大挑战之一是**自修改代码**（Self-Modifying Code）：程序在运行时动态生成或修改机器码。

JIT 编译器（V8、JVM）是最常见的自修改代码：

```
问题：
  1. DynamoRIO 扫描并翻译了代码块 A（原始地址 0x1000）
  2. 代码被放入代码缓存
  3. JIT 编译器在地址 0x1000 生成了新代码（原始代码被覆盖）
  4. DynamoRIO 还在执行旧的翻译！

解决：
  DynamoRIO 通过 mprotect 监控代码页的写操作
  检测到代码页被修改 → 清除对应的代码缓存 → 重新翻译
  （但这带来额外开销）
```

另一个挑战是 `io_uring`：这个异步 I/O 接口允许程序把系统调用"放进环形缓冲区"，由内核异步执行，完全绕过正常的 `syscall` 指令路径，从而绕过 DBI 拦截。Shimmy Sandbox 必须特别处理 `io_uring`。

## 小结

```
插桩 = 在程序执行中注入额外逻辑

静态 vs 动态：
  静态：运行前改写，快，但无法处理动态生成代码
  动态（DBI）：运行时实时改写，灵活，但有开销

主流框架：
  Pin          → 易用，学术界广泛使用
  DynamoRIO    → 高性能，Shimmy 的选择
  Valgrind     → 最著名的内存检测工具，慢 10~50×

性能开销来源：
  代码翻译（一次性）
  间接跳转的哈希表查找（每次）
  插桩代码本身（每次）

DBI 在沙箱中的优势：
  ✓ 可以读取指针内容（按路径过滤）
  ✓ 不需要任何内核特权
  ✗ 开销比 seccomp 大（~2~3× vs ~5%）
  ✗ 自修改代码（JIT）处理复杂
  ✗ io_uring 等异步接口需要特别处理
```

## 与 Shimmy/沙箱设计的联系

Shimmy Sandbox 的核心是 **DynamoRIO**。它在 AWS Lambda 的受限环境中（无法使用 seccomp、ptrace、namespace 等任何传统工具），通过 DBI 实现了完整的系统调用拦截。

DynamoRIO 允许 Shimmy 做到 seccomp 做不到的事：在拦截 `openat` 时真正读取文件路径，按路径内容做决策。这是 Shimmy 能实现细粒度访问控制的技术基础。

指南第七章（二进制插桩）和第八章（DynamoRIO 深度剖析）详细讲解了 Shimmy 是如何使用 DynamoRIO 构建沙箱的，包括如何处理 `io_uring` 这个特殊难题。
