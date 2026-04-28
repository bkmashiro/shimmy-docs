# Trampoline 技术

**前置知识**：了解系统调用和 `syscall` 指令（指南第三章）；了解 ELF 文件格式、PLT/GOT 机制（指南第一章）有帮助；对 x86-64 汇编有基本认知。

**你将学到**：
- Trampoline（蹦床）的通用含义：间接跳转中转站
- PLT/GOT 中的 trampoline 是怎么工作的
- zpoline 的创新：把地址 0 附近映射成蹦床区域
- 为什么地址 0 可以使用（Linux 的 mmap_min_addr）
- lazypoline 的改进：只为实际被调用的 syscall 设置蹦床

---

## 1. Trampoline 的通用含义

"蹦床"（trampoline）这个词在编程中有一个通用含义：**一段用来做间接跳转的中间代码**。

类比：现实中的蹦床——你从高处跳下，踩到蹦床，蹦床把你弹向另一个方向。代码里的蹦床也一样：程序跳到这里，蹦床再把它弹向真正的目标。

> 💡 **Trampoline（蹦床代码）**
> 一段短小的汇编代码，作为间接跳转的中介。程序跳到蹦床，蹦床做一些准备工作（保存寄存器、修改参数等），然后再跳到最终目标。

蹦床在多个场景下使用：

```
场景 1：动态链接（PLT/GOT）
  程序调用外部库函数
    → 跳到 PLT 中的蹦床
    → 蹦床从 GOT 读取真实地址
    → 跳到真实函数

场景 2：函数钩子（Hook）
  原函数入口被覆盖为蹦床地址
    → 蹦床执行监控逻辑
    → 蹦床跳回原函数继续执行

场景 3：架构适配
  32 位代码调用 64 位库
    → 蹦床做位宽转换
    → 跳到 64 位目标

场景 4：zpoline（本文核心）
  syscall 指令被替换为 "callq *%rax"（间接调用 RAX）
    → RAX = 0 附近的蹦床区域
    → 蹦床执行安全检查
    → 蹦床真正发出 syscall
```

## 2. PLT/GOT 中的 Trampoline

### 2.1 动态链接的问题

动态链接程序使用外部库（如 glibc）的函数时，编译时不知道这些函数在内存中的确切地址（因为共享库每次加载到不同的位置）。

**PLT**（Procedure Linkage Table，过程链接表）和 **GOT**（Global Offset Table，全局偏移表）解决了这个问题。

> 💡 **PLT（Procedure Linkage Table）**
> ELF 文件中的一张表，每个要调用的外部函数对应一个"蹦床"条目。编译时所有外部函数调用都跳到 PLT，PLT 再转发到真实地址。

> 💡 **GOT（Global Offset Table）**
> 存放外部函数真实地址的表。动态链接器在程序启动时填写 GOT 的内容。

### 2.2 PLT 蹦床的工作原理

```
程序调用 printf：
  call    printf@plt     ; 跳到 PLT 中 printf 的蹦床

printf@plt（PLT 蹦床）的内容：
  jmp    *printf@got     ; 间接跳转：读取 GOT[printf] 的值并跳过去
  push   <printf的GOT偏移>
  jmp    <动态链接器>

第一次调用（延迟绑定 / Lazy Binding）：
  1. GOT[printf] 还没被填写
  2. jmp *GOT[printf] → 跳到 push 指令（GOT 里存的是 push 的地址）
  3. push + jmp → 跳到动态链接器
  4. 动态链接器找到 printf 的真实地址
  5. 把真实地址写入 GOT[printf]
  6. 跳到 printf 执行

第二次调用：
  1. jmp *GOT[printf] → GOT[printf] 已经是真实地址
  2. 直接跳到 printf
  （蹦床只在第一次调用时有额外开销）
```

ASCII 图示：

