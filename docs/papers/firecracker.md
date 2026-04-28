# Firecracker: Lightweight Virtualization for Serverless Applications

**Authors:** Alexandru Agache, Marc Brooker, Andreea Florescu, Alexandra Iordache, Anthony Liguori, Rolf Neugebauer, Phil Piwonka, Diana-Maria Popa (Amazon Web Services)  **Venue:** NSDI  **Year:** 2020

## Summary

Firecracker is a lightweight Virtual Machine Monitor (VMM) developed by AWS for serverless and container workloads. Its core insight is that specialization enables extreme efficiency: by replacing QEMU's 1.4M-line codebase with ~50K lines of Rust and eliminating every feature not needed for serverless (BIOS, legacy devices, PCI, VM migration, Windows), Firecracker achieves ~3 MB per-MicroVM memory overhead, 125 ms startup time, and the isolation strength of hardware virtualization. It is deployed in production for AWS Lambda and Fargate, handling trillions of requests per month.

## Key Ideas

- **Extreme specialization**: No BIOS, no PCI bus, no legacy devices, no VM migration, no Windows support. Each removed feature reduces code size, attack surface, and resource overhead simultaneously.
- **Four virtualized devices only**: virtio block (~1400 lines Rust), virtio net (similar), serial console (~250 lines), partial i8042 PS/2 controller (<50 lines). Block device chosen over filesystem passthrough to minimize host kernel attack surface.
- **Jailer**: A secondary security layer that sandboxes the Firecracker VMM process itself before it launches the guest — chroot with minimal files, PID + network namespaces, dropped capabilities, 24-syscall + 30-ioctl seccomp-BPF whitelist.
- **Soft allocation with oversubscription**: CPU and memory allocated on demand; tested at up to 20× oversubscription ratios. Idle MicroVMs consume only memory, not CPU.
- **Pre-warmed pool sizing via Little's Law**: Maintenance of a small pre-started MicroVM pool using `L = λW` (creation rate × creation latency) to hide startup latency.
- **Dependency on Linux, not reimplementation**: Scheduling, memory management, and networking delegated to the Linux host kernel, keeping Firecracker's own codebase minimal and auditable.

## Relevance to Shimmy

Firecracker is the isolation substrate that AWS Lambda runs on, making it the direct context for all of Shimmy's Lambda-mode constraints. The Jailer's 24-syscall seccomp-BPF whitelist is what the Shimmy guest kernel sees — this is why `ptrace`, `seccomp`, `user namespaces`, `chroot`, and `eBPF` are unavailable inside Lambda. Understanding Firecracker's architecture explains Shimmy's constraints from first principles rather than treating them as arbitrary.

The paper also provides Shimmy's design baseline: if 3 MB overhead and 125 ms cold start are acceptable for Lambda's general-purpose functions, Shimmy's specialized student code sandboxes (which need less capability) can target substantially lower numbers by using lighter mechanisms (WASM, rlimits-only). Firecracker's soft allocation model also validates Shimmy's cost analysis: idle warm sandboxes cost only their memory footprint, making pre-warming economical only when memory cost < latency-reduction value.

## Detailed Notes

### Problem & Motivation

Serverless computing and containers depend on multi-tenancy — running workloads from different customers on the same hardware to maximize utilization. Multi-tenancy requires two kinds of isolation:

1. **Security isolation**: Prevent one workload from accessing or inferring another's data, including defense against privilege escalation, information disclosure, and covert channel attacks.
2. **Performance isolation**: Prevent "noisy neighbor" effects.

The fundamental tradeoffs of existing approaches:

- **Linux containers** (cgroups + namespaces + seccomp-BPF): Extremely low overhead but security depends on restricting the syscall surface. Restricting syscalls breaks compatibility; Ubuntu 15.04 needs 224 syscalls + 52 ioctls to run normally.
- **Traditional virtualization** (QEMU/KVM): Strong isolation via hardware VT-x (security boundary moves from OS interface to hardware), but QEMU has >1.4M lines of code, ~131 MB per-VM memory overhead, hundreds of milliseconds startup — incompatible with serverless density requirements.
- **Language-level isolation** (V8 isolates, JVM): Cannot run arbitrary Linux binaries; vulnerable to Spectre-class microarchitectural attacks.

AWS Lambda's original design used one VM per customer with container-based isolation for functions within a VM, requiring unacceptable security/compatibility tradeoffs and inefficient bin packing due to fixed-size VMs.

