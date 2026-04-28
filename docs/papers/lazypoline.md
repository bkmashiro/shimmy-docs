# Lazypoline: System Call Interposition Without Compromise

**Authors:** Adriaan Jacobs, Merve Gulmez, Alicia Andries, Stijn Volckaert, Alexios Voulimeneas (KU Leuven / Ericsson Security Research / TU Delft)  **Venue:** DSN  **Year:** 2024

## Summary

Lazypoline is the first system call interposition mechanism that is simultaneously exhaustive (intercepts all syscalls, including from JIT-compiled code), expressive (runs arbitrary interposer logic), and efficient (near-pure-binary-rewriting performance). It uses a hybrid design: Syscall User Dispatch (SUD) serves as a slow-path catch-all that discovers new syscall sites on first use, then lazily rewrites them to `call rax` (zpoline-style) for fast subsequent execution. On web server benchmarks, lazypoline maintains 94–95% of baseline throughput while guaranteeing exhaustive interception.

## Key Ideas

- **Lazy rewriting pattern**: Use a reliable-but-slow mechanism (SUD) to discover syscall sites once, then install a fast mechanism (`call rax` rewriting) for all future executions. The system converges toward pure-rewriting performance as more sites are discovered.
- **Hybrid slow/fast path**: SUD triggers a SIGSYS on first execution; the signal handler rewrites the 2-byte instruction to `call rax` and redirects RIP to the fast-path interposer. Subsequent calls bypass the kernel entirely.
- **Selector-only SUD**: Rather than allowlisting code address ranges (which creates security holes), lazypoline sets the selector to ALLOW before returning from the signal handler, reducing the security problem to protecting a single selector byte.
- **ABI correctness**: Identifies and fixes a real bug in all prior binary rewriters — the x86-64 ABI requires preserving extended state (SSE/AVX/x87 FPU) across syscalls. In Ubuntu 20.04 (glibc 2.31), 40% of coreutils are affected; in Clear Linux (glibc 2.39), 100% are affected. Lazypoline uses `xsave`/`xrstor` to preserve this state.
- **Exhaustiveness proof**: Demonstrated on Tiny C Compiler JIT — lazypoline and SUD both intercept a syscall embedded in JIT-compiled C code; zpoline misses it entirely.
- **Minimal implementation**: 1.4K lines of C/C++ and 200 lines of x86-64 assembly.

## Relevance to Shimmy

