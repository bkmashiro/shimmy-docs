# Light-Weight Contexts: An OS Abstraction for Safety and Performance

**Authors:** James Litton, Anjo Vahldiek-Oberwagner, Eslam Elnikety, Deepak Garg, Bobby Bhattacharjee, Peter Druschel (University of Maryland / MPI-SWS)  **Venue:** OSDI  **Year:** 2016

## Summary

Light-weight contexts (lwCs) are a new first-class OS abstraction that decouples memory isolation, privilege separation, and execution state from processes and threads. A process can contain multiple lwCs, each with its own virtual memory mappings, file descriptor table, and credentials, while sharing threads. Switching between lwCs costs about half as much as a process/thread context switch. Implemented in FreeBSD 11.0, lwCs enable fast rollback, session isolation, sensitive data compartments, and in-process reference monitors in production servers like Apache and nginx with negligible overhead.

## Key Ideas

- **Decoupled isolation**: Isolation, privilege, and execution state can be separated from both processes and threads. A lightweight context within a process has its own VM mappings, file descriptors, and credentials, yet shares threads.
- **Orthogonality to threads**: lwCs are not schedulable entities — they are orthogonal to threads. A thread executes within one lwC at a time and switches via a system call. Multiple threads can execute simultaneously in the same lwC.
- **Cheap switching**: Switching contexts is essentially just swapping a page table pointer. Using PCID-tagged TLBs avoids full TLB flushes. lwC switch costs 2.01 μs vs. 4.25 μs for process switching.
- **Four usage patterns**: Snapshot and rollback, event-driven session isolation, sensitive data isolation (e.g., SSL private keys), and in-process reference monitors via `LWC_SYSTRAP`.
- **COW creation**: `lwCreate` gives the child a copy-on-write copy of the parent's state, analogous to fork. Resource-spec controls what is shared, copied, or unmapped.

## Relevance to Shimmy

lwCs demonstrate that OS-level isolation need not be expensive, and that a single primitive can unify multiple security use cases. For Shimmy, the most relevant patterns are snapshot/rollback (creating a clean execution environment per student submission) and reference monitor (`LWC_SYSTRAP` for syscall interposition). The main limitation is that lwCs are implemented only in FreeBSD 11.0 — not Linux — making them unavailable in Lambda or standard Linux deployments. Nevertheless, the performance numbers (2 μs switch, negligible nginx overhead) provide a strong existence proof that the isolation overhead needed for Shimmy's use case can be near-zero if the right primitives existed in Linux.

## Detailed Notes

### Problem & Motivation

In general-purpose OSes, processes are the unit of isolation, privilege, and execution state. Any computation requiring isolation must run in a separate process, paying the costs of kernel scheduling, resource accounting, context switching, and IPC. But the actual hardware cost of isolation is much smaller: with tagged TLBs, switching an address space requires just a system call and a CR3 register load.

Threads separate execution from processes but share a single address space and provide no isolation. Applications needing in-process isolation (web servers isolating user sessions, protecting private keys from Heartbleed-style attacks, running reference monitors) are forced to either use expensive process-based separation or forego isolation entirely.

### Design & Architecture

**The lwC Abstraction**:

Each lwC has:
- Its own virtual memory space (vmspace)
- Its own file descriptor table
- Its own credentials (uid, gid, jail, limits)

lwCs are NOT schedulable entities — they are orthogonal to threads.

**API**:

| Operation | System Call | Description |
|-----------|------------|-------------|
| Create | `lwCreate(resource-spec, options)` | Fork-like creation; child gets COW copy of parent |
| Switch | `lwSwitch(target, args)` | Coroutine-style switch; atomically changes VM, file table, credentials |
| Restrict | `lwRestrict(l, resource-spec)` | Narrow access capabilities on an lwC descriptor |
| Overlay | `lwOverlay(l, resource-spec)` | Dynamically map resources from another lwC |
| Syscall | `lwSyscall(target, mask, syscall, args)` | Execute a syscall on behalf of another lwC |

**Sharing Mechanisms**:
- **Static sharing** at creation time via resource-spec: `LWC_SHARED`, `LWC_COW` (default), or `LWC_UNMAP`
- **Dynamic sharing** via `lwOverlay`: map memory or file descriptors from another lwC
- **Access capabilities**: associated with lwC descriptors; can be narrowed with `lwRestrict` but never widened

