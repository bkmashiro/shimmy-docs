# SoK：在受限无服务器环境中对不可信代码进行沙箱处理

**Yuzhe · Imperial College London · 2026**

---

## 前置知识

- 了解 AWS Lambda 和无服务器计算的基本概念
- 知道什么是进程、系统调用和虚拟机（VM）
- 理解为什么执行不可信代码需要隔离
- 对 Linux 安全机制（seccomp、命名空间、cgroups）有基本认知

## 你将学到

- 什么是"嵌套沙箱问题"以及 Lambda 为何特别棘手
- 五大沙箱机制范式及各自的信任边界
- 14 种候选方案中哪 8 种可行、哪 6 种被明确屏蔽
- io_uring 为何是最关键的未解决安全威胁
- 如何构建在 Lambda、自托管 Linux 和 macOS 上都有效的分层架构

---

## 摘要

在 AWS Lambda 等无服务器环境中运行不可信代码存在一个根本性矛盾：平台自身的隔离机制——Firecracker microVM——屏蔽了几乎所有传统沙箱工具依赖的内核原语。seccomp 过滤器安装、ptrace、用户命名空间、chroot 和 eBPF 在 Lambda 内部全部不可用，消除了 gVisor、bubblewrap、nsjail、minijail、firejail 以及所有主流 Linux 沙箱工具。本文通过对五种隔离范式——内核介导的系统调用过滤、操作系统级命名空间/容器隔离、硬件辅助虚拟化、用户态二进制插桩和语言运行时沙箱——的 14 种候选方案进行评估，系统化了适用于受限无服务器环境的沙箱技术全景。我们基于四个维度建立分类法：强制机制（内核、虚拟机监控程序、翻译器或解释器）、隔离粒度（系统调用、进程、VM 或语言）、信任边界（隔离成立时必须正确的组件）以及部署约束（所需的内核原语）。通过对 AWS Lambda 约束概况的系统评估，我们确定了 8 种可行方案和 6 种被明确屏蔽的方案。我们进一步分析了五条具体实施路径——带环境清理的 rlimits、通过 wazero 的 WebAssembly、通过 Goja 的嵌入式 JavaScript 解释、通过 DynamoRIO 的动态二进制插桩、以及 QEMU 用户模式翻译——将每条路径映射到其研究传承并量化安全性能权衡。我们的关键发现是，没有单一机制能在 Lambda 内部提供完整隔离；最强的实用架构将多种技术分层，其中 WebAssembly（WASM）为支持的语言提供最佳安全复杂度比，动态二进制插桩以适中开销提供最广泛的语言覆盖。最后，我们给出在 Lambda、自托管 Linux 和 macOS 开发环境中优雅降级的分层架构。

---

## 1. 引言

执行不可信代码是系统安全中最古老的问题之一。从最早的分时系统，到 Java applet、浏览器沙箱，再到现代云函数，根本挑战始终如一：如何在允许计算的同时防止危害。随着无服务器计算、AI 生成代码执行和教育平台（学生提交的代码需要自动评测）的兴起，这一挑战愈加紧迫。

> **💡 什么是 AWS Lambda 和 Firecracker？**
> AWS Lambda 是亚马逊的无服务器计算平台：你上传一段代码，Lambda 在需要时运行它，你只为实际执行时间付费，无需管理服务器。Lambda 的安全核心是 Firecracker——一种专为无服务器设计的轻量级虚拟机监控程序。每个 Lambda 函数运行在自己的 Firecracker microVM 中，拥有独立的内核，与其他租户的代码完全隔离。这种设计非常安全，但问题在于：为了保护 Firecracker 自身，它屏蔽了几乎所有用于在内部构建更多沙箱的工具。

AWS Lambda 是主流无服务器平台，通过 Firecracker microVM [1] 提供强租户间隔离。每次 Lambda 调用都在由 KVM 支持的轻量级虚拟机中运行，拥有专用 guest 内核、最小化的设备模型和宿主端 seccomp 过滤器。这种架构有效防止了跨租户攻击——在一个客户的 Lambda 函数中运行的代码无法访问另一个客户的数据或计算。

然而，Lambda 的隔离模型给需要在单一租户函数*内部*对不可信代码进行沙箱处理的应用创造了悖论。教育自动评测系统、在线评测、AI 智能体框架和工作流自动化工具都需要在超出 Lambda 本身强制范围的限制下执行用户提供或机器生成的代码。问题是，Lambda 为了最小化 Firecracker 攻击面而设计的 guest 端安全策略，屏蔽了沙箱工具所需的原语：

- `prctl(PR_SET_NO_NEW_PRIVS)` 返回 EPERM，阻止安装 seccomp 过滤器 [2, 3]
- 带 `CLONE_NEWUSER` 的 `clone()` 返回 EPERM，屏蔽所有基于命名空间的工具 [4]
- `ptrace()` 被明确屏蔽 [5]
- `/dev/kvm` 不暴露，阻止嵌套虚拟化 [1]
- `chroot()` 需要不可用的 CAP_SYS_CHROOT [6]
- eBPF 需要 Lambda 进程未获授予的高级能力 [7]

