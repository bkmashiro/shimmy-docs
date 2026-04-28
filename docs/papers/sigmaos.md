# SigmaOS: Unifying Serverless and Microservice Tasks

**Authors:** Ariel Szekely, Adam Belay, Robert Morris, M. Frans Kaashoek (MIT CSAIL)  **Venue:** SOSP  **Year:** 2024

## Summary

SigmaOS (σOS) is a new multi-tenant cloud operating system that unifies serverless functions and microservices under a single platform. Its core insight is that cloud-native applications depend primarily on cloud infrastructure rather than local OS features, so a minimal shared filesystem image suffices and network namespaces can be replaced by a lightweight endpoint abstraction (σEP). By eliminating overlay filesystem creation, network namespace setup, and using a 67-syscall whitelist, σOS achieves 7.7 ms cold starts, 36,650 procs/sec scheduling throughput, and established-connection performance identical to uncontained networking.

## Key Ideas

- **σEP (sigma endpoint)**: Replaces IP addresses and overlay networks. Connection establishment is brokered by a local `dialproxyd` that verifies tenant identity; after that, processes communicate via direct TCP socket passing. This eliminates the persistent overhead of overlay networks while preserving tenant isolation.
- **Unified proc abstraction**: All computation is expressed as procs — whether short-lived serverless functions or long-running microservices. `Spawn(descriptor)` queues the request; schedulers handle placement.
- **σ container**: Lightweight container that skips overlay filesystem creation (~5 ms savings) and network namespace setup (~100 ms savings). Creates only UTS/IPC/PID namespaces; uses FUSE-based binfs for demand-paging binary files from S3.
- **67-syscall whitelist**: σOS restricts each proc to 67 syscalls via seccomp-BPF — compared to Docker's 352 and Kubernetes' 340. All network syscalls (socket, connect, bind, accept, listen) are blocked; connections go through dialproxyd.
- **Two-level scheduling**: `lcsched` globally places latency-critical (LC) procs with CPU/memory reservations; `besched` shards distribute best-effort (BE) procs, with machines proactively pulling work.

## Relevance to Shimmy

σOS demonstrates that aggressive syscall reduction (67 vs. 352) combined with architectural alternatives to network namespaces can drastically reduce sandbox creation cost. For Shimmy, the key lessons are: (1) seccomp-BPF with a very short whitelist is practical and measurably reduces attack surface — the 67-syscall approach is a concrete design target for self-hosted Shimmy; (2) eliminating overlay filesystems and network namespaces from the sandbox creation path saves 100+ ms; (3) the LC/BE scheduling distinction is directly applicable to Shimmy's workload where interactive API requests (LC) and background grading tasks (BE) have fundamentally different latency requirements. Note that σOS's seccomp filter approach is not viable inside Lambda (where seccomp installation is blocked), but it is directly usable in Shimmy's self-hosted tier.

## Detailed Notes

### Problem & Motivation

Cloud applications need both:
1. **Microservices**: Long-running, stateful, needing communication and performance guarantees — Kubernetes is good, but instance startup is too slow (seconds) for burst parallelism
2. **Serverless functions**: Short-lived, stateless, massively parallel — Lambda is fast but doesn't support direct communication, long-lived state, or resource reservations

No platform simultaneously provides the generality of container orchestration and the fast startup of serverless.

**Why containers start slowly**:
1. Creating an isolated read-write filesystem from an application-specific container image
2. Configuring an IP address and isolated overlay network for each instance
3. Insufficient scheduling infrastructure speed

### Design & Architecture

**proc**: The unified compute unit. `Spawn(descriptor)` includes binary path, arguments, LC/BE tag, CPU reservation, memory reservation, optional failure domain.

Key departure from conventional systems: σOS does **not** automatically restart procs after failure. If a scheduling component crashes during proc creation, `WaitStart`/`WaitExit` return errors; callers decide whether to re-`Spawn`. This reduces creation cost.

**σEP**: Replaces overlay networks.
- Server calls `NewSigmaEP()`, writes σEP to named service, calls `Accept(Listener)`
- Client reads σEP from named service, calls `Dial(σEP)`
- Both sides IPC to local `dialproxyd`; it verifies both procs belong to the same realm, then passes the TCP socket file descriptor directly to each process
- After setup, dialproxyd is not on the data path — data flows directly between processes

