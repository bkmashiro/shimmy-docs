# SoK: Sandboxing Untrusted Code in Constrained Serverless Environments

**Yuzhe · Imperial College London · 2026**

---

## Abstract

Running untrusted code in serverless environments such as AWS Lambda presents a fundamental tension: the platform's own isolation mechanism — Firecracker microVMs — blocks nearly every kernel primitive that traditional sandboxing tools depend on. seccomp filter installation, ptrace, user namespaces, chroot, and eBPF are all unavailable inside Lambda, eliminating gVisor, bubblewrap, nsjail, minijail, firejail, and every major Linux sandboxing tool. This paper systematises the landscape of sandboxing techniques applicable to constrained serverless environments by evaluating 14 candidate approaches across five isolation paradigms: kernel-mediated syscall filtering, OS-level namespace/container isolation, hardware-assisted virtualisation, userspace binary instrumentation, and language-runtime sandboxing. We develop a taxonomy based on four dimensions — the enforcement mechanism (kernel, hypervisor, translator, or interpreter), the isolation granularity (syscall, process, VM, or language), the trust boundary (what must be correct for isolation to hold), and the deployment constraints (which kernel primitives are required). Through systematic evaluation against the AWS Lambda constraint profile, we identify 8 viable approaches and 6 that are definitively blocked. We further analyse five concrete implementation paths — rlimits with environment sanitisation, WebAssembly via wazero, embedded JavaScript interpretation via Goja, dynamic binary instrumentation via DynamoRIO, and QEMU user-mode translation — mapping each to its underlying research lineage and quantifying security-performance trade-offs. Our key finding is that no single mechanism provides complete isolation inside Lambda; the strongest practical architecture layers multiple techniques, with WebAssembly (WASM) offering the best security-to-complexity ratio for supported languages, and dynamic binary instrumentation providing the broadest language coverage at moderate overhead. We conclude with a tiered architecture that degrades gracefully across Lambda, self-hosted Linux, and macOS development environments.

---

## 1. Introduction

The execution of untrusted code is among the oldest problems in systems security. From the earliest time-sharing systems through Java applets, browser sandboxes, and modern cloud functions, the fundamental challenge remains: how to permit computation while preventing harm. This challenge has taken on renewed urgency with the rise of serverless computing, AI-generated code execution, and educational platforms where student-submitted code must be evaluated automatically.

AWS Lambda, the dominant serverless platform, provides strong inter-tenant isolation through Firecracker microVMs [1]. Each Lambda invocation runs inside a lightweight virtual machine backed by KVM, with a dedicated guest kernel, minimal device model, and host-side seccomp filters. This architecture effectively prevents cross-tenant attacks — code running in one customer's Lambda function cannot access another customer's data or computation.

However, Lambda's isolation model creates a paradox for applications that must themselves sandbox untrusted code *within* a single tenant's function. Educational autograders, online judges, AI agent frameworks, and workflow automation tools all need to execute user-supplied or machine-generated code with restrictions beyond what Lambda itself enforces. The problem is that Lambda's guest-side security posture — designed to minimise the Firecracker attack surface — blocks the very primitives that sandboxing tools require:

- `prctl(PR_SET_NO_NEW_PRIVS)` returns EPERM, preventing seccomp filter installation [2, 3]
- `clone()` with `CLONE_NEWUSER` returns EPERM, blocking all namespace-based tools [4]
- `ptrace()` is explicitly blocked [5]
- `/dev/kvm` is not exposed, preventing nested virtualisation [1]
- `chroot()` requires CAP_SYS_CHROOT, which is unavailable [6]
- eBPF requires elevated capabilities not granted to Lambda processes [7]

This creates what we term the *nested sandboxing problem*: the outer sandbox (Firecracker) deliberately prevents the construction of inner sandboxes to reduce its own attack surface. The result is that every mainstream Linux sandboxing tool fails inside Lambda.

This paper makes the following contributions:

1. A systematic taxonomy of sandboxing mechanisms across five paradigms, evaluated against the specific constraint profile of AWS Lambda.
2. An empirical catalogue of which kernel primitives are available vs. blocked inside Lambda.
3. A comparative evaluation of 14 candidate sandboxing approaches, classifying 8 as viable and 6 as definitively blocked.
4. A mapping of five implementation paths to their research lineage.
5. A tiered architecture that degrades gracefully across deployment environments.

---

## 2. Background and Threat Model

### 2.1 The Lambda Execution Environment