这形成了我们所称的*嵌套沙箱问题*：外层沙箱（Firecracker）故意阻止构建内层沙箱，以减少其自身的攻击面。结果是每个主流 Linux 沙箱工具在 Lambda 内部都失效。

本文的贡献如下：

1. 一个跨五种范式的沙箱机制系统分类法，针对 AWS Lambda 的特定约束概况评估。
2. Lambda 内部可用与被屏蔽的内核原语实证目录。
3. 对 14 种候选沙箱方案的比较评估，将 8 种分类为可行，6 种为被明确屏蔽。
4. 将五条实施路径映射到其研究传承。
5. 在部署环境间优雅降级的分层架构。

---

## 2. 背景与威胁模型

### 2.1 Lambda 执行环境

AWS Lambda 函数在裸金属 EC2 Nitro 实例上运行的 Firecracker microVM 中执行 [1]。每个 microVM 运行一个 guest Linux 内核（截至 2026 年 3 月，通过 `k510ga` 平台标签识别为版本 5.10）。函数代码以用户 `sbx_user1051`（uid 993）运行。`/var/task`（函数代码）、`/var/runtime` 和 `/opt`（层）处的文件系统为只读；只有 `/tmp` 可写。

Lambda 在后续调用同一函数时复用执行环境（"热启动"）。这意味着 `/tmp` 内容、全局变量和进程状态在调用间持久化——这在函数执行来自不同用户的不可信代码时是重大安全隐患。

**确认被屏蔽的原语：**

| 原语 | 错误 | 含义 |
|-----------|-------|-------------|
| `prctl(PR_SET_NO_NEW_PRIVS)` | EPERM | 阻止非特权 seccomp-bpf |
| `seccomp(SECCOMP_SET_MODE_FILTER)` | EPERM | 无系统调用过滤 |
| `ptrace()` | EPERM | 无基于调试器的插桩 |
| `clone(CLONE_NEWUSER)` | EPERM | 无用户命名空间 |
| `chroot()` | EPERM | 无文件系统根切换 |
| `mount()` | EPERM | 无私有 /proc |
| eBPF 加载 | EPERM | 无内核插桩 |
| `prctl(PR_SET_PDEATHSIG)` | EPERM | 无父进程死亡信号 |

**确认可用的原语：**

| 原语 | 备注 |
|-----------|-------|
| `setrlimit()` / `prlimit()` | 标准非特权资源限制 |
| `fork()` / `exec()` | 正常子进程创建 |
| `/proc` 文件系统 | 可读，包括凭证 |
| `/tmp` 写入 | 在热调用间持久化 |
| `mprotect(PROT_EXEC)` | 可能可用（V8/JIT 工作） |

guest 内核是 Linux 5.10，这意味着 **Landlock**（需要 5.13+）和 **Syscall User Dispatch**（需要 5.11+）不可用。Amazon Linux 2023 为内核 6.1+ 启用了 `CONFIG_SECURITY_LANDLOCK`，未来的 Lambda 内核升级可能改变这一点。

### 2.2 威胁模型

一个学生提交代码进行自动评测的教育平台（"Lambda Feedback"）。攻击者是一个学生，具有：

- 在支持的语言（Python、C、JavaScript）中的任意代码执行能力
- 执行环境知识（Lambda、Linux 5.10、uid 993）
- 对 /proc 的访问，包括 `/proc/self/environ`（AWS 凭证）和 `/proc/self/maps`
- 向 /tmp 写入并可能影响后续调用的能力

攻击目标：
1. **数据外泄**：读取其他学生的提交、AWS 凭证或函数源代码
2. **资源耗尽**：fork 炸弹、内存炸弹、磁盘填满、CPU 独占
3. **横向移动**：利用 AWS 凭证访问其他 AWS 服务
4. **持久化**：修改 /tmp 或环境以影响后续调用
5. **容器逃逸**：突破 Lambda 执行环境

对 Firecracker 本身的宿主级攻击被排除在外——这些由 AWS 自身的安全模型处理 [1, 8]。

### 2.3 设计目标

| 目标 | 描述 |
|------|-------------|
| G1 | 资源控制——防止 CPU 耗尽、内存炸弹、fork 炸弹、磁盘填满 |
| G2 | 系统调用限制——限制不可信代码可以访问的内核接口 |
| G3 | 文件系统隔离——防止访问敏感文件和跨调用泄露 |
| G4 | 网络隔离——防止通过网络进行数据外泄 |
| G5 | 凭证保护——防止访问 AWS 凭证和 Lambda 内部数据 |
| G6 | 跨平台运行——在 Lambda、自托管 Linux 和 macOS 上工作 |
| G7 | 语言覆盖——至少支持 Python、C/C++ 和 JavaScript |
| G8 | 低开销——对典型工作负载执行时间增加不超过 2× |

---

## 3. 沙箱机制分类法

### 3.1 强制机制

- **内核介导**：seccomp-bpf、Landlock、命名空间、cgroups、能力。最强保证；需要内核支持。
- **虚拟机监控程序介导**：Firecracker、QEMU/KVM、gVisor。硬件支持；重量级。
- **翻译器介导**：DynamoRIO、QEMU 用户模式、zpoline。用户空间；翻译器在 TCB 中。
- **解释器介导**：WASM、Goja、Deno、Lua。可移植；仅限支持的语言。

