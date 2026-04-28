# 带注释参考文献：路径专项研究

## 前置知识

- 了解什么是沙箱（sandbox）以及为什么隔离不可信代码很重要
- 知道基本的 Linux 进程概念（fork、exec、系统调用）
- 理解 AWS Lambda 中可用内核原语受限这一基本约束

## 你将学到

- 五条候选路径（A–E）各自依赖的底层技术
- 支持或警示每条路径的学术研究
- 每条路径的安全等级和主要权衡
- 如何将多条路径组合成分层防御栈

---

本文档将学术论文和权威来源映射到 Lambda 沙箱的五条候选解决方案路径（A–E），标明每条路径依赖的底层技术以及支持或警示这些技术的研究成果。

---

## 路径 A：rlimits + 环境清理 Re-exec 包装器

**使用的技术：** `setrlimit()`/`prlimit()` 进行资源上限控制、环境变量清理、文件描述符清理、进程组管理（`setpgid`）、基于 `SIGKILL` 的超时强制。

**关键属性：** 零依赖，纯 Go。适用于所有平台，包括 Lambda。提供资源控制，但**不过滤系统调用**——不可信代码可以调用环境允许的任何系统调用。

### 论文与来源

**Provos，"Improving Host Security with System Call Policies (Systrace)"（2003）**
USENIX Security '03 — https://www.usenix.org/legacy/event/sec03/tech/full_papers/provos/provos.pdf

确立了单纯的资源限制不足以保证安全——进程隔离需要限制*可以执行的操作*，而不仅仅是*消耗多少资源*。Systrace 将 rlimits 与系统调用策略结合。直接论证了路径 A 是必要基础，但非独立解决方案。

**Garfinkel，"Traps and Pitfalls: Practical Problems in System Call Interposition"（2003）**
NDSS '03 — https://www.ndss-symposium.org/wp-content/uploads/2017/09/Traps-and-Pitfalls-Practical-Problems-in-System-Call-Interposition-Based-Security-Tools-Tal-Garfinkel.pdf

记录了为什么用户态隔离（环境清理、关闭 fd）是脆弱的——竞争条件、间接资源路径和继承状态可能泄露。理解路径 A 局限性的必读材料。

**Mareš 和 Blackham，"A New Contest Sandbox (Isolate)"（2012）**
Olympiads in Informatics, Vol. 6 — http://mj.ucw.cz/papers/isolate.pdf

IOI 的 Isolate 工具将 rlimits 作为多层沙箱（命名空间 + cgroups + rlimits）中的一层。演示了路径 A 应复制的 rlimit 精确配置（RLIMIT_CPU、RLIMIT_AS、RLIMIT_FSIZE、RLIMIT_NPROC），并记录了为什么单独的 rlimits 不是安全边界。

**Mareš，"Security of Grading Systems"（2021）**
Olympiads in Informatics, Vol. 15 — https://ioinformatics.org/journal/v15_2021_37_52.pdf

全面调查了评测系统的攻击方式，包括资源耗尽、/proc 信息泄露和 /tmp 中的跨调用数据持久化。与路径 A 的环境清理直接相关：记录了为什么 AWS_* 变量清理和 /tmp 清理是必要但不充分的。

**AWS，"Security Overview of AWS Lambda"（2023）**
AWS Whitepaper — https://docs.aws.amazon.com/whitepapers/latest/security-overview-aws-lambda/

确认 Lambda 进程共享 uid 993，/tmp 在热调用间持久化，环境变量包含实时凭证。路径 A 的清理需求直接来自这一架构。

**NIST SP 800-190，"Application Container Security Guide"（2017）**
https://nvlpubs.nist.gov/nistpubs/specialpublications/nist.sp.800-190.pdf

指出没有内核强制边界的进程级隔离提供"强度较高的隔离"，但不如 VM 那样"清晰且具体的安全边界"。路径 A 处于这一边界位置。

**路径 A 评估：** 路径 A 是所有其他路径的**必要基础**——每条路径都需要 rlimits 和环境清理。作为独立解决方案，它提供 DoS 防护，但对能够调用任意系统调用的有意攻击者不提供机密性或完整性保证。

---

## 路径 B：wazero WASM 沙箱

> **💡 什么是 WebAssembly（WASM）线性内存？**
> WebAssembly 是一种低级字节码格式。它的核心安全特性是"线性内存沙箱"：每个 WASM 模块只能访问自己分配的内存区域，所有内存访问都受边界检查，控制流不能跳转到任意地址。就像给程序套了一个透明的玻璃箱——程序在里面正常运行，但无法触碰玻璃箱外面的任何东西。WASM 模块也不能直接调用系统调用，所有与外部的交互都必须通过运行时明确暴露的接口。

