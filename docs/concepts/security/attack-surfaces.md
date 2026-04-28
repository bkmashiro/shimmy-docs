# 攻击面分析

**前置知识**：了解系统调用（指南第三章）；了解沙箱的基本概念（本章 what-is-sandboxing.md）；知道什么是"漏洞"（有洞即可）。

**你将学到**：
- 什么是攻击面（attack surface），用数学语言量化它
- 沙箱逃逸的几类常见攻击手法
- syscall 攻击面 vs 内存攻击面 vs 侧信道攻击面的区别
- 最小权限原则：为什么 Firecracker 只开 24 个系统调用
- 如何量化攻击面：syscall 数量、暴露的内核代码行数

---

## 1. 什么是攻击面

**攻击面**（attack surface）是一个系统中所有**可能被攻击者利用的入口点**的总和。

> 💡 **攻击面（Attack Surface）**
> 系统向外界暴露的所有潜在攻击入口的集合，包括：接受外部输入的接口（API、系统调用、网络端口）、处理这些输入的代码（及其中的漏洞）、以及拥有的权限（越高权限，被攻破后危害越大）。

类比：一栋建筑的"攻击面"是它所有的门、窗、通风口、管道入口的总和。每一个开口都是潜在的入侵路径。安全设计的目标不是把所有开口封死（那样无法使用），而是：
1. 尽量减少开口的数量（最小化攻击面）
2. 确保每个开口都有可靠的守卫（每个接口都有安全检查）
3. 把最不重要的开口封死（把不必要的接口完全移除）

### 1.1 攻击面的组成

```
一个沙箱系统的攻击面：

  ┌─────────────────────────────────────────────────────────────┐
  │                    沙箱系统                                  │
  │                                                             │
  │  ┌──────────────────────────────────────────────────────┐  │
  │  │                  不可信代码                           │  │
  │  │                                                      │  │
  │  │  [1] syscall 接口   [2] 内存接口   [3] 侧信道         │  │
  │  └──────────────────────────────────────────────────────┘  │
  │          │                 │                │               │
  │          ▼                 ▼                ▼               │
  │   系统调用处理       内存保护机制         缓存/时序         │
  │   (内核代码)        (MMU/页表)           (硬件行为)         │
  └─────────────────────────────────────────────────────────────┘

攻击面 = 所有可能被利用的接口 + 处理这些接口的代码中的漏洞
```

## 2. syscall 攻击面

系统调用是用户程序与内核交互的唯一接口，也是内核最大的攻击面之一。

### 2.1 系统调用数量 = 攻击面的近似指标

Linux 内核有约 **330+ 个系统调用**。每个系统调用都是内核代码的一个入口点，如果该入口点的代码有漏洞，攻击者就可能利用它：

```
允许的 syscall 越少 → 暴露的内核代码越少 → 攻击面越小

300+ 个 syscall（默认）
    ↓
50 个 syscall（典型 seccomp 过滤）
    ↓
24 个 syscall（Firecracker 的配置）
    ↓
4 个 syscall（seccomp strict 模式）
```

### 2.2 高危系统调用

不同的系统调用对应不同程度的风险：

```
极高风险（通常应完全禁止）：
  execve(59)   → 执行任意程序（弹 Shell 的标配）
  fork(57)     → 创建子进程（Fork 炸弹；产生脱离控制的进程）
  ptrace(101)  → 调试/控制其他进程（可以完全控制被调试进程）
  mknod(133)   → 创建设备文件（可以直接访问硬件）
  mount(165)   → 挂载文件系统（可以覆盖系统文件）

高风险（需要谨慎允许）：
  socket(41)   → 创建网络套接字（数据外泄）
  connect(42)  → 建立网络连接（反弹 Shell）
  open/openat  → 打开文件（读取敏感数据）
  mmap(9) with PROT_EXEC → 分配可执行内存（动态注入代码）
  clone(56)    → 创建线程（资源竞争、逃逸）
  prctl(157)   → 进程控制（可修改安全属性）
  io_uring_setup(425) → 异步 I/O（可绕过系统调用拦截）

中等风险（通常允许但需监控）：
  read(0)      → 读取已打开的 fd（取决于 fd 是什么）
  write(1)     → 写入已打开的 fd
  mmap(9) without PROT_EXEC → 正常内存分配
  mprotect(10) → 修改内存保护（W⊕X 相关）

低风险（通常安全允许）：
  getpid(39)   → 读取自己的 PID
  gettimeofday → 读取时间（注意：侧信道！）
  exit(60)     → 进程退出
  futex(202)   → 线程同步（用户态锁）
```

