# Annotated Bibliography: Path-Specific Research

This document maps academic papers and authoritative sources to each of the five candidate solution paths (A–E) for Lambda sandboxing, identifying which underlying techniques each path relies on and the research that supports or cautions against them.

---

## Path A: rlimits + Environment Sanitization Re-exec Wrapper

**Techniques used:** `setrlimit()`/`prlimit()` for resource caps, environment variable scrubbing, file descriptor sanitization, process group management (`setpgid`), `SIGKILL`-based timeout enforcement.

**Key property:** Zero-dependency, pure Go. Works on all platforms including Lambda. Provides resource control but **no syscall filtering** — untrusted code can call any syscall the environment permits.

### Papers and Sources

**Provos, "Improving Host Security with System Call Policies (Systrace)" (2003)**
USENIX Security '03 — https://www.usenix.org/legacy/event/sec03/tech/full_papers/provos/provos.pdf

Establishes that resource limits alone are insufficient for security — process isolation requires restricting *which* operations can be performed, not just *how much* resource they consume. Systrace combines rlimits with syscall policies. Directly motivates why Path A is a necessary baseline but not a standalone solution.

**Garfinkel, "Traps and Pitfalls: Practical Problems in System Call Interposition" (2003)**
NDSS '03 — https://www.ndss-symposium.org/wp-content/uploads/2017/09/Traps-and-Pitfalls-Practical-Problems-in-System-Call-Interposition-Based-Security-Tools-Tal-Garfinkel.pdf

Documents why user-space isolation (env sanitization, fd closing) is fragile — race conditions, indirect resource paths, and inherited state can leak. Essential reading for understanding Path A's limitations.

**Mareš and Blackham, "A New Contest Sandbox (Isolate)" (2012)**
Olympiads in Informatics, Vol. 6 — http://mj.ucw.cz/papers/isolate.pdf

The IOI's Isolate tool uses rlimits as one layer within a multi-layer sandbox (namespaces + cgroups + rlimits). Demonstrates the exact rlimit configuration (RLIMIT_CPU, RLIMIT_AS, RLIMIT_FSIZE, RLIMIT_NPROC) that Path A should replicate, and documents why rlimits alone are not a security boundary.

**Mareš, "Security of Grading Systems" (2021)**
Olympiads in Informatics, Vol. 15 — https://ioinformatics.org/journal/v15_2021_37_52.pdf

Comprehensive survey of attacks on grading systems including resource exhaustion, /proc information leakage, and cross-invocation data persistence in /tmp. Directly relevant to Path A's environment sanitization: documents why AWS_* variable scrubbing and /tmp cleanup are necessary but insufficient.

**AWS, "Security Overview of AWS Lambda" (2023)**
AWS Whitepaper — https://docs.aws.amazon.com/whitepapers/latest/security-overview-aws-lambda/

Confirms that Lambda processes share uid 993, /tmp persists across warm invocations, and environment variables contain live credentials. Path A's sanitization requirements derive directly from this architecture.

**NIST SP 800-190, "Application Container Security Guide" (2017)**
https://nvlpubs.nist.gov/nistpubs/specialpublications/nist.sp.800-190.pdf

States that process-level isolation without kernel-enforced boundaries provides "a strong degree of isolation" but not "as clear and concrete a security boundary as a VM." Path A sits at this boundary.

**Path A assessment:** Path A is the **necessary foundation** for all other paths — every path needs rlimits and env sanitization. As a standalone solution, it provides DoS prevention but no confidentiality or integrity guarantees against a determined attacker who can call arbitrary syscalls.

---

## Path B: wazero WASM Sandbox

**Techniques used:** WebAssembly linear memory sandbox, WASI capability-based security, wazero pure-Go runtime (interpreter + AOT compiler), language interpreters compiled to WASM (CPython-WASI, QuickJS-WASM).

**Key property:** Strongest formal isolation guarantees. No kernel features required. Works identically on Lambda, self-hosted, and macOS.

