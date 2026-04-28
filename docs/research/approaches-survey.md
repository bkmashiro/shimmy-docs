# Lambda 沙箱化：所有方案全面调查

---

## 前置知识

- 了解 AWS Lambda 的基本概念（无服务器函数执行平台）
- 理解系统调用和进程隔离的基本概念
- 知道什么是虚拟机（VM）和容器

## 你将学到

- AWS Lambda 内部阻塞了哪些关键的安全原语
- 哪 8 种方案可行，哪 6 种被彻底封堵
- 如何用分层架构在受限环境中构建实用的安全防护
- 各方案的安全级别和性能开销对比

---

WebAssembly 是当前 AWS Lambda 内部最强的实用沙箱，但另外七种可行方案也存在。Lambda 的 Firecracker microVM 阻塞了 seccomp 过滤器安装、ptrace、用户命名空间、chroot，且不提供 `/dev/kvm`——消除了大多数标准 Linux 沙箱工具。对 14 个候选方案进行穷举分析后：**8 个可行**（安全保证程度不同）、**6 个被明确阻塞**，还有 1 个有前途的选项（Landlock）等待内核升级。

## Lambda 的限制概况

> **💡 什么是 Firecracker microVM？**
> Firecracker 是 AWS 开发的轻量级虚拟机监视器。AWS Lambda 中每个函数调用都运行在一个独立的 Firecracker microVM 中，提供硬件级别的租户间隔离。但正是这个外层沙箱，为了保护自身不被攻击，封锁了内层再建沙箱所需的几乎所有 Linux 内核原语。

Lambda 运行在 Firecracker microVM 中，客户机内核为 **Linux 5.10.240**（通过 `k510ga` 平台标签确认）。被阻塞的原语完整列表：

| 原语 | 错误 | 备注 |
|-----------|-------|-------|
| `prctl(PR_SET_NO_NEW_PRIVS)` | EPERM | 阻塞所有非特权 seccomp-bpf |
| `prctl(PR_SET_SECCOMP)` / `seccomp(SECCOMP_SET_MODE_FILTER)` | EPERM | 无系统调用过滤 |
| `ptrace()` | EPERM | 按 AWS Lambda FAQ 明确阻塞 |
| `clone(CLONE_NEWUSER)` | EPERM | 无用户命名空间 |
| `chroot()` / `pivot_root` | EPERM | 需要 root 权限 |
| `mount()` / bind mount / overlayfs | EPERM | 需要 CAP_SYS_ADMIN |
| eBPF 加载 | EPERM | 需要提升的权限 |
| `prctl(PR_SET_PDEATHSIG)` | EPERM | 已阻塞 |
| `/dev/kvm` | 不存在 | 无嵌套虚拟化 |
| Landlock LSM | EINVAL | 需要内核 5.13+ |
| Syscall User Dispatch（SUD）| EINVAL | 需要内核 5.11+ |

所有进程以 `sbx_user1051`（uid 993）运行。只有 `/tmp` 可写（512 MB–10 GB）。`/var/task`、`/var/runtime` 和 `/opt` 为只读。

**重要提示：** `/tmp` 在热调用之间持久存在。这意味着一次不可信执行的状态可能影响下一次，除非明确清理。

## 第一层：具有强安全性的生产就绪方案

### WebAssembly——最佳安全性与复杂度比

> **💡 什么是 WASM 线性内存沙箱？**
> WebAssembly 程序运行在一块"线性内存"中——一个连续的字节数组。程序中的每次内存访问都会被运行时检查是否超出这块内存的边界。越界访问不会悄悄读写其他程序的内存，而是立即触发一个"陷阱"（trap）并终止执行。这就像给程序装了护栏——它只能在自己的游乐场里玩，出界就停。

WASM 是为此问题量身打造的。模块在**线性内存沙箱**中执行，每次内存访问都有边界检查。除非通过 WASI 能力明确授权，否则不存在文件系统、网络或系统调用访问。运行时是一个普通的非特权用户态进程。

