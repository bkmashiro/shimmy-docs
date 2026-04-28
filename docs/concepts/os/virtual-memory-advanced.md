# 虚拟内存进阶

> 前面的文章解释了"虚拟内存是什么"。这篇文章深入一层：TLB 怎么加速地址翻译？mmap 能做什么？mprotect 怎么改变内存页的权限？以及 shimmy 核心依赖的内存保护键（MPK）是什么？

## 前置知识

- 已理解虚拟地址空间和页表的基本概念（见《进程与内存空间》）
- 了解系统调用的基本工作方式
- 了解 CPU 特权级

## 你将学到

- TLB（Translation Lookaside Buffer）的原理和重要性
- PCID 如何优化进程切换时的 TLB 开销
- `mmap` 系统调用：文件映射和匿名映射的用法
- `mprotect` 系统调用：在运行时修改内存页权限
- W^X 安全策略的含义和重要性
- MPK（Memory Protection Keys）：无需 syscall 的内存保护

---

## 1. TLB：地址翻译的缓存

### 问题：页表查找太慢

回忆页表翻译过程：CPU 访问一个虚拟地址，需要查多级页表（x86-64 是 4 级：PML4 → PDPT → PD → PT → 物理地址），每级页表都要访问一次内存。

**4 次内存访问才能翻译一个地址！** 如果程序每访问一个内存地址都需要额外 4 次内存访问，速度会慢 4-5 倍。

### 解决方案：TLB（Translation Lookaside Buffer）

> 💡 **TLB**（Translation Lookaside Buffer，翻译后备缓冲器）是 CPU 内部的一块超高速缓存，存储最近用过的虚拟页→物理页的映射。

```
类比：小区门卫记住常客

第一次访客到来：
  门卫翻花名册（查页表，慢！）
  找到此人信息
  记录到"常客本子"（TLB）

以后同一访客到来：
  门卫直接认出（TLB 命中，快！）
  不需要翻花名册
```

地址翻译流程（有 TLB）：

```
CPU 访问虚拟地址 0x401008
         │
         ▼
    ┌──────────┐
    │   TLB    │  查询：VPN 0x401 是否在缓存中？
    │  (快！)  │
    └────┬─────┘
    命中 │ 未命中
         │              │
         ▼              ▼
  直接得到         访问内存，走页表（4次内存访问）
  物理地址         翻译完成后，把结果写入 TLB
         │              │
         └──────┬────────┘
                ▼
         访问物理内存 0x2B1008
```

**TLB 命中率** 对性能至关重要。现代程序的 TLB 命中率通常在 **99% 以上**（因为程序有空间局部性，反复访问同一块内存）。

### TLB 的容量限制

TLB 的条目数量有限（通常 L1 TLB 64-128 条，L2 TLB 1024-4096 条）。如果程序同时使用很多不同的内存区域（大量跳转访问），TLB 会频繁"未命中"（TLB miss），性能下降。

这就是为什么大内存程序（数据库、科学计算）喜欢使用 **2MB 大页**（Huge Pages）：每个页更大，TLB 条目能覆盖更多地址，减少 TLB miss。

---

## 2. PCID：进程切换时保留 TLB

### 问题：切换进程时 TLB 失效

传统上，当内核切换到另一个进程（切换页表）时，所有 TLB 条目都必须**全部清空**（TLB flush）——因为新进程的虚拟地址映射完全不同，旧的翻译结果无效了。

TLB flush 代价极高：切换后，新进程刚开始运行的那段时间，每次内存访问都是 TLB 未命中，要走慢速的页表查找。

### 解决方案：PCID（Process Context Identifier）

> 💡 **PCID**（Process Context Identifier，进程上下文标识符）是每个 TLB 条目附带的一个 12 位标签，标记这个翻译属于哪个地址空间。