### 2.3 案例：io_uring 攻击面

`io_uring`（Linux 5.1+）是一个高性能异步 I/O 接口，它允许程序把 I/O 操作放进**环形缓冲区**，由内核异步执行。

这创造了一个特殊的攻击面：

```
传统系统调用路径（可以拦截）：
  用户程序 → syscall 指令 → 内核处理 → 返回

io_uring 路径（可以绕过拦截！）：
  用户程序 → 写入 SQ（提交队列）
  内核轮询 → 从 SQ 读取操作请求 → 执行
  用户程序 → 从 CQ（完成队列）读取结果

  关键：用户程序不需要执行 syscall 指令！
        它只是向共享内存写入"请帮我做这个 I/O 操作"
        内核自己去取并执行
        → DBI 拦截 syscall 指令完全失效！
```

这就是为什么 Shimmy Sandbox 需要特别处理 `io_uring`：不能只拦截 `syscall` 指令，还必须拦截 `io_uring_setup`、`io_uring_enter` 等调用，并验证提交到队列中的操作。

### 2.4 量化 syscall 攻击面：内核代码行数

```
不同配置下暴露的内核代码量（粗略估计）：

              允许的 syscall 数量   相关内核代码行数
────────────────────────────────────────────────────
默认 Linux         330+             ~15,000,000 行
典型容器            ~80              ~3,000,000 行
Docker seccomp      ~44              ~2,000,000 行
Firecracker          24              ~500,000 行
gVisor              ~60            ~无限（重新实现）

注：内核代码行数是粗略估计
    gVisor 在用户态重新实现了内核，所以攻击面是 gVisor 代码
```

**gVisor** 是 Google 开源的沙箱方案，它不使用 Linux 内核处理系统调用，而是在用户态重新实现了一个兼容 Linux 的内核（用 Go 编写）。每个系统调用都由 gVisor 的用户态代码处理，不暴露真实的内核。代价是额外开销（约 3~5×）和兼容性问题。

## 3. 内存攻击面

### 3.1 常见内存漏洞类型

```
内存漏洞分类：

缓冲区溢出（Buffer Overflow）
  原因：向数组写入超过其大小的数据
  危害：覆盖相邻内存（可能包含函数指针、返回地址）
  例子：gets(buf) 没有长度限制 → 可以覆盖栈上的返回地址

  [栈布局]
  低地址: [buffer（16字节）] [saved_rbp] [return_addr]
  攻击:   [AAAAAAAAAAAAAAA...A] [fake_rbp] [shellcode地址]

Use-After-Free（UAF）
  原因：内存被 free 后仍然被使用
  危害：攻击者重新分配同一块内存，控制其内容
  例子：
    char *p = malloc(16);
    free(p);               // 内存还给堆管理器
    // 攻击者现在 malloc 同样大小，得到 p 指向的内存
    // 并写入 shellcode 或假冒对象
    p->func();             // 调用了攻击者控制的函数！

整数溢出（Integer Overflow）
  原因：整数运算结果超出类型范围（如 uint8_t 255 + 1 = 0）
  危害：导致错误的大小计算，间接造成缓冲区溢出
  例子：
    size_t n = user_input;   // 用户输入 UINT_MAX
    char *buf = malloc(n+1); // n+1 溢出 → malloc(0)
    read(fd, buf, n);        // 写入 UINT_MAX 字节！

格式化字符串漏洞
  原因：用户输入直接作为 printf 的格式字符串
  危害：任意内存读/写
  例子：
    printf(user_input);  // 危险！
    // 用户输入 "%x %x %x" → 打印栈上的数据
    // 用户输入 "%n" → 向某地址写入数字
```

### 3.2 防御内存漏洞的机制

