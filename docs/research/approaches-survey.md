# Lambda Sandboxing: Every Approach Surveyed

WebAssembly is the strongest practical sandbox available inside AWS Lambda today, but seven other viable approaches exist. Lambda's Firecracker microVM blocks seccomp filter installation, ptrace, user namespaces, chroot, and provides no `/dev/kvm` — eliminating most standard Linux sandboxing tools. After exhaustive analysis of 14 candidate approaches, **8 are viable** (with varying security guarantees), **6 are definitively blocked**, and 1 promising option (Landlock) awaits a kernel upgrade.

## Lambda's Restriction Landscape

Lambda runs inside Firecracker microVMs with guest kernel **Linux 5.10.240** (confirmed via the `k510ga` platform label). The complete list of blocked primitives:

| Primitive | Error | Notes |
|-----------|-------|-------|
| `prctl(PR_SET_NO_NEW_PRIVS)` | EPERM | Blocks all unprivileged seccomp-bpf |
| `prctl(PR_SET_SECCOMP)` / `seccomp(SECCOMP_SET_MODE_FILTER)` | EPERM | No syscall filtering |
| `ptrace()` | EPERM | Explicitly blocked per AWS Lambda FAQ |
| `clone(CLONE_NEWUSER)` | EPERM | No user namespaces |
| `chroot()` / `pivot_root` | EPERM | Requires root |
| `mount()` / bind mount / overlayfs | EPERM | Requires CAP_SYS_ADMIN |
| eBPF loading | EPERM | Requires elevated capabilities |
| `prctl(PR_SET_PDEATHSIG)` | EPERM | Blocked |
| `/dev/kvm` | Not present | No nested virtualization |
| Landlock LSM | EINVAL | Kernel 5.13+ required |
| Syscall User Dispatch (SUD) | EINVAL | Kernel 5.11+ required |

All processes run as `sbx_user1051` (uid 993). Only `/tmp` is writable (512 MB–10 GB). `/var/task`, `/var/runtime`, and `/opt` are read-only.

**Important:** `/tmp` persists across warm invocations. This means state from one untrusted execution can affect the next unless explicitly cleaned up.

## Tier 1: Production-Ready Approaches with Strong Security

### WebAssembly — Best Security-to-Complexity Ratio

WASM is purpose-built for this problem. Modules execute inside a **linear memory sandbox** with bounds checking on every memory access. No filesystem, network, or syscall access exists unless explicitly granted via WASI capabilities. The runtime is a normal unprivileged userspace process.

**Runtime options:**
- **wazero** (pure Go, zero CGo): Ideal for Go-based Lambda. Single binary, interpreter and AOT compiler modes (10× speed difference). Each module runs in complete isolation.
- **Wasmtime**: Fuel-based instruction metering (precise CPU limiting), epoch-based interruption, 5-microsecond instantiation for pre-compiled modules. Fastly runs Wasmtime in production at 35-microsecond cold starts.

**Language support:**
- C, C++, Rust, Go, Zig: compile directly to WASM with **5–15% overhead** vs. native
- Python: via `python.wasm` (CPython-WASI) — ~34 MB bundle, 500 ms–2 s startup (cacheable), pure stdlib works; NumPy/C extensions do not
- JavaScript: via QuickJS-WASM — ~2 MB binary, ~300 ms first compile, ~0.5 ms cached

A practical Lambda bundle — wazero + python.wasm + quickjs.wasm + pre-compiled C modules — totals ~50–60 MB, well within Lambda's 250 MB limit.

### Lambda-per-Execution — Firecracker's Own VM Boundary

Each Lambda invocation gets its own **Firecracker microVM with a dedicated kernel** — hardware-virtualization-level isolation. Pattern: spawn a separate Lambda function per untrusted execution, configured with a VPC with no internet access, minimal IAM role, and a tight timeout.

**Required hardening before exec-ing untrusted code:**
- Clear all `AWS_*` and `_LAMBDA_*` environment variables
- Close every inherited file descriptor (iterate `/proc/self/fd`, keep only controlled pipes)
- Redirect stdin/stdout/stderr through pipes you control
- Create a new process group (`setpgid(0, 0)`) for clean `killpg` termination
- Apply `setrlimit`: RLIMIT_CPU (10s), RLIMIT_AS (256 MB), RLIMIT_NPROC (10), RLIMIT_FSIZE (50 MB), RLIMIT_NOFILE (20)

