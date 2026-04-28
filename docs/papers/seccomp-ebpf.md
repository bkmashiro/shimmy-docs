# 使用 eBPF 实现可编程系统调用安全

**作者：** Jinghao Jia, YiFei Zhu, Dan Williams, Andrea Arcangeli, Claudio Canella, Hubertus Franke, Tobin Feldman-Fitzthum, Dimitrios Skarlatos, Daniel Gruss, Tianyin Xu（UIUC / Google / Virginia Tech / Red Hat / AWS / IBM Research / CMU / Graz University of Technology）  **发表于：** arXiv  **年份：** 2023

---

## 前置知识

- 了解系统调用（syscall）和 seccomp 过滤的基本概念
- 知道什么是 BPF（伯克利数据包过滤器）
- 理解"有状态"与"无状态"过滤的区别

## 你将学到

- 经典 seccomp-cBPF 的根本局限在哪里
- eBPF 如何通过状态管理和辅助函数弥补这些不足
- 什么是"时间专业化"（temporal specialization）
- 为什么无法检查指针参数是一个严重的安全漏洞

---

## 摘要

本文提出 Seccomp-eBPF，一种可编程系统调用过滤机制，克服了现有 Seccomp-cBPF 的根本局限：无状态性、表达能力有限、无法解引用指针参数以及没有同步原语。通过引入新的 eBPF 程序类型 `BPF_PROG_TYPE_SECCOMP` 以及精心设计的状态管理、用户内存访问和系统调用序列化辅助函数，Seccomp-eBPF 实现了时间专业化，与静态 cBPF 过滤器相比额外减少 33–55% 的系统调用攻击面，同时维持与优化后的 cBPF 相当的性能。

## 核心思想

> **💡 什么是 seccomp？**
> seccomp（SECure COMPuting）是 Linux 内核的系统调用过滤模块。程序可以安装一个"过滤器"，在每次系统调用发生前运行——根据规则决定允许通过、返回错误码、或直接杀死进程。Docker、Chrome 等都大量使用 seccomp 来限制容器/沙箱的系统调用权限。

- **`BPF_PROG_TYPE_SECCOMP`**：新的 eBPF 程序类型，其允许的辅助函数和能力要求在加载时由 eBPF 验证器检查。
- **五类辅助函数**：状态管理（eBPF 映射 + 安全任务存储）、序列化（`bpf_wait_syscall`）、用户内存访问（`bpf_safe_read_user`）、内核访问（`bpf_ktime_get_ns`）和 eBPF 特性（`bpf_tail_call`）。
- **时间专业化**：由于 eBPF 程序可以维护状态，过滤器可以在初始化阶段和服务阶段强制执行不同的系统调用白名单——这是无状态 cBPF 不可能实现的。
- **安全用户内存访问**：通过将目标内存复制到仅内核可访问的区域，或在检查期间对目标用户内存区域进行写保护，来避免 TOCTTOU 竞争。
- **系统调用序列化**：`bpf_wait_syscall` 使用每系统调用的原子计数器和调度循环，防止特定系统调用对并发执行，缓解像 CVE-2016-5195（Dirty COW）这样的内核竞争条件。
- **防篡改**：`seccomp()` 在返回前关闭 eBPF 程序 FD；用户必须在调用 `seccomp()` 前关闭所有映射 FD。

## 与 Shimmy 的关联

对于 Shimmy 的自托管层，Seccomp-eBPF 相对于静态 cBPF 过滤器提供了两项直接改进。首先，**时间专业化**让 Shimmy 可以在沙箱初始化完成后应用严格的服务阶段白名单（例如，在学生代码开始后阻塞 `exec`、`mmap`），无需兼容性代价地将攻击面减少 33–55%。其次，**有状态调用计数**让 Shimmy 可以限制危险系统调用的次数（例如，将每次调用的 `clone` 限制为固定次数），无需内核补丁。