```
防御机制              原理                  绕过难度
─────────────────────────────────────────────────────
Stack Canary         栈上放随机值，返回前检查  中（信息泄露可绕过）
ASLR（地址随机化）    代码和栈的地址随机化      中（需要 info leak 配合）
NX / W⊕X            数据段不可执行            中（ROP 攻击绕过）
SafeStack            影子栈存返回地址          高
CFI（控制流完整性）  限制间接跳转目标          高

ROP（Return-Oriented Programming）：
  ASLR 和 NX 同时存在时的绕过技术
  不需要注入 shellcode，而是把已有代码的"碎片"串联起来
  每个碎片以 ret 结尾（"gadget"）
  通过覆盖返回地址链接多个 gadget，实现任意计算
```

### 3.3 沙箱中的内存攻击面

沙箱本身的代码（如 DynamoRIO、QEMU）也可能有内存漏洞。如果不可信代码能触发沙箱代码中的 UAF 或缓冲区溢出，就可能实现沙箱逃逸：

```
沙箱逃逸的内存路径示例（VENOM 漏洞，CVE-2015-3456）：

  VM 内的攻击者代码
    │
    │ 向虚拟软盘控制器发送精心构造的数据包
    ▼
  QEMU 的 FDC 模拟代码（有缓冲区溢出漏洞）
    │
    │ 堆溢出 → 覆盖 QEMU 进程的内存
    ▼
  任意代码执行（在 QEMU 进程里，即宿主机用户态）
    │
    │ 配合提权漏洞
    ▼
  主机 root 权限 = 完全逃逸！
```

**防御**：减少模拟的设备数量（Firecracker 没有软盘控制器）、用内存安全语言编写（Firecracker 用 Rust）、对沙箱代码本身做 fuzzing。

## 4. 侧信道攻击面

**侧信道攻击**（Side-channel Attack）不攻击程序的逻辑，而是利用程序运行时的**物理特性**（时序、功耗、缓存行为）来推断秘密信息。

> 💡 **侧信道攻击（Side-channel Attack）**
> 通过观察系统运行时的物理特征（执行时间、内存访问模式、电磁辐射、缓存状态）来推断秘密，而不是直接攻击逻辑漏洞。

### 4.1 缓存侧信道：Spectre/Meltdown

```
Meltdown（CVE-2017-5754）原理（简化）：

正常情况：
  用户程序访问内核内存 → 硬件检查权限 → SIGSEGV

Meltdown 利用的 CPU 特性：乱序执行（Out-of-Order Execution）：
  CPU 为了性能，会"乐观地"提前执行下一条指令
  即使权限检查还没完成，CPU 也先乱序执行后面的代码

代码：
  char *kernel_addr = 0xffff000...; // 内核内存地址
  char secret = *kernel_addr;       // 访问内核内存
  // 权限检查在这里：SIGSEGV（这条指令最终会失败）
  // 但 CPU 已经乱序执行了：
  uint64_t index = secret * 4096;
  char dummy = probe_array[index];  // 把 probe_array[secret*4096] 缓存了

  // 虽然 SIGSEGV 撤销了 secret 的寄存器值
  // 但缓存没有被清除！
  // 攻击者测量访问 probe_array[i*4096] 的时间：
  //   快 → 在缓存里 → index = i*4096 → secret = i
  //   慢 → 不在缓存里
  // 从而重建出 secret 的值
```

这类攻击绕过了所有基于软件的沙箱——沙箱无法控制 CPU 缓存的行为。

### 4.2 计时侧信道

```
简单的计时侧信道示例：

// 密码比较（有漏洞的版本）
bool check_password(const char *input, const char *real_pw) {
    for (int i = 0; real_pw[i]; i++) {
        if (input[i] != real_pw[i])
            return false;  // 第一个不匹配就返回
    }
    return true;
}

攻击：
  测量每次比较的时间
  "a????" 返回快 → 第一个字符不是 a
  "b????" 返回快 → 第一个字符不是 b
  ...
  "p????" 返回稍慢 → 第一个字符是 p！（比较了第一位）
  逐字符恢复真实密码

防御：常数时间比较
  for (int i = 0; i < len; i++) result |= (input[i] ^ real_pw[i]);
  return result == 0;  // 不管哪里不匹配，都完整扫描所有字节
```