**使用的技术：** WebAssembly 线性内存沙箱、WASI 基于能力的安全、wazero 纯 Go 运行时（解释器 + AOT 编译器）、编译为 WASM 的语言解释器（CPython-WASI、QuickJS-WASM）。

**关键属性：** 最强的形式化隔离保证。不需要内核特性。在 Lambda、自托管和 macOS 上运行方式完全相同。

### 论文与来源

**Haas 等，"Bringing the Web up to Speed with WebAssembly"（2017）**
PLDI '17 — https://dl.acm.org/doi/10.1145/3062341.3062363

定义了线性内存模型、结构化控制流和类型系统的 WASM 基础论文，正是这些特性使路径 B 的隔离成为可能。每次内存访问都受边界检查；控制流无法跳转到任意地址。

**Lehmann 等，"Everything Old is New Again: Binary Security of WebAssembly"（2020）**
USENIX Security '20 — https://www.usenix.org/conference/usenixsecurity20/presentation/lehmann

**路径 B 的关键警告。** 虽然 WASM 对宿主的隔离很强，但沙箱*内部*的二进制级安全性较弱——WASM 模块内的缓冲区溢出、栈破坏和控制流劫持是可行的。对于 Shimmy，这意味着有漏洞的 Python-in-WASM 解释器可能被利用，尽管攻击者仍被限制在 WASM 沙箱内。

**Bosamiya 等，"Provably-Safe Multilingual Software Sandboxing using WebAssembly"（2022）**
USENIX Security '22（杰出论文 + 互联网防御奖）— https://www.andrew.cmu.edu/user/bparno/papers/wasm-sandboxing.pdf

提出了可证明安全的 WASM 编译器（vWasm、rWasm）。起因于 Lucet/Wasmtime JIT 编译器漏洞 CVE-2021-32629 的沙箱逃逸。证明即使 WASM 运行时也可能存在逃逸漏洞，为 wazero 的 AOT 编译器方式提供了理由。

**Johnson 等，"VeriWasm: SFI safety for native-compiled Wasm"（2021）**
NDSS '21 — https://www.ndss-symposium.org/wp-content/uploads/ndss2021_5B-3_24078_paper.pdf

针对从 WASM 编译的 x86-64 二进制文件的静态离线验证器。在 Fastly 生产环境部署。验证线性内存隔离、栈安全性和控制流安全性。如果 Shimmy 预编译 WASM 模块则相关。

**Johnson 等，"WaVe: A Verifiably Secure WebAssembly Sandboxing Runtime"（2023）**
IEEE S&P '23（杰出论文）— https://cseweb.ucsd.edu/~dstefan/pubs/johnson:2023:wave.pdf

正式验证的 WASI 运行时，将运行时从可信计算基中移除。WASM 沙箱最强的形式化保证。

**Jangda 等，"Not So Fast: Analyzing the Performance of WebAssembly vs. Native Code"（2019）**
USENIX ATC '19 — https://www.usenix.org/conference/atc19/presentation/jangda

WASM 在 SPEC CPU 基准测试上比原生代码慢 45–55%。识别寄存器压力和指令缓存未命中为主要原因。与路径 B 的性能预算直接相关——Python-in-WASM 在此开销之上还叠加了解释器开销。

**Narayan 等，"Swivel: Hardening WebAssembly against Spectre"（2021）**
USENIX Security '21 — https://www.usenix.org/conference/usenixsecurity21/presentation/narayan

证明 Spectre 可以在 FaaS 环境中绕过 WASM 的隔离。虽然 Lambda 的 Firecracker 提供了外层 Spectre 缓解，但这对自托管部署是相关的。

**Narayan 等，"Retrofitting Fine Grain Isolation in the Firefox Renderer (RLBox)"（2020）**
USENIX Security '20 — https://www.usenix.org/conference/usenixsecurity20/presentation/narayan

RLBox 框架使用 WASM 对 Firefox 中的 C/C++ 库进行沙箱处理。在生产 Firefox 中部署，页面延迟开销仅 3%。在规模上验证了 WASM 作为沙箱的方式。

**Kolosick 等，"Isolation without Taxation: Near-Zero-Cost Transitions for WebAssembly and SFI"（2022）**
POPL '22 — https://dl.acm.org/doi/10.1145/3498688

确定了零成本 SFI 沙箱切换的条件。当 Shimmy 在 Go 宿主和 WASM 沙箱之间频繁调用时，与 wazero 的性能相关。