### Papers and Sources

**Haas et al., "Bringing the Web up to Speed with WebAssembly" (2017)**
PLDI '17 — https://dl.acm.org/doi/10.1145/3062341.3062363

The foundational WASM paper defining the linear memory model, structured control flow, and type system that make Path B's isolation possible. Every memory access is bounds-checked; control flow cannot jump to arbitrary addresses.

**Lehmann et al., "Everything Old is New Again: Binary Security of WebAssembly" (2020)**
USENIX Security '20 — https://www.usenix.org/conference/usenixsecurity20/presentation/lehmann

**Critical caveat for Path B.** While WASM's host isolation is strong, binary-level security *within* the sandbox is weak — buffer overflows, stack smashing, and control flow hijacking within a WASM module are feasible. For Shimmy, this means a buggy Python-in-WASM interpreter could be exploited, though the attacker remains confined to the WASM sandbox.

**Bosamiya et al., "Provably-Safe Multilingual Software Sandboxing using WebAssembly" (2022)**
USENIX Security '22 (Distinguished Paper + Internet Defense Prize) — https://www.andrew.cmu.edu/user/bparno/papers/wasm-sandboxing.pdf

Presents provably safe WASM compilers (vWasm, rWasm). Motivated by CVE-2021-32629, a sandbox escape in Lucet/Wasmtime from a JIT compiler bug. Demonstrates that even WASM runtimes can have escape vulnerabilities, justifying wazero's AOT compiler approach.

**Johnson et al., "VeriWasm: SFI safety for native-compiled Wasm" (2021)**
NDSS '21 — https://www.ndss-symposium.org/wp-content/uploads/ndss2021_5B-3_24078_paper.pdf

Static offline verifier for x86-64 binaries compiled from WASM. Deployed at Fastly in production. Verifies linear memory isolation, stack safety, and control flow safety. Relevant if Shimmy pre-compiles WASM modules.

**Johnson et al., "WaVe: A Verifiably Secure WebAssembly Sandboxing Runtime" (2023)**
IEEE S&P '23 (Distinguished Paper) — https://cseweb.ucsd.edu/~dstefan/pubs/johnson:2023:wave.pdf

Formally verified WASI runtime removing the runtime from the trusted computing base. Strongest formal guarantees available for WASM sandboxing.

**Jangda et al., "Not So Fast: Analyzing the Performance of WebAssembly vs. Native Code" (2019)**
USENIX ATC '19 — https://www.usenix.org/conference/atc19/presentation/jangda

WASM runs 45–55% slower than native on SPEC CPU benchmarks. Identifies register pressure and I-cache misses as primary causes. Directly relevant to Path B's performance budget — Python-in-WASM compounds this overhead with interpreter overhead.

**Narayan et al., "Swivel: Hardening WebAssembly against Spectre" (2021)**
USENIX Security '21 — https://www.usenix.org/conference/usenixsecurity21/presentation/narayan

Demonstrates Spectre can bypass WASM's isolation in FaaS environments. While Lambda's Firecracker provides outer Spectre mitigation, this is relevant for self-hosted deployments.

**Narayan et al., "Retrofitting Fine Grain Isolation in the Firefox Renderer (RLBox)" (2020)**
USENIX Security '20 — https://www.usenix.org/conference/usenixsecurity20/presentation/narayan

RLBox framework sandboxing C/C++ libraries using WASM. Deployed in production Firefox with only 3% page latency overhead. Validates the WASM-as-sandbox approach at scale.

**Kolosick et al., "Isolation without Taxation: Near-Zero-Cost Transitions for WebAssembly and SFI" (2022)**
POPL '22 — https://dl.acm.org/doi/10.1145/3498688

Identifies conditions for zero-cost SFI sandbox transitions. Relevant to wazero's performance when Shimmy makes frequent calls between Go host and WASM sandbox.

