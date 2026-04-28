# SoK 综述：在受限无服务器环境中对不可信代码进行沙箱处理

**Yuzhe · Imperial College London · 2026**

## 前置知识

- 了解 AWS Lambda 是什么（托管的函数执行平台）
- 知道什么是沙箱（sandbox）以及为什么要隔离不可信代码
- 理解进程、系统调用和虚拟机的基本概念

## 你将学到

- 什么是"嵌套沙箱问题"以及为什么在 Lambda 中特别棘手
- 五大沙箱机制范式及其在 Lambda 中的可用性
- 五条具体实施路径的安全性与开销权衡
- 最关键的未解决威胁（io_uring）和最有希望的近期改进（Landlock）
- Lambda、自托管 Linux 和 macOS 上的推荐分层架构

---

## 嵌套沙箱问题

> **💡 什么是嵌套沙箱问题？**
> AWS Lambda 使用 Firecracker microVM 为不同租户提供强隔离——每个 Lambda 函数在自己的轻量级虚拟机中运行。但正是这种安全设计，给需要在 Lambda 函数*内部*进一步隔离不可信代码的应用带来了悖论：为了保护 Firecracker 自身，Lambda 屏蔽了所有主流沙箱工具所需的内核原语。结果就是：外层沙箱（Firecracker）故意阻止了内层沙箱的构建。

AWS Lambda 通过 Firecracker microVM 为租户之间提供强隔离。但这种安全姿态给需要在单一租户函数*内部*对不可信代码进行沙箱处理的应用创造了悖论：平台有意屏蔽了沙箱工具所需的原语。教育自动评测系统、在线评测和 AI 智能体框架都需要在超出 Lambda 本身强制范围的限制下执行用户提供的代码——却发现无法使用 gVisor、bubblewrap、nsjail、seccomp、ptrace 或任何主流 Linux 沙箱工具。

这就是**嵌套沙箱问题**：外层沙箱（Firecracker）故意阻止构建内层沙箱，以减少其自身的攻击面。

## Lambda 的约束概况

在 Lambda 内部，以下原语被屏蔽（返回 EPERM）：

`prctl(PR_SET_NO_NEW_PRIVS)` · `seccomp(SECCOMP_SET_MODE_FILTER)` · `ptrace()` · `clone(CLONE_NEWUSER)` · `chroot()` · `mount()` · eBPF 加载 · `prctl(PR_SET_PDEATHSIG)` · `/dev/kvm`

唯一可用的进程限制原语是 `setrlimit()`/`prlimit()`。guest 内核是 **Linux 5.10**，使 Landlock（需要 5.13+）和 Syscall User Dispatch（需要 5.11+）无法使用。所有进程以 uid 993 运行；`/tmp` 在热调用间持久化。

## 沙箱机制分类法

本文按四个维度组织机制：**强制机制**（内核、虚拟机监控程序、翻译器或解释器）、**隔离粒度**（系统调用、进程、VM 或语言）、**信任边界**（隔离成立时必须正确的组件）和 **Lambda 兼容性**（原生、部分、被屏蔽或未来可用）。

五大范式浮现：

1. **内核介导**（seccomp-BPF、Landlock、命名空间）：最强保证，需要内核支持 → 在 Lambda 中全部被屏蔽
2. **虚拟机监控程序介导**（Firecracker、QEMU/KVM、gVisor）：硬件支持的隔离 → 仅作为 Lambda 的外层边界或无 KVM 的 QEMU（极慢）可用
3. **翻译器介导**（DynamoRIO、QEMU 用户模式、zpoline）：用户空间二进制插桩 → 部分可用；DynamoRIO 可能工作，zpoline 被 mmap_min_addr 屏蔽
4. **解释器介导**（WASM/wazero、Goja、Deno）：语言运行时限制操作 → 完全可用，跨平台最佳方案
5. **资源限制**（rlimits、cgroups）：无过滤的上限控制 → 部分可用（rlimits 工作；cgroups 需要 CAP_SYS_ADMIN）