AWS Lambda functions execute inside Firecracker microVMs running on bare-metal EC2 Nitro instances [1]. Each microVM runs a guest Linux kernel (version 5.10, identified via the `k510ga` platform label as of March 2026). The function code runs as user `sbx_user1051` (uid 993). The filesystem at `/var/task` (function code), `/var/runtime`, and `/opt` (layers) is read-only; only `/tmp` is writable.

Lambda reuses execution environments ("warm starts") for subsequent invocations of the same function. This means `/tmp` contents, global variables, and process state persist across invocations — a significant security concern when the function executes untrusted code from different users.

**Confirmed blocked primitives:**

| Primitive | Error | Implication |
|-----------|-------|-------------|
| `prctl(PR_SET_NO_NEW_PRIVS)` | EPERM | Blocks unprivileged seccomp-bpf |
| `seccomp(SECCOMP_SET_MODE_FILTER)` | EPERM | No syscall filtering |
| `ptrace()` | EPERM | No debugger-based interposition |
| `clone(CLONE_NEWUSER)` | EPERM | No user namespaces |
| `chroot()` | EPERM | No filesystem root change |
| `mount()` | EPERM | No private /proc |
| eBPF loading | EPERM | No kernel instrumentation |
| `prctl(PR_SET_PDEATHSIG)` | EPERM | No parent-death signalling |

**Confirmed available primitives:**

| Primitive | Notes |
|-----------|-------|
| `setrlimit()` / `prlimit()` | Standard unprivileged resource limits |
| `fork()` / `exec()` | Normal child process spawning |
| `/proc` filesystem | Readable, including credentials |
| `/tmp` writes | Persists across warm invocations |
| `mprotect(PROT_EXEC)` | Likely available (V8/JIT works) |

The guest kernel is Linux 5.10, which means **Landlock** (requires 5.13+) and **Syscall User Dispatch** (requires 5.11+) are unavailable. Amazon Linux 2023 enables `CONFIG_SECURITY_LANDLOCK` for kernel 6.1+, so a future Lambda kernel upgrade could change this.

### 2.2 Threat Model

An educational platform ("Lambda Feedback") where students submit code for automated evaluation. The attacker is a student with:

- Arbitrary code execution in a supported language (Python, C, JavaScript)
- Knowledge of the execution environment (Lambda, Linux 5.10, uid 993)
- Access to /proc including `/proc/self/environ` (AWS credentials) and `/proc/self/maps`
- Ability to write to /tmp and potentially affect subsequent invocations

Attack goals:
1. **Data exfiltration**: reading other students' submissions, AWS credentials, or function source code
2. **Resource exhaustion**: fork bombs, memory bombs, disk filling, CPU monopolisation
3. **Lateral movement**: using AWS credentials to access other AWS services
4. **Persistence**: modifying /tmp or environment to affect subsequent invocations
5. **Container escape**: breaking out of the Lambda execution environment

Host-level attacks against Firecracker itself are excluded — these are addressed by AWS's own security model [1, 8].

### 2.3 Design Goals

| Goal | Description |
|------|-------------|
| G1 | Resource control — prevent CPU exhaustion, memory bombs, fork bombs, disk filling |
| G2 | Syscall restriction — limit which kernel interfaces untrusted code can access |
| G3 | Filesystem isolation — prevent access to sensitive files and cross-invocation leakage |
| G4 | Network isolation — prevent data exfiltration via network |
| G5 | Credential protection — prevent access to AWS credentials and Lambda internals |
| G6 | Cross-platform operation — work on Lambda, self-hosted Linux, and macOS |
| G7 | Language breadth — support Python, C/C++, and JavaScript at minimum |
| G8 | Low overhead — add less than 2× to execution time for typical workloads |

---

## 3. Taxonomy of Sandboxing Mechanisms

### 3.1 Enforcement Mechanism

- **Kernel-mediated**: seccomp-bpf, Landlock, namespaces, cgroups, capabilities. Strongest guarantees; requires kernel support.
- **Hypervisor-mediated**: Firecracker, QEMU/KVM, gVisor. Hardware-backed; heavyweight.
- **Translator-mediated**: DynamoRIO, QEMU user-mode, zpoline. Userspace; translator is in the TCB.
- **Interpreter-mediated**: WASM, Goja, Deno, Lua. Portable; limited to supported languages.

### 3.2 Isolation Granularity

- **Syscall-level**: Individual system calls filtered or intercepted (seccomp, DBI)
- **Process-level**: Entire processes confined (namespaces, cgroups, rlimits)
- **VM-level**: Complete VMs provide isolation (Firecracker, QEMU system)
- **Language-level**: Type system and runtime enforce restrictions (WASM, Goja)

### 3.3 Trust Boundary