**Abbadini 等，"Leveraging eBPF to Enhance Sandboxing of WebAssembly Runtimes"（2023）**
ASIA CCS '23 — https://dl.acm.org/doi/fullHtml/10.1145/3579856.3592831

注意到 WASI 运行时的文件系统安全检查粒度较差——与理解 wazero 的 WASI FSConfig 限制相关。

**WASI Design Principles** — https://github.com/WebAssembly/WASI/blob/main/docs/DesignPrinciples.md

官方基于能力的设计：句柄不可伪造，无环境权限。路径 B"除非明确授予，否则无文件系统、无网络"保证的理论基础。

**路径 B 评估：** 提供**最强的跨平台隔离**，无需内核特性。主要权衡：性能（Python-in-WASM 比原生 CPython 慢 4–8×）和生态系统限制（通过 Pyodide 的 NumPy/Pandas 对 WASI 的支持不完整）。对于通过 QuickJS-WASM 的 JavaScript，权衡要有利得多（首次编译约 300 ms，缓存后约 0.5 ms）。

---

## 路径 C：Goja（纯 Go JS 引擎）

**使用的技术：** 通过纯 Go 字节码 VM 进行进程内 JavaScript 解释、Go 内存安全作为隔离边界、受控的全局对象暴露。

**关键属性：** Go↔JS 调用零开销。每个运行时一个 goroutine。仅限 JavaScript（ES5.1 + 部分 ES6）。

### 论文与来源

**Barth 等，"The Security Architecture of the Chromium Browser"（2008）**
Stanford Technical Report — https://seclab.stanford.edu/websec/chromium/chromium-security-architecture.pdf

确立了渲染引擎应在最小权限的沙箱进程中运行。路径 C 提供语言级隔离，但不提供进程级隔离——Goja Go 实现中的漏洞可能危及宿主进程。

**Wahbe 等，"Efficient Software-Based Fault Isolation"（1993）**
SOSP '93 — https://dl.acm.org/doi/10.1145/168619.168635

基础 SFI 论文。Goja 通过语言级限制提供一种 SFI 形式——不可信 JS 只能访问从 Go 明确桥接的对象。与二进制 SFI 不同，这依赖于解释器的正确性，而非指令级强制。

**Shu 等，"A Study of Security Isolation Techniques"（2016）**
ACM Computing Surveys — https://dl.acm.org/doi/abs/10.1145/2988545

按强制粒度对隔离技术进行分类。Goja 在"语言级"粒度运行——隔离的最弱形式，但开销最低。Goja 中的任何 Go 内存安全漏洞都会破坏隔离边界。

**Tan，"Principles and Implementation Techniques of Software-Based Fault Isolation"（2017）**
Foundations and Trends — https://www.cse.psu.edu/~gxt29/papers/sfi-final.pdf

全面的 SFI 专著。路径 C 的权衡：将解释器实现作为 TCB 信任。对于纯 Go 解释器，Go 的内存安全比基于 C 的解释器提供更强的基础。

**Goja GitHub** — https://github.com/dop251/goja

纯 Go ES5.1 引擎，被 Grafana K6 在生产中使用。每个运行时一个 goroutine。比 otto 快 6–7×，比 V8 慢约 20×。除非宿主明确提供，否则无文件系统、无网络、无 goroutine。

**路径 C 评估：** **JS 专用工作负载最快的选项**——无进程启动，无 WASM 开销，纯进程内执行。隔离完全依赖 Goja 的实现正确性和 Go 的内存安全。适用于 eval 函数语言限于 JavaScript、且威胁模型接受语言级隔离的情况。

---

## 路径 D：DynamoRIO（LD_PRELOAD 模式）

> **💡 什么是动态二进制插桩（DBI）？**
> 动态二进制插桩（Dynamic Binary Instrumentation，DBI）是一种在程序运行时实时修改其机器码的技术。DBI 框架（如 DynamoRIO）将程序代码分块翻译并放入"代码缓存"中，在真正执行前可以在每个块插入自定义代码——比如记录系统调用、修改指令等。这类似于给程序的每一行代码都加上一个"翻译中间层"，让你能看到并控制程序的每个动作，即使是通过内联汇编直接写的系统调用也不例外。

**使用的技术：** 通过 JIT 代码翻译进行动态二进制插桩（DBI）、LD_PRELOAD 注入、通过 `dr_register_pre_syscall_event()` 进行系统调用拦截、替换原始 `syscall` 指令的基本块翻译。

**关键属性：** 拦截所有系统调用，包括内联汇编。适用于任何 ELF 二进制文件。10–30% 开销。约 50 MB 二进制文件。