### 4.3 沙箱无法完全防止侧信道

这是沙箱设计的根本局限之一：

```
沙箱能防止：           沙箱通常无法防止：
  直接读取 /etc/passwd   通过缓存侧信道推断内存内容
  执行 execve            通过 gettimeofday 实现计时攻击
  建立网络连接           通过共享 CPU 缓存泄露信息
  写入任意文件           通过内存访问模式推断密钥
```

缓解侧信道的手段通常在硬件或内核层面（如 KPTI 内核页表隔离、降低计时器精度）。

## 5. 最小权限原则

> **最小权限原则（Principle of Least Privilege）**：每个程序、用户、进程应该只拥有完成其任务所必需的最小权限，不多一点。

类比：超市收银员只需要收银机的操作权限，不需要仓库管理系统的访问权限。即使收银员"出问题"（被黑客控制），能造成的伤害也被限制在收银相关操作内。

### 5.1 Firecracker 的极端示例

Firecracker microVM 只允许 24 个系统调用：

```
Firecracker 允许的 24 个系统调用（来自 Firecracker NSDI 2020 论文）：

基本内存：
  brk, mmap, munmap, mprotect
  mremap, mincore, madvise

基本 I/O：
  read, write, pread64, pwrite64
  recvfrom, sendto, readv, writev

文件描述符：
  close, dup, dup2, ioctl
  epoll_create, epoll_ctl, epoll_wait

线程/进程：
  exit, exit_group, futex, sched_yield, tkill

以上是完整列表（24 个）
其他约 300 个系统调用全部被 KILL 阻断
```

为什么是 24 个？因为 Firecracker 的功能极其专注：

```
Firecracker 需要做的事：
  ✓ 从 KVM 读取 VM exit 信息（read/ioctl）
  ✓ 向 Guest 内存写入数据（mmap + write/pwrite）
  ✓ 管理 virtio 设备的 I/O（read/write/epoll）
  ✓ 管理内存（mmap/munmap/mprotect）
  ✓ 线程同步（futex）
  ✓ 退出（exit/exit_group）

Firecracker 不需要：
  ✗ 打开新文件（openat）→ 所有文件在启动时就已打开
  ✗ 网络连接（socket/connect）→ 网络通过 virtio 设备模拟
  ✗ 创建子进程（fork/clone）→ 不需要
  ✗ 执行程序（execve）→ 绝对不需要
```

### 5.2 最小权限 vs 可用性的权衡

```
权限越小 → 攻击面越小 → 越安全
权限越小 → 限制越多   → 越多合法功能无法使用

Python 解释器启动需要的系统调用（strace 实测）：
  约 50~80 个不同的 syscall
  包括：openat（加载模块）、mmap（内存分配）
        read/write（文件操作）、socket（某些模块）
        clone（线程）、futex（线程同步）...

Firecracker 的 24 个 syscall 根本不够运行 Python！

Shimmy Sandbox 的取舍：
  目标是在 Lambda 环境里运行任意用户代码（包括 Python）
  需要允许足够多的 syscall 让代码能运行
  同时拦截危险的 syscall 序列（如 socket+connect）
  → 这是一个细粒度的、带参数分析的过滤，比 seccomp 更复杂
```

### 5.3 如何量化攻击面

**度量 1：允许的系统调用数量**

```
越少越好，但有下限（程序必须能运行）

工具：
  strace -c ./my_program   # 统计各系统调用的调用次数
  seccomp-tools dump ./    # 分析已有的 seccomp 过滤器
  syscall-table           # 查看系统调用号和名称的对应关系
```

**度量 2：暴露的内核代码路径**

```
每允许一个系统调用，就暴露了相应内核代码的攻击面。

估算方法：
  $ grep -c "SYSCALL_DEFINE" linux/*/syscall*.c
  (统计每个系统调用的代码行数)

  或者：使用 sysfilter 工具自动分析
  (https://github.com/apf/sysfilter)
```

**度量 3：攻击面的"深度"**

```
不仅仅是 syscall 数量，还要考虑：
  - 每个允许的 syscall 处理多少来自用户的可控输入？
  - 该 syscall 的内核实现有多少已知漏洞历史？

举例：
  getpid()   → 输入：无  → 风险极低
  openat()   → 输入：路径字符串（用户完全可控）→ 风险较高
  ioctl()    → 输入：大量结构体（复杂语义）→ 风险高
```

