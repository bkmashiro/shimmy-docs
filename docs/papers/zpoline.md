# zpoline: A System Call Hook Mechanism Based on Binary Rewriting

**Authors:** Kenichi Yasukata, Hajime Tazaki, Pierre-Louis Aublin, Kenta Ishiguro (IIJ Research Laboratory / Hosei University)  **Venue:** USENIX ATC  **Year:** 2023

## Summary

zpoline is a system call hook mechanism for x86-64 CPUs that replaces `syscall`/`sysenter` instructions with a two-byte `callq *%rax` instruction, jumping to a trampoline at virtual address 0 consisting of a nop sled that redirects execution to a user-defined hook function. It achieves 28–761x lower overhead than exhaustive alternatives (SUD, int3, ptrace) and only 5.2% throughput reduction for Redis on a user-space network stack, compared to 72–99% degradation with other exhaustive mechanisms. The paper received the USENIX ATC 2023 Best Paper award.

## Key Ideas

- **The core trick**: On x86-64, the calling convention requires `rax` to hold the syscall number before executing `syscall`/`sysenter`. Since syscall numbers are small integers (0–~500), `callq *%rax` (also exactly 2 bytes: `0xff 0xd0`) jumps to a virtual address between 0 and ~500. Placing a nop sled + jump-to-hook at virtual address 0 routes every rewritten syscall instruction through the hook automatically.
- **Binary rewriting**: Replaces every `syscall` (0x0f 0x05) and `sysenter` (0x0f 0x34) instruction with `callq *%rax` (0xff 0xd0). Both source and target are exactly 2 bytes, so the replacement never breaks neighboring instructions.
- **Trampoline structure**: Virtual address 0 contains single-byte `nop` instructions for addresses 0–N (max syscall number), followed by a jump to the user-defined hook function.
- **NULL access termination**: Uses MPK (execute-only memory) to preserve NULL read/write faults, plus a bitmap of rewritten addresses to detect unexpected control transfers to address 0.
- **Hook isolation**: Uses `dlmopen` to load the hook implementation in a separate namespace to avoid infinite loops when hook functions call into libc.
- **No kernel modifications**: Pure user-space solution, loadable via LD_PRELOAD.
- **Performance**: 41 ns overhead per hook (vs. 31,201 ns for ptrace, 1,156 ns for SUD).

## Relevance to Shimmy

zpoline is directly referenced as a state-of-the-art syscall interception technique in Shimmy's research. It demonstrates that user-space syscall interception can achieve near-LD_PRELOAD performance while being exhaustive for statically-loaded code. However, the requirement for `mmap_min_addr = 0` makes it non-viable inside AWS Lambda. For self-hosted Shimmy deployments, zpoline (or its successor lazypoline) would be the recommended mechanism for DBI-based sandboxing. The paper also motivates why simpler approaches like LD_PRELOAD alone are insufficient for security-critical sandboxing.

## Detailed Notes

### Problem & Motivation

System call hooks are essential for tracing, sandboxing, OS emulation, and transparently applying user-space OS subsystems (like user-space TCP/IP stacks backed by DPDK). However, no existing mechanism for UNIX-like systems on x86-64 simultaneously achieves:

1. Low hook overhead
2. Exhaustive hooking (catches all syscalls)
3. No overwriting of unrelated instructions
4. No kernel modifications
5. No source code requirement
6. No specially modified standard libraries
7. Usable for syscall emulation

**ptrace** is exhaustive but imposes 31,201 ns per hook (context switch between tracer/tracee). **int3 signaling** and **SUD** achieve exhaustive hooking at 1,342 ns and 1,156 ns respectively (signal handling overhead). **LD_PRELOAD** has ~6 ns overhead but cannot exhaustively hook syscalls — glibc embeds `syscall`/`sysenter` in internal functions invisible to LD_PRELOAD. Other binary rewriting techniques (instruction punning, E9Patch, XContainers) cannot exhaustively rewrite all syscall sites due to disassembly limitations.