### 论文与来源

**Bruening，"Efficient, Transparent, and Comprehensive Runtime Code Manipulation"（2004）**
MIT 博士论文 — https://dynamorio.org/pubs/bruening_phd.pdf

DynamoRIO 基础论文。描述了进程虚拟机架构：代码缓存、基本块翻译、轨迹优化。确立了 DBI 可以以 10–30% 开销实现近乎透明的执行。

**D'Elia 等，"SoK: Using Dynamic Binary Instrumentation for Security"（2019）**
AsiaCCS '19 — http://season-lab.github.io/papers/sok-dbi-ASIACCS19.pdf

全面的 DBI 安全应用系统化研究。关键发现：DBI 框架通过代码缓存翻译拦截所有系统调用，不像 LD_PRELOAD 只能捕获 libc 包装器。

**D'Elia 等，"Evaluating Dynamic Binary Instrumentation Systems for Conspicuous Features and Artifacts"（2021）**
ACM DTRAP — https://dl.acm.org/doi/10.1145/3478520

评估 DBI 规避技术。DynamoRIO 的 LD_PRELOAD 注入模式避免了 ptrace——对 Lambda 兼容性至关重要。记录了 DBI 可通过 /proc/self/stat EIP 检查和代码缓存内存特征被检测到。

**Cifuentes 等，"Evasion and Countermeasures Techniques to Detect Dynamic Binary Instrumentation Frameworks"（2022）**
ACM DTRAP — https://dl.acm.org/doi/full/10.1145/3480463

列举了 12+ 种 DynamoRIO 检测方法。对于学生代码沙箱，这些规避向量风险较低。

**"Unveiling Dynamic Binary Instrumentation Techniques"（2025）**
arXiv:2508.00682 — https://arxiv.org/html/2508.00682v1

最新的 DBI 技术综合调查，涵盖 JIT-DBT（DynamoRIO、Pin）、动态探针注入（Frida、Dyninst）和全系统方式。跨插桩粒度的详细性能比较。

**Garfinkel，"Traps and Pitfalls"（2003）**（路径 A 中已引用）

基于 DBI 的系统调用插桩与所有系统调用级插桩共享 TOCTOU 陷阱。DynamoRIO 的代码翻译缓解了 LD_PRELOAD 绕过问题，但不能消除指针参数竞争。

**路径 D 评估：** 提供**最广泛的语言覆盖**（任何 ELF 二进制文件），真正的系统调用拦截无法被内联汇编绕过。主要风险：(1) 约 50 MB DynamoRIO 二进制文件增加了 Lambda 层大小，(2) 计算密集型工作负载 10–30% 开销，(3) DynamoRIO 的 JIT 需要 `mprotect(PROT_EXEC)` 在 Lambda 中工作（可能没问题，因为 Node.js V8 工作——但待直接验证）。

---

## 路径 E：QEMU 用户模式

> **💡 什么是动态二进制翻译（DBT）？**
> 动态二进制翻译（Dynamic Binary Translation，DBT）是像 QEMU 这样的工具将一种架构的机器码实时翻译为另一种架构机器码的技术。在 QEMU 用户模式中，它将 Linux 进程的系统调用通过自己的翻译层转发——就像一个"语言翻译员"，让不同语言（架构）的程序能够运行。这个翻译层可以作为系统调用过滤的副产品：许多危险的系统调用在 QEMU 中根本没有实现，直接返回"不支持"错误。

**使用的技术：** 通过 TCG 进行动态二进制翻译、在翻译层进行系统调用翻译/拦截。

**关键属性：** 不需要 ptrace、不需要 seccomp、不需要命名空间、不需要 KVM。2–5× 开销。**无文件系统或网络隔离。**

### 论文与来源

**Bellard，"QEMU, a Fast and Portable Dynamic Translator"（2005）**
USENIX ATC '05 — https://www.usenix.org/legacy/event/usenix05/tech/freeware/full_papers/bellard/bellard.pdf

原始 QEMU 论文。描述了 TCG 动态翻译和系统调用翻译层。QEMU 用户模式翻译每条 guest 指令，允许在不需要内核支持的情况下在翻译层拦截系统调用。

**QEMU Security Documentation** — https://qemu-project.gitlab.io/qemu/system/security.html

明确声明："影响非虚拟化用例的漏洞不被视为安全漏洞。非虚拟化用例的用户不得依赖 QEMU 提供 guest 隔离或任何安全保证。"官方关于 QEMU 用户模式安全的立场：**它不是安全边界**。

**QEMU User-Mode Documentation** — https://www.qemu.org/docs/master/user/main.html