```
程序的 .text 段：
  ...
  call printf@plt    ─────────────────┐
  ...                                 │
                                      ▼
PLT 段（蹦床）：                    printf@plt:
                                      jmp *[GOT+offset]  ─────┐
                                      push idx                 │
                                      jmp resolver             │
                                                               │
GOT 段（运行时填写）：           ◄───────────────────────────────┘
  GOT[printf] = 0x7f... ─────────────────────────────────────────► printf 函数
  （第一次：存蹦床回路；之后：存真实地址）
```

### 2.3 为什么这和沙箱有关

PLT/GOT 机制说明了一件事：**一条 `jmp *reg` 指令可以指向任意内存地址**。zpoline 正是利用这个特性，在系统调用的路径上插入蹦床。

## 3. zpoline：把地址 0 变成蹦床

**zpoline**（ATC 2023 论文）是 Cybozu Labs（日本）研究团队提出的一种新型系统调用拦截技术，它的核心思路非常巧妙。

> 💡 **zpoline**
> 一种用户态系统调用拦截技术。通过把 `syscall` 指令替换为 `callq *%rax`，然后在地址 0 附近映射蹦床代码，实现对所有系统调用的零开销（接近）拦截。

### 3.1 问题：如何拦截所有 syscall 指令

拦截系统调用的方法有很多（ptrace、seccomp、DBI），但它们都有各自的局限（性能差、需要特权等）。

zpoline 的目标：**不需要内核特权，性能接近原生，能拦截所有 syscall**。

### 3.2 zpoline 的创新：`callq *%rax` + 地址 0

关键观察：

1. `syscall` 指令在 x86-64 上的编码是 `0x0F 0x05`（2 字节）
2. `callq *%rax` 指令在 x86-64 上的编码是 `0xFF 0xD0`（2 字节，同样 2 字节！）
3. 发出系统调用时，**RAX 存放的是系统调用号**（一个小整数，比如 `read=0`，`write=1`，`open=2`...）
4. 如果把所有 `syscall` 指令替换为 `callq *%rax`，那么 `callq *%rax` 会以系统调用号作为目标地址进行调用

步骤 4 的意思是：执行 `callq *%rax`（RAX=1）时，CPU 会调用**地址 1 处**的代码！

```
原始代码：
  mov $1, %rax    ; RAX = 1 (write 系统调用号)
  syscall         ; 发出 write 系统调用

替换后：
  mov $1, %rax    ; RAX = 1 (write 系统调用号)
  callq *%rax     ; CPU 跳到地址 1 处执行代码！
```

地址 1 通常是空的，内核不允许映射。但 zpoline 通过降低 `vm.mmap_min_addr` 把地址 0 附近映射成蹦床代码：

```
地址 0 附近的内存（zpoline 映射在这里）：

地址:  0x0000  0x0001  0x0002  0x0003  ... 0x01FF
内容:  [NOP]   [NOP]   [NOP]   [NOP]   ... [蹦床处理函数]

当 RAX = N（系统调用号为 N）时：
  callq *%rax → 跳到地址 N
  地址 N 处：NOP（或跳转指令）
  最终执行到蹦床处理函数

蹦床处理函数：
  1. 获取调用的系统调用号（从 call 的返回地址推算）
  2. 执行安全检查
  3. 如果允许：执行真正的 syscall 指令
  4. 返回
```

### 3.3 地址 0 的映射：vm.mmap_min_addr

Linux 默认不允许把内存映射到地址 0 附近，防止空指针解引用漏洞被利用（攻击者通过向地址 0 写入数据，然后诱导内核解引用空指针来劫持内核流程）。

这由内核参数 `vm.mmap_min_addr` 控制，默认值通常是 **65536**（0x10000）。

zpoline 需要把这个值设为 0：

```bash
# 允许映射到地址 0（需要 root 或 CAP_SYS_RAWIO）
sysctl -w vm.mmap_min_addr=0

# 验证
cat /proc/sys/vm/mmap_min_addr
# 输出: 0
```

然后映射地址 0 附近的内存：

