# Enclosure: Language-Based Restriction of Untrusted Libraries

**Authors:** Adrien Ghosn, Marios Kogias, Mathias Payer, James R. Larus, Edouard Bugnion (EPFL / Microsoft Research)  **Venue:** ASPLOS  **Year:** 2021

## Summary

Enclosure is a programming language construct that restricts untrusted library code from accessing program resources it should not touch. A single `with [policies] func() { body }` annotation binds a closure to a memory view (which packages are visible) and a syscall filter (which syscalls are allowed), enforced at runtime by LitterBox using Intel MPK or VT-x hardware. Implemented for Go and Python, enclosures can isolate 160K+ lines of untrusted dependency code with a single annotation, incurring as little as 1.02× overhead on real HTTP workloads.

## Key Ideas

- **Package-granularity isolation**: Packages are the right unit of isolation — they have well-defined entry points, explicitly declared dependencies, and their own code/data/heap. The system automatically computes a *minimal memory view* from the import graph, without requiring the developer to enumerate memory regions.
- **The `with` construct**: `with [policies] func() { body }` is a dynamically scoped expression. Policies apply to the closure body and all code it transitively invokes, including through deep dependency chains. Violations cause faults.
- **LitterBox backend**: A language-independent runtime framework enforcing policies via hardware. Two backends: LB_MPK (Intel MPK, 86 ns switch) and LB_VTX (Intel VT-x, 924 ns switch).
- **Nesting**: Child enclosures can only impose equal or stricter restrictions — no privilege escalation.
- **Meta-packages**: Packages with identical access rights across all enclosures are clustered into single hardware protection domains, working around MPK's 16-key limit.

## Relevance to Shimmy

Enclosure validates the idea of hardware-enforced in-process isolation, which is directly applicable to Shimmy's self-hosted deployment mode. The LB_MPK backend (86 ns per switch) shows that MPK-based domain switching is practical for production use. For Shimmy running inside AWS Lambda where kernel primitives are blocked, Enclosure's LitterBox model could be adapted: the `with` construct could isolate student code from the surrounding Lambda function environment using MPK. The paper's treatment of syscall filtering via seccomp-BPF (in LB_MPK) also informs Shimmy's self-hosted sandbox architecture.

## Detailed Notes

### Problem & Motivation

Modern software imports hundreds of transitive dependencies whose code is unknown and unverified. Malicious actors inject malware into popular packages (e.g., Python packages stealing SSH/GPG keys). Yet programming languages provide no mechanism to restrict what a library can do at runtime — every package can access every variable, every file descriptor, and every syscall.

Existing approaches fail to provide package-granularity, language-integrated, hardware-enforced isolation:
- OS-level abstractions (processes, containers): require heavy refactoring and IPC marshalling
- Language-based isolation (Rust ownership, JS isolates): language-specific, increases TCB
- Hardware memory domains (Erim, Hodor): ignore package structure entirely

### Design & Architecture

**The Enclosure Construct**:
- `with [policies] func() { body }` — a dynamically scoped expression
- **Memory view**: Per-package access rights (R, RW, RWX, or U for unmapped). Default: only the closure's natural dependencies (transitive import closure) are accessible.
- **Syscall filter**: Categories of permitted syscalls (none, all, net, file, mem, etc.). Default: all syscalls prohibited.
- Memory modifiers can extend the view (e.g., read-only access to a `secrets` package) or restrict it further.
- Policies are dynamically scoped — apply to the closure body and all transitively invoked code.

**LitterBox Backend APIs**:
- `Init`: Receives package/enclosure descriptions; creates hardware execution environments
- `Prolog/Epilog`: Switch into/out of an enclosure's restricted environment
- `FilterSyscall`: Intercepts and permits/rejects syscalls based on current enclosure filter
- `Transfer`: Dynamically repartitions heap memory between package arenas
- `Execute`: Supports user-level thread scheduling across protection environments (critical for Go goroutines)

**Hardware Backends**:

| Operation | Baseline | LB_MPK | LB_VTX |
|-----------|----------|--------|--------|
| call (ns) | 45 | 86 | 924 |
| transfer (ns) | 0 | 1002 | 158 |
| syscall (ns) | 387 | 523 | 4126 |

- **LB_MPK**: Uses 4-bit protection keys in PTEs and user-writable PKRU register. Each enclosure is a PKRU value. Syscall filtering via seccomp-BPF indexed by PKRU. ~86 ns per switch.
- **LB_VTX**: Runs the application inside a KVM VM. Each enclosure gets a separate page table (CR3). Switches via guest syscalls. Syscall filtering via hypercalls. ~924 ns per switch.

### Evaluation

**Macrobenchmarks (Go)**:
- **Bild image processing** (160K LOC dependency): LB_MPK 1.12×, LB_VTX 1.05× slowdown
- **HTTP server** (net/http): LB_MPK 1.02×, LB_VTX 1.77×
- **FastHTTP** (350K LOC, 100+ contributors): LB_MPK 1.04×, LB_VTX 2.01×
- All benchmarks: a single enclosure declaration reduces the TCB from hundreds of thousands of LOC to under 100 LOC

**Python**: Conservative approach (switch on every reference count) yields 18× overhead. With relaxed access: 1.4× overhead, dominated by one-time initialization.

**Security**: Recreated real-world malicious packages; enclosures detect and block most attacks with default policies.

### Strengths & Weaknesses

**Strengths**:
1. Minimal developer effort — a single `with` annotation can isolate an entire dependency tree of 160K+ LOC
2. Language-independent backend cleanly separates language frontends from hardware enforcement
3. LB_MPK achieves 1.02–1.12× slowdown — deployable in production
4. Hardware enforcement means even unsafe code (raw memory access, inline assembly) is contained

**Weaknesses**:
1. **Package granularity only**: Cannot isolate subsets of a package's code or data
2. **No information flow control**: Code with both sensitive data access and permitted syscalls can still exfiltrate
3. **Python performance**: CPython's reference count co-location with object data causes 18× overhead in conservative mode
4. **Intel-specific hardware**: Both backends require Intel VT-x or MPK; ARM and RISC-V not supported
5. **MPK key limit**: Intel MPK supports only 16 keys; applications with many fine-grained packages may exceed this

### Implementation Details

- **Go frontend** (1,000 LOC patch): Extends Go parser for `with` keyword; compiler inserts Prolog/Epilog calls; linker segregates marked packages into separate ELF sections; runtime memory allocator assigns spans to per-package arenas
- **Python frontend** (600 LOC CPython 3.9.1 fork): Handles dynamic module loading via multiple Init calls; introduces `localcopy` for explicit data placement
- **LitterBox**: 6,500 LOC in Go

### Glossary

- **Enclosure**: A language construct binding a closure to a restricted memory view and syscall filter
- **LitterBox**: The language-independent backend enforcing enclosure policies via hardware
- **Memory view**: The set of packages (and access rights) visible to code running inside an enclosure
- **Natural dependencies**: The transitive closure of a package's import graph
- **Meta-package**: A cluster of packages with identical access rights across all enclosures, managed as a single hardware protection domain
- **MPK (Memory Protection Keys)**: Intel hardware feature using 4-bit tags in PTEs and a user-writable PKRU register
- **VT-x**: Intel hardware virtualization extensions; LitterBox uses them to create per-enclosure page tables
- **TCB (Trusted Codebase)**: The portion of code that runs with unrestricted access to all program resources