系统调用翻译层："QEMU 包含通用系统调用翻译器。翻译器负责调整字节序、32/64 位参数大小，然后调用等效的宿主系统调用。"许多危险的系统调用（ptrace、命名空间相关的 clone 标志、seccomp）返回 ENOSYS，提供隐式过滤。

**exec-sandbox 项目（2025–2026）** — https://github.com/dualeai/exec-sandbox

演示了 QEMU **系统模式**（非用户模式），使用 microvm 机器类型、Alpine Linux 3.21、加固内核、EROFS 只读 rootfs 和 Rust guest 代理。有 KVM：400 ms 冷启动，57 ms p50 执行。无 KVM（Lambda）：5–30 秒启动，8–12× 运行时开销。

**Anjali 等，"Blending Containers and Virtual Machines: A Study of Firecracker and gVisor"（2020）**
ACM VEE '20 — https://dl.acm.org/doi/10.1145/3381052.3381315

关键发现：Firecracker 和 gVisor 都比原生 Linux 执行更多内核代码。路径 E（QEMU 用户模式）通过翻译而非拦截避免了这一问题。

**路径 E 评估：** 通过 QEMU 的翻译层提供**隐式系统调用过滤**——许多危险的系统调用简单地未实现，返回 ENOSYS。但 QEMU 官方声明用户模式不提供安全保证，且 guest 共享宿主文件系统和网络。最适合作为**一个防御层**，与 Lambda 的 Firecracker 边界和路径 A 的资源控制结合使用。

---

## 所有路径通用的横切论文

**Agache 等，"Firecracker: Lightweight Virtualization for Serverless Applications"（2020）**
NSDI '20 — https://www.usenix.org/conference/nsdi20/presentation/agache

Lambda 的外层安全边界。所有五条路径都在这个边界内部运行。理解 Firecracker 的 seccomp 过滤器和能力限制，解释了为什么嵌套沙箱如此受限。

**Salaün，"Landlock: From a Security Mechanism Idea to a Widely Available Implementation"（2024）**
https://landlock.io/talks/2024-06-06_landlock-article.pdf

所有路径的未来增强：当 Lambda 升级到内核 5.13+ 时，Landlock 可以在不使用任何被屏蔽原语的情况下实现非特权文件系统限制。

**Abbadini 等，"NatiSand: Native Code Sandboxing for JavaScript Runtimes"（2023）**
RAID '23 — https://dl.acm.org/doi/10.1145/3607199.3607233

结合 Landlock + eBPF + seccomp 对 Deno 中的原生代码进行沙箱处理。演示了 Shimmy 在自托管时应采用的多机制分层方式。

**Koczka（Google Security），"Learnings from kCTF VRP's 42 Linux Kernel Exploits"（2023）**
https://security.googleblog.com/2023/06/learnings-from-kctf-vrps-42-linux.html

60% 的内核漏洞利用针对 io_uring。所有路径必须确保 io_uring_setup/enter/register 被屏蔽（路径 A 通过 Firecracker 的过滤器，路径 B/C 通过 WASM/语言级隔离，路径 D/E 通过 DBI/翻译层拦截）。

**Peveler 等，"Comparing Jailed Sandboxes vs Containers Within an Autograding System"（2019）**
SIGCSE '19 — https://dl.acm.org/doi/10.1145/3287324.3287507

Docker 每次容器创建增加约 2.4 秒——论证了相对于每次执行启动容器，更轻量级方案（所有五条路径）的合理性。

---

## 总结：路径 → 技术 → 论文映射

| 路径 | 核心技术 | 关键论文 | 安全等级 |
|------|---------------|------------|----------------|
| **A** | rlimits + 环境清理 | Mareš 2012、Mareš 2021、Garfinkel 2003 | 仅资源控制 |
| **B** | WASM 线性内存 + WASI 能力 | Haas 2017、Lehmann 2020、Bosamiya 2022 | 架构级隔离 |
| **C** | Go 内存安全 + JS 解释器 | Wahbe 1993、Shu 2016 | 语言级隔离 |
| **D** | DBI 代码缓存 + 系统调用重写 | Bruening 2004、D'Elia 2019/2021 | 系统调用级拦截 |
| **E** | 二进制翻译 + 系统调用翻译 | Bellard 2005、QEMU 安全文档 | 隐式系统调用过滤 |

**推荐分层：** A（始终）+ B（用于 JS/编译为 WASM 的代码）或 D（用于任意二进制文件）+ Firecracker 外层边界。路径 C 用于 JS 专用快速路径。如果需要处理特殊二进制文件，路径 E 作为额外层。