```c
// 映射 512 字节到地址 0
void *p = mmap(0, 512,
               PROT_READ | PROT_WRITE,
               MAP_FIXED | MAP_PRIVATE | MAP_ANONYMOUS,
               -1, 0);
// MAP_FIXED + 地址 0 = 精确映射到地址 0

// 写入 NOP sled（每个地址对应的字节都是 NOP 或跳转）
memset(p, 0x90, 512);  // 0x90 = NOP
// 最后几个字节放置蹦床跳转指令
// ...

// 改为可执行
mprotect(p, 512, PROT_READ | PROT_EXEC);
```

完整的映射布局：

```
地址 0x0000:  NOP  ← syscall 0 (read) 跳到这里，再往后走
地址 0x0001:  NOP  ← syscall 1 (write) 跳到这里
地址 0x0002:  NOP  ← syscall 2 (open) 跳到这里
...
地址 0x00FF:  NOP  ← syscall 255 跳到这里
地址 0x0100:  JMP  → 蹦床处理函数（实际安全检查在这里）
```

所有系统调用号（0~最大值）都对应地址 0~N 处的 NOP，所有 NOP 最终都滑向处理函数。

### 3.4 zpoline 的整体流程

```
原程序发出系统调用（以 write(1, "hello\n", 6) 为例）：

步骤 1（预处理，程序启动时一次性）：
  扫描所有 .text 代码段
  找到每条 syscall (0x0F 0x05) 指令
  替换为 callq *%rax (0xFF 0xD0) ← 二进制改写

步骤 2（运行时，每次系统调用）：
  mov $1, %rax       ; RAX = 1 (SYS_write)
  callq *%rax        ; 跳到地址 1（被 zpoline 替换后的代码）
         │
         ▼
  地址 0x0001: NOP   ; 滑向蹦床
  地址 0x0002: NOP
  ...
  地址 0x0100: call trampoline_handler
         │
         ▼
  trampoline_handler：
    读取返回地址 → 推算出系统调用号 N
    检查安全策略（是否允许 write？）
    如果允许：
      执行真正的 syscall 指令
    返回

步骤 3（返回）：
  callq 的返回机制保证了正确的返回地址
  程序继续执行
```

### 3.5 zpoline 的性能

zpoline 相比 ptrace（10× 开销）和 DBI（2~3× 开销）有显著的性能优势：

```
系统调用拦截方案性能对比：

方案              系统调用密集型程序的开销
────────────────────────────────────────────
无拦截（基准）    1×
seccomp-BPF      ~1.05×（~5% 额外开销）
zpoline          ~1.10×（~10% 额外开销）
lazypoline       ~1.05×（~5% 额外开销，见下节）
DynamoRIO        ~2~3×
ptrace           ~10×

注：数据来自各论文报告，具体值取决于工作负载
```

zpoline 比 DBI 快得多，因为它只拦截系统调用，不需要处理每条普通指令。

## 4. lazypoline：只设置实际被调用的蹦床

**lazypoline**（DSN 2024 论文）是对 zpoline 的改进，解决了 zpoline 的一个问题：**地址 0 的映射安全风险**。

> 💡 **lazypoline**
> zpoline 的改进版本。不再依赖地址 0 附近的静态映射，而是采用懒初始化（lazy initialization）策略，只在第一次遇到某个系统调用时才设置对应的蹦床。

### 4.1 zpoline 的安全问题

把 `vm.mmap_min_addr` 设为 0 本身就有风险：

```
zpoline 的安全代价：
  允许 vm.mmap_min_addr=0
    → 任何程序（包括被沙箱的程序！）可以 mmap 到地址 0
    → 传统的空指针保护失效
    → 内核某些路径假设地址 0 无效，可能被利用

  这是一个安全性和可用性的权衡
```

### 4.2 lazypoline 的解决方案

lazypoline 不映射地址 0，而是在**每次遇到新的系统调用号时动态设置蹦床**：