### 3.2 隔离粒度

- **系统调用级**：单个系统调用被过滤或拦截（seccomp、DBI）
- **进程级**：整个进程受限（命名空间、cgroups、rlimits）
- **VM 级**：完整 VM 提供隔离（Firecracker、QEMU 系统模式）
- **语言级**：类型系统和运行时强制限制（WASM、Goja）

### 3.3 信任边界

- **硬件 + 虚拟机监控程序**：只需 CPU 和 VMM 正确（Firecracker、QEMU/KVM）
- **内核**：宿主内核的安全机制必须正确（seccomp、命名空间）
- **翻译器/运行时**：二进制翻译器或语言运行时必须正确（DynamoRIO、wazero、Goja）
- **语言规范**：语言设计必须排除不安全操作（WASM 规范、Lua 的受限环境）

### 3.4 Lambda 兼容性

- **原生**：无需任何被屏蔽原语即可工作
- **部分**：部分功能可用，其他被屏蔽
- **被屏蔽**：需要至少一个不可用原语
- **未来**：现在被屏蔽但随内核升级可能可用

---

## 4. 内核介导机制

### 4.1 seccomp-BPF

> **💡 什么是 seccomp-BPF？**
> seccomp（安全计算模式）是 Linux 的一项安全机制，允许进程声明它只需要某些系统调用，内核强制执行这一策略。BPF（Berkeley Packet Filter）程序在每次系统调用前运行，可以决定允许（ALLOW）、终止（KILL）、返回错误（ERRNO）等。就像一个给程序安装的"系统调用防火墙"——只有白名单上的操作才能通过。问题是，安装这个防火墙本身需要特定权限（`PR_SET_NO_NEW_PRIVS`），而 Lambda 把这个权限禁掉了。

seccomp-BPF [9, 10] 允许进程安装在每次系统调用前运行的 BPF 程序，返回 ALLOW、KILL、ERRNO、TRAP、LOG 或 USER_NOTIF。被 Chrome、Firefox、Docker、Kubernetes 和 Firecracker 本身使用。

**研究全景。** Ghavamnia 等 [11] 引入了时序特化——程序在初始化期间和服务期间需要不同的系统调用——启用了可将攻击面减少高达 55.4% 的按阶段过滤器。Jia 等 [12] 提出将 seccomp 从经典 BPF 扩展到 eBPF，以支持有状态策略和 TOCTOU 缓解。Alhindi 等 [13] 在一项可用性研究中发现 seccomp "灵活到了问题"。Pailoor 等 [14] 结合静态分析和程序综合实现自动化策略生成。

**关键限制。** seccomp-bpf 无法解引用指针参数——只能检查寄存器值，不能检查它们指向的内存 [15]。这为基于路径的系统调用创造了固有的 TOCTOU 漏洞。Brauner [16] 警告 `SECCOMP_RET_USER_NOTIF` 由于这些竞争无法实现安全策略。

**Lambda 状态：被屏蔽。** seccomp 过滤器安装需要 `prctl(PR_SET_NO_NEW_PRIVS)` 或 `CAP_SYS_ADMIN`，两者均不可用。

### 4.2 Landlock LSM

Landlock [17, 18] 是一个非特权、可堆叠的 Linux 安全模块，提供文件系统访问控制（自内核 5.13 起）和 TCP 网络限制（自内核 6.7 起）。与 seccomp 不同，它在文件系统层面操作，避免了路径参数的 TOCTOU 竞争。

**Lambda 状态：未来可用。** Lambda 的内核是 5.10；Landlock 需要 5.13+。Amazon Linux 2023 为内核 6.1+ 启用 `CONFIG_SECURITY_LANDLOCK`。

### 4.3 Linux 命名空间和 Cgroups

Linux 命名空间（PID、NET、MNT、USER、UTS、IPC、cgroup、time）和 cgroups 构成容器隔离的基础。工具 bubblewrap [23]、nsjail [24] 和 firejail [25] 包装了这些原语。

**研究全景。** Reeves 等 [26] 发现用户命名空间防御能阻止 9 个已知容器逃逸漏洞中的 7 个。He 等 [28] 证明 eBPF 可以在容器环境中绕过 seccomp 和 AppArmor。

**Lambda 状态：被屏蔽。** `clone(CLONE_NEWUSER)` 返回 EPERM。

### 4.4 资源限制（rlimits）

`setrlimit()`/`prlimit()` 提供每进程资源上限：CPU 时间、地址空间、文件大小、打开文件数、进程数、core dump 大小。

**Lambda 状态：可用。** 标准非特权操作。

**警告：** `RLIMIT_NPROC` 限制*用户*的总进程数，而非进程树。由于所有 Lambda 调用以 uid 993 运行，一次调用的 fork 炸弹会影响同一热容器中的后续调用。

---

## 5. 用户态隔离技术

### 5.1 WebAssembly（WASM）和 WASI

WebAssembly [29] 提供带线性内存沙箱的可移植字节码格式：每次内存访问都受边界检查，控制流是结构化的，指令集中不存在系统调用指令。WASI [30] 通过基于能力的系统访问扩展了 WASM。