## 评估的五条实施路径

本文按八个设计目标（资源控制、系统调用限制、文件系统隔离、网络隔离、凭证保护、跨平台、语言覆盖、低开销）评估五条具体路径：

| 路径 | 核心技术 | G1 资源 | G2 系统调用 | G3 文件系统 | G4 网络 | 开销 |
|------|---------------|:-----------:|:----------:|:-------------:|:----------:|---------|
| A | rlimits + 环境清理 | ✓ | ✗ | ✗ | ✗ | ~0% |
| B | wazero WASM 沙箱 | ✓ | ✓ | ✓ | ✓ | 1.5–8× |
| C | Goja（纯 Go JS 引擎） | 部分 | ✓ | ✓ | ✓ | ~20× vs V8 |
| D | DynamoRIO（LD_PRELOAD） | 部分 | ✓ | 部分 | 部分 | 1.1–1.3× |
| E | QEMU 用户模式 | 部分 | 部分 | ✗ | ✗ | 2–5× |

路径 A（rlimits）是所有其他路径的必要基础，但不提供系统调用限制。路径 B（WASM）提供最佳安全属性——无需任何内核特性的架构级隔离，通过构造满足所有五个安全目标，并有形式化验证结果（WaVe、VeriWasm）支撑其声明。主要限制是 Python-in-WASM 启动开销（500 ms–2 s）以及缺乏 NumPy/C 扩展支持。路径 D（DynamoRIO）将覆盖范围扩展到任意 ELF 二进制文件，开销仅 10–30%，弥补了无法预编译为 WASM 的 C/Python 代码的差距。

## 关键发现

**六种方案被明确屏蔽：** gVisor（所有平台）、Kata/Sysbox/嵌套 Firecracker、所有无根容器运行时（runc、crun、Podman、bubblewrap）、Cosmopolitan pledge()、Intel Pin 和 SIGSYS-without-seccomp。

**八种方案可行：** WebAssembly/wazero、每次执行一个 Lambda、QEMU 系统模式（较慢）、DynamoRIO、Deno、QEMU 用户模式、LFI（ARM64）和静态二进制重写（离线）。

**io_uring 是最关键的未解决威胁：** Google kCTF VRP 42 个内核漏洞中 60% 针对 io_uring。任何基于 seccomp 的沙箱都必须屏蔽 `io_uring_setup/enter/register`。在 Lambda 中，Firecracker 的宿主端过滤器可能处理了这个问题——但必须验证。

**Landlock 是最有希望的近期改进：** 当 Lambda 将其 guest 内核升级到 5.13+ 时，Landlock 将可用于非特权文件系统限制，无需任何当前被屏蔽的原语。

## 推荐架构

没有单一机制能在 Lambda 内满足所有设计目标。最强的实用架构分层如下：

1. **每次执行一个 Lambda**，置于无互联网访问、最小 IAM、紧超时的 VPC 中——Firecracker 提供外层硬件隔离边界
2. **路径 A 始终启用** — rlimits、环境清理、每次执行的 /tmp 隔离、进程组管理
3. **路径 B 用于支持的语言** — 对 JS（QuickJS-WASM）和预编译代码，使用无 WASI 能力的 wazero；纯 Python 使用 CPython-WASI
4. **路径 D 用于任意二进制文件** — 对无法预编译为 WASM 的 C/Python，使用 LD_PRELOAD 模式的 DynamoRIO

在**自托管 Linux** 上，完整栈变为可用：通过 `elastic/go-seccomp-bpf` 的 seccomp-BPF、通过 `landlock-lsm/go-landlock` 的 Landlock，以及带 Go 绑定的 syd/sydbox 用于监督系统调用执行。在 **macOS 开发环境**上，系统优雅降级为 rlimits + 嵌入式运行时。

最值得探索的机会是**已验证的 WASM 运行时**（WaVe、可证明安全的编译器）结合编译为 WASM 的语言解释器，在所有部署环境中提供可证明安全的沙箱处理，无内核依赖。