### Lambda's Six Requirements

1. **Isolation**: Defend against broad attack classes including microarchitectural side channels
2. **Overhead & density**: Run thousands of functions per host with minimal overhead
3. **Performance**: Near-native, stable, isolated from neighbors
4. **Compatibility**: Support arbitrary unmodified Linux binaries
5. **Fast switching**: Millisecond-scale creation and teardown
6. **Soft allocation**: On-demand resource allocation supporting oversubscription

### Design & Architecture

**Device model**:

| Device | Implementation | Notes |
|--------|---------------|-------|
| virtio block | ~1400 lines Rust (incl. MMIO + data structures) | Storage |
| virtio net | Similar scale | Network |
| Serial console | ~250 lines Rust | Console output |
| i8042 (PS/2 controller) | <50 lines Rust | Partial implementation |

Block device chosen over filesystem passthrough: filesystems are large, complex codebases; exposing only block I/O protects a large portion of the host kernel's attack surface.

**Management interface**: Firecracker is configured and controlled via a REST API over a Unix socket. Enables pre-configuration: start the Firecracker process and configure the MicroVM before it is needed, then trigger startup on demand to reduce hot-path latency.

**Rate limiters**: Block and network devices have built-in token-bucket rate limiters (configurable via API) for IOPS, bandwidth, and burst. Implemented in the VMM rather than relying on cgroups because the device emulation layer is the optimal point to control host CPU consumption by guest I/O behavior.

**Security architecture — multi-layer defense**:

- **Microarchitectural side-channel mitigations**: Disabled SMT/HyperThreading, enabled KPTI, IBPB, IBRS, L1TF cache flush, SSBD, disabled swap and same-page merging, no shared files (prevent Flush+Reload and Prime+Probe attacks).
- **Guest kernel hardening**: Nearly all drivers removed; only virtio and serial retained; all features compiled in (no modules); optimized compressed kernel 4.0 MB vs. Ubuntu 18.04's 6.7 MB + 44 MB modules; serial console logging disabled (saves ~70 ms startup time).

**Jailer**:

Jailer sandboxes the Firecracker process itself before guest launch:
- `chroot` containing only the Firecracker binary, `/dev/net/tun`, cgroup control files, and resources for that specific MicroVM
- PID and network namespace isolation
- Dropped capabilities
- seccomp-BPF whitelist: exactly 24 syscalls (each with argument filtering) + 30 ioctls (22 of which are required by the KVM ioctl API)

**Lambda production architecture**:

```
Frontend (stateless) → Worker Manager (stateful router) → Placement Service
                                                         ↓
                                                   Workers (each runs hundreds–thousands of MicroVMs)
```

- **Worker Manager**: Custom high-throughput (<10 ms p99.9) stateful router performing sticky routing of same-function invocations to minimize cold starts.
- **Placement Service**: Global optimizer for slot placement across the worker fleet; time-based lease protocol.
- **MicroManager**: One process per worker, manages all Firecracker processes; maintains a small pre-started MicroVM pool.
- **Lambda Shim**: Control process inside each MicroVM; communicates with MicroManager via TCP/IP.

**Slot lifecycle**:

```
Init → Idle ↔ Busy → Dead (after max 12 hours)
```

Idle slots consume only memory; busy slots additionally consume CPU, cache, and network/memory bandwidth. Memory accounts for ~40% of typical server capital cost, so idle slots cost approximately 40% of busy slots.

**Pool sizing**: Using Little's Law (`L = λW`), at 125 ms startup latency and 8 MicroVM/sec creation rate, only 1 pre-started MicroVM is needed. This makes pre-warming economically efficient.

### Evaluation

**Hardware**: EC2 m5d.metal, 2× Intel Xeon Platinum 8175M (48 cores, SMT disabled), 384 GB RAM, 4× 840 GB NVMe SSD, Ubuntu 18.04, Linux 4.15.0. Compared against Firecracker v0.20.0, QEMU v4.2.0 (minimal static build), and Intel Cloud Hypervisor.

**Startup latency** (serial, 500 samples):

| VMM | Median startup time | Notes |
|-----|--------------------|----|
| Firecracker (pre-configured) | ~60 ms | API-triggered to init execution |
| Cloud Hypervisor | ~65 ms | Slightly slower than pre-configured FC |
| Firecracker (end-to-end) | ~80 ms | Including fork + API configuration |
| QEMU | ~120 ms+ | Including qboot minimal BIOS |

