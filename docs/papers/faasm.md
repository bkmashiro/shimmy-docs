# Faasm: Lightweight Isolation for Efficient Stateful Serverless Computing

**Authors:** Simon Shillaker, Peter Pietzuch (Imperial College London)  **Venue:** USENIX ATC  **Year:** 2020

## Summary

Faasm introduces Faaslets, a new isolation abstraction for serverless computing that combines WebAssembly-based software fault isolation (SFI) for memory safety, Linux cgroups for CPU/network resource isolation, and shared memory regions for efficient state sharing between co-located functions. Faasm achieves 2× speed-up and 10× memory reduction over containers for ML training, doubles inference throughput, and reduces cold starts to hundreds of microseconds via Proto-Faaslet snapshots.

## Key Ideas

- **Faaslet abstraction**: Wraps a WebAssembly function with memory safety (SFI), CPU isolation (cgroups/CFS), network isolation (namespaces + tc), private memory, and shared memory regions — a complete isolation mechanism far lighter than containers.
- **Shared memory regions**: WebAssembly's linear memory model can be extended with regions that map onto common process memory without breaking safety guarantees. Co-located functions share in-memory state directly (zero-copy, zero-serialization).
- **Two-tier state architecture**: Local tier (shared memory within a host) + global tier (distributed KVS, currently Redis). Functions synchronize via explicit `push`/`pull` operations; large values split into independently managed chunks.
- **Proto-Faaslets**: Pre-initialized Faaslet snapshots (stack, heap, function table, stack pointer). Since WebAssembly memory is a simple byte array, snapshots are OS-independent and restorable via COW mapping in ~0.5 ms vs. ~5 ms for a fresh Faaslet or ~2.8 s for Docker.
- **Minimal host interface**: Not a full POSIX environment — a serverless-specific API for function invocation, key-value state, dynamic linking, memory, networking, and file I/O.

## Relevance to Shimmy

Faasm demonstrates that WebAssembly can serve as a production isolation mechanism for serverless computing, providing memory safety without containers or kernel-level sandboxing primitives. For Shimmy, which runs inside AWS Lambda where seccomp/namespaces are blocked, Faasm validates the wazero/WASM approach: Path B (wazero WASM sandbox) is architecturally identical to a single Faaslet, and the Proto-Faaslet snapshot mechanism directly motivates caching pre-compiled WASM modules to eliminate cold-start overhead. The paper also shows that WebAssembly's 32-bit address space limitation and compute overhead (40–240% for some benchmarks) are the practical constraints for this approach.

## Detailed Notes

### Problem & Motivation

Serverless computing has two fundamental problems:

1. **Data access overhead**: Stateless containers force all state to live externally (S3, Redis). Functions must duplicate, serialize, and transfer data repeatedly — worse with parallelism.
2. **Container resource footprint**: Multi-megabyte memory, hundreds-of-milliseconds cold starts, limited to thousands per machine.

The "cold start problem" and "data-shipping architecture" together prevent serverless from reaching its theoretical potential for data-intensive parallel workloads like ML training.

### Design & Architecture

**Faaslet abstraction components**:
- **Memory safety**: WebAssembly SFI — bounds-checked linear byte array; violations trigger traps
- **CPU isolation**: Dedicated thread in a cgroup with equal CPU share, scheduled by Linux CFS
- **Network isolation**: Own network namespace with virtual interface; `tc` enforces ingress/egress rate limits
- **Private memory**: Contiguous region allocated from process memory, accessed via offsets from zero
- **Shared memory regions**: Extensions of the linear byte array remapped via `mremap` onto common process memory

**Host interface** (not POSIX — serverless-specific):
- Function invocation: `chain_call`, `await_call`, `get_call_output`
- State API: `get_state`, `set_state`, `push/pull_state`, locking
- Dynamic linking: `dlopen`/`dlsym` for pre-compiled WebAssembly modules
- File I/O: Read-global, write-local filesystem with WASI capability-based security