### Design & Architecture

**Binary Rewriting**: zpoline replaces every `syscall` and `sysenter` instruction found in executable memory regions with `callq *%rax`. Since both source and target instructions are exactly 2 bytes, the replacement never breaks neighboring instructions — a fundamental advantage over techniques that need more bytes for jump targets.

**Trampoline Code**: At virtual address 0, zpoline allocates memory and fills it with:
- Addresses 0 through N (max syscall number, ~448 on Linux 5.15): single-byte `nop` (0x90) instructions
- Address N+1: a jump to the user-defined hook function

When `callq *%rax` executes with, say, `rax = 1` (write), execution jumps to address 1, slides through all subsequent nops, and arrives at the hook function.

**NULL Access Termination**: Mapping memory at virtual address 0 breaks NULL pointer detection. zpoline mitigates this via eXecute-Only Memory (XOM) using MPK for NULL reads/writes, and a bitmap of replaced syscall addresses to detect unexpected NULL code execution.

**Setup Procedure**: Implemented as a shared library (`libzpoline.so`) loaded via LD_PRELOAD, or a special loader for statically linked binaries. Before `main()` starts, it mmaps virtual address 0, fills the trampoline, scans executable memory from procfs, and replaces syscall instructions.

### Evaluation

| Mechanism | Time (ns) | Relative to zpoline |
|-----------|-----------|---------------------|
| ptrace | 31,201 | 761x slower |
| int3 signaling | 1,342 | 32.7x slower |
| SUD | 1,156 | 28.1x slower |
| zpoline | 41 | — |
| LD_PRELOAD | 6 | 6.8x faster |

**Application Benchmarks (lwIP + DPDK)**:
- Redis (GET workload): zpoline 5.2% throughput reduction vs. LD_PRELOAD; SUD 72.3%, int3 75.0%, ptrace 98.8%
- HTTP server: zpoline 12.7% reduction; SUD 83.0%, int3 85.3%, ptrace 98.9%

### Strengths & Weaknesses

**Strengths**:
1. Elegant 2-byte rewriting trick that completely solves the instruction-size mismatch problem
2. Practical performance: 41 ns overhead, 28–761x better than exhaustive alternatives
3. No kernel modifications; transparent to applications

**Weaknesses**:
1. **Not truly exhaustive**: Cannot hook syscalls loaded or generated after setup (JIT compilers, packed binaries)
2. **x86-64 only**: Relies on variable-length instructions and unaligned jumps
3. **Virtual address 0 requirement**: Needs root or `mmap_min_addr = 0` — unavailable in AWS Lambda
4. **No security guarantees**: Trampoline and hook are in the same address space as the application; a malicious process can bypass

### Relation to Other Work

zpoline's most direct descendant is lazypoline (DSN 2024), which uses zpoline as its fast path but adds SUD as a slow path for exhaustive discovery of dynamically generated syscall sites, directly addressing zpoline's biggest limitation.

### Glossary

- **zpoline**: System call hook mechanism that rewrites syscall/sysenter to `callq *%rax` with a trampoline at virtual address 0
- **Trampoline code**: The nop sled at address 0..N followed by a jump to the hook function
- **`callq *%rax`**: x86-64 instruction (0xff 0xd0) that pushes the return address and jumps to the address in rax
- **Nop sled**: A sequence of nop (0x90) instructions that execution "slides" through to reach the hook
- **XOM (eXecute-Only Memory)**: Memory protection mode where pages can be executed but not read or written
- **SUD (Syscall User Dispatch)**: Linux kernel mechanism (since 5.11) that raises SIGSYS on syscall invocation for user-space handling
- **vDSO**: Virtual dynamic shared object; kernel-provided library for fast syscalls that bypass the normal syscall path
- **DPDK (Data Plane Development Kit)**: Framework for kernel-bypass packet processing
- **lwIP**: Lightweight TCP/IP stack that can run in user space