**System Call Interposition (Reference Monitor)**:
- With `LWC_SYSTRAP`, a child lwC's prohibited syscalls are redirected to its parent
- Parent can inspect arguments, perform the call on the child's behalf via `lwSyscall`, or deny it

**Usage Patterns**:
1. **Snapshot and Rollback**: Create a lwC snapshot before serving a request; switch back to discard all request-specific state
2. **Event-driven Session Isolation**: Per-connection lwC in nginx; each connection's event handler runs with a private copy of process state
3. **Sensitive Data Isolation**: Load private key, create child lwC, erase key in parent, revoke overlay rights. Child exposes only a narrow signing interface.
4. **Reference Monitor**: Parent creates sandboxed child with `LWC_SYSTRAP`; intercepts all prohibited syscalls before executing on child's behalf

### Implementation Details

Implemented in **FreeBSD 11.0** kernel.

**Memory**: Each lwC has its own vmspace. `lwCreate` replicates the parent's vmspace (COW). Switching swaps the thread's vmspace reference. FreeBSD PCIDs (12-bit process context identifiers) tag TLB entries, so lwC switches avoid full TLB flushes.

**File Table**: Copied like fork by default; can be shared entirely as an optimization.

**Credentials**: Copied like fork. Switching to a previous lwC can restore dropped privileges, enabling the reference monitor pattern.

### Evaluation

**Hardware**: Dell R410, 2× Intel Xeon X5650 2.66 GHz 6-core, 48 GB RAM, FreeBSD 11.0.

#### Switch Time Microbenchmarks

| Mechanism | Switch time (μs) |
|-----------|-----------------|
| lwC | 2.01 |
| Process | 4.25 |
| Kernel thread | 4.12 |
| User thread (no isolation) | 1.71 |

lwC switch costs less than half of a process or kernel thread switch.

**lwC creation**: 87.7 μs with no page writes (independent of allocated memory). Each COW fault adds ~3 μs.

**Apache**: lwC matches or exceeds fork at all session lengths; for short sessions (1–16), dramatically faster than fork.

**Nginx**: lwC-event (per-connection lwC) adds no significant overhead across all session lengths. Even with reference monitoring, overhead is minimal.

**OpenSSL Key Isolation**: 10,000 SSL handshakes took 100.4 s vs. 99.7 s for native — essentially free.

**PHP Fast Launch**: lwC snapshots skip PHP runtime initialization. Without opcode cache: 2.7× speedup (226 → 616 req/s).

### Strengths & Weaknesses

**Strengths**:
1. Clean, general abstraction unifying rollback, isolation, privilege separation, and reference monitoring
2. Near-zero overhead: 2 μs switches, negligible impact on nginx throughput, free SSL key isolation
3. No language dependence — purely an OS abstraction
4. Production-scale evaluation on Apache, nginx, OpenSSL, PHP

**Weaknesses**:
1. **FreeBSD only**: Prototype in FreeBSD 11.0; porting to Linux requires significant kernel work
2. **No protection against denial-of-service**: A lwC can block a thread indefinitely or call `exit()` to terminate the entire process
3. **Manual refactoring required**: No automated tool to identify lwC boundary insertion points
4. **Shared threads are a double-edged sword**: Threads in different lwCs can interfere with scheduling; requires barrier synchronization during lwCreate

### Relation to Other Work

lwCs improve on Wedge (sthreads) by avoiding scheduling costs and providing snapshots. They improve on Dune by not requiring VT-x hardware (thus working on virtualized platforms). The Enclosure paper cites lwC as a potential LitterBox backend, which would bring language-integrated policies to lwC's efficient OS-level isolation.

### Glossary

- **lwC (Light-Weight Context)**: A unit of isolation, privilege, and execution state within a process, with its own VM mappings, file table, and credentials
- **vmspace**: FreeBSD kernel structure representing a process's (or lwC's) virtual address space
- **PCID (Process Context Identifier)**: 12-bit TLB tag that avoids full TLB flushes on address space switches
- **COW (Copy-On-Write)**: Memory sharing strategy where pages are shared until written, then copied
- **Resource-spec**: The parameter to lwCreate/lwOverlay that specifies how resources are shared, copied, or unmapped
- **Overlay**: Dynamic mapping of memory/file descriptors from one lwC into another's address space
- **Reference monitor**: A trusted component that interposes on and controls access to resources
