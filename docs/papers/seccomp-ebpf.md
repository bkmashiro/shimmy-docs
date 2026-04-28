# Programmable System Call Security with eBPF

**Authors:** Jinghao Jia, YiFei Zhu, Dan Williams, Andrea Arcangeli, Claudio Canella, Hubertus Franke, Tobin Feldman-Fitzthum, Dimitrios Skarlatos, Daniel Gruss, Tianyin Xu (UIUC / Google / Virginia Tech / Red Hat / AWS / IBM Research / CMU / Graz University of Technology)  **Venue:** arXiv  **Year:** 2023

## Summary

This paper proposes Seccomp-eBPF, a programmable system call filtering mechanism that overcomes the fundamental limitations of the existing Seccomp-cBPF: statelessness, limited expressiveness, inability to dereference pointer arguments, and no synchronization primitives. By introducing a new eBPF program type `BPF_PROG_TYPE_SECCOMP` and carefully designed helper functions for state management, user memory access, and syscall serialization, Seccomp-eBPF enables temporal specialization that reduces the syscall attack surface by an additional 33–55% compared to static cBPF filters, while maintaining performance comparable to optimized cBPF.

## Key Ideas

- **`BPF_PROG_TYPE_SECCOMP`**: A new eBPF program type whose allowed helper functions and capability requirements are verified at load time by the eBPF verifier.
- **Five categories of helper functions**: State management (eBPF maps + safe task storage), serialization (`bpf_wait_syscall`), user memory access (`bpf_safe_read_user`), kernel access (`bpf_ktime_get_ns`), and eBPF features (`bpf_tail_call`).
- **Temporal specialization**: Because eBPF programs can maintain state, filters can enforce different syscall whitelists during the initialization phase vs. the serving phase — something impossible with stateless cBPF.
- **Safe user memory access**: Avoids TOCTTOU races by either copying target memory to a kernel-only region or write-protecting it against userspace modification during the check.
- **Syscall serialization**: `bpf_wait_syscall` uses per-syscall atomic counters and a schedule loop to prevent concurrent execution of specific syscall pairs, mitigating kernel race conditions like CVE-2016-5195 (Dirty COW).
- **Tamper protection**: `seccomp()` closes the eBPF program FD before returning; users must close all map FDs before calling `seccomp()`.

## Relevance to Shimmy

For Shimmy's self-hosted tier, Seccomp-eBPF offers two direct improvements over static cBPF filters. First, **temporal specialization** lets Shimmy apply a strict serving-phase whitelist after the sandbox initialization completes (e.g., blocking `exec`, `mmap` once student code starts), reducing attack surface by 33–55% with no compatibility cost. Second, **stateful call counting** lets Shimmy cap the number of dangerous syscalls (e.g., limiting `clone` to a fixed count per invocation) without a kernel patch.

For Lambda mode, Seccomp-eBPF is unavailable: seccomp installation is blocked inside Lambda, and the patch has not merged into the mainline kernel. However, the temporal specialization concept directly informs Shimmy's WASM-based sandboxing design — WASM's host function interface provides an equivalent of "phase-aware" capability exposure at the language level. The CVE mitigation data also validates Shimmy's preference for kernel-version-aware sandbox design.

## Detailed Notes

### Problem & Motivation

Linux's Seccomp is the most widely deployed syscall filtering mechanism — used by Docker, Kubernetes, gVisor, Firecracker, and Android. But the classic BPF (cBPF) language it uses has fundamental limitations:

1. **Stateless**: Filter output depends only on the syscall number and argument values, not on prior execution history. Cannot implement call counting, phase-based policies, or sequence checks.
2. **Limited expressiveness**: cBPF is too simple to invoke kernel helpers or use data structures like hash tables. The 4096-instruction limit forces complex policies to chain multiple filters, incurring indirect jump overhead (aggravated by Retpoline).
3. **No pointer dereference**: Cannot perform deep argument inspection (DPI) on pointer-type arguments — e.g., cannot inspect the filename string in `open()`.
4. **No synchronization primitives**: Cannot serialize concurrent syscalls to mitigate kernel race vulnerabilities.

The Seccomp Notifier mechanism (userspace decision proxy) addresses expressiveness but introduces severe context-switch overhead and TOCTTOU races.

These limitations force overly permissive policies in practice: container runtimes must allow `exec` for the entire container lifetime even though it's only needed during initialization.