**运行时选项：**
- **wazero**（纯 Go，零 CGo）：适合基于 Go 的 Lambda。单一二进制文件，解释器和 AOT 编译器模式（速度差 10×）。每个模块在完全隔离环境中运行。
- **Wasmtime**：基于燃料的指令计量（精确 CPU 限制）、基于时间戳的中断、预编译模块 5 微秒实例化。Fastly 在生产中以 35 微秒冷启动运行 Wasmtime。

**语言支持：**
- C、C++、Rust、Go、Zig：直接编译到 WASM，开销 **5–15%**
- Python：通过 `python.wasm`（CPython-WASI）——约 34 MB 包，500 ms–2 s 启动（可缓存），纯标准库可用；NumPy/C 扩展不行
- JavaScript：通过 QuickJS-WASM——约 2 MB 二进制文件，约 300 ms 首次编译，约 0.5 ms 已缓存

实用的 Lambda 包——wazero + python.wasm + quickjs.wasm + 预编译 C 模块——总计约 50–60 MB，远低于 Lambda 的 250 MB 限制。

### Lambda 每次执行独立调用——Firecracker 自身的虚拟机边界

每次 Lambda 调用都获得自己的 **Firecracker microVM 及专用内核**——硬件虚拟化级别的隔离。模式：每次不可信执行生成一个单独的 Lambda 函数，配置为无互联网访问的 VPC、最小 IAM 角色和严格超时。

**执行不可信代码前必须做的加固：**
- 清除所有 `AWS_*` 和 `_LAMBDA_*` 环境变量
- 关闭所有继承的文件描述符（遍历 `/proc/self/fd`，只保留受控管道）
- 通过你控制的管道重定向 stdin/stdout/stderr
- 创建新进程组（`setpgid(0, 0)`）以便干净地 `killpg` 终止
- 应用 `setrlimit`：RLIMIT_CPU（10s）、RLIMIT_AS（256 MB）、RLIMIT_NPROC（10）、RLIMIT_FSIZE（50 MB）、RLIMIT_NOFILE（20）

**成本：** 在 2048 MB 下每次 10 秒执行约 $0.00033，100 万次执行约 $333/月。主要缺点：约 300–500 ms 冷启动，约 50–200 ms 热路由开销。

### QEMU 全系统仿真——Lambda 内最强的进程内隔离

带 **microvm 机器类型**的 QEMU 系统模式在仿真虚拟机中启动完整的 Linux 内核。客户机系统调用永远不会到达宿主内核。无共享文件系统、无共享网络。真正的两层虚拟机隔离边界。

没有 KVM（Lambda 使用软件 TCG）：预期**慢 8–12 倍**，**启动时间 5–30 秒**。最小设置（QEMU 约 15–30 MB + 内核约 5–10 MB + 基于 Python 的 initramfs 约 140 MB）总计约 200 MB。QEMU 自己的文档指出 TCG"不被认为是安全边界"。

`exec-sandbox` 项目（Apache 2.0，2025–2026 年活跃）用 Alpine Linux 3.21、移除约 360 个子系统的加固内核、EROFS 只读根文件系统和通过 virtio-serial 的 Rust 客户机代理演示了这一点。有 KVM 时：400 ms 冷启动，57 ms p50 执行。

## 第二层：有实质性注意事项的可行方案

### DynamoRIO——无需 ptrace 的系统调用拦截

> **💡 什么是动态二进制插桩（DBI）？**
> DBI 框架（如 DynamoRIO）在程序运行时拦截其所有代码执行。程序的每个"基本块"（顺序执行的指令序列）在运行前都会经过 DBI 框架的"翻译引擎"重写。由于所有代码都经过翻译，程序中的每条 `syscall` 指令都会被替换为调用 DBI 自己处理程序的指令——不论这条指令是在普通函数里、内联汇编里，还是 JIT 运行时动态生成的。

DynamoRIO 的动态二进制插桩引擎在运行时翻译每个基本块，将 `syscall` 指令替换为调用自己处理程序的指令。主要的 Linux 注入模式使用 **LD_PRELOAD，而非 ptrace**——ptrace 路径仅用于附加到已运行的进程。