- **Hardware + hypervisor**: Only CPU and VMM must be correct (Firecracker, QEMU/KVM)
- **Kernel**: Host kernel's security mechanisms must be correct (seccomp, namespaces)
- **Translator/runtime**: Binary translator or language runtime must be correct (DynamoRIO, wazero, Goja)
- **Language specification**: Language's design must preclude unsafe operations (WASM spec, Lua's restricted environments)

### 3.4 Lambda Compatibility

- **Native**: Works without any blocked primitives
- **Partial**: Some features work, others blocked
- **Blocked**: Requires at least one unavailable primitive
- **Future**: Blocked now but may become available with kernel upgrades

---

## 4. Kernel-Mediated Mechanisms

### 4.1 seccomp-BPF

seccomp-BPF [9, 10] allows processes to install BPF programs that run before each syscall, returning ALLOW, KILL, ERRNO, TRAP, LOG, or USER_NOTIF. Used by Chrome, Firefox, Docker, Kubernetes, and Firecracker itself.

**Research landscape.** Ghavamnia et al. [11] introduced temporal specialisation — programs need different syscalls during initialisation vs. serving — enabling per-phase filters that reduce attack surface by up to 55.4%. Jia et al. [12] proposed extending seccomp from classic BPF to eBPF for stateful policies and TOCTOU mitigation. Alhindi et al. [13] found seccomp "flexible to a fault" in a usability study. Pailoor et al. [14] combined static analysis and program synthesis for automated policy generation.

**Critical limitations.** seccomp-bpf cannot dereference pointer arguments — only inspect register values, not the memory they point to [15]. This creates inherent TOCTOU vulnerabilities for path-based syscalls. Brauner [16] warned that SECCOMP_RET_USER_NOTIF cannot implement security policy due to these races.

**Lambda status: BLOCKED.** seccomp filter installation requires either `prctl(PR_SET_NO_NEW_PRIVS)` or `CAP_SYS_ADMIN`, neither available.

### 4.2 Landlock LSM

Landlock [17, 18] is an unprivileged, stackable Linux Security Module providing filesystem access control (since kernel 5.13) and TCP network restriction (since kernel 6.7). Unlike seccomp, it operates at the filesystem level, avoiding TOCTOU races on path arguments.

**Lambda status: FUTURE.** Lambda's kernel is 5.10; Landlock requires 5.13+. Amazon Linux 2023 enables `CONFIG_SECURITY_LANDLOCK` for kernel 6.1+.

### 4.3 Linux Namespaces and Cgroups

Linux namespaces (PID, NET, MNT, USER, UTS, IPC, cgroup, time) and cgroups form the foundation of container isolation. Tools bubblewrap [23], nsjail [24], and firejail [25] wrap these primitives.

**Research landscape.** Reeves et al. [26] found user namespace defence stops 7 of 9 known container escape exploits. He et al. [28] demonstrated eBPF can bypass seccomp and AppArmor in container environments.

**Lambda status: BLOCKED.** `clone(CLONE_NEWUSER)` returns EPERM.

### 4.4 Resource Limits (rlimits)

`setrlimit()`/`prlimit()` provide per-process resource caps: CPU time, address space, file size, open files, process count, core dump size.

**Lambda status: AVAILABLE.** Standard unprivileged operations.

**Caveat:** RLIMIT_NPROC limits total process count for a *user*, not a process tree. Since all Lambda invocations run as uid 993, a fork bomb from one invocation affects subsequent invocations in the same warm container.

---

## 5. Userspace Isolation Techniques

### 5.1 WebAssembly (WASM) and WASI

WebAssembly [29] provides a portable bytecode format with a linear memory sandbox: every memory access is bounds-checked, control flow is structured, and no system call instructions exist in the instruction set. WASI [30] extends WASM with capability-based system access.

**Research landscape.** Lehmann et al. [31] showed WASM's *host isolation* is strong but *binary security* is weak — classic vulnerabilities within the sandbox are fully exposed. Bosamiya et al. [32] presented provably-safe WASM compilers (vWasm, rWasm). Johnson et al. [33] developed VeriWasm, a static verifier deployed at Fastly. Johnson et al. [34] built WaVe, a formally verified WASI runtime (IEEE S&P 2023 Distinguished Paper). Narayan et al. [35] demonstrated Spectre attacks against WASM in FaaS environments. Jangda et al. [36] measured 45–55% overhead vs. native code on SPEC benchmarks.

**Runtimes.** For Go-based Lambda: **wazero** (pure Go, zero CGo, interpreter and AOT modes). For maximum features: **Wasmtime** with fuel-based instruction metering and 5-microsecond instantiation.