## 6. 沙箱逃逸的常见类别

### 6.1 内核漏洞利用

```
路径：
  用户代码 → 系统调用 → 内核代码 → 漏洞 → 内核态代码执行 → 逃逸

代表案例：
  CVE-2022-0847（Dirty Pipe）
    → Linux 管道实现的漏洞 → 任意文件覆盖 → 容器逃逸
  CVE-2019-5736（runc 漏洞）
    → Docker 容器可以覆盖宿主机的 runc 可执行文件 → 逃逸
```

### 6.2 Hypervisor/VMM 漏洞

```
路径：
  Guest 代码 → 与虚拟设备交互 → Hypervisor 漏洞 → 宿主机代码执行

代表案例：
  CVE-2015-3456（VENOM）→ QEMU FDC 漏洞 → VM 逃逸
  CVE-2019-14378（QEMU）→ slirp 网络堆溢出 → VM 逃逸
```

### 6.3 逻辑绕过

```
路径：
  利用安全策略的"歧义"或"遗漏" → 合法调用序列完成危险操作

例子（time-of-check time-of-use）：
  /tmp/safe 被检查 ✓
  /tmp/safe 被替换为 /etc/passwd 的符号链接
  /tmp/safe 被读取 → 实际读取 /etc/passwd！

例子（io_uring 绕过）：
  安全策略拦截了 openat syscall
  但 io_uring 允许通过环形缓冲区异步执行 openat
  → 绕过了 syscall 拦截
```

### 6.4 侧信道攻击

```
路径：
  不需要突破任何访问控制
  通过观察共享资源的状态（缓存、时序）推断秘密

典型场景：
  云服务上的"恶意邻居"攻击：
  VM A 和 VM B 运行在同一台物理服务器上
  VM A 通过缓存侧信道推断 VM B 的内存内容（如加密密钥）
  → 即使 VM 之间有完整的内存隔离，侧信道仍然存在
```

## 小结

```
攻击面 = 系统向外暴露的所有可能被攻击的入口点

三类主要攻击面：
  syscall 攻击面 → 内核代码中的漏洞
  内存攻击面    → 缓冲区溢出、UAF 等
  侧信道攻击面  → 缓存时序、电磁辐射等物理特性

最小权限原则：
  只给程序完成任务所必需的最小权限
  Firecracker 的极端实践：只允许 24 个 syscall

量化攻击面的指标：
  允许的 syscall 数量（越少越好）
  暴露的内核代码行数
  每个接口接受的可控输入量

沙箱逃逸的四类路径：
  内核漏洞利用
  Hypervisor/VMM 漏洞
  逻辑绕过（TOCTOU、io_uring、...）
  侧信道攻击（软件沙箱无法完全防止）
```

## 与 Shimmy/沙箱设计的联系

攻击面分析是 Shimmy 设计决策的理论基础：

1. **为什么要禁止 execve、socket、io_uring_setup**：这些是攻击面最大的系统调用。即使不能做到 Firecracker 那样只允许 24 个，也要把最高危的入口点封闭。

2. **为什么 DBI 优于 seccomp**：seccomp 只能看 syscall 号（浅层），DBI 可以读取参数内容（更深层）。DBI 可以检查 `openat("/etc/passwd")` 而不是仅仅检查 `openat`，从而实现更精细的攻击面控制。

3. **io_uring 是 Shimmy 的挑战**：`io_uring` 创造了一个绕过 `syscall` 指令路径的异步攻击面，Shimmy 必须专门拦截 `io_uring_setup` 和 `io_uring_enter`，并验证提交队列中的操作。

4. **侧信道是 Shimmy 的局限**：Shimmy 不能防止 Spectre/Meltdown 类侧信道——这需要硬件和 OS 层面的防御。这是 Shimmy 研究论文中明确承认的局限之一。

理解攻击面分析能帮助你评估任何安全方案的有效性：不是"能不能防所有攻击"（没有方案能做到），而是"把最大的攻击面减小到什么程度，代价是什么"。