**Abbadini et al., "Leveraging eBPF to Enhance Sandboxing of WebAssembly Runtimes" (2023)**
ASIA CCS '23 — https://dl.acm.org/doi/fullHtml/10.1145/3579856.3592831

Notes that WASI runtimes' filesystem security checks have poor granularity — relevant for understanding wazero's WASI FSConfig limitations.

**WASI Design Principles** — https://github.com/WebAssembly/WASI/blob/main/docs/DesignPrinciples.md

Official capability-based design: handles are unforgeable, no ambient authorities. The theoretical foundation for Path B's "no filesystem, no network unless explicitly granted" guarantee.

**Path B assessment:** Provides the **strongest cross-platform isolation** without kernel features. Main trade-offs: performance (Python-in-WASM is 4–8× slower than native CPython) and ecosystem limitations (NumPy/Pandas via Pyodide have incomplete WASI support). For JavaScript via QuickJS-WASM, the trade-off is far more favorable (~300 ms first compile, ~0.5 ms cached).

---

## Path C: Goja (Pure Go JS Engine)

**Techniques used:** In-process JavaScript interpretation via pure Go bytecode VM, Go memory safety as the isolation boundary, controlled global object exposure.

**Key property:** Zero overhead for Go↔JS calls. Single-goroutine-per-runtime. JavaScript only (ES5.1 + partial ES6).

### Papers and Sources

**Barth et al., "The Security Architecture of the Chromium Browser" (2008)**
Stanford Technical Report — https://seclab.stanford.edu/websec/chromium/chromium-security-architecture.pdf

Establishes that rendering engines should run in sandboxed processes with minimal privileges. Path C provides language-level but not process-level isolation — a bug in Goja's Go implementation could compromise the host process.

**Wahbe et al., "Efficient Software-Based Fault Isolation" (1993)**
SOSP '93 — https://dl.acm.org/doi/10.1145/168619.168635

The foundational SFI paper. Goja provides a form of SFI through language-level containment — untrusted JS can only access objects explicitly bridged from Go. Unlike binary SFI, this relies on interpreter correctness rather than instruction-level enforcement.

**Shu et al., "A Study of Security Isolation Techniques" (2016)**
ACM Computing Surveys — https://dl.acm.org/doi/abs/10.1145/2988545

Classifies isolation techniques by enforcement granularity. Goja operates at the "language-level" granularity — the weakest form of isolation but with the lowest overhead. Any Go memory safety bug in Goja breaks the isolation boundary.

**Tan, "Principles and Implementation Techniques of Software-Based Fault Isolation" (2017)**
Foundations and Trends — https://www.cse.psu.edu/~gxt29/papers/sfi-final.pdf

Comprehensive SFI monograph. The trade-off Path C makes: trusting the interpreter implementation as the TCB. For a pure Go interpreter, Go's memory safety provides a stronger foundation than C-based interpreters.

**Goja GitHub** — https://github.com/dop251/goja

Pure Go ES5.1 engine used by Grafana K6 in production. Single goroutine per runtime. 6–7× faster than otto, ~20× slower than V8. No filesystem, no network, no goroutines unless host explicitly provides them.

**Path C assessment:** The **fastest option for JS-only workloads** — no process spawn, no WASM overhead, pure in-process execution. Isolation depends entirely on Goja's implementation correctness and Go's memory safety. Appropriate when the eval function language is restricted to JavaScript and when the threat model accepts language-level isolation.

---

## Path D: DynamoRIO (LD_PRELOAD Mode)

**Techniques used:** Dynamic binary instrumentation (DBI) via JIT code translation, LD_PRELOAD injection, syscall interception via `dr_register_pre_syscall_event()`, basic block translation replacing raw `syscall` instructions.

**Key property:** Intercepts all syscalls including inline assembly. Works on any ELF binary. 10–30% overhead. ~50 MB binary.

### Papers and Sources

**Bruening, "Efficient, Transparent, and Comprehensive Runtime Code Manipulation" (2004)**
MIT PhD Dissertation — https://dynamorio.org/pubs/bruening_phd.pdf