对于 Lambda 模式，Seccomp-eBPF 不可用：seccomp 安装在 Lambda 内被阻塞，且该补丁尚未合入主线内核。然而，时间专业化概念直接启发了 Shimmy 基于 WASM 的沙箱设计——WASM 的宿主函数接口在语言层面提供了等效的"阶段感知"能力暴露。CVE 缓解数据也验证了 Shimmy 偏好内核版本感知沙箱设计的正确性。

## 详细说明

### 问题与动机

> **💡 什么是 cBPF 和 eBPF？**
> cBPF（classic BPF，经典 BPF）是最初的 BPF 实现——一种简单的虚拟机，只有几个寄存器和很少的指令，适合编写简单的包过滤规则。eBPF（extended BPF，扩展 BPF）是其现代进化版：有更多寄存器、可以调用内核辅助函数、支持数据结构（映射）、有 JIT 编译器——本质上是内核内的安全可编程沙箱，功能强大得多。seccomp 目前只用 cBPF，本文提议升级到 eBPF。

Linux 的 seccomp 是部署最广泛的系统调用过滤机制——被 Docker、Kubernetes、gVisor、Firecracker 和 Android 使用。但它使用的经典 BPF（cBPF）语言有根本局限：

1. **无状态**：过滤器输出仅取决于系统调用号和参数值，而非之前的执行历史。无法实现调用计数、基于阶段的策略或序列检查。
2. **表达能力有限**：cBPF 过于简单，无法调用内核辅助函数或使用哈希表等数据结构。4096 条指令的限制迫使复杂策略链接多个过滤器，产生间接跳转开销（Retpoline 加剧）。
3. **无法解引用指针**：不能对指针类型参数进行深层参数检查（DPI）——例如，无法检查 `open()` 中的文件名字符串。
4. **无同步原语**：无法序列化并发系统调用以缓解内核竞争漏洞。

Seccomp Notifier 机制（用户态决策代理）解决了表达能力问题，但引入了严重的上下文切换开销和 TOCTTOU 竞争。

这些限制在实践中迫使采用过于宽松的策略：容器运行时必须在整个容器生命周期内允许 `exec`，即使它只在初始化期间需要。

### 设计与架构

> **💡 什么是 TOCTTOU 竞争？**
> TOCTTOU（Time-Of-Check-To-Time-Of-Use，检查时与使用时之间的竞争）是一种竞争条件漏洞。程序检查某个值（如文件路径）时看到 A，但实际使用时这个值已经被恶意修改为 B。就像你检查了门锁是安全的，但在你走进门的那一秒，有人换了锁。seccomp 过滤器检查系统调用参数时，程序可以在检查后、内核使用前修改这些参数。

**新 eBPF 程序类型**：

三步工作流：
1. **加载**：通过 `bpf()` 系统调用提交 eBPF 字节码；验证器检查辅助函数使用和 seccomp 数据结构访问边界；可选 JIT 编译。
2. **安装**：用新标志 `SECCOMP_FILTER_FLAG_EXTENDED` 调用 `seccomp()`；内核在返回前关闭 eBPF 程序 FD。
3. **运行**：每个后续系统调用都触发已安装的 eBPF 过滤器。

**辅助函数类别**：

| 类别 | 辅助函数 | 备注 |
|----------|-----------------|-------|
| 状态管理 | `bpf_map_lookup_elem`、`bpf_map_update_elem`、`bpf_map_delete_elem` | 标准 eBPF 映射（数组、哈希表）|
| 状态管理 | `bpf_safe_task_storage_get`、`bpf_safe_task_storage_del` | 修改以避免内核指针泄露 |
| 序列化 | `bpf_wait_syscall` | 新辅助函数；原子计数器 + 调度循环 |
| 用户内存访问 | `bpf_safe_read_user`、`bpf_safe_read_user_str` | TOCTTOU 安全；复制到内核区域或写保护 |
| 内核访问 | `bpf_ktime_get_ns` | 现有辅助函数暴露 |
| eBPF 特性 | `bpf_tail_call` | 现有辅助函数暴露 |

**安全任务存储**：