**Proto-Faaslet mechanism**:
- Pre-initialize Faaslets and snapshot memory (stack, heap, function table)
- WebAssembly memory = simple byte array → snapshots are OS-independent
- Restore via copy-on-write memory mapping
- Guarantees clean state between calls (no information leakage between tenants)

**Two-tier state**:
- **Local tier**: State replicas as shared memory regions; local read/write locks for consistency
- **Global tier**: Authoritative values in distributed KVS; explicit `push`/`pull` for synchronization
- **DDOs (Distributed Data Objects)**: Language-specific classes (`SparseMatrixReadOnly`, `VectorAsync`) hiding the two-tier architecture

### Evaluation

**Testbed**: 20 Intel Xeon E3-1220 3.1 GHz machines, 16 GB RAM, 1 Gbps network. Baseline: Knative with Docker containers.

#### Faaslet vs. Container Overhead

| Metric | Docker | Faaslet | Proto-Faaslet | Improvement |
|--------|--------|---------|---------------|-------------|
| Init time | 2.8 s | 5.2 ms | 0.5 ms | 5600× |
| CPU cycles | 251M | 1.4K | 650 | 385K× |
| PSS memory | 1.3 MB | 200 KB | 90 KB | 15× |
| Capacity | ~8K | ~70K | >100K | 12× |

**ML Training (SGD, Reuters RCV1)**:
- 60% faster at 15 parallel functions
- Faasm scales to 38 functions (80% improvement); Knative exhausts memory at 30
- 70% reduction in network traffic due to local-tier batching
- 10× reduction in billable memory

**ML Inference (TensorFlow Lite / MobileNet)**:
- 200%+ increase in throughput
- Cold starts nearly free: <1 ms (Proto-Faaslet restore)

**Compute overhead (Polybench/C benchmarks)**: Most comparable to native; two benchmarks with 40–55% overhead due to lost loop optimizations; Python pidigits benchmark 240% overhead (big integer arithmetic in 32-bit WASM).

### Strengths & Weaknesses

**Strengths**:
1. Demonstrates containers are not the only viable isolation mechanism for serverless
2. Elegant layering: WebAssembly handles memory safety (the hard part), cgroups handle resources (the easy part)
3. 15× less memory, 5600× faster cold starts, 12× higher density than Docker
4. Two-tier architecture solves the data-shipping problem without sacrificing isolation

**Weaknesses**:
1. **32-bit address space**: Restricts Faaslets to 4 GB per function (64-bit WASM in development)
2. **WebAssembly performance overhead**: Some workloads 40–240% overhead due to lost compiler optimizations
3. **Trusted host interface**: Host interface bugs could break isolation; it operates outside WebAssembly's safety guarantees
4. **Redis as global tier**: Potential bottleneck for large-scale state synchronization

### Implementation Details

- **Compilation pipeline**: User compiles to WebAssembly → Faasm validates binary → generates machine code via LLVM JIT → links with host interface
- **Languages**: C/C++, Python, TypeScript (compilation to WebAssembly); CPython ported with <10 lines changed
- **WebAssembly VM**: WAVM (passes conformance tests)
- **Platform integration**: Deployed on Knative (Kubernetes-based serverless)

### Glossary

- **Faaslet**: Faasm's isolation abstraction combining WebAssembly SFI, Linux cgroups, and shared memory regions
- **Proto-Faaslet**: A snapshot of a pre-initialized Faaslet, restorable in hundreds of microseconds on any host
- **SFI (Software Fault Isolation)**: Restricts memory access through compile-time instrumentation and runtime traps
- **Two-tier state**: Local tier (shared memory on one host) + global tier (distributed KVS)
- **DDO (Distributed Data Object)**: Language-specific class exposing a high-level state interface over key-value state API
- **WASI**: WebAssembly System Interface — an emerging standard for server-side WebAssembly host interactions
- **Cold start**: The latency of initializing a new function instance from scratch