**Language support:** C/C++/Rust/Go: 5–15% overhead. Python via CPython-WASI (~34 MB, 500 ms–2 s startup). JavaScript via QuickJS-WASM (~2 MB, ~300 ms first compile).

**Lambda status: AVAILABLE.** Strongest sandbox available inside Lambda.

### 5.2 Dynamic Binary Instrumentation (DBI)

DBI frameworks (DynamoRIO [37], Pin [38], Valgrind [39]) intercept application execution by copying basic blocks into a code cache, translating and instrumenting them at runtime. Unlike LD_PRELOAD, DBI intercepts raw `syscall` instructions because all code passes through the translation engine.

**DynamoRIO specifics.** Primary Linux injection mode uses LD_PRELOAD, not ptrace. `dr_register_pre_syscall_event()` allows blocking or modifying any syscall. 10–30% overhead for full instrumentation. D'Elia et al. [40, 41] systematised DBI security applications and detection methods.

**Lambda status: LIKELY AVAILABLE.** Requires `mprotect(PROT_EXEC)` for JIT; likely permitted since V8 works. Pending direct verification.

### 5.3 QEMU User-Mode Emulation

QEMU user-mode [43] translates guest binary instructions via TCG, intercepting every syscall at the translation layer. No ptrace, seccomp, namespaces, or KVM required. Static binary 5–20 MB.

**Critical limitation.** No filesystem or network isolation — guest accesses host filesystem directly through syscall translation, runs with same UID, shares host network stack. Many dangerous syscalls return ENOSYS (implicit but not deliberate filtering).

**Lambda status: AVAILABLE.** No blocked primitives. 2–5× overhead.

### 5.4 Binary Rewriting

**zpoline** [45] requires `mmap_min_addr = 0` — Lambda likely doesn't allow this. **E9Patch/E9Syscall** and **SaBRe** work offline (pre-rewrite ELF binaries, deploy modified versions) with <3% overhead. Fundamental limitation: dynamically generated code (JIT) bypasses static rewriting.

**Lambda status: PARTIAL.** Static rewriting works; zpoline blocked.

### 5.5 LD_PRELOAD Interposition

Trivially bypassed by raw `syscall` instructions, static binaries, Go/Rust defaults, io_uring, and `dlsym(RTLD_NEXT)`.

**Lambda status: AVAILABLE but NOT a security boundary.**

---

## 6. Language-Runtime Sandboxing

### 6.1 Embedded JavaScript Engines

**Goja** (pure Go, ES5.1): complete functional isolation, used by Grafana K6 in production. Single-goroutine-per-runtime. ~20× slower than V8 but zero CGo overhead for Go interop.

**v8go**: embeds V8 with ~290 μs per script execution (reusing isolates), 100× faster than spawning Node.js. Requires CGo.

**QuickJS-over-WASM**: strongest JS isolation — even a QuickJS memory corruption bug cannot escape the WASM boundary.

**Lambda status: ALL AVAILABLE.**

### 6.2 Python Sandboxing

Python's deep object introspection model makes language-level sandboxing essentially impossible [47]. RestrictedPython has multiple CVEs (CVE-2024-47532, CVE-2025-22153). Python audit hooks (PEP 578) are explicitly not a sandbox — ctypes enables direct syscall access. PyPy sandbox mode is theoretically strong but unmaintained.

Practical approaches: CPython compiled to WASM via wazero (accepting startup overhead); Pyodide inside Deno for broader package support; rlimits + env sanitization + Firecracker as the security boundary.

### 6.3 Deno's Permission Model

Deno enforces deny-by-default permissions in Rust: `deno run` without `--allow-*` flags blocks all filesystem, network, environment, subprocess, and FFI access. Works inside Lambda (~140 MB binary). NDSS 2025 found bypass vectors; CVE-2024-34346 showed `/proc/self/mem` writes could grant all permissions. Deno Sandbox (February 2026) uses Firecracker, acknowledging that runtime permissions alone are insufficient.

### 6.4 Lua Sandboxing