**σ container creation steps**:
1. Only UTS/IPC/PID namespaces (not network)
2. Jail proc into filesystem with a few read-only config files + `/proc` + FUSE `binfs`
3. Seccomp: allow exactly 67 syscalls (memory, threads, signals, random, timers); block all network syscalls
4. AppArmor: drop all Linux capabilities
5. Assign to pre-created cgroup pool (avoids cgroup creation on the critical path)

**binfs**: FUSE server that demand-pages proc binary files from S3 or local disk cache. First run: read from S3, cache to local disk. Subsequent runs: direct from cache.

**Scheduling**:
- **LC procs**: `lcsched` (single global) tracks reserved CPU+RAM per machine; places LC procs where reservations are available
- **BE procs**: Multiple `besched` shards; machines proactively pull work from random shards

### Evaluation

**Hardware**: AWS EC2 m6i.4xlarge (16 vCPU, 64 GiB RAM), CloudLab c220g5.

**Startup latency**:

| Platform | Cold start (ms) | Warm start (ms) |
|----------|----------------|----------------|
| σOS | 7.7 | 2.0 |
| AWS Lambda | 1,290 | 46 |
| Docker | 2,671 | 469 |
| Kubernetes | 1,143 | 217 |
| Mitosis | 3.1 | 2.8 |
| Faasm | 8.8 | 0.3 |

σOS warm start (2.0 ms) is dramatically faster than Docker/K8s/Lambda. Faasm warm start (0.3 ms) is faster but relies on WASM runtime isolation rather than independent address spaces.

**Hot start breakdown** (BE proc):

| Operation | Time (ms) |
|-----------|----------|
| Scheduling placement | 0.42 |
| Linux namespaces | 0.28 |
| Filesystem jail | 0.42 |
| Seccomp filter | 0.46 |
| AppArmor | 0.02 |
| exec | 0.37 |
| **Total** | **1.97** |

Seccomp filter installation (0.46 ms) is the most expensive single operation.

**Scheduling throughput**:

| Component | Max throughput (procs/sec) |
|-----------|--------------------------|
| lcsched | 50,144 |
| Single besched shard | 53,306 |
| Single machine proc creation | 1,590 |
| 24-machine cluster end-to-end | 36,650 |

Single-machine bottleneck: Linux mount namespace creation requires a global lock.

**σEP network performance**:

| Metric | σOS σEP | No isolation | Docker overlay | K8s overlay |
|--------|---------|-------------|----------------|-------------|
| Dial latency (μs) | 659 | 131 | 413 | 195 |
| Per-packet latency (μs) | 53 | 53 | 85 | 80 |
| Throughput (Gb/s) | 8.96 | 8.96 | 7.84 | 5.12 |

After connection establishment, σEP latency and throughput are identical to uncontained networking.

**Application benchmarks** (DeathStarBench hotel, 8-machine CloudLab):
- σOS vs. K8s: p99 latency reduced 42%, peak throughput 1.68× higher
- σOS socialnet vs. K8s: p99 latency reduced 47%, peak throughput 3.01× higher

### Strengths & Weaknesses

**Strengths**:
1. Radical reduction in startup cost by eliminating overlay filesystem and network namespace (the two slowest operations)
2. σEP provides tenant isolation with zero cost to established connections vs. uncontained networking
3. Unified LC/BE scheduling with resource guarantees
4. 67-syscall whitelist is a concrete, auditable security design

**Weaknesses**:
1. Not backward-compatible — existing applications must be ported to the σOS API
2. Limited authorization model — only AWS S3 tokens and 9P ACLs; no fine-grained authorization
3. Go runtime startup adds ~15 ms for Go-based procs (worked around in evaluation)
4. Mount namespace creation global lock limits single-machine throughput to 1,590 procs/sec

### Glossary

- **proc**: σOS's unified compute unit — may be serverless function or long-running microservice
- **σEP (sigma endpoint)**: Network endpoint abstraction replacing IP+overlay; connection brokered by dialproxyd, then direct
- **σ container**: Lightweight isolation container without overlay filesystem or network namespace; uses seccomp 67-syscall whitelist
- **realm**: Per-tenant isolation and global namespace unit (based on etcd + Raft)
- **dialproxyd**: Per-machine proxy that brokers connection establishment and verifies tenant identity
- **binfs**: FUSE server that demand-pages proc binaries from S3 or local cache
- **LC (latency-critical)**: Proc type with CPU and memory reservations; scheduled globally by lcsched
- **BE (best-effort)**: Proc type using unreserved resources and idle LC reservations; scheduled by besched shards
- **named**: Per-tenant naming service (based on etcd) for service discovery and shared state