现有的 `bpf_task_storage_get` 需要通过 `bpf_get_current_task_btf` 获取的 `task_struct` 指针，这需要 `CAP_BPF` 和 `CAP_PERFMON`。更糟糕的是，`task_struct` 包含指向父进程的指针，可以递归遍历到 init（PID 0）来泄露敏感内核数据。新的 `bpf_safe_task_storage_get` 自动查找当前任务的组长，不需要 `task_struct` 指针输入，消除了泄露路径。

**安全用户内存访问**：

两种实现选项：
1. 在检查前将目标用户内存复制到仅内核可访问的区域。
2. 在检查期间对目标用户内存区域进行写保护，防止用户态访问。

安全性降低到 Seccomp Notifier 威胁模型（等同于 ptrace）。对于不可转储进程（如 OpenSSH），只有具有 `CAP_SYS_PTRACE` 的加载器才能访问进程内存。

**系统调用序列化**：

每个系统调用有一个内核侧原子计数器，跟踪当前有多少线程正在执行它。`bpf_wait_syscall(curr_nr, target_nr)` 递增当前系统调用的计数器，然后通过调度循环忙等待，直到目标系统调用的计数器降为零。对于全系统序列化策略，过滤器安装在 init 进程上并由所有子进程继承。冲突系统调用对集合存储在 eBPF 映射中，过滤器安装后可由特权用户态进程更新，实现对新发现竞争漏洞的零重启缓解。

**防篡改**：

- `seccomp()` 在返回用户态前自动关闭 eBPF 程序 FD。
- 用户通过 `bpf_seccomp_close_fd` 在调用 `seccomp()` 前关闭所有映射 FD。关闭 FD 不删除映射——映射通过 eBPF 程序本身的引用计数保持存活。
- 命名空间追踪：过滤器在加载时记录用户命名空间，在安装时验证，阻止攻击者通过创建新命名空间绕过能力检查。

### 评估

**硬件**：Intel i7-9700K，8 核 3.60 GHz，32 GB RAM，Ubuntu 20.04，Linux 5.15.0-rc3。

**时间专业化**（6 个服务器应用程序，两个阶段：初始化 P1 + 服务 P2）：

| 应用程序 | \|S_init\| | \|S_serv\| | \|S_comm\| | 总允许 | 攻击面减少 |
|-------------|-----------|-----------|-----------|---------------|--------------------------|
| HTTPD | 71 | 83 | 47 | 107 | 33.6% |
| NGINX | 52 | 93 | 36 | 109 | 52.3% |
| Lighttpd | 46 | 78 | 25 | 99 | 53.5% |
| Memcached | 45 | 83 | 27 | 101 | 55.4% |
| Redis | 42 | 84 | 33 | 93 | 54.8% |
| Bind | 75 | 113 | 53 | 135 | 44.4% |

cBPF 必须在整个生命周期内允许 S_init ∪ S_serv。eBPF 在初始化期间只允许 S_init，在服务期间只允许 S_serv——差异是总攻击面的 33.6–55.4%。

**漏洞缓解**：

| CVE | 攻击模式 | 涉及系统调用 | eBPF 防御 |
|-----|---------------|-------------------|--------------|
| CVE-2016-0728 | 重复系统调用 | keyctl | 计数器限制 |
| CVE-2019-11487 | 重复系统调用 | io_submit | 计数器限制 |
| CVE-2017-5123 | 重复系统调用 | waitid | 计数器限制 |
| BusyBox Bug #9071 | 系统调用序列 | socket → exec/mprotect | 系统调用流完整性保护（SFIP）|
| CVE-2018-18281 | 竞争系统调用 | mremap, ftruncate | 序列化 |
| CVE-2016-5195（Dirty COW）| 竞争系统调用 | write/ptrace + madvise | 序列化 |
| CVE-2017-7533 | 竞争系统调用 | fsnotify, rename | 序列化 |

**微基准测试**（策略：拒绝 245 个系统调用，允许其余包括 getppid）：