```
lazypoline 的工作原理：

程序启动时：
  所有 syscall 指令同样替换为 callq *%rax
  但不映射地址 0！

第一次发出某个系统调用（比如 write, RAX=1）：
  callq *%rax（RAX=1）→ 跳到地址 1
  地址 1 没有映射 → SIGSEGV（段错误）！
  lazypoline 的 SIGSEGV 处理函数被调用：
    1. 检测到这是 zpoline 触发的 SIGSEGV
    2. 为系统调用号 1 在安全地址动态分配蹦床代码
    3. 修改 "地址 1 应该跳到哪里" 的记录（通过 mprotect）
    4. 或者：用 trampolineTable[1] 存蹦床地址，
             把地址 1 映射为 "jmp trampolineTable[1]"
    5. 重新执行 callq *%rax

第二次发出 write（RAX=1）：
  callq *%rax → 跳到地址 1
  地址 1 有了 jmp trampolineTable[1]
  → 直接跳到已设置的蹦床，无 SIGSEGV
```

这就是"lazy"（懒初始化）的含义：只在真正需要时才设置蹦床，避免了在地址 0 维护一大片预映射内存。

### 4.3 lazypoline 与 zpoline 的比较

```
特性              zpoline         lazypoline
──────────────────────────────────────────────
地址 0 映射       需要            不需要
mmap_min_addr=0   需要（root）    不需要
首次调用开销      无              有（SIGSEGV 处理）
后续调用开销      类似           类似
安全风险          较高           较低
实现复杂度        较低           较高
```

## 5. 蹦床技术的全景

```
各种蹦床技术的用途总结：

调用场景               蹦床的位置          蹦床做什么
──────────────────────────────────────────────────────────
动态链接（PLT）        .plt 段             查 GOT，跳到真实函数
函数钩子               原函数入口被覆盖    调用监控逻辑，再跳回原函数
zpoline syscall 拦截   地址 0 附近         安全检查，发出真 syscall
lazypoline syscall     动态分配           同上，但只对已用 syscall 分配
DynamoRIO              代码缓存           完整 JIT 翻译，不止蹦床
```

## 小结

```
Trampoline = 间接跳转的中转站，"弹"到真正的目标

PLT/GOT：
  动态链接库函数的蹦床机制
  第一次调用：经过蹦床 → 动态链接器解析 → 填写 GOT
  后续调用：直接通过 GOT 跳到真实函数

zpoline：
  把 syscall (0x0F 0x05) 替换为 callq *%rax (0xFF 0xD0)
  在地址 0 附近映射 NOP sled + 蹦床处理函数
  需要 vm.mmap_min_addr=0（需要 root）
  开销：~10%（远优于 ptrace 的 10×）

lazypoline：
  zpoline 的改进：不映射地址 0
  SIGSEGV-driven 懒初始化：首次调用某 syscall 时才设置蹦床
  更安全（不需要降低 mmap_min_addr）
  后续调用开销与 zpoline 相近
```

## 与 Shimmy/沙箱设计的联系

zpoline 和 lazypoline 直接与 Shimmy 相关：

1. **zpoline 论文（ATC 2023）**是 Shimmy 的核心参考文献之一。zpoline 提供了一种"无需内核特权"的系统调用拦截方案，与 Shimmy 面临的 Lambda 环境完全吻合。

2. **lazypoline 论文（DSN 2024）**改进了 zpoline 的安全性，消除了对 `vm.mmap_min_addr=0` 的依赖，对于在不可控环境（如 Lambda）中部署尤为重要。

3. **Shimmy vs zpoline 的权衡**：zpoline 比 DynamoRIO 更快（~10% vs ~200~300%），但功能更单一（只能拦截系统调用，不能做 DBI 的其他事）。Shimmy 使用 DynamoRIO，因为 DynamoRIO 同时提供了系统调用拦截和代码分析能力，对 JIT 代码的支持也更完整。

Papers 部分的 [zpoline](../../papers/zpoline) 和 [lazypoline](../../papers/lazypoline) 有更详细的论文阅读笔记。
