# SoK Overview: Sandboxing Untrusted Code in Constrained Serverless Environments

**Yuzhe · Imperial College London · 2026**

---

## The Nested Sandboxing Problem

AWS Lambda provides strong inter-tenant isolation through Firecracker microVMs. But this same security posture creates a paradox for applications that must sandbox untrusted code *within* a single tenant's function: the platform deliberately blocks the primitives that sandboxing tools require. Educational autograders, online judges, and AI agent frameworks all need to execute user-supplied code with restrictions beyond what Lambda itself enforces — and find themselves unable to use gVisor, bubblewrap, nsjail, seccomp, ptrace, or any mainstream Linux sandboxing tool.

This is the **nested sandboxing problem**: the outer sandbox (Firecracker) intentionally prevents the construction of inner sandboxes to reduce its own attack surface.

## Lambda's Constraint Profile

Inside Lambda, the following primitives are blocked (returning EPERM):

`prctl(PR_SET_NO_NEW_PRIVS)` · `seccomp(SECCOMP_SET_MODE_FILTER)` · `ptrace()` · `clone(CLONE_NEWUSER)` · `chroot()` · `mount()` · eBPF loading · `prctl(PR_SET_PDEATHSIG)` · `/dev/kvm`

The only process restriction primitive that works is `setrlimit()`/`prlimit()`. The guest kernel is **Linux 5.10**, placing Landlock (requires 5.13+) and Syscall User Dispatch (requires 5.11+) out of reach. All processes run as uid 993; `/tmp` persists across warm invocations.

## A Taxonomy of Sandboxing Mechanisms

The paper organises mechanisms along four dimensions: **enforcement mechanism** (kernel, hypervisor, translator, or interpreter), **isolation granularity** (syscall, process, VM, or language), **trust boundary** (what must be correct for isolation to hold), and **Lambda compatibility** (native, partial, blocked, or future).

Five paradigms emerge:

1. **Kernel-mediated** (seccomp-BPF, Landlock, namespaces): strongest guarantees, requires kernel support → all blocked in Lambda
2. **Hypervisor-mediated** (Firecracker, QEMU/KVM, gVisor): hardware-backed isolation → available only as Lambda's outer boundary or QEMU-without-KVM (very slow)
3. **Translator-mediated** (DynamoRIO, QEMU user-mode, zpoline): userspace binary interposition → partially available; DynamoRIO likely works, zpoline blocked by mmap_min_addr
4. **Interpreter-mediated** (WASM/wazero, Goja, Deno): language runtime restricts operations → fully available, best cross-platform story
5. **Resource limits** (rlimits, cgroups): caps without filtering → partially available (rlimits work; cgroups require CAP_SYS_ADMIN)

## Five Implementation Paths Evaluated

The paper evaluates five concrete paths against eight design goals (resource control, syscall restriction, filesystem isolation, network isolation, credential protection, cross-platform, language breadth, low overhead):

| Path | Core technique | G1 Resource | G2 Syscall | G3 Filesystem | G4 Network | Overhead |
|------|---------------|:-----------:|:----------:|:-------------:|:----------:|---------|
| A | rlimits + env sanitization | ✓ | ✗ | ✗ | ✗ | ~0% |
| B | wazero WASM sandbox | ✓ | ✓ | ✓ | ✓ | 1.5–8× |
| C | Goja (pure Go JS engine) | Partial | ✓ | ✓ | ✓ | ~20× vs V8 |
| D | DynamoRIO (LD_PRELOAD) | Partial | ✓ | Partial | Partial | 1.1–1.3× |
| E | QEMU user-mode | Partial | Partial | ✗ | ✗ | 2–5× |

Path A (rlimits) is the necessary baseline for all other paths but provides no syscall restriction. Path B (WASM) provides the best security properties — architectural isolation without any kernel features, satisfaction of all five security goals by construction, and formal verification results (WaVe, VeriWasm) backing its claims. The key limitation is Python-in-WASM startup overhead (500 ms–2 s) and absence of NumPy/C-extension support. Path D (DynamoRIO) extends coverage to arbitrary ELF binaries at 10–30% overhead, bridging the gap for C/Python code that cannot be pre-compiled to WASM.

## Key Findings

**Six approaches are definitively blocked:** gVisor (all platforms), Kata/Sysbox/nested Firecracker, all rootless container runtimes (runc, crun, Podman, bubblewrap), Cosmopolitan pledge(), Intel Pin, and SIGSYS-without-seccomp.

**Eight approaches are viable:** WebAssembly/wazero, Lambda-per-execution, QEMU system-mode (slow), DynamoRIO, Deno, QEMU user-mode, LFI (ARM64), and static binary rewriting (offline).

**io_uring is the most critical unaddressed threat:** 60% of 42 kernel exploits from Google's kCTF VRP targeted io_uring. Any seccomp-based sandbox must block `io_uring_setup/enter/register`. In Lambda, Firecracker's host-side filter likely handles this — but this must be verified.

**Landlock is the most promising near-future improvement:** When Lambda upgrades its guest kernel to 5.13+, Landlock becomes available for unprivileged filesystem restriction without any currently-blocked primitives.

## Recommended Architecture

No single mechanism satisfies all design goals inside Lambda. The strongest practical architecture layers:

1. **Lambda-per-execution** in a VPC with no internet access, minimal IAM, tight timeout — Firecracker provides the outer hardware isolation boundary
2. **Path A always** — rlimits, environment sanitization, per-execution /tmp isolation, process group management
3. **Path B for supported languages** — wazero with no WASI capabilities for JS (QuickJS-WASM) and pre-compiled code; CPython-WASI for pure Python
4. **Path D for arbitrary binaries** — DynamoRIO in LD_PRELOAD mode for C/Python that cannot be pre-compiled to WASM

On **self-hosted Linux**, the full stack becomes available: seccomp-BPF via `elastic/go-seccomp-bpf`, Landlock via `landlock-lsm/go-landlock`, and syd/sydbox with Go bindings for supervised syscall execution. On **macOS development**, the system degrades gracefully to rlimits + embedded runtimes.

The most underexplored opportunity is **verified WASM runtimes** (WaVe, provably-safe compilers) combined with language interpreters compiled to WASM, providing provably-safe sandboxing with no kernel dependencies across all deployment environments.