**Cost:** ~$0.00033 per 10-second execution at 2048 MB, or ~$333/month at 1M executions. Main downside: ~300–500 ms cold start, ~50–200 ms warm routing overhead.

### QEMU Full-System Emulation — Strongest In-Lambda Isolation

QEMU system mode with the **microvm machine type** boots a complete Linux kernel inside an emulated VM. Guest syscalls never reach the host kernel. No shared filesystem, no shared network. A genuine two-layer VM isolation boundary.

Without KVM (Lambda uses software TCG): expect **8–12× slower execution** and **5–30 second boot times**. A minimal setup (QEMU ~15–30 MB + kernel ~5–10 MB + Python-based initramfs ~140 MB) totals ~200 MB. QEMU's own documentation states TCG is "not considered a security boundary."

The `exec-sandbox` project (Apache 2.0, active 2025–2026) demonstrates this with Alpine Linux 3.21, a hardened kernel with ~360 subsystems removed, EROFS read-only rootfs, and a Rust guest agent over virtio-serial. With KVM: 400 ms cold start, 57 ms p50 execution.

## Tier 2: Viable Approaches with Meaningful Caveats

### DynamoRIO — Syscall Interception Without ptrace

DynamoRIO's dynamic binary instrumentation engine translates every basic block at runtime, replacing `syscall` instructions with calls to its own handlers. The primary Linux injection mode uses **LD_PRELOAD, not ptrace** — the ptrace path is only for attaching to already-running processes.

The `dr_register_pre_syscall_event()` API allows blocking or modifying any syscall. Since all code passes through the translation engine, raw `syscall` instructions in untrusted code are rewritten — unlike LD_PRELOAD, this cannot be bypassed by inline assembly. **10–30% overhead**, works on any x86-64 ELF binary.

**Lambda status:** Likely functional (requires `mprotect(PROT_EXEC)` for JIT — available since V8 and Java JIT work in Lambda). Pending direct verification.

### Deno — Permission Model in Rust

Deno's security model is deny-by-default: without `--allow-*` flags, all filesystem, network, environment, subprocess, and FFI access is blocked. Enforced in Rust within the Deno runtime — no seccomp or ptrace. Binary ~140 MB (or ~61 MB for `denort`).

**Limitations:** CVE-2024-34346 showed `/proc/self/mem` writes could grant all permissions. An NDSS 2025 paper found `/proc/self/environ` reads (patched in Deno 1.43+). Deno's own documentation recommends additional OS-level sandboxing. Best thought of as one defense layer, not a complete sandbox.

For Python: **Pyodide (CPython compiled to WASM) inside Deno** is a validated pattern used by LangChain Sandbox and Pydantic AI.

### QEMU User-Mode — Implicit Syscall Filtering

QEMU user-mode translates guest binary instructions via TCG, intercepting every syscall at the translation layer. Requires no ptrace, seccomp, namespaces, or KVM. Static binary ~5–20 MB. **2–5× overhead**.

**Critical weakness:** No filesystem or network isolation — the guest accesses the host filesystem directly through QEMU's syscall translation, runs with the same UID, shares the host network stack. Many dangerous syscalls return ENOSYS (providing implicit filtering), but QEMU explicitly states user-mode is "not a security boundary."

### LFI — Formally Verified SFI for ARM64 Lambda

Lightweight Fault Isolation (ASPLOS 2024, Stanford) reserves specific registers as sandbox base/addressing registers and uses a formally verified static verifier (~400 LOC) ensuring all memory accesses stay within a 4 GiB sandbox region. No OS sandboxing primitives required. **~6–8% overhead** on ARM64 SPEC2017 (1.5% for write-only sandboxing).

**Limitation:** x86-64 backend is experimental; ARM64 (Graviton Lambda) is the primary target. Code must be recompiled with the LFI compiler (being upstreamed into LLVM). C/C++/assembly only.

## Tier 3: Defense-in-Depth Layers, Not Standalone Sandboxes

### Interpreter Sandboxes