```
有 PCID 的 TLB：
┌──────────┬──────────┬───────────┐
│ PCID = 1 │ VPN 0x401│ PFN 0x2B1 │ ← 属于进程 A
│ PCID = 1 │ VPN 0x600│ PFN 0x05C │ ← 属于进程 A
│ PCID = 2 │ VPN 0x401│ PFN 0x7F3 │ ← 属于进程 B
│ PCID = 2 │ VPN 0x800│ PFN 0x1A0 │ ← 属于进程 B
└──────────┴──────────┴───────────┘
```

切换到进程 B 时，只需改变 CPU 当前使用的 PCID，TLB 里进程 B 的条目仍然有效，**不需要全局 flush**！

PCID 是现代 Linux（尤其是 Meltdown 漏洞修复之后）的重要优化：
- Meltdown 漏洞修复（KPTI，内核页表隔离）需要每次系统调用都切换页表
- 没有 PCID：每次 syscall 都要 TLB flush，性能暴跌 5-30%
- 有 PCID：切换页表时保留 TLB，性能损失降至 1-5%

---

## 3. mmap：万能的内存映射

`mmap`（memory map）是 Linux 最强大的内存管理系统调用之一，它能：
1. 把文件的内容直接映射到内存（像访问内存一样读写文件）
2. 分配匿名内存（大块 malloc 的底层实现）
3. 在进程间共享内存

### mmap 系统调用接口

```c
#include <sys/mman.h>

void *mmap(
    void  *addr,    // 期望映射到的虚拟地址（通常 NULL，让内核决定）
    size_t length,  // 映射的字节数
    int    prot,    // 内存保护标志：PROT_READ, PROT_WRITE, PROT_EXEC
    int    flags,   // 映射类型：MAP_PRIVATE, MAP_SHARED, MAP_ANONYMOUS
    int    fd,      // 文件描述符（匿名映射用 -1）
    off_t  offset   // 文件偏移量
);
// 返回值：映射的虚拟地址，失败返回 MAP_FAILED
```

### 文件映射

```c
// 把整个文件映射到内存，直接用指针访问内容
int fd = open("/etc/passwd", O_RDONLY);
struct stat st;
fstat(fd, &st);

char *data = mmap(NULL, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
// 现在 data 指向文件内容，可以直接读取
printf("文件第一个字符: %c\n", data[0]);

munmap(data, st.st_size);  // 解除映射
close(fd);
```

文件映射的工作原理：

```
mmap 文件映射流程：

mmap(..., fd=3, offset=0)
    │
    ▼
内核只分配虚拟地址范围，不立即加载文件内容
    │
    ▼
你第一次访问 data[0]
    │
    ▼
页错误！→ 内核处理程序
    ├── 发现这是文件映射区域
    ├── 从磁盘读取对应的文件页
    ├── 映射到物理内存
    └── 更新页表，重试被中断的访问
    │
    ▼
data[0] 可用，后续访问该页无需磁盘 I/O
```

这就是为什么大型数据库（PostgreSQL、MySQL 的某些模式）用 mmap 管理数据文件——让内核的页面缓存自动处理 I/O，而不需要手动 read/write。

### 匿名映射

```c
// 分配 1 MB 的内存（比 malloc 更直接，不经过 libc 的内存管理）
void *buf = mmap(NULL, 1024*1024,
                 PROT_READ | PROT_WRITE,
                 MAP_PRIVATE | MAP_ANONYMOUS,
                 -1, 0);
// 使用 buf...
munmap(buf, 1024*1024);
```

**libc 的 `malloc` 在内部**：对于小于约 128KB 的请求，使用 `brk` 系统调用扩展堆；对于大于约 128KB 的请求，使用 `mmap` 匿名映射。

### 共享内存映射

```c
// MAP_SHARED：多个进程映射同一个文件/shm 对象，修改对所有人可见
// MAP_PRIVATE：写时复制（CoW），修改只影响当前进程
```

`fork()` 系统调用之所以高效，正是因为它用了写时复制（Copy-on-Write）：父子进程最初共享相同的物理页（标记为只读），只有当某一方写入时，内核才复制那个页，让两者各有一份。

---

## 4. mprotect：运行时修改内存权限

`mprotect` 允许在程序运行时修改一段内存的访问权限：