`dr_register_pre_syscall_event()` API 允许阻塞或修改任何系统调用。由于所有代码都经过翻译引擎，不可信代码中的原始 `syscall` 指令会被重写——不像 LD_PRELOAD，内联汇编无法绕过。**开销 10–30%**，适用于任何 x86-64 ELF 二进制文件。

**Lambda 状态：** 可能可用（需要 `mprotect(PROT_EXEC)` 用于 JIT——自 V8 和 Java JIT 在 Lambda 中可用以来应该可用）。待直接验证。

### Deno——Rust 实现的权限模型

Deno 的安全模型是默认拒绝：没有 `--allow-*` 标志，所有文件系统、网络、环境、子进程和 FFI 访问均被阻塞。在 Deno 运行时的 Rust 代码内强制执行——无需 seccomp 或 ptrace。二进制文件约 140 MB（或约 61 MB 的 `denort`）。

**局限：** CVE-2024-34346 表明 `/proc/self/mem` 写入可授予所有权限。NDSS 2025 论文发现了 `/proc/self/environ` 读取问题（已在 Deno 1.43+ 中修补）。Deno 自己的文档推荐额外的操作系统级沙箱。最好视为一层防御，而非完整沙箱。

对于 Python：**Deno 内的 Pyodide（CPython 编译到 WASM）** 是一个经过验证的模式，LangChain Sandbox 和 Pydantic AI 都在使用。

### QEMU 用户模式——隐式系统调用过滤

QEMU 用户模式通过 TCG 翻译客户机二进制指令，在翻译层拦截每个系统调用。不需要 ptrace、seccomp、命名空间或 KVM。静态二进制约 5–20 MB。**开销 2–5×**。

**关键弱点：** 无文件系统或网络隔离——客户机通过 QEMU 的系统调用翻译直接访问宿主文件系统，以相同的 UID 运行，共享宿主网络栈。许多危险的系统调用返回 ENOSYS（提供隐式过滤），但 QEMU 明确声明用户模式"不是安全边界"。

### LFI——适用于 ARM64 Lambda 的经过形式验证的 SFI

轻量级故障隔离（ASPLOS 2024，Stanford）保留特定寄存器作为沙箱基址/寻址寄存器，并使用经过形式验证的静态验证器（约 400 行代码）确保所有内存访问保持在 4 GiB 沙箱区域内。不需要操作系统沙箱原语。ARM64 SPEC2017 上**开销约 6–8%**（写入沙箱仅 1.5%）。

**局限：** x86-64 后端是实验性的；ARM64（Graviton Lambda）是主要目标。代码必须用 LFI 编译器重新编译（正在上游合入 LLVM）。仅支持 C/C++/汇编。

## 第三层：纵深防御层，非独立沙箱

### 解释器沙箱

**Lua / Luau：** 通过受限全局表 + `debug.sethook` 指令计数提供真正良好的内置沙箱。Luau（Roblox 的分支）经过数百万对抗性用户的实战检验。约 300 KB 二进制文件。如果 Lua 是可接受的语言，表现出色。

**Python 审计钩子（PEP 578）：** 明确不是沙箱——ctypes 允许直接调用 C 库和系统调用，完全绕过所有钩子。RestrictedPython 有多个 CVE。PyPy 沙箱模式理论上更强但缺乏维护。

**Node.js `--experimental-permission`：** Node.js 自己描述为"受信任代码的安全带"。CVE-2025-55130 展示了符号链接路径遍历绕过。截至 Node 25 仍是实验性的。

### 二进制重写

**E9Patch/E9Syscall 和 SaBRe：** 离线静态重写 ELF 二进制文件，将 `syscall` 指令重定向到处理程序。**开销 <3%**。在 Lambda 中可用（离线预重写，部署修改后的二进制文件）。根本局限：动态生成的代码（JIT）绕过静态重写。

**zpoline：** 需要 `mmap_min_addr = 0`——Lambda 可能不允许。未经修改不可行。

### LD_PRELOAD

