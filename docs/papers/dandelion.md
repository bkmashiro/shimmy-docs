# Dandelion: Unlocking True Elasticity for the Cloud-Native Era

**Authors:** Tom Kuchler, Pinghe Li, Yazhuo Zhang, Lazar Cvetković, Boris Goranov, Tobias Stocker, Leon Thomm, Simone Kalbermatter, Tim Notter, Andrea Lattuada, Ana Klimovic (ETH Zurich / MPI-SWS)  **Venue:** SOSP  **Year:** 2025

## Summary

Dandelion is a cloud-native elastic compute platform whose core insight is that decomposing applications into pure compute functions (no syscalls) and communication functions (platform-provided I/O) eliminates the need for guest OS and network configuration — the root cause of slow cold starts. This reduces sandbox cold starts to hundreds of microseconds, cuts committed memory by 96% vs. Knative on Azure workloads, and reduces latency variance by 2–3 orders of magnitude. Dandelion implements four isolation backends: KVM (889 μs cold start), Process (486 μs), CHERI (89 μs), and rWasm (241 μs).

## Key Ideas

- **Pure compute functions**: User-provided functions that cannot issue syscalls, access the network, or create threads — they only consume declared input sets and produce declared output sets. The platform can sandbox these in an extremely lightweight container with no guest OS.
- **Communication functions**: Platform-provided I/O primitives (currently HTTP). Users can call but not modify them. They run in trusted execution without a sandbox.
- **DAG programming model**: A Dandelion composition is a directed graph of compute and communication functions with typed data edges specifying distribution semantics (`all`, `each`, `key`).
- **Four isolation backends**: KVM (hardware virtualization, no guest kernel), Process (ptrace-blocked), CHERI (in-process capability hardware), rWasm (Wasm-to-safe-Rust, compile-time isolation). Same dispatcher works with all backends.
- **PI-controller for compute/communication balance**: A proportional-integral controller measures queue growth rates every 30 ms and dynamically reallocates CPU cores between compute engines (run-to-completion) and communication engines (cooperative multithreading).
- **dlibc**: A custom C standard library that provides standard interfaces (malloc, file operations) backed by an in-memory virtual filesystem, without issuing syscalls.

## Relevance to Shimmy

Dandelion's core lesson is that POSIX is the enemy of cold-start performance. Guest OS loading and network configuration dominate Firecracker's snapshot cold-start time (>8 ms of the total). For Shimmy, this motivates a layered design: functions that only need to compute (e.g., student algorithm solutions) can run in an ultra-lightweight sandbox with no POSIX exposure, achieving sub-millisecond cold starts. Dandelion's pluggable backend architecture also demonstrates how a single scheduler can front multiple isolation mechanisms — relevant for Shimmy's tiered approach (Lambda mode vs. self-hosted). The 96% memory reduction achieved by eliminating pre-warming aligns directly with Shimmy's cost model: if cold starts are cheap enough, pre-warming becomes unnecessary.

## Detailed Notes

### Problem & Motivation

Serverless platforms achieve elasticity through rapid sandbox creation, but current approaches are fundamentally bottlenecked:

- **Cold start**: Firecracker snapshot restoration takes >10 ms, with >8 ms spent loading the guest OS snapshot and rebuilding the guest-host network connection — solely to provide a POSIX-like interface to user functions
- **Memory overprovisioning**: Keeping warm containers ready for burst traffic means platforms allocate 16× more memory than active requests actually need (measured on Azure Functions production trace with Knative autoscaling)
- **High tail latency**: Even when 97% of requests hit warm sandboxes, the 3% cold-start tail dominates p99 latency

**Root cause**: Current FaaS platforms unnecessarily expose a full POSIX environment to user functions. Cloud-native applications don't need it.

### Design & Architecture

**Programming model**: A composition is a directed graph G = (V, E):
- **Compute functions**: User code, no syscalls, no network, no threads. Receives input sets (folders), produces output sets.
- **Communication functions**: Platform-provided I/O (HTTP). Verified and sanitized by the platform.
- **Edges**: `(V1, V2, M)` where M specifies distribution: `all` (all items to single instance), `each` (each item to independent instance), `key` (grouped by key).

**dlibc/dlibc++**: Custom C standard library providing malloc, local filesystem operations, math — backed by an in-memory virtual filesystem. Syscalls for mmap, mprotect, socket, and threads have stub implementations that return appropriate error codes.