**Lua / Luau:** Genuinely good built-in sandboxing via restricted global tables + `debug.sethook` instruction counting. Luau (Roblox's fork) is battle-tested against millions of adversarial users. ~300 KB binary. Excellent if Lua is an acceptable language.

**Python audit hooks (PEP 578):** Explicitly not a sandbox — ctypes enables direct C library and syscall calls, bypassing all hooks. RestrictedPython has multiple CVEs. PyPy sandbox mode is theoretically stronger but unmaintained.

**Node.js `--experimental-permission`:** Described by Node.js itself as a "seat belt" for trusted code. CVE-2025-55130 demonstrated symlink path traversal bypass. Still experimental as of Node 25.

### Binary Rewriting

**E9Patch/E9Syscall and SaBRe:** Statically rewrite ELF binaries offline to redirect `syscall` instructions to handlers. **<3% overhead.** Works in Lambda (pre-rewrite offline, deploy modified binaries). Fundamental limitation: dynamically generated code (JIT) bypasses static rewriting.

**zpoline:** Requires `mmap_min_addr = 0` — Lambda likely doesn't allow this. Not viable without modification.

### LD_PRELOAD

Interposes libc wrapper functions. Trivially bypassed by: raw `syscall` instructions, statically linked binaries, Go/Rust defaults, io_uring, `dlsym(RTLD_NEXT)`. Useful for monitoring cooperative code only. **Not a security mechanism** for adversarial code.

## Six Definitively Blocked Approaches

| Approach | Reason blocked |
|----------|---------------|
| **gVisor** (all platforms) | systrap needs seccomp SECCOMP_RET_TRAP + ptrace; KVM platform needs `/dev/kvm`; ptrace platform needs ptrace; all modes need user namespaces |
| **Kata / Sysbox / nested Firecracker** | All require KVM; Firecracker doesn't support nested virtualization |
| **All rootless container runtimes** (runc, crun, Podman, bubblewrap) | All require user namespaces; runc errors "rootless containers require user namespaces" |
| **Cosmopolitan `pledge()`** | Implemented entirely via `prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER)` — returns EPERM |
| **Intel Pin** | Uses fork-ptrace injection mechanism |
| **SIGSYS without seccomp** | No kernel mechanism to trigger SIGSYS on syscall instructions without seccomp SECCOMP_RET_TRAP or SUD (needs kernel 5.11+) |

**go-judge note:** Degrades to rlimits-only mode when namespaces/seccomp are unavailable — processes can read/write the Lambda filesystem, access the network, see other processes. Not a sandbox in Lambda.

## Landlock: The Most Promising Future Option

Landlock (Linux 5.13+) enforces filesystem access control without root or any capabilities. Only `prctl(PR_SET_NO_NEW_PRIVS, 1)` is needed. Amazon Linux 2023 explicitly enables `CONFIG_SECURITY_LANDLOCK` on kernels 6.1 and 6.12.

Lambda currently runs 5.10. When AWS upgrades, Landlock becomes the **best lightweight sandboxing option**: restrict untrusted code to read/write only `/tmp/sandbox/`, deny all other filesystem access.

**Action:** Monitor `uname -r` inside Lambda and attempt `landlock_create_ruleset()` periodically to detect when this becomes available.

## Recommended Layered Architecture

No single approach provides complete isolation inside Lambda. The strongest practical architecture:

1. **Outer boundary:** Lambda-per-execution in a VPC with no internet access, minimal IAM role, tight timeout and memory limits
2. **Process hardening:** Clear environment variables, close all inherited FDs, redirect stdio through pipes, apply rlimits (CPU, memory, processes, files), new process group for clean termination
3. **Execution sandbox:** Run untrusted code inside a WASM runtime (wazero for Go Lambda, Wasmtime for maximum features) with no WASI capabilities granted
4. **Future enhancement:** Add Landlock filesystem restrictions when Lambda upgrades to kernel 5.13+

**Language-specific recommendations:**
- **Python (pure):** CPython-WASI inside wazero/Wasmtime; if C extensions required, Pyodide inside Deno inside Lambda-per-execution
- **JavaScript:** QuickJS-WASM for lightweight sandboxing; Deno with `--deny-all` for full V8 performance
- **C/C++:** Pre-compile to WASM offline, execute inside WASM runtime
- **Arbitrary compiled binary, near-native performance:** DynamoRIO in LD_PRELOAD mode (10–30% overhead), combined with Lambda-per-execution for the outer boundary
- **Maximum isolation regardless of performance:** QEMU system-mode with microvm and minimal initramfs (5–30 second boot, 8–12× runtime overhead)