```c
#include <sys/mman.h>

int mprotect(void *addr, size_t len, int prot);
// prot 可以是：
//   PROT_NONE    （不可访问）
//   PROT_READ    （可读）
//   PROT_WRITE   （可写）
//   PROT_EXEC    （可执行）
// 以及这些的组合
```

### 用法示例：动态改变权限

```c
// 分配一块可读写的内存
char *buf = mmap(NULL, 4096, PROT_READ | PROT_WRITE,
                 MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

// 往里写机器码...
memcpy(buf, machine_code, code_size);

// 改成只读+可执行（不再可写）
mprotect(buf, 4096, PROT_READ | PROT_EXEC);

// 现在可以执行这段代码了
void (*func)() = (void(*)())buf;
func();
```

这是 JIT 编译器（如 V8、LuaJIT）的工作方式：先写入机器码，再改成可执行。

---

## 5. W^X 策略：不可同时可写可执行

**W^X**（Write XOR Execute，"W 异或 X"）是一个安全策略：**内存页不能同时具有可写（W）和可执行（X）权限**。

```
W^X 规则：
  合法的权限组合：
    PROT_READ           （只读）
    PROT_READ | PROT_WRITE  （可读写，不可执行）
    PROT_READ | PROT_EXEC   （可读可执行，不可写）

  违反 W^X 的组合（危险！）：
    PROT_READ | PROT_WRITE | PROT_EXEC  （既可写又可执行）
```

### 为什么 W^X 重要

经典的缓冲区溢出攻击需要两步：
1. 把 shellcode（恶意机器码）写入某块内存
2. 让 CPU 执行那块内存

W^X 阻止了第二步：如果数据区域（堆、栈）标记为不可执行，即使攻击者成功写入了 shellcode，CPU 也无法执行它（触发页错误，内核发送 SIGSEGV）。

```
W^X 的防护效果：
  堆区域：PROT_READ | PROT_WRITE      → 写入 shellcode ✓ 但执行 ✗
  栈区域：PROT_READ | PROT_WRITE      → 写入 shellcode ✓ 但执行 ✗
  代码区域：PROT_READ | PROT_EXEC     → 执行 ✓ 但不能修改 ✗
```

现代操作系统（Linux、Windows、macOS）默认强制 W^X。硬件上由 CPU 的 NX（No-Execute）位实现（Intel 叫 XD，AMD 叫 NX）。

### 对 JIT 编译的影响

JIT 编译器需要在运行时生成并执行代码，这与 W^X 冲突。解决方法：
- 分配内存时用 `PROT_READ | PROT_WRITE`（可写）
- 写入机器码完成后，调用 `mprotect` 改成 `PROT_READ | PROT_EXEC`（可执行）
- 如果需要修改代码，先改回 `PROT_WRITE`，修改完再改回 `PROT_EXEC`

这个"写完就封口"的模式就是符合 W^X 的 JIT 实现。

---

## 6. MPK（Memory Protection Keys）：不进内核就能改保护

### 背景：mprotect 的代价

`mprotect` 是系统调用——每次调用都要 Ring 3 → Ring 0 → Ring 3 切换，约 100-300 纳秒。如果需要频繁切换某块内存的权限（比如每次函数调用都要切换），这个代价会很显著。

> 💡 **MPK**（Memory Protection Keys，内存保护键）是 Intel 的一个 CPU 特性（Intel MPK，也叫 PKU，Protection Keys for User space），允许在**用户态**（不进内核）直接修改内存页的访问权限。

### MPK 的工作原理

MPK 给每个内存页额外附加一个 4 位的"颜色标记"（保护键，key），共 16 种颜色。另外有一个特殊的寄存器 **PKRU**（Protection Keys Rights for User pages），用 32 位控制每种颜色的读/写权限。

