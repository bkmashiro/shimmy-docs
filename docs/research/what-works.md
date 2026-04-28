# Sandboxing in Lambda: What Actually Works

Lambda blocks nearly every kernel-level sandboxing primitive. After extensive research, the critical finding is that AWS Lambda's guest-side restrictions block `prctl(PR_SET_NO_NEW_PRIVS)`, seccomp filter installation, ptrace, user namespaces, and eBPF — eliminating every major Linux sandboxing tool (gVisor, bubblewrap, nsjail, minijail, firejail). The only kernel primitive confirmed working for process restriction is `setrlimit`/`prlimit`. Shimmy's sandboxing strategy must rely on **Firecracker as the outer security boundary**, rlimits for resource control, environment sanitization, and userspace-only isolation techniques like embedded runtimes (WASM via wazero, V8 isolates) or Deno's permission model.

---

## Lambda Is More Locked Down Than Documented

The conventional wisdom — that Firecracker's seccomp applies only host-side and the guest kernel provides "almost all syscalls" — is **misleading for Lambda specifically**. AWS applies additional seccomp filters and capability restrictions *inside* the guest microVM that block key sandboxing primitives.

**Confirmed blocked inside Lambda** (from OpenAI Codex issue #4725, Plotly/Kaleido #313, Sentry-Native #925, and aws/containers-roadmap #2102):

- **`prctl(PR_SET_NO_NEW_PRIVS)`** — EPERM. This is the prerequisite for unprivileged seccomp filter installation; seccomp-bpf self-sandboxing is impossible.
- **`prctl(PR_SET_SECCOMP)` / `seccomp(SECCOMP_SET_MODE_FILTER)`** — blocked because PR_SET_NO_NEW_PRIVS cannot be set and CAP_SYS_ADMIN is unavailable.
- **`ptrace()`** — explicitly blocked per AWS Lambda FAQ.
- **`clone()` with `CLONE_NEWUSER`** — EPERM (confirmed in aws/containers-roadmap#2102).
- **eBPF** — requires elevated capabilities not granted to Lambda processes.
- **`chroot()`** — requires CAP_SYS_CHROOT.
- **`prctl(PR_SET_PDEATHSIG)`** — blocked.

**Confirmed working inside Lambda:**

- **`setrlimit()` / `prlimit()`** — standard unprivileged operations for CPU, memory, file size, process count, and file descriptor limits.
- **`fork()` / `exec()`** — child process spawning works normally.
- **`process_vm_readv()` / `process_vm_writev()`** — available between same-UID processes.
- **`/proc` filesystem** — readable, exposing cpuinfo, meminfo, network info, and **environment variables including AWS credentials**.
- **Standard file I/O in `/tmp`** — writable, persists across warm invocations.
- **`mprotect(PROT_EXEC)`** — likely available (V8/JIT works).

The guest kernel is **Linux 5.10**. This means Landlock (requires 5.13+) and Syscall User Dispatch (requires 5.11+) are unavailable. Amazon Linux 2023 enabled `CONFIG_SECURITY_LANDLOCK` for kernel 6.1+ — a future Lambda kernel upgrade could change this picture.

---

## Every Major Linux Sandboxing Tool Fails Inside Lambda

A systematic evaluation reaches the same conclusion: every mainstream sandboxing tool requires at least one of root, user namespaces, ptrace, or seccomp installation — none of which Lambda permits.

**gVisor** has three platforms, all blocked. KVM platform needs `/dev/kvm`. ptrace platform needs ptrace. systrap platform (default since mid-2023) requires user namespaces for sandbox setup even in `--rootless` mode; `CLONE_NEWUSER` returns EPERM.

**Bubblewrap** requires either unprivileged user namespaces or SUID root. Fails with "No permissions to create new namespace."

**nsjail** relies on Linux namespaces for all isolation. `--disable_clone_newuser` requires root, and seccomp installation is blocked.

**Minijail and Firejail** — same pattern. Both require user namespaces or root.

**go-judge** degrades to rlimits-only mode without cgroup/namespace support — processes can read/write the Lambda filesystem, access the network, see other processes. No evidence of anyone successfully running go-judge inside Lambda.

---

## Practical Techniques That Work

### Resource Limits via rlimits

The most reliable sandboxing primitive available. In Go, use `syscall.Setrlimit()` in a re-exec child:

- **`RLIMIT_CPU`** — hard cap on CPU seconds (SIGKILL after hard limit)
- **`RLIMIT_AS`** — address space cap prevents memory bombs
- **`RLIMIT_FSIZE`** — limits file write size
- **`RLIMIT_NOFILE`** — restricts open file descriptors
- **`RLIMIT_NPROC`** — prevents fork bombs (via `golang.org/x/sys/unix`)
- **`RLIMIT_CORE`** — set to 0 to prevent core dumps

**Important caveat:** `RLIMIT_NPROC` limits the total process count for a *user*, not a process tree. All Lambda invocations run as uid 993, so a fork bomb from one invocation can affect subsequent invocations in the same warm container. This is a hard limitation of the Lambda environment.

Go's `os/exec` does not have an `Rlimit` field on `SysProcAttr`. The cleanest pattern is a **re-exec wrapper**: a thin Go binary that applies rlimits via `syscall.Setrlimit()`, sanitizes the environment, then calls `syscall.Exec()` to replace itself with the target interpreter. This wrapper can be bundled with Shimmy and invoked for all untrusted code execution.

### Embedded Runtimes for Language-Specific Isolation

**For JavaScript**, three strong options:

**Goja** (`github.com/dop251/goja`) — pure Go JavaScript engine (no CGo) implementing ES5.1. Complete functional isolation — untrusted JS has zero access to filesystem, network, or host unless explicitly bridged. Used by Grafana K6 in production. Single-goroutine-per-runtime. Main limitation: ES5.1 only; ~20× slower than V8 for compute-heavy tasks.

**v8go** (`github.com/rogchap/v8go`) — embeds V8 in Go with ~290 μs per script execution (reusing isolates), 100× faster than spawning Node.js. Proper V8 isolate memory isolation. Requires CGo. Best choice when V8-grade JS compatibility matters.

**QJS-over-WASM** — QuickJS compiled to WebAssembly running inside wazero. Even a memory corruption bug in QuickJS cannot escape the WASM boundary. Strongest security option for JS.

**For Python**, options are weaker:
- RestrictedPython: explicitly "not a sandbox system," multiple CVEs (CVE-2024-47532, CVE-2025-22153).
- Python audit hooks (PEP 578): ctypes enables direct syscall calls, completely bypassing all hooks.
- PyPy sandbox mode: theoretically stronger (all I/O marshalled through a controller process) but experimental and limited to PyPy2.

**Practical answer for Python:** rlimits + environment sanitization + Firecracker as the security boundary, or CPython compiled to WASM via wazero (accepting the startup overhead).

**For C/C++:** Compiled native code can make arbitrary syscalls. Language-level sandboxing is not possible. Rlimits provide resource control; without seccomp, a malicious C program can call any syscall the Lambda environment permits. The mitigation is Firecracker's hardware isolation boundary plus strict rlimits.

### WASM as a Universal Sandbox

**Wazero** (`github.com/tetratelabs/wazero`) — zero-dependency, pure Go WebAssembly runtime. No CGo, no external dependencies, single binary. Each WASM module runs in complete isolation: no access to host memory, no filesystem or network access unless explicitly mounted via `FSConfig`.

For untrusted code that cannot be pre-compiled to WASM, run an interpreter compiled to WASM:
- Python-in-WASM: significant startup overhead (several seconds first compilation), limited package support
- JavaScript-in-WASM (QuickJS): much lighter, practical for production

### Environment Sanitization Details

Before `exec`-ing untrusted code:
- Clear `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_SESSION_EXPIRATION`
- Clear `_LAMBDA_LOG_FD`, `_LAMBDA_SHARED_MEM_FD`, all `_LAMBDA_*` variables
- Close every inherited file descriptor (iterate `/proc/self/fd`, keep only controlled pipes)
- Create a per-execution subdirectory in `/tmp` (`/tmp/execution-<uuid>/`), `chdir` into it, clean up after completion
- The Lambda Runtime API at `127.0.0.1:9001` is accessible to all processes — untrusted code could hijack invocation responses or register as an extension if not properly isolated

---

## How the Industry Handles This

The dominant pattern across platforms is that **the isolation boundary IS the VM or container**, not a sandbox within it.

**Cloudflare Workers** uses V8 isolates as primary mechanism with five additional security layers: Linux namespaces + seccomp at the process level, tenant cordoning by trust level, hardware Memory Protection Keys (MPK), V8's internal compressed pointer cages, and custom Spectre mitigations. Workers runs on infrastructure Cloudflare fully controls, not inside Lambda.

**Deno** enforces deny-by-default permissions in Rust: `deno run --no-prompt script.ts` without `--allow-*` flags permits only pure computation. Works inside Lambda (~140 MB binary). However, Deno's own documentation recommends additional OS-level sandboxing for truly untrusted code. Deno Sandbox (February 2026) uses Firecracker.

**Judge0** (most popular open-source code execution system) uses ioi/isolate, which requires `--privileged` Docker containers. **Cannot work inside Lambda.** The 2024 CVEs (CVE-2024-28185, CVE-2024-28189) demonstrate the risks of privileged container approaches.

**The Lambda-as-sandbox pattern:** Quesma (AI-generated R code), LambdaJudge (Python online judge), and others each give untrusted code its own Lambda invocation inside a VPC with no internet access. This leverages Firecracker's hardware isolation — the strongest available — as the security boundary.

---

## syd/sydbox for Self-Hosted Mode

**Sydbox (syd)**, presented at FOSDEM 2025, uses `SECCOMP_RET_USER_NOTIF` (seccomp user notifications) instead of ptrace. Requires Linux ≥5.6, no root, no ptrace rights. The supervisor receives syscall notifications via file descriptor, executes syscalls on behalf of the sandboxed process (eliminating TOCTOU races), and layers Landlock for filesystem restrictions. Has **Go bindings** (`gosyd`).

However, syd still requires `prctl(PR_SET_NO_NEW_PRIVS)` for seccomp filter installation — **blocked in Lambda**. For self-hosted and standalone modes where these restrictions don't apply, syd is the recommended advanced sandboxing solution.

---

## Recommended Tiered Architecture

### Tier 1: AWS Lambda Managed Mode

1. **rlimits** on every child process (CPU=5s, AS=256 MB, NOFILE=32, NPROC=1, FSIZE=10 MB) via re-exec wrapper
2. **Environment sanitization** — clear AWS_* and sensitive variables before forking
3. **Per-execution /tmp isolation** — unique temporary directory per execution, `chdir` into it, clean up after completion
4. **Process timeout enforcement** — Go-level context with deadline, `cmd.Process.Kill()` on timeout, then `kill(-pid, SIGKILL)` for process group cleanup
5. **Stdout/stderr capture with limits** — pipe output through parent with byte-count limits
6. **For JS:** Goja (pure Go, no CGo) or QJS-over-WASM (wazero) for strongest isolation
7. **For Python/C:** rely on rlimits + env sanitization + Firecracker boundary

### Tier 2: Self-Hosted Linux

1. **seccomp-bpf** via `elastic/go-seccomp-bpf` (pure Go, no CGo) — allowlist: read, write, exit, exit_group, brk, mmap, mprotect, munmap, futex, clock_gettime; KILL everything else for computation-only workloads
2. **Landlock** via `landlock-lsm/go-landlock` (official) — restrict filesystem to read-only `/usr`, `/lib`, `/bin` and read-write sandbox directory only. Use `BestEffort()` for graceful degradation on older kernels
3. **rlimits** as in Tier 1
4. **syd/sydbox** with Go bindings for most sophisticated unprivileged sandboxing

### Tier 3: macOS Development

1. **rlimits** (partially supported: RLIMIT_CPU, RLIMIT_FSIZE, RLIMIT_NOFILE work; RLIMIT_AS may not)
2. **Embedded runtimes** — Goja and wazero work identically on macOS (pure Go)
3. **Deno subprocess** — works on macOS with the same permission model
4. `shoenig/go-landlock` provides a no-op implementation on non-Linux for cross-platform builds

### Go Libraries

| Library | Purpose | Platform |
|---------|---------|---------|
| `golang.org/x/sys/unix` | prlimit, setrlimit, prctl wrappers | All |
| `github.com/elastic/go-seccomp-bpf` | Pure Go seccomp filter builder (no CGo) | Tier 2 only |
| `github.com/landlock-lsm/go-landlock` | Official Landlock bindings with BestEffort degradation | Tier 2 only |
| `github.com/tetratelabs/wazero` | Zero-dependency WASM runtime | All |
| `github.com/dop251/goja` | Pure Go JS engine | All |
| `github.com/rogchap/v8go` | V8 isolates in Go (CGo) | Linux/macOS |

---

## Core Insight

**Lambda's security model intentionally prevents nested sandboxing** — Firecracker IS the sandbox, and AWS blocks the primitives that would allow building a second one inside it. This is a deliberate design choice to reduce the guest kernel's attack surface against Firecracker itself, not an oversight.

For Shimmy, this means abandoning the search for a kernel-level inner sandbox in Lambda mode and instead building a practical defense-in-depth stack from the primitives that do work. The tiered architecture ensures that when running self-hosted or standalone — where seccomp, Landlock, and potentially syd become available — the system upgrades to genuine kernel-level sandboxing automatically.

The most underexplored opportunity is **wazero + language interpreters compiled to WASM**: true memory-safe sandboxing that works identically across all deployment modes and macOS, with no kernel feature dependencies.