The foundational DynamoRIO paper. Describes the process virtual machine architecture: code cache, basic block translation, trace optimization. Establishes that DBI can achieve near-transparent execution with 10–30% overhead.

**D'Elia et al., "SoK: Using Dynamic Binary Instrumentation for Security" (2019)**
AsiaCCS '19 — http://season-lab.github.io/papers/sok-dbi-ASIACCS19.pdf

Comprehensive systematization of DBI security applications. Key finding: DBI frameworks intercept all syscalls via code cache translation, unlike LD_PRELOAD which only catches libc wrappers.

**D'Elia et al., "Evaluating Dynamic Binary Instrumentation Systems for Conspicuous Features and Artifacts" (2021)**
ACM DTRAP — https://dl.acm.org/doi/10.1145/3478520

Evaluates DBI evasion techniques. DynamoRIO's LD_PRELOAD injection mode avoids ptrace — critical for Lambda compatibility. Documents that DBI can be detected via /proc/self/stat EIP inspection and code cache memory artifacts.

**Cifuentes et al., "Evasion and Countermeasures Techniques to Detect Dynamic Binary Instrumentation Frameworks" (2022)**
ACM DTRAP — https://dl.acm.org/doi/full/10.1145/3480463

Catalogs 12+ detection methods for DynamoRIO. For student code sandboxing, these evasion vectors are low-risk.

**"Unveiling Dynamic Binary Instrumentation Techniques" (2025)**
arXiv:2508.00682 — https://arxiv.org/html/2508.00682v1

Most recent comprehensive survey of DBI techniques covering JIT-DBT (DynamoRIO, Pin), dynamic probe injection (Frida, Dyninst), and full-system approaches. Detailed performance comparison across instrumentation granularities.

**Garfinkel, "Traps and Pitfalls" (2003)** (cited in Path A above)

DBI-based syscall interposition shares the TOCTOU pitfalls of all syscall-level interposition. DynamoRIO's code translation mitigates the LD_PRELOAD bypass problem but doesn't eliminate pointer argument races.

**Path D assessment:** Provides **the broadest language coverage** (any ELF binary) with genuine syscall interception that cannot be bypassed by inline assembly. Main risks: (1) ~50 MB DynamoRIO binary adds Lambda layer size, (2) 10–30% overhead for compute-heavy workloads, (3) `mprotect(PROT_EXEC)` must work in Lambda for DynamoRIO's JIT (likely, since Node.js V8 works — but pending direct verification).

---

## Path E: QEMU User-Mode

**Techniques used:** Dynamic binary translation via TCG, syscall translation/interception at the translation layer.

**Key property:** No ptrace, no seccomp, no namespaces, no KVM needed. 2–5× overhead. **No filesystem or network isolation.**

### Papers and Sources

**Bellard, "QEMU, a Fast and Portable Dynamic Translator" (2005)**
USENIX ATC '05 — https://www.usenix.org/legacy/event/usenix05/tech/freeware/full_papers/bellard/bellard.pdf

The original QEMU paper. Describes TCG dynamic translation and the syscall translation layer. QEMU user-mode translates every guest instruction, allowing syscall interception at the translation level without kernel support.

**QEMU Security Documentation** — https://qemu-project.gitlab.io/qemu/system/security.html

Explicitly states: "Bugs affecting the non-virtualization use case are not considered security bugs. Users with non-virtualization use cases must not rely on QEMU to provide guest isolation or any security guarantees." The official position on QEMU user-mode security: **it is not a security boundary**.

**QEMU User-Mode Documentation** — https://www.qemu.org/docs/master/user/main.html

The syscall translation layer: "QEMU includes a generic system call translator. The translator takes care of adjusting endianness, 32/64 bit parameter size and then calling the equivalent host system call." Many dangerous syscalls (ptrace, namespace-related clone flags, seccomp) return ENOSYS, providing implicit filtering.