Lazypoline directly advances the state of syscall interception beyond zpoline by solving the exhaustiveness problem for dynamically generated code. For Shimmy's self-hosted deployments (where `mmap_min_addr = 0` and SUD kernel 5.11+ are available), lazypoline would be the recommended DBI-based sandboxing mechanism. The paper's ABI analysis is particularly important — any system that interposes on syscalls in a multi-threaded environment with modern glibc must preserve extended CPU state or face subtle, hard-to-debug failures. The K23 paper (Middleware '25) subsequently identified further pitfalls in lazypoline's implementation, making K23 the most complete solution in this lineage.

## Detailed Notes

### Problem & Motivation

System call interposition must be simultaneously:
1. **Expressive**: Can run arbitrary logic (deep argument inspection, state modification), not just BPF-limited filtering
2. **Exhaustive**: Catches *all* syscalls, including from dynamically loaded or JIT-compiled code
3. **Efficient**: Does not impose prohibitive overhead on syscall-intensive applications

No existing mechanism achieves all three:

| Mechanism | Expressive | Exhaustive | Efficient |
|-----------|-----------|-----------|----------|
| ptrace | ✓ | ✓ | ✗ (31,201 ns) |
| seccomp-BPF | ✗ | ✓ | ✓ |
| SUD | ✓ | ✓ | ✗ (~1,156 ns) |
| zpoline | ✓ | ✗ | ✓ (~41 ns) |
| **lazypoline** | **✓** | **✓** | **✓** |

### Design & Architecture

**Slow path (SUD-based)**: When an application executes a syscall instruction for the first time:
1. SUD triggers SIGSYS
2. Signal handler rewrites the syscall instruction to `call rax` (zpoline-style)
3. Modifies signal context's RIP to point to the fast-path interposer entry
4. Returns from handler with selector set to ALLOW, causing the interposer to execute without re-triggering SUD

**Fast path (zpoline-based)**: On subsequent executions, the rewritten `call rax` instruction jumps to virtual address 0..N (syscall number), slides through a nop sled, and lands in the interposer (~41 ns overhead).

The slow path remains constantly enabled to discover new syscall sites (e.g., newly loaded libraries or JIT-compiled code). Over time, the vast majority of syscalls take the fast path.

**Selector-only SUD**: Lazypoline never allowlists code address ranges — doing so would create security weaknesses (attackers could jump to allowlisted syscalls). Instead, it sets the selector to ALLOW before returning from the signal handler and uses `REG_RIP` modification to redirect execution. This reduces the security problem to protecting a single selector byte, solvable with MPK or similar mechanisms.

**ABI compatibility**: Extended state (`xstate`) — SSE/AVX/x87 FPU registers — must be preserved across syscalls per the x86-64 ABI. Prior binary rewriters (zpoline, SaBRe) do not preserve this, causing subtle failures. Lazypoline defaults to preserving all extended state, with a configurable option to skip for performance-sensitive interposers.

**Per-task state**: Each thread gets its own `%gs`-relative selector byte, xstate save area (managed as a stack for nested invocations), and sigreturn stack for signal handling.

### Evaluation

**Hardware**: 48-core Intel Xeon Gold 5318S, 1 TiB RAM, Ubuntu 22.04, Linux 5.15.

#### Microbenchmarks (100M non-existent syscall invocations)

| Mechanism | Overhead vs. baseline |
|-----------|----------------------|
| zpoline | 1.23× |
| lazypoline (no xstate) | 1.66× |
| lazypoline (with xstate) | 2.38× |
| SUD | 20.8× |
| baseline + SUD enabled | 1.42× |

The 1.42× overhead of merely enabling SUD (even for non-intercepted syscalls) is a kernel-level cost that lazypoline cannot eliminate.

#### Web Server Benchmarks (nginx, lighttpd)

- **nginx (1 worker)**: lazypoline (no xstate) ~94.7%, lazypoline (with xstate) ~90.0%, SUD significantly lower
- **lighttpd (1 worker)**: lazypoline (no xstate) ~94.8%
- From 64 KB files onward, the difference between zpoline and lazypoline practically vanishes

### Strengths & Weaknesses

**Strengths**:
1. First to achieve all three properties simultaneously without kernel/hardware modifications
2. Elegant lazy rewriting converges to optimal performance as syscall sites are discovered
3. Identifies and fixes a real ABI compatibility bug affecting all prior binary rewriters
4. Practical security model — reducing SUD attack surface to a single selector byte

**Weaknesses**:
1. **Linux/x86-64 only**: SUD is Linux-specific; zpoline technique requires variable-length instructions
2. **Enabling SUD has inherent cost**: 1.42× overhead even for non-intercepted syscalls (kernel-level cost)
3. **No security guarantees by default**: Selector byte, nop sled, and interposer state are in the same address space as the application
4. **First-execution penalty**: First invocation of each unique syscall site takes the slow path (~20× overhead)

The K23 paper (Middleware '25) identified additional pitfalls in lazypoline's implementation: LD_PRELOAD bypass (P1a), SUD disabling via prctl (P1b), attack-induced misidentification (P3b), missing NULL execution checks (P4a), and concurrent runtime rewriting issues (P5).

### Relation to Other Work

Lazypoline directly builds on zpoline (ATC 2023) for its fast path and SUD for its slow path. It directly addresses zpoline's fundamental limitation (non-exhaustiveness for dynamic code) while maintaining its performance advantage. The subsequent K23 paper (Clair Obscur, Middleware '25) identifies remaining pitfalls in lazypoline and presents a more complete solution through offline+online phase hybrid design.

### Glossary

- **Lazypoline**: Hybrid syscall interposition using SUD as slow-path discovery + zpoline-style fast path
- **SUD (Syscall User Dispatch)**: Linux 5.11+ kernel interface that raises SIGSYS when a process invokes a syscall
- **Slow path**: SUD-triggered signal handler that discovers and rewrites a new syscall site
- **Fast path**: The rewritten `call rax` instruction that jumps directly to the interposer
- **xstate**: Extended CPU state including SSE, AVX, and x87 FPU registers
- **SIGSYS**: Signal raised by SUD when an application invokes a syscall with selector set to BLOCK
- **Selector byte**: Per-task user-space byte that SUD checks; ALLOW lets syscalls pass, BLOCK triggers SIGSYS
- **Exhaustiveness**: The ability to intercept all invoked syscalls, including dynamically generated code