Restricted global tables + `debug.sethook` for instruction counting. Luau (Roblox's fork) is battle-tested against millions of adversarial users. ~300 KB binary. Excellent if Lua is an acceptable language.

---

## 7. Hardware-Assisted and Full-VM Isolation

### 7.1 Firecracker (Lambda's Outer Boundary)

Each Lambda invocation gets its own Firecracker microVM — hardware-virtualisation-level isolation [1]. The "Lambda-per-execution" pattern spawns a separate Lambda function per submission in a VPC with no internet access, minimal IAM role, tight timeout.

**Required hardening:** clear all AWS_* and _LAMBDA_* environment variables; close every inherited file descriptor; redirect stdio through controlled pipes; create new process group; apply rlimits [6].

**Cost:** ~$0.00033 per 10-second execution at 2048 MB.

### 7.2 QEMU System-Mode

Boots a complete guest kernel, providing full hardware isolation. The exec-sandbox project [50] demonstrates this with Alpine Linux 3.21, ~360 removed subsystems, EROFS rootfs. With KVM: 400 ms cold start, 57 ms p50. Without KVM (Lambda): 5–30 second boot, 8–12× overhead.

**Lambda status: AVAILABLE but SLOW.**

### 7.3 Software Fault Isolation (SFI/NaCl/LFI)

LFI [53] (ASPLOS 2024) uses reserved registers and a formally verified static verifier (~400 LOC) ensuring memory accesses stay within a 4 GiB sandbox region. ~6–8% overhead on ARM64. Requires code recompilation; experimental x86-64 support.

**Lambda status: AVAILABLE if code can be recompiled.**

---

## 8. The io_uring Problem

io_uring operations execute in kernel context without passing through the normal syscall path, completely circumventing seccomp filters [54, 55]. Google's kCTF VRP data [54]: 60% of 42 kernel exploit submissions targeted io_uring; ~$1M paid for io_uring vulnerabilities. Google disabled io_uring on ChromeOS and blocked it on Android. ARMO Security [57] built a fully functional rootkit operating entirely via io_uring, invisible to Falco, Tetragon, CrowdStrike, and Microsoft Defender.

**Implication:** Any seccomp-based sandbox must block `io_uring_setup`, `io_uring_enter`, and `io_uring_register`. In Lambda, Firecracker's host-side filter likely blocks these, but verification is needed. For self-hosted deployments, this is non-negotiable.

---

## 9. Evaluation of Five Implementation Paths

### Comparative Summary

| Path | G1 Resource | G2 Syscall | G3 Filesystem | G4 Network | G5 Credentials | G6 Cross-plat | G7 Languages | G8 Overhead |
|------|:-----------:|:----------:|:-------------:|:----------:|:--------------:|:-------------:|:------------:|:-----------:|
| **A** rlimits + env | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ~0% |
| **B** wazero WASM | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Partial | 1.5–8× |
| **C** Goja JS | Partial | ✓ | ✓ | ✓ | ✓ | ✓ | JS only | ~20× vs V8 |
| **D** DynamoRIO | Partial | ✓ | Partial | Partial | Partial | Linux+Mac | ✓ | 1.1–1.3× |
| **E** QEMU user | Partial | Partial | ✗ | ✗ | ✗ | Linux | ✓ | 2–5× |

**Path A** satisfies G1 (resource control) and G5 (credential protection) but not G2–G4. Necessary foundation for all other paths. Overhead ~1.5 ms for the re-exec wrapper.

**Path B** satisfies G1–G5 by construction — no syscalls exist in WASM. Trust boundary is the wazero runtime implementation. Python-in-WASM startup is 500 ms–2 s. QuickJS-WASM is ~0.5 ms cached.

**Path C** satisfies G2–G5 at the language level. Key risk: a bug in Goja's ~50K lines of Go could allow escape to the host process. JS only — does not satisfy G7.

**Path D** satisfies G2 and G7 (any ELF binary). Trust boundary is DynamoRIO's ~200K+ lines of C/C++. ~50 MB binary. Requires `mprotect(PROT_EXEC)`.

**Path E** provides implicit filtering only. No filesystem or network isolation. QEMU officially disclaims security guarantees for user-mode. Best as one layer combined with Path A and Lambda's Firecracker boundary.

---

## 10. Recommended Layered Architecture

### Tier 1: AWS Lambda Managed Mode

1. **Path A (always):** rlimits, environment sanitisation, per-execution /tmp isolation, process timeout enforcement, stdout/stderr capture with byte limits.
2. **Path B (for JS and compiled-to-WASM):** wazero with no WASI capabilities. QuickJS-WASM for JavaScript. CPython-WASI for pure Python (accepting startup overhead).
3. **Path D (for arbitrary binaries):** DynamoRIO in LD_PRELOAD mode. Allowlist: read, write, exit, exit_group, brk, mmap, mprotect, futex, clock_gettime.
4. **Lambda-per-execution:** For maximum isolation, spawn separate Lambda function per submission in VPC with no internet access.

### Tier 2: Self-Hosted Linux

1. seccomp-bpf via `elastic/go-seccomp-bpf` (pure Go, no CGo)
2. Landlock via `landlock-lsm/go-landlock` with `BestEffort()` degradation
3. rlimits as in Tier 1
4. syd/sydbox with Go bindings for supervised syscall execution

### Tier 3: macOS Development

1. rlimits (partially supported)
2. Embedded runtimes (Goja, wazero — identical on macOS)
3. Deno subprocess with `--deny-all`

---

## 11. Related Work

Shu et al. [62] surveyed security isolation techniques across process, VM, container, SFI, and hardware dimensions. Maass et al. [63] analysed the science of sandboxing. Wąsik et al. [67] surveyed 100+ online judge systems. Sultan et al. [65] and a 2025 ACM Computing Surveys paper [66] covered container security comprehensively.

This work differs by focusing specifically on the *constrained serverless* deployment model where most kernel sandboxing primitives are unavailable — a scenario not addressed by prior systematisations.

---

## 12. Conclusion

**Lambda's security model intentionally prevents nested sandboxing** — Firecracker IS the sandbox, and AWS blocks the primitives that would allow building a second one inside it. This is a deliberate design choice to reduce the guest kernel's attack surface against Firecracker, not an oversight.

For applications like Shimmy that must sandbox untrusted code within Lambda, the solution is a practical defence-in-depth stack from the primitives that do work. WebAssembly provides the strongest available mechanism — architectural isolation without kernel features, works identically across all deployment tiers, and has formal verification results backing its security claims. Dynamic binary instrumentation via DynamoRIO extends coverage to arbitrary binaries at moderate overhead.

The most underexplored opportunity is **verified WASM runtimes** (WaVe, vWasm) combined with language interpreters compiled to WASM. This provides provably-safe sandboxing with no kernel dependencies. The startup overhead for Python-in-WASM remains the main practical barrier, but for JavaScript and compiled code, the approach is production-ready today.

**Future work.** Monitor Lambda's kernel version — when it upgrades to 5.13+, Landlock becomes available and fundamentally changes the landscape. Track the evolution of `SECCOMP_RET_USER_NOTIF` and syd/sydbox for self-hosted deployments. Evaluate the exec-sandbox project for QEMU microvm-based isolation as an alternative to Lambda-per-execution.

---

## References

[1] A. Agache et al., "Firecracker: Lightweight Virtualization for Serverless Applications," USENIX NSDI, 2020. https://www.usenix.org/conference/nsdi20/presentation/agache

[2] OpenAI Codex, Issue #4725: prctl(PR_SET_SECCOMP) returns EPERM in Lambda, 2025.

[3] Plotly/Kaleido, Issue #313: PR_SET_NO_NEW_PRIVS blocked in Lambda, 2024.

[4] AWS containers-roadmap, Issue #2102: CLONE_NEWUSER blocked in Lambda, 2024.

[5] AWS Lambda FAQ: ptrace explicitly blocked.

[6] Y. [Author], "Shimmy Sandbox Research Notes," Imperial College London, March 2026.

[7] H. He et al., "Cross Container Attacks: The Bewildered eBPF on Clouds," USENIX Security, 2023. https://www.usenix.org/system/files/usenixsecurity23-he.pdf

[8] AWS, "Security Overview of AWS Lambda," AWS Whitepaper, 2023.

[9] W. Drewry, "Dynamic seccomp policies (using BPF filters)," LWN, 2012. https://lwn.net/Articles/475019/

[10] Linux Kernel Documentation, "Seccomp BPF." https://www.kernel.org/doc/html/v4.16/userspace-api/seccomp_filter.html

[11] S. Ghavamnia et al., "Temporal System Call Specialization for Attack Surface Reduction," USENIX Security, 2020. https://www.usenix.org/conference/usenixsecurity20/presentation/ghavamnia

[12] J. Jia et al., "Programmable System Call Security with eBPF," arXiv:2302.10366, 2023. https://arxiv.org/abs/2302.10366

[13] S. Alhindi et al., "Playing in the Sandbox: A Study on the Usability of Seccomp," arXiv:2506.10234, 2025. https://arxiv.org/html/2506.10234v1

[14] M. Pailoor et al., "Automated Policy Synthesis for System Call Sandboxing," ACM OOPSLA, 2020.

[15] LWN, "seccomp deep argument inspection," 2020. https://lwn.net/Articles/822256/

[16] C. Brauner, "Seccomp Notify: New Frontiers in Unprivileged Container Development," 2020. https://brauner.io/2020/07/23/seccomp-notify.html

[17] M. Salaün, "Landlock: From a Security Mechanism Idea to a Widely Available Implementation," 2024. https://landlock.io/talks/2024-06-06_landlock-article.pdf

[18] Linux Kernel Documentation, "Landlock: unprivileged access control." https://docs.kernel.org/userspace-api/landlock.html

[19] M. Abbadini et al., "NatiSand: Native Code Sandboxing for JavaScript Runtimes," RAID, 2023. https://dl.acm.org/doi/10.1145/3607199.3607233

[20] A. Grattafiori (NCC Group), "Understanding and Hardening Linux Containers," 2016. https://research.nccgroup.com/wp-content/uploads/2020/07/ncc_group_understanding_hardening_linux_containers-1-1.pdf

[21] NIST SP 800-190, "Application Container Security Guide," 2017.

[22] R. Priedhorsky et al., "Minimizing Privilege for Building HPC Containers," arXiv:2104.07508, 2021.

[23] bubblewrap. https://github.com/containers/bubblewrap

[24] nsjail. https://github.com/google/nsjail

[25] firejail. https://github.com/netblue30/firejail

[26] B. Reeves et al., "Towards Improving Container Security by Preventing Runtime Escapes," IEEE SecDev, 2021.

[27] Y. Sun et al., "Security Namespace: Making Linux Security Frameworks Available to Containers," USENIX Security, 2018.

[28] H. He et al., "Cross Container Attacks: The Bewildered eBPF on Clouds," USENIX Security, 2023.

[29] A. Haas et al., "Bringing the Web up to Speed with WebAssembly," PLDI, 2017. https://dl.acm.org/doi/10.1145/3062341.3062363

[30] WASI Design Principles. https://github.com/WebAssembly/WASI/blob/main/docs/DesignPrinciples.md

[31] D. Lehmann et al., "Everything Old is New Again: Binary Security of WebAssembly," USENIX Security, 2020.

[32] J. Bosamiya et al., "Provably-Safe Multilingual Software Sandboxing using WebAssembly," USENIX Security, 2022. https://www.andrew.cmu.edu/user/bparno/papers/wasm-sandboxing.pdf

[33] E. Johnson et al., "VeriWasm: SFI safety for native-compiled Wasm," NDSS, 2021.

[34] E. Johnson et al., "WaVe: A Verifiably Secure WebAssembly Sandboxing Runtime," IEEE S&P, 2023.

[35] S. Narayan et al., "Swivel: Hardening WebAssembly against Spectre," USENIX Security, 2021.

[36] A. Jangda et al., "Not So Fast: Analyzing the Performance of WebAssembly vs. Native Code," USENIX ATC, 2019. https://www.usenix.org/conference/atc19/presentation/jangda

[37] D. Bruening, "Efficient, Transparent, and Comprehensive Runtime Code Manipulation," MIT PhD Dissertation, 2004. https://dynamorio.org/pubs/bruening_phd.pdf

[38] C.-K. Luk et al., "Pin: Building Customized Program Analysis Tools with Dynamic Instrumentation," PLDI, 2005.

[39] N. Nethercote and J. Seward, "Valgrind: A Framework for Heavyweight Dynamic Binary Instrumentation," PLDI, 2007.

[40] E. D'Elia et al., "SoK: Using Dynamic Binary Instrumentation for Security," AsiaCCS, 2019. http://season-lab.github.io/papers/sok-dbi-ASIACCS19.pdf

[41] E. D'Elia et al., "Evaluating Dynamic Binary Instrumentation Systems for Conspicuous Features and Artifacts," ACM DTRAP, 2021. https://dl.acm.org/doi/10.1145/3478520

[42] "Unveiling Dynamic Binary Instrumentation Techniques," arXiv:2508.00682, 2025.

[43] F. Bellard, "QEMU, a Fast and Portable Dynamic Translator," USENIX ATC, 2005.

[44] QEMU Security Documentation. https://qemu-project.gitlab.io/qemu/system/security.html

[45] K. Yasukata et al., "zpoline: a system call hook mechanism based on binary rewriting," USENIX ATC (Best Paper), 2023. https://www.usenix.org/conference/atc23/presentation/yasukata

[46] T. Garfinkel, "Traps and Pitfalls: Practical Problems in System Call Interposition Based Security Tools," NDSS, 2003.

[47] RestrictedPython CVEs: CVE-2024-47532, CVE-2025-22153.

[48] Anjali et al., "Blending Containers and Virtual Machines: A Study of Firecracker and gVisor," ACM VEE, 2020. https://dl.acm.org/doi/10.1145/3381052.3381315

[49] J. Xiao et al., "Attacks are Forwarded: Breaking the Isolation of MicroVM-based Containers," USENIX Security, 2023.

[50] exec-sandbox. https://github.com/dualeai/exec-sandbox

[51] R. Wahbe et al., "Efficient Software-Based Fault Isolation," SOSP, 1993. https://dl.acm.org/doi/10.1145/168619.168635

[52] B. Yee et al., "Native Client: A Sandbox for Portable, Untrusted x86 Native Code," IEEE S&P, 2009.

[53] LFI, "Lightweight Fault Isolation," ASPLOS, 2024.

[54] Google Security, "Learnings from kCTF VRP's 42 Linux Kernel Exploits," 2023. https://security.googleblog.com/2023/06/learnings-from-kctf-vrps-42-linux.html

[55] Z. Zhang et al., "RingGuard: Guard io_uring with eBPF," ACM eBPF Workshop, 2023.

[56] Z. Lin et al., "Bad io_uring: New Attack Surface and New Exploit Technique to Rooting Android," Black Hat USA, 2023.

[57] ARMO Security, "io_uring Rootkit Bypasses Linux Security Tools," 2025. https://www.armosec.io/blog/io_uring-rootkit-bypasses-linux-security/

[58] N. Provos, "Improving Host Security with System Call Policies (Systrace)," USENIX Security, 2003. https://www.usenix.org/legacy/event/sec03/tech/full_papers/provos/provos.pdf

[59] M. Mareš and B. Blackham, "A New Contest Sandbox (Isolate)," Olympiads in Informatics, 2012. http://mj.ucw.cz/papers/isolate.pdf

[60] M. Mareš, "Security of Grading Systems," Olympiads in Informatics, 2021. https://ioinformatics.org/journal/v15_2021_37_52.pdf

[61] S. Narayan et al., "Retrofitting Fine Grain Isolation in the Firefox Renderer (RLBox)," USENIX Security, 2020.

[62] R. Shu et al., "A Study of Security Isolation Techniques," ACM Computing Surveys, 2016. https://dl.acm.org/doi/abs/10.1145/2988545

[63] M. Maass et al., "A Systematic Analysis of the Science of Sandboxing," PeerJ Computer Science, 2016.

[64] T. Laurén et al., "A Survey on Application Sandboxing Techniques," CompSysTech, 2017.

[65] S. Sultan et al., "Container Security: Issues, Challenges, and the Road Ahead," IEEE Access, 2019. https://ieeexplore.ieee.org/document/8693491/

[66] "A Container Security Survey: Exploits, Attacks, and Defenses," ACM Computing Surveys, 2025. https://dl.acm.org/doi/full/10.1145/3715001

[67] S. Wąsik et al., "A Survey on Online Judge Systems and Their Applications," ACM Computing Surveys, 2018.

[68] J. Watson et al., "Capsicum: Practical Capabilities for UNIX," USENIX Security (Best Student Paper), 2010.

[69] T. de Raadt, "Privilege Separation and Pledge," OpenBSD, 2016.

[70] A. Barth et al., "The Security Architecture of the Chromium Browser," Stanford, 2008.

[71] G. Tan, "Principles and Implementation Techniques of Software-Based Fault Isolation," Foundations and Trends, 2017. https://www.cse.psu.edu/~gxt29/papers/sfi-final.pdf

[72] N. Provos et al., "Preventing Privilege Escalation," USENIX Security, 2003.

[73] D. Kolosick et al., "Isolation without Taxation: Near-Zero-Cost Transitions for WebAssembly and SFI," POPL, 2022. https://dl.acm.org/doi/10.1145/3498688

[74] Schrammel et al., "Jenny: Securing Syscalls for PKU-based Memory Isolation Systems," USENIX Security, 2022.

[75] B. Findlay et al., "bpfbox: Simple Precise Process Confinement with eBPF," ACM CCSW, 2020.

[76] Peveler et al., "Comparing Jailed Sandboxes vs Containers Within an Autograding System," SIGCSE, 2019. https://dl.acm.org/doi/10.1145/3287324.3287507

[77] Wasmtime Security Documentation. https://docs.wasmtime.dev/security.html

[78] Pyodide. https://pyodide.org/

[79] Z. Li et al., "RunD: A Lightweight Secure Container Runtime for High-density Deployment," USENIX ATC, 2022.

[80] E. Young et al., "The True Cost of Containing: A gVisor Case Study," USENIX HotCloud, 2019.

[81] N. Hardy, "The Confused Deputy," ACM SIGOPS, 1988.

[82] ASC-Hook, "Efficient System Call Interception for ARM," LCTES, 2025. https://dl.acm.org/doi/10.1145/3735452.3735524