**研究全景。** Lehmann 等 [31] 展示了 WASM 的*宿主隔离*很强，但*二进制安全性*较弱——沙箱内的经典漏洞被充分暴露。Bosamiya 等 [32] 提出了可证明安全的 WASM 编译器（vWasm、rWasm）。Johnson 等 [33] 开发了在 Fastly 部署的静态验证器 VeriWasm。Johnson 等 [34] 构建了正式验证的 WASI 运行时 WaVe（IEEE S&P 2023 杰出论文）。Narayan 等 [35] 演示了在 FaaS 环境中针对 WASM 的 Spectre 攻击。Jangda 等 [36] 在 SPEC 基准测试上测量了比原生代码 45–55% 的开销。

**运行时。** 对于基于 Go 的 Lambda：**wazero**（纯 Go，零 CGo，解释器和 AOT 模式）。对于最多功能：**Wasmtime** 带有基于燃料的指令计量和 5 微秒实例化。

**语言支持：** C/C++/Rust/Go：5–15% 开销。通过 CPython-WASI 的 Python（约 34 MB，500 ms–2 s 启动）。通过 QuickJS-WASM 的 JavaScript（约 2 MB，首次编译约 300 ms）。

**Lambda 状态：可用。** Lambda 内部可用的最强沙箱。

### 5.2 动态二进制插桩（DBI）

> **💡 什么是动态二进制插桩（DBI）？**
> DBI 框架（如 DynamoRIO）在程序运行时实时翻译其机器码。所有代码在进入"代码缓存"前都经过翻译引擎，工具可以在每个基本块插入自定义代码——比如拦截系统调用、监控内存访问等。与 LD_PRELOAD 只能拦截 libc 函数调用不同，DBI 可以拦截任何代码发出的原始 syscall 指令，包括内联汇编。代价是约 10–30% 的执行开销。

DBI 框架（DynamoRIO [37]、Pin [38]、Valgrind [39]）通过将基本块复制到代码缓存并在运行时翻译和插桩来拦截应用执行。与 LD_PRELOAD 不同，DBI 拦截原始 `syscall` 指令，因为所有代码都通过翻译引擎。

**DynamoRIO 细节。** 主要 Linux 注入模式使用 LD_PRELOAD，而非 ptrace。`dr_register_pre_syscall_event()` 允许阻塞或修改任何系统调用。完整插桩 10–30% 开销。D'Elia 等 [40, 41] 系统化了 DBI 安全应用和检测方法。

**Lambda 状态：可能可用。** 需要 JIT 的 `mprotect(PROT_EXEC)`；由于 V8 工作，可能被允许——待直接验证。

### 5.3 QEMU 用户模式仿真

QEMU 用户模式 [43] 通过 TCG 翻译 guest 二进制指令，在翻译层拦截每个系统调用。不需要 ptrace、seccomp、命名空间或 KVM。静态二进制 5–20 MB。

**关键限制。** 无文件系统或网络隔离——guest 通过系统调用翻译直接访问宿主文件系统，以相同 UID 运行，共享宿主网络栈。许多危险的系统调用返回 ENOSYS（隐式但非刻意的过滤）。

**Lambda 状态：可用。** 无被屏蔽原语。2–5× 开销。

### 5.4 二进制重写

**zpoline** [45] 需要 `mmap_min_addr = 0`——Lambda 可能不允许。**E9Patch/E9Syscall** 和 **SaBRe** 离线工作（预先重写 ELF 二进制文件，部署修改版本），开销 <3%。根本限制：动态生成的代码（JIT）绕过静态重写。

**Lambda 状态：部分可用。** 静态重写可行；zpoline 被屏蔽。

### 5.5 LD_PRELOAD 插桩

可被原始 `syscall` 指令、静态二进制文件、Go/Rust 默认值、io_uring 和 `dlsym(RTLD_NEXT)` 轻易绕过。

**Lambda 状态：可用，但不是安全边界。**

---

## 6. 语言运行时沙箱

### 6.1 嵌入式 JavaScript 引擎

**Goja**（纯 Go，ES5.1）：完整功能隔离，被 Grafana K6 在生产中使用。每个运行时一个 goroutine。比 V8 慢约 20×，但 Go 互操作零 CGo 开销。

**v8go**：以约 290 μs 每次脚本执行（复用 isolate）嵌入 V8，比启动 Node.js 快 100×。需要 CGo。

**QuickJS-over-WASM**：最强的 JS 隔离——即使 QuickJS 的内存损坏漏洞也无法逃逸 WASM 边界。

**Lambda 状态：全部可用。**

### 6.2 Python 沙箱

Python 深度的对象自省模型使语言级沙箱在实践中几乎不可能 [47]。RestrictedPython 有多个 CVE（CVE-2024-47532、CVE-2025-22153）。Python audit hooks（PEP 578）明确不是沙箱——ctypes 支持直接系统调用访问。PyPy sandbox 模式理论上更强，但无人维护。

实用方案：通过 wazero 将 CPython 编译为 WASM（接受启动开销）；Deno 内的 Pyodide 支持更广泛的包；rlimits + 环境清理 + Firecracker 作为安全边界。