拦截 libc 包装函数。容易被以下方式绕过：原始 `syscall` 指令、静态链接二进制文件、Go/Rust 默认设置、io_uring、`dlsym(RTLD_NEXT)`。仅对监控合作代码有用。**对对抗性代码不是安全机制。**

## 六种被明确阻塞的方案

| 方案 | 被阻塞原因 |
|----------|---------------|
| **gVisor**（所有平台）| systrap 需要 seccomp SECCOMP_RET_TRAP + ptrace；KVM 平台需要 `/dev/kvm`；ptrace 平台需要 ptrace；所有模式都需要用户命名空间 |
| **Kata / Sysbox / 嵌套 Firecracker** | 所有都需要 KVM；Firecracker 不支持嵌套虚拟化 |
| **所有无根容器运行时**（runc、crun、Podman、bubblewrap）| 所有都需要用户命名空间；runc 报错"无根容器需要用户命名空间" |
| **Cosmopolitan `pledge()`** | 完全通过 `prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER)` 实现——返回 EPERM |
| **Intel Pin** | 使用 fork-ptrace 注入机制 |
| **没有 seccomp 的 SIGSYS** | 没有内核机制可以在不使用 seccomp SECCOMP_RET_TRAP 或 SUD（需要内核 5.11+）的情况下在系统调用指令上触发 SIGSYS |

**go-judge 说明：** 当命名空间/seccomp 不可用时降级为仅 rlimits 模式——进程可以读写 Lambda 文件系统、访问网络、看到其他进程。在 Lambda 中不是沙箱。

## Landlock：最有前途的近未来选项

> **💡 什么是 Landlock？**
> Landlock 是 Linux 5.13 引入的一种文件系统访问控制机制，不需要 root 权限或任何特殊能力，普通程序就能安装。一旦安装了 Landlock 规则集，程序只能访问被明确允许的目录，其余全部拒绝。就像给程序颁发一个"通行证"，上面只列出它被允许进入的区域。

Landlock（Linux 5.13+）无需 root 或任何权限即可强制执行文件系统访问控制。只需要 `prctl(PR_SET_NO_NEW_PRIVS, 1)`。Amazon Linux 2023 在内核 6.1 和 6.12 上明确启用了 `CONFIG_SECURITY_LANDLOCK`。

Lambda 当前运行 5.10。当 AWS 升级时，Landlock 成为**最佳轻量级沙箱选项**：限制不可信代码只能读写 `/tmp/sandbox/`，拒绝所有其他文件系统访问。

**行动：** 在 Lambda 内定期监控 `uname -r` 并尝试 `landlock_create_ruleset()`，以检测何时可用。

## 推荐的分层架构

Lambda 内没有单一方案能提供完整隔离。最强的实用架构：

1. **外部边界：** 在无互联网访问的 VPC 中每次执行使用独立 Lambda，最小 IAM 角色，严格的超时和内存限制
2. **进程加固：** 清除环境变量，关闭所有继承的 FD，通过管道重定向 stdio，应用 rlimits（CPU、内存、进程、文件），新建进程组以便干净终止
3. **执行沙箱：** 在 WASM 运行时（Go Lambda 用 wazero，最大功能用 Wasmtime）中运行不可信代码，不授予任何 WASI 能力
4. **未来增强：** 当 Lambda 升级到内核 5.13+ 时添加 Landlock 文件系统限制

**针对特定语言的建议：**
- **Python（纯粹）：** wazero/Wasmtime 中的 CPython-WASI；如果需要 C 扩展，则使用 Lambda 每次执行中的 Deno 里的 Pyodide
- **JavaScript：** 用于轻量级沙箱的 QuickJS-WASM；用于完整 V8 性能的带 `--deny-all` 的 Deno
- **C/C++：** 离线预编译为 WASM，在 WASM 运行时中执行
- **任意编译二进制文件，接近原生性能：** LD_PRELOAD 模式的 DynamoRIO（开销 10–30%），结合 Lambda 每次执行作为外部边界
- **无论性能如何的最大隔离：** 带 microvm 和最小 initramfs 的 QEMU 系统模式（5–30 秒启动，运行时慢 8–12 倍）