**Worker node components**:
- **Dispatcher**: Maintains DAG registry, tracks input/output dependencies, prepares isolated memory contexts, queues ready functions
- **Memory Context**: Bounded, contiguous memory region; uses virtual memory reservation + demand paging for zero-filled pages
- **Compute Engines**: One task to completion per engine; minimizes interference and context switches
- **Communication Engines**: Trusted; cooperative multithreading (green threads) on dedicated cores

**Four isolation backends**:

| Backend | Cold Start | Mechanism |
|---------|-----------|-----------|
| CHERI | 89 μs | Capability hardware — user code runs as a thread in the Dandelion process; CHERI capabilities provide in-address-space isolation |
| rWasm | 241 μs | Wasm-to-safe-Rust compiler; isolation enforced at compile time by Rust's memory safety |
| Process | 486 μs | Separate process with ptrace blocking all syscalls from the compute function |
| KVM | 889 μs | Hardware VM with no guest kernel; identity-mapped guest physical address space; reuses KVM structures to skip VM setup overhead |

**Control plane**: PI controller measures compute/communication queue growth rates every 30 ms, reallocates CPU cores accordingly. This dynamic separation of compute and I/O enables stable performance under mixed workloads.

### Evaluation

**Hardware**: 2× Intel Xeon E5-2630v3, 16 physical cores, 256 GiB DRAM. CHERI experiments on Arm Morello board (4 cores, 16 GiB). Azure trace experiments on CloudLab d430.

**Sandbox creation latency** (Morello board, 1×1 matrix multiply):

| Backend | Total latency (μs) |
|---------|--------------------|
| CHERI | 89 |
| rWasm | 241 |
| Process | 486 |
| KVM | 889 |

For comparison: Firecracker cold start >150 ms, Firecracker snapshot max 120 RPS; Wasmtime with pooled allocation ~7000 RPS.

**Matrix multiply (128×128, 16-core server)**:
- Dandelion KVM backend: 4800 RPS peak; creates new sandbox per request with stable latency
- Firecracker (97% warm): unstable after 2800 RPS due to CPU contention; peak 3000 RPS

**Mixed workload (log processing + image compression)**:
- Dandelion: avg/p99 latency variance 1.3%/2.9%
- Firecracker: 389%/1495% variance (bimodal due to cold starts)
- Wasmtime: 6.1%/79.2% variance

**Azure Functions trace replay** (100 functions, CloudLab cluster):
- Firecracker + Knative: average committed memory 2619 MB
- Dandelion (process backend): average committed memory **109 MB** (only 4%)
- Dandelion p99 end-to-end latency 46% lower than Firecracker

**SSB query processing vs. AWS Athena** (EC2 m7a.8xlarge, Apache Arrow Acero):
- Latency reduced 40%, cost reduced 67% for short queries

### Security Analysis

- **Attack surface**: Compute functions have no access to syscalls during execution; output parser is 100 lines of Rust (auditable)
- **TCB comparison**: Dandelion ~12K lines Rust (of which ~2K lines directly related to isolation); Firecracker ~68K lines Rust; gVisor ~38K lines Go

### Limitations

1. **Programming model restrictions**: Not suitable for OLTP, online games, fine-grained shared-memory algorithms; pure compute functions cannot issue syscalls, create threads, or open sockets
2. **Data copy overhead**: Current implementation copies data between contexts; future work: memory remapping or COW
3. **Language support**: Currently C/C++ SDK and CPython; planned LLVM extension for more languages
4. **Manual application splitting**: Developers must manually decompose apps into compute/communication functions
5. **rWasm overhead**: Transpiled code is less efficient than native compilation for compute-intensive tasks

### Glossary

- **Pure compute function**: User code that issues no syscalls, performs no I/O, only consumes declared inputs and produces declared outputs
- **Communication function**: Platform-provided I/O primitive (e.g., HTTP), trusted, runs outside the sandbox
- **dlibc**: Dandelion's custom C standard library backed by an in-memory virtual filesystem, no syscalls required
- **Memory context**: Bounded contiguous memory region allocated for each function invocation
- **CHERI**: Capability Hardware Enhanced RISC Instructions — in-process isolation via hardware capabilities
- **rWasm**: Wasm-to-safe-Rust compiler; compile-time isolation enforced by Rust's memory safety guarantees
- **Green threads**: Cooperative user-space threads, not depending on OS scheduling
- **PI controller**: Proportional-integral controller used to dynamically balance compute/communication engine core allocation