```
MPK 架构示意：

内存页：
  [颜色=1] 代码页      → PKRU 中 key1 的权限
  [颜色=2] 数据页      → PKRU 中 key2 的权限
  [颜色=0] 默认页      → PKRU 中 key0 的权限

PKRU 寄存器（32 位）：
  位 0-1:  key 0 的 AD（Access Disable）和 WD（Write Disable）
  位 2-3:  key 1 的权限
  位 4-5:  key 2 的权限
  ...
  位 30-31: key 15 的权限
```

修改 PKRU 不需要 syscall，直接用 `WRPKRU` 指令（用户态可执行）：

```c
// 禁止访问 key 1 对应的所有内存页
// (比 mprotect 快 ~50倍！)
__builtin_ia32_wrpkru(0b11 << 2);  // key 1 的 AD+WD 都置 1

// 恢复访问
__builtin_ia32_wrpkru(0);
```

### MPK 的速度对比

```
修改内存权限的方式（比较）：

mprotect() 系统调用：
  用户态 → syscall → 内核 → 修改页表 → 返回用户态
  代价：~100-300 纳秒（一次内核切换）

WRPKRU 指令：
  直接修改 CPU 寄存器（像普通算术指令一样）
  代价：~2-5 纳秒（约快 50-100 倍！）
```

### MPK 的局限性

- 只有 16 个 key（颜色），对于需要大量不同保护区域的场景不够用
- 只有 Intel CPU 支持（AMD 也有类似机制 AMD pkeys）
- PKRU 寄存器是每线程的（每个线程有独立的 PKRU），适合线程级权限控制
- PKRU 只能控制用户态的访问，内核态访问不受限

---

## 虚拟内存高级特性速览

```
特性                   原语              典型用途
──────────────────────────────────────────────────────────────────
惰性分配（Lazy Alloc）  mmap + 页错误    节省物理内存，按需分配
写时复制（CoW）         fork + 页错误    高效进程创建
大页（Huge Pages）      mmap(MAP_HUGE)   减少 TLB miss，提升 DRAM 带宽
内存锁定               mlock            防止被换出到磁盘（实时系统）
内存建议               madvise          告诉内核访问模式（顺序/随机等）
共享内存               shm_open + mmap  进程间高速通信
```

---

## 小结

```
TLB（地址翻译缓存）：
  虚拟→物理地址映射的硬件缓存，命中时跳过页表查找
  PCID 允许多个进程共存于 TLB，避免切换进程时全量 flush

mmap：
  文件映射（零拷贝读文件）+ 匿名映射（大块内存分配）
  底层：虚拟地址空间 + 惰性分配 + 页错误处理

mprotect：
  运行时修改内存页权限（需要 syscall，约 100-300 ns）
  
W^X 策略：
  内存页不能同时可写且可执行
  防止 shellcode 攻击

MPK（Memory Protection Keys）：
  用 WRPKRU 指令（用户态）直接切换内存保护，约 2-5 ns
  比 mprotect 快 50-100 倍，shimmy 的核心技术
```

**核心要点**：
1. TLB 是地址翻译的"快速通道"，命中率决定内存访问性能
2. mmap 是 Linux 最强大的内存操作接口，文件 I/O 和匿名内存都走它
3. mprotect 能动态改权限，但每次需要 syscall
4. W^X 防止代码注入攻击，但 JIT 编译器需要特殊处理
5. MPK 让用户态程序无需 syscall 就能切换内存保护，速度提升两个数量级

## 与沙箱技术的联系

MPK 是 shimmy 最核心的技术依赖之一。在 shimmy 的设计中：

- **被沙箱代码**和**shimmy 框架代码**共享同一个进程地址空间
- shimmy 需要在两者之间设立内存保护边界，防止被沙箱代码篡改 shimmy 的数据结构
- 使用 `mprotect`：每次切换（进入/退出被沙箱代码）需要 syscall，约 100-300 ns × 频繁切换 = 不可接受的开销
- 使用 **MPK（WRPKRU）**：切换代价约 2-5 ns，即使每个函数调用都切换也几乎没有性能损失

这就是为什么 shimmy 的论文反复讨论 MPK：它是让"进程内沙箱"在生产中可用的关键技术使能者。