Parallel launch of 1000 MicroVMs (50 concurrent): pre-configured Firecracker p99 = 146 ms; 100 concurrent: p99 = 153 ms.

Startup cost contributors:
- Compressed kernel decompression: +40 ms
- Ubuntu 18.04 default kernel: +~900 ms (legacy device probing + unused driver loading)
- Adding a network interface: +20 ms (FC/Cloud HV) or +35 ms (QEMU)

**Memory overhead**:

| VMM | Per-VM memory overhead | Notes |
|-----|----------------------|-------|
| Firecracker | ~3 MB | Constant regardless of VM RAM size |
| Cloud Hypervisor | ~13 MB | Constant |
| QEMU | ~131 MB | Roughly constant |

For a 128 MB Lambda function, QEMU imposes >100% memory overhead; Firecracker ~2.3%.

**Block I/O** (fio, random I/O, queue depth 32, local NVMe):
- Firecracker 4 KB read IOPS: ~13,000 vs. bare-metal >340,000 — limited by serial I/O handling.
- 4 KB write: high (no flush-to-disk implemented at time of paper).
- 4 KB read p99 latency: Firecracker only 49 μs above bare-metal at queue depth 1.

**Network I/O** (iperf3, TAP interface, MTU 1500):

| VMM | Single-stream RX (Gb/s) | Single-stream TX (Gb/s) |
|-----|------------------------|------------------------|
| Bare-metal loopback | 44.14 | 44.14 |
| Firecracker | 15.61 | 14.15 |
| Cloud Hypervisor | 23.12 | 20.96 |
| QEMU | 23.76 | 20.43 |

Firecracker network throughput is lower than Cloud Hypervisor and QEMU but has not been a bottleneck in production.

**Oversubscription**: Tested at up to 20× oversubscription; production deployments use up to 10×.

### Production Deployment

Migration from old Lambda architecture (one EC2 instance per customer + containers per function) to Firecracker on EC2 bare-metal instances began in 2018.

Key operational lessons:
- Disabling SMT changed timing behavior, exposing subtle bugs in AWS SDK and Apache Commons HttpClient.
- DNS queries not cached inside MicroVMs caused performance issues.
- Immutable infrastructure model: patches applied by terminating and restarting EC2 instances with updated AMIs, not in-place updates.
- Rolling migration: used the 12-hour slot maximum lifetime to gradually shift slots from old to new architecture with no customer disruption.

### Limitations

1. **Block I/O performance gap**: Serial I/O handling and no flush-to-disk limit throughput and durability guarantees.
2. **Network throughput**: ~1/3 of bare-metal; not a bottleneck in Lambda/Fargate workloads but limits IO-intensive applications.
3. **No PCI passthrough**: virtio cannot reach bare-metal I/O performance; hardware doesn't support passthrough for thousands of short-lived VMs.
4. **Extreme feature removal costs generality**: No Windows, no VM migration, no legacy devices.
5. **Linux host dependency**: Tightly coupled to Linux KVM, process scheduler, memory manager, and networking stack.
6. **SMT disabling**: Costs ~50% of thread-level parallelism; a hard production requirement for side-channel defense.

### Glossary

- **VMM (Virtual Machine Monitor)**: Software layer that creates and manages VMs, provides device emulation, handles VM exits
- **MicroVM**: Firecracker's lightweight VM, optimized for serverless workloads
- **KVM (Kernel-based Virtual Machine)**: Linux kernel's virtualization infrastructure using Intel VT-x / AMD-V hardware extensions
- **virtio**: Open paravirtualization device standard for efficient I/O in virtual machines
- **MMIO (Memory-Mapped I/O)**: Firecracker exposes virtio devices via MMIO rather than a PCI bus
- **Jailer**: Firecracker's outer security sandbox wrapper; contains the VMM process itself
- **Slot**: A function execution environment unit on a Lambda worker; one slot = one MicroVM
- **Soft allocation**: On-demand resource allocation with oversubscription (CPU/memory allocated when needed, not pre-reserved)
- **Sticky routing**: Routing same-function invocations to the same worker to maximize warm cache hits
- **SMT (Symmetric MultiThreading)**: Hyperthreading; disabled in Firecracker production deployments as a side-channel mitigation
- **TCB (Trusted Computing Base)**: The minimal set of code the system's security depends on
- **Little's Law**: Queuing theory result: average queue length L = arrival rate λ × average time in system W