### 6.3 Deno 的权限模型

Deno 在 Rust 中强制执行默认拒绝权限：不带 `--allow-*` 标志的 `deno run` 屏蔽所有文件系统、网络、环境、子进程和 FFI 访问。在 Lambda 内部工作（约 140 MB 二进制）。NDSS 2025 发现了绕过向量；CVE-2024-34346 展示了 `/proc/self/mem` 写入可以授予所有权限。Deno Sandbox（2026 年 2 月）使用 Firecracker，承认单纯的运行时权限不足。

### 6.4 Lua 沙箱

受限全局表 + `debug.sethook` 用于指令计数。Luau（Roblox 的 fork）已在数百万对抗性用户上经过实战检验。约 300 KB 二进制。如果 Lua 是可接受的语言则非常出色。

---

## 7. 硬件辅助和完整 VM 隔离

### 7.1 Firecracker（Lambda 的外层边界）

每次 Lambda 调用都有自己的 Firecracker microVM——硬件虚拟化级别的隔离 [1]。"每次执行一个 Lambda"模式在无互联网访问、最小 IAM 角色、紧超时的 VPC 中为每次提交启动一个独立的 Lambda 函数。

**所需加固：** 清除所有 AWS_* 和 _LAMBDA_* 环境变量；关闭所有继承的文件描述符；通过受控管道重定向标准 I/O；创建新进程组；应用 rlimits [6]。

**成本：** 以 2048 MB 运行 10 秒约 $0.00033。

### 7.2 QEMU 系统模式

启动完整的 guest 内核，提供完整的硬件隔离。exec-sandbox 项目 [50] 用 Alpine Linux 3.21、约 360 个删除的子系统、EROFS rootfs 演示了这一方案。有 KVM：400 ms 冷启动，57 ms p50。无 KVM（Lambda）：5–30 秒启动，8–12× 开销。

**Lambda 状态：可用，但很慢。**

### 7.3 软件故障隔离（SFI/NaCl/LFI）

LFI [53]（ASPLOS 2024）使用保留寄存器和正式验证的静态验证器（约 400 行代码），确保内存访问保持在 4 GiB 沙箱区域内。ARM64 上约 6–8% 开销。需要代码重编译；x86-64 支持处于实验阶段。

**Lambda 状态：如果代码可以重编译则可用。**

---

## 8. io_uring 问题

> **💡 什么是 io_uring 及为什么它危险？**
> io_uring 是 Linux 5.1 引入的高性能异步 I/O 接口。它的工作原理是让用户程序和内核通过共享内存中的环形队列交换 I/O 请求，大幅减少系统调用次数。但这里有一个严重的安全问题：io_uring 操作在内核上下文中执行，不经过正常的系统调用路径——这意味着 seccomp 过滤器对它完全无效。攻击者可以用 io_uring 执行文件操作、网络操作等，而 seccomp 看不见这些操作。

io_uring 操作在内核上下文中执行，不经过正常的系统调用路径，完全规避 seccomp 过滤器 [54, 55]。Google 的 kCTF VRP 数据 [54]：42 个内核漏洞提交中 60% 针对 io_uring；为 io_uring 漏洞支付了约 $1M 赏金。Google 在 ChromeOS 上禁用了 io_uring，在 Android 上屏蔽了它。ARMO Security [57] 构建了一个完全通过 io_uring 操作的完整功能 rootkit，对 Falco、Tetragon、CrowdStrike 和 Microsoft Defender 不可见。

**含义：** 任何基于 seccomp 的沙箱都必须屏蔽 `io_uring_setup`、`io_uring_enter` 和 `io_uring_register`。在 Lambda 中，Firecracker 的宿主端过滤器可能屏蔽了这些——但需要验证。对于自托管部署，这是不可妥协的。

---

## 9. 五条实施路径的评估

### 比较总结

| 路径 | G1 资源 | G2 系统调用 | G3 文件系统 | G4 网络 | G5 凭证 | G6 跨平台 | G7 语言 | G8 开销 |
|------|:-----------:|:----------:|:-------------:|:----------:|:--------------:|:-------------:|:------------:|:-----------:|
| **A** rlimits + 环境 | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ~0% |
| **B** wazero WASM | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 部分 | 1.5–8× |
| **C** Goja JS | 部分 | ✓ | ✓ | ✓ | ✓ | ✓ | 仅 JS | ~20× vs V8 |
| **D** DynamoRIO | 部分 | ✓ | 部分 | 部分 | 部分 | Linux+Mac | ✓ | 1.1–1.3× |
| **E** QEMU 用户 | 部分 | 部分 | ✗ | ✗ | ✗ | Linux | ✓ | 2–5× |

**路径 A** 满足 G1（资源控制）和 G5（凭证保护），但不满足 G2–G4。所有其他路径的必要基础。re-exec 包装器开销约 1.5 ms。

**路径 B** 通过构造满足 G1–G5——WASM 中不存在系统调用。信任边界是 wazero 运行时实现。Python-in-WASM 启动 500 ms–2 s。QuickJS-WASM 缓存后约 0.5 ms。