### Design & Architecture

**New eBPF program type**:

The three-step workflow:
1. **Load**: Submit eBPF bytecode via `bpf()` syscall; verifier checks helper function usage and Seccomp data structure access bounds; optional JIT compilation.
2. **Install**: Call `seccomp()` with new flag `SECCOMP_FILTER_FLAG_EXTENDED`; kernel closes the eBPF program FD before returning.
3. **Run**: Every subsequent syscall triggers the installed eBPF filter.

**Helper function categories**:

| Category | Helper Functions | Notes |
|----------|-----------------|-------|
| State management | `bpf_map_lookup_elem`, `bpf_map_update_elem`, `bpf_map_delete_elem` | Standard eBPF maps (arrays, hash tables) |
| State management | `bpf_safe_task_storage_get`, `bpf_safe_task_storage_del` | Modified to avoid kernel pointer leakage |
| Serialization | `bpf_wait_syscall` | New helper; atomic counter + schedule loop |
| User memory access | `bpf_safe_read_user`, `bpf_safe_read_user_str` | TOCTTOU-safe; copies to kernel region or write-protects |
| Kernel access | `bpf_ktime_get_ns` | Existing helper exposed |
| eBPF features | `bpf_tail_call` | Existing helper exposed |

**Safe task storage**:

The existing `bpf_task_storage_get` requires a `task_struct` pointer obtained via `bpf_get_current_task_btf`, which needs `CAP_BPF` and `CAP_PERFMON`. Worse, `task_struct` contains a pointer to the parent process, enabling recursive traversal to init (PID 0) to leak sensitive kernel data. The new `bpf_safe_task_storage_get` automatically looks up the current task's group leader without taking a `task_struct` pointer input, eliminating the leak path.

**Safe user memory access**:

Two implementation options:
1. Copy target user memory to a kernel-only-accessible region before the check.
2. Write-protect the target user memory region against userspace access during the check.

Security is reduced to the Seccomp Notifier threat model (equivalent to ptrace). For non-dumpable processes (e.g., OpenSSH), only loaders with `CAP_SYS_PTRACE` can access the process's memory.

**Syscall serialization**:

Each syscall has a kernel-side atomic counter tracking how many threads are currently executing it. `bpf_wait_syscall(curr_nr, target_nr)` increments the current syscall's counter, then busy-waits via a schedule loop until the target syscall's counter drops to zero. For system-wide serialization policies, the filter is installed on the init process and inherited by all children. The set of conflicting syscall pairs is stored in an eBPF map updateable by a privileged userspace process after filter installation, enabling zero-restart mitigation of newly discovered race vulnerabilities.

**Tamper protection**:

- `seccomp()` automatically closes the eBPF program FD before returning to userspace.
- Users close all map FDs before calling `seccomp()` via `bpf_seccomp_close_fd`. Closing FDs does not delete maps — the maps remain alive via reference counting by the eBPF program itself.
- Namespace tracking: the filter records the user namespace at load time and verifies it at install time, blocking attackers from bypassing capability checks by creating new namespaces.

### Evaluation

**Hardware**: Intel i7-9700K, 8-core 3.60 GHz, 32 GB RAM, Ubuntu 20.04, Linux 5.15.0-rc3.

**Temporal specialization** (6 server applications, two phases: init P1 + serving P2):

| Application | \|S_init\| | \|S_serv\| | \|S_comm\| | Total allowed | Attack surface reduction |
|-------------|-----------|-----------|-----------|---------------|--------------------------|
| HTTPD | 71 | 83 | 47 | 107 | 33.6% |
| NGINX | 52 | 93 | 36 | 109 | 52.3% |
| Lighttpd | 46 | 78 | 25 | 99 | 53.5% |
| Memcached | 45 | 83 | 27 | 101 | 55.4% |
| Redis | 42 | 84 | 33 | 93 | 54.8% |
| Bind | 75 | 113 | 53 | 135 | 44.4% |

cBPF must allow S_init ∪ S_serv across the entire lifetime. eBPF allows only S_init during initialization and only S_serv during serving — the difference is 33.6–55.4% of the total attack surface.

**Vulnerability mitigation**:

| CVE | Attack pattern | Syscalls involved | eBPF defense |
|-----|---------------|-------------------|--------------|
| CVE-2016-0728 | Repeated syscall | keyctl | Counter limiting |
| CVE-2019-11487 | Repeated syscall | io_submit | Counter limiting |
| CVE-2017-5123 | Repeated syscall | waitid | Counter limiting |
| BusyBox Bug #9071 | Syscall sequence | socket → exec/mprotect | Syscall Flow Integrity Protection (SFIP) |
| CVE-2018-18281 | Racing syscalls | mremap, ftruncate | Serialization |
| CVE-2016-5195 (Dirty COW) | Racing syscalls | write/ptrace + madvise | Serialization |
| CVE-2017-7533 | Racing syscalls | fsnotify, rename | Serialization |

**Microbenchmarks** (policy: deny 245 syscalls, allow rest including getppid):

| Filter type | getppid time (cycles) | Filter overhead (cycles) |
|-------------|----------------------|--------------------------|
| No filter | 244.18 | 0 |
| cBPF (default libseccomp) | 493.06 | 214.19 |
| cBPF (optimized) | 329.47 | 68.68 |
| eBPF | 331.73 | 60.18 |
| Constant action bitmap | 297.60 | 0 |
| Seccomp Notifier | 15045.05 | 59.29 |

eBPF performance matches optimized cBPF (both use binary search). Seccomp Notifier is 45.4× slower than eBPF.

**Application benchmarks** (6 server applications): eBPF and cBPF have comparable performance impact. Pure Notifier adds 48–188% average latency and reduces throughput 32–65%.

**Draco caching acceleration**: Using eBPF to cache recently validated (syscall ID, argument value) pairs yields ~10% throughput improvement across three web servers.

### Implementation Details

- **Platform**: Linux kernel v5.15.0-rc3 with patch; not yet merged into mainline.
- **Sleepable filters**: New BPF section names (`seccomp` and `seccomp-sleepable`) for handling page faults during user memory access.
- **Container runtime integration**: Modified `crun` (Podman's default runtime) to support Seccomp-eBPF. Attaching an eBPF filter requires one annotation: `podman --runtime /usr/local/bin/crun run --annotation run.oci.seccomp_ebpf_file=ebpf_filter.o`
- **Filter authoring**: Filters can be written in C or Rust, compiled to eBPF bytecode via LLVM/Clang.
- **Privilege configuration**: Sysctl option to restrict Seccomp-eBPF to `CAP_SYS_ADMIN` only.
- **Repository**: https://github.com/xlab-uiuc/seccomp-ebpf-upstream

### Limitations

1. **Not merged upstream**: The Linux community remains skeptical; some maintainers argue "Seccomp doesn't need eBPF." The authors presented at LPC 2022/2023 to advance the discussion.
2. **Non-privileged eBPF risk**: The eBPF verifier and JIT compiler have historically had bugs exploitable by malicious programs. A sysctl option restricts Seccomp-eBPF to privileged use as a mitigation.
3. **No automatic filter generation**: Writing eBPF filters requires manual effort; no automated tool exists to generate them from application profiles.
4. **Serialization performance**: Busy-wait-based syscall serialization may degrade high-concurrency performance; the paper does not extensively evaluate this.
5. **Complementary to LSM, not a replacement**: Seccomp filters at syscall entry points; LSM hooks deep in kernel object access paths. Both are necessary for complete policy coverage.

### Glossary

- **Seccomp (SECure COMPuting)**: Linux kernel's syscall filtering module, widely used in containers and sandboxes
- **cBPF (classic BPF)**: Classic BPF — stateless, simple instruction set; the existing Seccomp filter language
- **eBPF (extended BPF)**: Extended BPF — Linux kernel's general programmable framework with maps, helper functions, and JIT compilation
- **Temporal specialization**: Applying different syscall policies at different application lifecycle phases (e.g., init vs. serving)
- **TOCTTOU (time-of-check-to-time-of-use)**: Race where userspace modifies a value after the filter checks it but before the kernel uses it
- **DPI (deep argument inspection)**: Dereferencing pointer-type syscall arguments to inspect their actual content
- **SFIP (Syscall Flow Integrity Protection)**: Using a state machine to verify that syscall sequences match expected control flow
- **Notifier**: Seccomp's userspace proxy mechanism that forwards syscall decisions to a userspace process
- **Task storage**: eBPF map type maintaining per-Linux-task key-value stores
- **NO_NEW_PRIVS**: Linux process attribute ensuring exec cannot gain new privileges; prerequisite for unprivileged Seccomp filters