| 过滤器类型 | getppid 时间（周期）| 过滤器开销（周期）|
|-------------|----------------------|--------------------------|
| 无过滤器 | 244.18 | 0 |
| cBPF（默认 libseccomp）| 493.06 | 214.19 |
| cBPF（优化版）| 329.47 | 68.68 |
| eBPF | 331.73 | 60.18 |
| 常量动作位图 | 297.60 | 0 |
| Seccomp Notifier | 15045.05 | 59.29 |

eBPF 性能与优化后的 cBPF 相当（两者都使用二分搜索）。Seccomp Notifier 比 eBPF 慢 45.4 倍。

**应用基准测试**（6 个服务器应用程序）：eBPF 和 cBPF 的性能影响相当。纯 Notifier 方案增加 48–188% 平均延迟，吞吐量降低 32–65%。

**Draco 缓存加速**：使用 eBPF 缓存最近验证的（系统调用 ID，参数值）对，在三个 Web 服务器上带来约 10% 吞吐量提升。

### 实现细节

- **平台**：带补丁的 Linux 内核 v5.15.0-rc3；尚未合入主线。
- **可睡眠过滤器**：新 BPF 节名称（`seccomp` 和 `seccomp-sleepable`），用于处理用户内存访问期间的页面错误。
- **容器运行时集成**：修改 `crun`（Podman 的默认运行时）以支持 Seccomp-eBPF。附加 eBPF 过滤器只需一个注解：`podman --runtime /usr/local/bin/crun run --annotation run.oci.seccomp_ebpf_file=ebpf_filter.o`
- **过滤器编写**：过滤器可以用 C 或 Rust 编写，通过 LLVM/Clang 编译为 eBPF 字节码。
- **权限配置**：sysctl 选项将 Seccomp-eBPF 限制为仅 `CAP_SYS_ADMIN`。
- **代码库**：https://github.com/xlab-uiuc/seccomp-ebpf-upstream

### 局限

1. **未合入主线**：Linux 社区仍持怀疑态度；一些维护者认为"seccomp 不需要 eBPF"。作者在 LPC 2022/2023 上进行了演讲以推进讨论。
2. **非特权 eBPF 风险**：eBPF 验证器和 JIT 编译器历史上有可被恶意程序利用的 bug。sysctl 选项将 Seccomp-eBPF 限制为特权使用以作缓解。
3. **无自动过滤器生成**：编写 eBPF 过滤器需要手动工作；没有从应用程序配置文件自动生成的工具。
4. **序列化性能**：基于忙等待的系统调用序列化可能降低高并发性能；论文未对此进行广泛评估。
5. **与 LSM 互补，非替代**：seccomp 在系统调用入口点过滤；LSM 钩子深入内核对象访问路径。完整策略覆盖需要两者。

### 术语表

- **seccomp（SECure COMPuting）**：Linux 内核的系统调用过滤模块，广泛用于容器和沙箱
- **cBPF（经典 BPF）**：经典 BPF——无状态的简单指令集；现有的 seccomp 过滤语言
- **eBPF（扩展 BPF）**：扩展 BPF——Linux 内核的通用可编程框架，具有映射、辅助函数和 JIT 编译
- **时间专业化（temporal specialization）**：在应用程序生命周期的不同阶段应用不同的系统调用策略（如初始化 vs. 服务）
- **TOCTTOU（检查时到使用时）**：用户态在过滤器检查后但内核使用前修改某值的竞争条件
- **DPI（深层参数检查）**：解引用指针类型系统调用参数以检查其实际内容
- **SFIP（系统调用流完整性保护）**：使用状态机验证系统调用序列是否符合预期控制流
- **Notifier**：seccomp 的用户态代理机制，将系统调用决策转发给用户态进程
- **任务存储**：维护每个 Linux 任务键值存储的 eBPF 映射类型
- **NO_NEW_PRIVS**：Linux 进程属性，确保 exec 不能获取新权限；非特权 seccomp 过滤器的前提条件