**路径 C** 在语言层面满足 G2–G5。关键风险：Goja 约 5 万行 Go 代码中的漏洞可能导致逃逸到宿主进程。仅限 JS——不满足 G7。

**路径 D** 满足 G2 和 G7（任何 ELF 二进制文件）。信任边界是 DynamoRIO 的 20 万+ 行 C/C++ 代码。约 50 MB 二进制文件。需要 `mprotect(PROT_EXEC)`。

**路径 E** 仅提供隐式过滤。无文件系统或网络隔离。QEMU 官方声明用户模式不提供安全保证。最适合作为结合路径 A 和 Lambda Firecracker 边界的一层。

---

## 10. 推荐分层架构

### Tier 1：AWS Lambda 托管模式

1. **路径 A（始终）：** rlimits、环境清理、每次执行的 /tmp 隔离、进程超时强制、带字节限制的 stdout/stderr 捕获。
2. **路径 B（用于 JS 和编译为 WASM 的代码）：** 无 WASI 能力的 wazero。JavaScript 使用 QuickJS-WASM。纯 Python 使用 CPython-WASI（接受启动开销）。
3. **路径 D（用于任意二进制文件）：** LD_PRELOAD 模式的 DynamoRIO。白名单：read、write、exit、exit_group、brk、mmap、mprotect、futex、clock_gettime。
4. **每次执行一个 Lambda：** 对于最大隔离，在无互联网访问的 VPC 中为每次提交启动独立的 Lambda 函数。

### Tier 2：自托管 Linux

1. 通过 `elastic/go-seccomp-bpf` 的 seccomp-bpf（纯 Go，无 CGo）
2. 通过 `landlock-lsm/go-landlock` 的 Landlock，带 `BestEffort()` 降级
3. rlimits 同 Tier 1
4. 带 Go 绑定的 syd/sydbox，用于监督系统调用执行

### Tier 3：macOS 开发环境

1. rlimits（部分支持）
2. 嵌入式运行时（Goja、wazero——在 macOS 上完全相同）
3. 带 `--deny-all` 的 Deno 子进程

---

## 11. 相关工作

Shu 等 [62] 调查了跨进程、VM、容器、SFI 和硬件维度的安全隔离技术。Maass 等 [63] 分析了沙箱科学。Wąsik 等 [67] 调查了 100 多个在线评测系统。Sultan 等 [65] 和 2025 年 ACM Computing Surveys 论文 [66] 全面覆盖了容器安全。

本文的不同之处在于专注于*受限无服务器*部署模型——大多数内核沙箱原语不可用——这是先前系统化研究未涉及的场景。

---

## 12. 结论

**Lambda 的安全模型有意阻止嵌套沙箱**——Firecracker 就是沙箱，AWS 屏蔽了会允许在其中构建第二个沙箱的原语。这是减少 guest 内核针对 Firecracker 攻击面的刻意设计选择，而非疏漏。

对于像 Shimmy 这样需要在 Lambda 内部对不可信代码进行沙箱处理的应用，解决方案是从可用的原语构建实用的纵深防御栈。WebAssembly 提供了最强的可用机制——无需内核特性的架构级隔离，在所有部署层上运行方式完全相同，并有形式化验证结果支持其安全声明。通过 DynamoRIO 的动态二进制插桩以适中开销将覆盖范围扩展到任意二进制文件。

最值得探索的机会是**已验证的 WASM 运行时**（WaVe、vWasm）结合编译为 WASM 的语言解释器。这提供了在所有部署环境中无内核依赖的可证明安全沙箱处理。Python-in-WASM 的启动开销仍是主要实际障碍，但对于 JavaScript 和编译代码，该方案今天已可投入生产。

**未来工作。** 监控 Lambda 的内核版本——升级到 5.13+ 时，Landlock 变为可用并从根本上改变格局。跟踪 `SECCOMP_RET_USER_NOTIF` 和 syd/sydbox 在自托管部署中的演进。评估 exec-sandbox 项目的 QEMU microvm 隔离方案作为每次执行一个 Lambda 的替代方案。

---

## 参考文献

[1] A. Agache 等，"Firecracker: Lightweight Virtualization for Serverless Applications," USENIX NSDI, 2020. https://www.usenix.org/conference/nsdi20/presentation/agache

[2] OpenAI Codex, Issue #4725: prctl(PR_SET_SECCOMP) returns EPERM in Lambda, 2025.

[3] Plotly/Kaleido, Issue #313: PR_SET_NO_NEW_PRIVS blocked in Lambda, 2024.

[4] AWS containers-roadmap, Issue #2102: CLONE_NEWUSER blocked in Lambda, 2024.

[5] AWS Lambda FAQ: ptrace explicitly blocked.

[6] Y. [Author], "Shimmy Sandbox Research Notes," Imperial College London, March 2026.

[7] H. He 等，"Cross Container Attacks: The Bewildered eBPF on Clouds," USENIX Security, 2023. https://www.usenix.org/system/files/usenixsecurity23-he.pdf

[8] AWS, "Security Overview of AWS Lambda," AWS Whitepaper, 2023.

[9] W. Drewry, "Dynamic seccomp policies (using BPF filters)," LWN, 2012. https://lwn.net/Articles/475019/