**exec-sandbox project (2025–2026)** — https://github.com/dualeai/exec-sandbox

Demonstrates QEMU **system mode** (not user mode) with microvm machine type, Alpine Linux 3.21, hardened kernel, EROFS read-only rootfs, and Rust guest agent. With KVM: 400 ms cold start, 57 ms p50 execution. Without KVM (Lambda): 5–30 second boot, 8–12× runtime overhead.

**Anjali et al., "Blending Containers and Virtual Machines: A Study of Firecracker and gVisor" (2020)**
ACM VEE '20 — https://dl.acm.org/doi/10.1145/3381052.3381315

Key finding: both Firecracker and gVisor execute substantially more kernel code than native Linux. Path E (QEMU user-mode) avoids this by translating rather than intercepting.

**Path E assessment:** Provides **implicit syscall filtering** through QEMU's translation layer — many dangerous syscalls simply aren't implemented and return ENOSYS. However, QEMU officially disclaims security guarantees for user-mode, and the guest shares the host filesystem and network. Best used as **one defense layer** combined with Lambda's Firecracker boundary and Path A's resource controls.

---

## Cross-Cutting Papers Relevant to All Paths

**Agache et al., "Firecracker: Lightweight Virtualization for Serverless Applications" (2020)**
NSDI '20 — https://www.usenix.org/conference/nsdi20/presentation/agache

Lambda's outer security boundary. All five paths operate inside this boundary. Understanding Firecracker's seccomp filters and capability restrictions explains why nested sandboxing is so constrained.

**Salaün, "Landlock: From a Security Mechanism Idea to a Widely Available Implementation" (2024)**
https://landlock.io/talks/2024-06-06_landlock-article.pdf

Future enhancement for all paths: when Lambda upgrades to kernel 5.13+, Landlock enables unprivileged filesystem restriction without any blocked primitives.

**Abbadini et al., "NatiSand: Native Code Sandboxing for JavaScript Runtimes" (2023)**
RAID '23 — https://dl.acm.org/doi/10.1145/3607199.3607233

Combines Landlock + eBPF + seccomp for sandboxing native code in Deno. Demonstrates the multi-mechanism layering approach that Shimmy should adopt when self-hosted.

**Koczka (Google Security), "Learnings from kCTF VRP's 42 Linux Kernel Exploits" (2023)**
https://security.googleblog.com/2023/06/learnings-from-kctf-vrps-42-linux.html

60% of kernel exploits targeted io_uring. All paths must ensure io_uring_setup/enter/register are blocked (Path A via Firecracker's filter, Paths B/C via WASM/language-level isolation, Paths D/E via DBI/translation layer interception).

**Peveler et al., "Comparing Jailed Sandboxes vs Containers Within an Autograding System" (2019)**
SIGCSE '19 — https://dl.acm.org/doi/10.1145/3287324.3287507

Docker adds ~2.4 seconds per container creation — motivating lighter-weight approaches (all five paths) over per-execution container spawning.

---

## Summary: Path → Technique → Paper Mapping

| Path | Core technique | Key papers | Security level |
|------|---------------|------------|----------------|
| **A** | rlimits + env sanitization | Mareš 2012, Mareš 2021, Garfinkel 2003 | Resource control only |
| **B** | WASM linear memory + WASI caps | Haas 2017, Lehmann 2020, Bosamiya 2022 | Architectural isolation |
| **C** | Go memory safety + JS interpreter | Wahbe 1993, Shu 2016 | Language-level isolation |
| **D** | DBI code cache + syscall rewriting | Bruening 2004, D'Elia 2019/2021 | Syscall-level interception |
| **E** | Binary translation + syscall translation | Bellard 2005, QEMU security docs | Implicit syscall filtering |

**Recommended layering:** A (always) + B (for JS/compiled-to-WASM) or D (for arbitrary binaries) + Firecracker outer boundary. Path C for JS-only fast path. Path E as additional layer if exotic binaries are needed.