[10] Linux Kernel Documentation, "Seccomp BPF." https://www.kernel.org/doc/html/v4.16/userspace-api/seccomp_filter.html

[11] S. Ghavamnia 等，"Temporal System Call Specialization for Attack Surface Reduction," USENIX Security, 2020. https://www.usenix.org/conference/usenixsecurity20/presentation/ghavamnia

[12] J. Jia 等，"Programmable System Call Security with eBPF," arXiv:2302.10366, 2023. https://arxiv.org/abs/2302.10366

[13] S. Alhindi 等，"Playing in the Sandbox: A Study on the Usability of Seccomp," arXiv:2506.10234, 2025. https://arxiv.org/html/2506.10234v1

[14] M. Pailoor 等，"Automated Policy Synthesis for System Call Sandboxing," ACM OOPSLA, 2020.

[15] LWN, "seccomp deep argument inspection," 2020. https://lwn.net/Articles/822256/

[16] C. Brauner, "Seccomp Notify: New Frontiers in Unprivileged Container Development," 2020. https://brauner.io/2020/07/23/seccomp-notify.html

[17] M. Salaün, "Landlock: From a Security Mechanism Idea to a Widely Available Implementation," 2024. https://landlock.io/talks/2024-06-06_landlock-article.pdf

[18] Linux Kernel Documentation, "Landlock: unprivileged access control." https://docs.kernel.org/userspace-api/landlock.html

[19] M. Abbadini 等，"NatiSand: Native Code Sandboxing for JavaScript Runtimes," RAID, 2023. https://dl.acm.org/doi/10.1145/3607199.3607233

[20] A. Grattafiori (NCC Group), "Understanding and Hardening Linux Containers," 2016. https://research.nccgroup.com/wp-content/uploads/2020/07/ncc_group_understanding_hardening_linux_containers-1-1.pdf

[21] NIST SP 800-190, "Application Container Security Guide," 2017.

[22] R. Priedhorsky 等，"Minimizing Privilege for Building HPC Containers," arXiv:2104.07508, 2021.

[23] bubblewrap. https://github.com/containers/bubblewrap

[24] nsjail. https://github.com/google/nsjail

[25] firejail. https://github.com/netblue30/firejail

[26] B. Reeves 等，"Towards Improving Container Security by Preventing Runtime Escapes," IEEE SecDev, 2021.

[27] Y. Sun 等，"Security Namespace: Making Linux Security Frameworks Available to Containers," USENIX Security, 2018.

[28] H. He 等，"Cross Container Attacks: The Bewildered eBPF on Clouds," USENIX Security, 2023.

[29] A. Haas 等，"Bringing the Web up to Speed with WebAssembly," PLDI, 2017. https://dl.acm.org/doi/10.1145/3062341.3062363

[30] WASI Design Principles. https://github.com/WebAssembly/WASI/blob/main/docs/DesignPrinciples.md

[31] D. Lehmann 等，"Everything Old is New Again: Binary Security of WebAssembly," USENIX Security, 2020.

[32] J. Bosamiya 等，"Provably-Safe Multilingual Software Sandboxing using WebAssembly," USENIX Security, 2022. https://www.andrew.cmu.edu/user/bparno/papers/wasm-sandboxing.pdf

[33] E. Johnson 等，"VeriWasm: SFI safety for native-compiled Wasm," NDSS, 2021.

[34] E. Johnson 等，"WaVe: A Verifiably Secure WebAssembly Sandboxing Runtime," IEEE S&P, 2023.

[35] S. Narayan 等，"Swivel: Hardening WebAssembly against Spectre," USENIX Security, 2021.

[36] A. Jangda 等，"Not So Fast: Analyzing the Performance of WebAssembly vs. Native Code," USENIX ATC, 2019. https://www.usenix.org/conference/atc19/presentation/jangda

[37] D. Bruening, "Efficient, Transparent, and Comprehensive Runtime Code Manipulation," MIT PhD Dissertation, 2004. https://dynamorio.org/pubs/bruening_phd.pdf

[38] C.-K. Luk 等，"Pin: Building Customized Program Analysis Tools with Dynamic Instrumentation," PLDI, 2005.

[39] N. Nethercote 和 J. Seward, "Valgrind: A Framework for Heavyweight Dynamic Binary Instrumentation," PLDI, 2007.

[40] E. D'Elia 等，"SoK: Using Dynamic Binary Instrumentation for Security," AsiaCCS, 2019. http://season-lab.github.io/papers/sok-dbi-ASIACCS19.pdf

[41] E. D'Elia 等，"Evaluating Dynamic Binary Instrumentation Systems for Conspicuous Features and Artifacts," ACM DTRAP, 2021. https://dl.acm.org/doi/10.1145/3478520

[42] "Unveiling Dynamic Binary Instrumentation Techniques," arXiv:2508.00682, 2025.

[43] F. Bellard, "QEMU, a Fast and Portable Dynamic Translator," USENIX ATC, 2005.

[44] QEMU Security Documentation. https://qemu-project.gitlab.io/qemu/system/security.html

[45] K. Yasukata 等，"zpoline: a system call hook mechanism based on binary rewriting," USENIX ATC（最佳论文），2023. https://www.usenix.org/conference/atc23/presentation/yasukata

[46] T. Garfinkel, "Traps and Pitfalls: Practical Problems in System Call Interposition Based Security Tools," NDSS, 2003.

[47] RestrictedPython CVEs: CVE-2024-47532, CVE-2025-22153.

[48] Anjali 等，"Blending Containers and Virtual Machines: A Study of Firecracker and gVisor," ACM VEE, 2020. https://dl.acm.org/doi/10.1145/3381052.3381315

[49] J. Xiao 等，"Attacks are Forwarded: Breaking the Isolation of MicroVM-based Containers," USENIX Security, 2023.

[50] exec-sandbox. https://github.com/dualeai/exec-sandbox

[51] R. Wahbe 等，"Efficient Software-Based Fault Isolation," SOSP, 1993. https://dl.acm.org/doi/10.1145/168619.168635

[52] B. Yee 等，"Native Client: A Sandbox for Portable, Untrusted x86 Native Code," IEEE S&P, 2009.

[53] LFI, "Lightweight Fault Isolation," ASPLOS, 2024.

[54] Google Security, "Learnings from kCTF VRP's 42 Linux Kernel Exploits," 2023. https://security.googleblog.com/2023/06/learnings-from-kctf-vrps-42-linux.html

[55] Z. Zhang 等，"RingGuard: Guard io_uring with eBPF," ACM eBPF Workshop, 2023.

[56] Z. Lin 等，"Bad io_uring: New Attack Surface and New Exploit Technique to Rooting Android," Black Hat USA, 2023.

[57] ARMO Security, "io_uring Rootkit Bypasses Linux Security Tools," 2025. https://www.armosec.io/blog/io_uring-rootkit-bypasses-linux-security/

[58] N. Provos, "Improving Host Security with System Call Policies (Systrace)," USENIX Security, 2003. https://www.usenix.org/legacy/event/sec03/tech/full_papers/provos/provos.pdf

[59] M. Mareš 和 B. Blackham, "A New Contest Sandbox (Isolate)," Olympiads in Informatics, 2012. http://mj.ucw.cz/papers/isolate.pdf

[60] M. Mareš, "Security of Grading Systems," Olympiads in Informatics, 2021. https://ioinformatics.org/journal/v15_2021_37_52.pdf

[61] S. Narayan 等，"Retrofitting Fine Grain Isolation in the Firefox Renderer (RLBox)," USENIX Security, 2020.

[62] R. Shu 等，"A Study of Security Isolation Techniques," ACM Computing Surveys, 2016. https://dl.acm.org/doi/abs/10.1145/2988545

[63] M. Maass 等，"A Systematic Analysis of the Science of Sandboxing," PeerJ Computer Science, 2016.

[64] T. Laurén 等，"A Survey on Application Sandboxing Techniques," CompSysTech, 2017.

[65] S. Sultan 等，"Container Security: Issues, Challenges, and the Road Ahead," IEEE Access, 2019. https://ieeexplore.ieee.org/document/8693491/

[66] "A Container Security Survey: Exploits, Attacks, and Defenses," ACM Computing Surveys, 2025. https://dl.acm.org/doi/full/10.1145/3715001

[67] S. Wąsik 等，"A Survey on Online Judge Systems and Their Applications," ACM Computing Surveys, 2018.

[68] J. Watson 等，"Capsicum: Practical Capabilities for UNIX," USENIX Security（最佳学生论文），2010.

[69] T. de Raadt, "Privilege Separation and Pledge," OpenBSD, 2016.

[70] A. Barth 等，"The Security Architecture of the Chromium Browser," Stanford, 2008.

[71] G. Tan, "Principles and Implementation Techniques of Software-Based Fault Isolation," Foundations and Trends, 2017. https://www.cse.psu.edu/~gxt29/papers/sfi-final.pdf

[72] N. Provos 等，"Preventing Privilege Escalation," USENIX Security, 2003.

[73] D. Kolosick 等，"Isolation without Taxation: Near-Zero-Cost Transitions for WebAssembly and SFI," POPL, 2022. https://dl.acm.org/doi/10.1145/3498688

[74] Schrammel 等，"Jenny: Securing Syscalls for PKU-based Memory Isolation Systems," USENIX Security, 2022.

[75] B. Findlay 等，"bpfbox: Simple Precise Process Confinement with eBPF," ACM CCSW, 2020.

[76] Peveler 等，"Comparing Jailed Sandboxes vs Containers Within an Autograding System," SIGCSE, 2019. https://dl.acm.org/doi/10.1145/3287324.3287507

[77] Wasmtime Security Documentation. https://docs.wasmtime.dev/security.html

[78] Pyodide. https://pyodide.org/

[79] Z. Li 等，"RunD: A Lightweight Secure Container Runtime for High-density Deployment," USENIX ATC, 2022.

[80] E. Young 等，"The True Cost of Containing: A gVisor Case Study," USENIX HotCloud, 2019.

[81] N. Hardy, "The Confused Deputy," ACM SIGOPS, 1988.

[82] ASC-Hook, "Efficient System Call Interception for ARM," LCTES, 2025. https://dl.acm.org/doi/10.1145/3735452.3735524
