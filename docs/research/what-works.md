# Lambda 沙箱：真正有效的方案

## 前置知识

- 了解什么是 AWS Lambda（托管的函数执行平台）
- 知道什么是进程和系统调用（程序请求操作系统服务的方式）
- 理解为什么在执行不可信代码时需要隔离

## 你将学到

- 为什么 Lambda 内部几乎所有主流沙箱工具都无法使用
- 哪些内核原语在 Lambda 中可用，哪些被屏蔽
- rlimits、WASM 和嵌入式运行时作为替代方案如何工作
- 三级推荐架构（Lambda、自托管 Linux、macOS）
- 业界（Cloudflare Workers、Deno、Judge0）如何处理同样的问题

---

Lambda 几乎屏蔽了所有内核级沙箱原语。大量研究后得出的关键发现是：AWS Lambda 的宿主端限制屏蔽了 `prctl(PR_SET_NO_NEW_PRIVS)`、seccomp 过滤器安装、ptrace、用户命名空间和 eBPF——这消除了所有主流 Linux 沙箱工具（gVisor、bubblewrap、nsjail、minijail、firejail）。唯一确认可用的进程限制内核原语是 `setrlimit`/`prlimit`。Shimmy 的沙箱策略必须依赖 **Firecracker 作为外层安全边界**、rlimits 进行资源控制、环境变量清理，以及纯用户态隔离技术，如嵌入式运行时（通过 wazero 的 WASM、V8 isolate）或 Deno 的权限模型。

---

## Lambda 的限制比文档更严格

> **💡 什么是 seccomp？**
> seccomp（安全计算模式）是 Linux 内核的一项安全机制，允许程序声明自己只需要哪些系统调用，然后让内核拦截所有其他调用。就像给程序装一道防火墙——只允许白名单上的操作通过。问题在于，安装 seccomp 过滤器本身也需要特定权限，而 Lambda 在 guest 内部把这个权限禁掉了。

传统认知——Firecracker 的 seccomp 只在宿主端生效，guest 内核提供"几乎所有系统调用"——**对于 Lambda 而言具有误导性**。AWS 在 guest microVM *内部*额外应用了 seccomp 过滤器和能力限制，屏蔽了关键的沙箱原语。

**确认在 Lambda 内部被屏蔽**（来源：OpenAI Codex issue #4725、Plotly/Kaleido #313、Sentry-Native #925 和 aws/containers-roadmap #2102）：

- **`prctl(PR_SET_NO_NEW_PRIVS)`** — 返回 EPERM。这是非特权 seccomp 过滤器安装的前提条件；seccomp-bpf 自沙箱完全不可能。
- **`prctl(PR_SET_SECCOMP)` / `seccomp(SECCOMP_SET_MODE_FILTER)`** — 被屏蔽，因为 PR_SET_NO_NEW_PRIVS 无法设置且 CAP_SYS_ADMIN 不可用。
- **`ptrace()`** — 根据 AWS Lambda FAQ，被明确屏蔽。
- **`clone()` 带 `CLONE_NEWUSER`** — 返回 EPERM（在 aws/containers-roadmap#2102 中确认）。
- **eBPF** — 需要 Lambda 进程未获授予的高级能力。
- **`chroot()`** — 需要 CAP_SYS_CHROOT。
- **`prctl(PR_SET_PDEATHSIG)`** — 被屏蔽。

**确认在 Lambda 内部可用：**

- **`setrlimit()` / `prlimit()`** — 标准的非特权操作，可限制 CPU、内存、文件大小、进程数和文件描述符数量。
- **`fork()` / `exec()`** — 子进程创建正常工作。
- **`process_vm_readv()` / `process_vm_writev()`** — 在同 UID 进程间可用。
- **`/proc` 文件系统** — 可读，暴露 cpuinfo、meminfo、网络信息，**以及包括 AWS 凭证在内的环境变量**。
- **`/tmp` 中的标准文件 I/O** — 可写，在热启动调用之间持久化。
- **`mprotect(PROT_EXEC)`** — 可能可用（V8/JIT 正常工作）。

guest 内核是 **Linux 5.10**。这意味着 Landlock（需要 5.13+）和 Syscall User Dispatch（需要 5.11+）均不可用。Amazon Linux 2023 为内核 6.1+ 启用了 `CONFIG_SECURITY_LANDLOCK`——未来的 Lambda 内核升级可能改变这一格局。

---

## 所有主流 Linux 沙箱工具在 Lambda 内部均失效

系统性评估得出相同结论：每个主流沙箱工具至少需要 root、用户命名空间、ptrace 或 seccomp 安装之一——而 Lambda 不允许任何一个。

**gVisor** 有三种平台，全部被屏蔽。KVM 平台需要 `/dev/kvm`；ptrace 平台需要 ptrace；systrap 平台（2023 年中期起默认）即使在 `--rootless` 模式下，沙箱设置也需要用户命名空间；`CLONE_NEWUSER` 返回 EPERM。

**Bubblewrap** 需要非特权用户命名空间或 SUID root。失败原因："No permissions to create new namespace"。

**nsjail** 依赖 Linux 命名空间实现所有隔离。`--disable_clone_newuser` 需要 root，且 seccomp 安装被屏蔽。

**Minijail 和 Firejail** — 同样的模式。两者都需要用户命名空间或 root。

**go-judge** 在没有 cgroup/命名空间支持的情况下降级为仅 rlimits 模式——进程可以读写 Lambda 文件系统、访问网络、查看其他进程。没有任何证据表明有人成功在 Lambda 内部运行 go-judge。

---

## 实际可行的技术

### 通过 rlimits 限制资源

> **💡 什么是 rlimits？**
> rlimits（资源限制，resource limits）是 Linux 提供给每个进程的"使用上限"配置。就像给用户设置手机流量套餐——你可以指定某个进程最多能用多少 CPU 时间、多少内存、能打开多少文件。即使进程是恶意的，超过上限后内核会强制终止它。rlimits 不需要特殊权限，是 Lambda 环境中少数可靠的资源控制手段之一。

最可靠的可用沙箱原语。在 Go 中，通过 re-exec 子进程使用 `syscall.Setrlimit()`：

- **`RLIMIT_CPU`** — CPU 秒数硬上限（超过硬限制后发送 SIGKILL）
- **`RLIMIT_AS`** — 地址空间上限，防止内存炸弹
- **`RLIMIT_FSIZE`** — 限制文件写入大小
- **`RLIMIT_NOFILE`** — 限制打开的文件描述符数量
- **`RLIMIT_NPROC`** — 防止 fork 炸弹（通过 `golang.org/x/sys/unix`）
- **`RLIMIT_CORE`** — 设为 0 以防止 core dump

**重要警告：** `RLIMIT_NPROC` 限制的是*用户*的总进程数，而非进程树。所有 Lambda 调用都以 uid 993 运行，因此一次调用的 fork 炸弹可能影响同一热容器中的后续调用。这是 Lambda 环境的硬性限制。

Go 的 `os/exec` 在 `SysProcAttr` 上没有 `Rlimit` 字段。最干净的模式是 **re-exec 包装器**：一个轻量 Go 二进制，通过 `syscall.Setrlimit()` 应用 rlimits，清理环境变量，然后调用 `syscall.Exec()` 将自身替换为目标解释器。这个包装器可以与 Shimmy 一起打包，并在所有不可信代码执行时调用。

### 语言特定隔离的嵌入式运行时

**对于 JavaScript**，有三个强力选项：

**Goja**（`github.com/dop251/goja`）— 纯 Go JavaScript 引擎（无 CGo），实现 ES5.1。完整的功能隔离——不可信 JS 对文件系统、网络或宿主没有任何访问权限，除非明确桥接。被 Grafana K6 在生产中使用。每个 goroutine 一个运行时。主要限制：仅 ES5.1；对计算密集型任务比 V8 慢约 20×。

**v8go**（`github.com/rogchap/v8go`）— 在 Go 中嵌入 V8，每次脚本执行约 290 μs（复用 isolate），比启动 Node.js 快 100×。正确的 V8 isolate 内存隔离。需要 CGo。当需要 V8 级别的 JS 兼容性时是最佳选择。

**QJS-over-WASM** — QuickJS 编译为 WebAssembly，运行在 wazero 内部。即使 QuickJS 中存在内存损坏漏洞，也无法逃逸 WASM 边界。JS 最强安全选项。

**对于 Python**，选项较弱：
- RestrictedPython：明确声明"不是沙箱系统"，存在多个 CVE（CVE-2024-47532、CVE-2025-22153）。
- Python audit hooks（PEP 578）：ctypes 支持直接系统调用，完全绕过所有钩子。
- PyPy sandbox 模式：理论上更强（所有 I/O 通过控制进程串行化）但处于实验阶段，仅限于 PyPy2。

**Python 的实际答案：** rlimits + 环境清理 + Firecracker 作为安全边界，或将 CPython 编译为 WASM 通过 wazero 运行（接受启动开销）。

**对于 C/C++：** 编译后的原生代码可以进行任意系统调用。语言级沙箱不可行。rlimits 提供资源控制；在没有 seccomp 的情况下，恶意 C 程序可以调用 Lambda 环境允许的任何系统调用。缓解措施是 Firecracker 的硬件隔离边界加严格的 rlimits。

### WASM 作为通用沙箱

> **💡 什么是 WebAssembly（WASM）？**
> WebAssembly（WASM）是一种低级字节码格式，最初为浏览器设计，但现在也用于服务端。WASM 最大的安全特性是"线性内存沙箱"：每个 WASM 模块只能访问自己被分配的内存区域，不能任意读写宿主进程的内存，也不能直接调用系统调用——所有对外部世界的访问都必须通过运行时明确提供的接口。这使 WASM 成为在不信任代码场景下的强力隔离方案。

**Wazero**（`github.com/tetratelabs/wazero`）— 零依赖、纯 Go WebAssembly 运行时。无 CGo，无外部依赖，单一二进制。每个 WASM 模块在完全隔离中运行：无宿主内存访问，无文件系统或网络访问，除非通过 `FSConfig` 显式挂载。

对于无法预先编译为 WASM 的不可信代码，可以运行编译为 WASM 的解释器：
- Python-in-WASM：显著的启动开销（首次编译需要数秒），有限的包支持
- JavaScript-in-WASM（QuickJS）：轻得多，适合生产使用

### 环境清理详情

在 `exec` 不可信代码之前：
- 清除 `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`AWS_SESSION_TOKEN`、`AWS_SESSION_EXPIRATION`
- 清除 `_LAMBDA_LOG_FD`、`_LAMBDA_SHARED_MEM_FD`、所有 `_LAMBDA_*` 变量
- 关闭所有继承的文件描述符（遍历 `/proc/self/fd`，只保留受控管道）
- 在 `/tmp` 中为每次执行创建子目录（`/tmp/execution-<uuid>/`），`chdir` 进入，完成后清理
- `127.0.0.1:9001` 处的 Lambda Runtime API 对所有进程可访问——不可信代码可能劫持调用响应或注册为扩展，如果没有适当隔离

---

## 业界如何处理这个问题

各平台的主流模式是：**隔离边界就是 VM 或容器本身**，而不是其中的沙箱。

**Cloudflare Workers** 以 V8 isolate 作为主要机制，加上五个额外安全层：进程级 Linux 命名空间 + seccomp、按信任级别的租户隔离、硬件内存保护键（MPK）、V8 的内部压缩指针笼，以及自定义 Spectre 缓解措施。Workers 运行在 Cloudflare 完全掌控的基础设施上，而非 Lambda 内部。

**Deno** 在 Rust 中强制执行默认拒绝权限：不带 `--allow-*` 标志的 `deno run --no-prompt script.ts` 仅允许纯计算。在 Lambda 内部工作（约 140 MB 二进制）。但 Deno 自己的文档建议对真正不可信的代码使用额外的 OS 级沙箱。Deno Sandbox（2026 年 2 月）使用 Firecracker。

**Judge0**（最流行的开源代码执行系统）使用 ioi/isolate，需要 `--privileged` Docker 容器。**无法在 Lambda 内部工作。** 2024 年的 CVE（CVE-2024-28185、CVE-2024-28189）展示了特权容器方案的风险。

**Lambda 作为沙箱的模式：** Quesma（AI 生成的 R 代码）、LambdaJudge（Python 在线评测）等，每个都将不可信代码放入 VPC 内部、无互联网访问的独立 Lambda 调用中。这充分利用了 Firecracker 的硬件隔离——可用的最强隔离——作为安全边界。

---

## 自托管模式下的 syd/sydbox

**Sydbox（syd）**，在 FOSDEM 2025 上发布，使用 `SECCOMP_RET_USER_NOTIF`（seccomp 用户通知）而非 ptrace。需要 Linux ≥5.6，无需 root，无需 ptrace 权限。监督者通过文件描述符接收系统调用通知，代表被沙箱进程执行系统调用（消除 TOCTOU 竞争），并通过 Landlock 分层实现文件系统限制。有 **Go 绑定**（`gosyd`）。

但是，syd 仍然需要 `prctl(PR_SET_NO_NEW_PRIVS)` 来安装 seccomp 过滤器——**在 Lambda 中被屏蔽**。对于不受此限制的自托管和独立模式，syd 是推荐的高级沙箱解决方案。

---

## 推荐的三级架构

### Tier 1：AWS Lambda 托管模式

1. **rlimits** 应用于每个子进程（CPU=5s、AS=256 MB、NOFILE=32、NPROC=1、FSIZE=10 MB），通过 re-exec 包装器
2. **环境清理** — 在 fork 前清除 AWS_* 和敏感变量
3. **每次执行的 /tmp 隔离** — 每次执行一个唯一临时目录，`chdir` 进入，完成后清理
4. **进程超时强制** — 带截止时间的 Go 级别 context，超时时 `cmd.Process.Kill()`，然后 `kill(-pid, SIGKILL)` 清理进程组
5. **有限制的 stdout/stderr 捕获** — 通过父进程管道输出，设置字节数限制
6. **对于 JS：** Goja（纯 Go，无 CGo）或 QJS-over-WASM（wazero）以获得最强隔离
7. **对于 Python/C：** 依赖 rlimits + 环境清理 + Firecracker 边界

### Tier 2：自托管 Linux

1. **seccomp-bpf** 通过 `elastic/go-seccomp-bpf`（纯 Go，无 CGo）— 白名单：read、write、exit、exit_group、brk、mmap、mprotect、munmap、futex、clock_gettime；对纯计算工作负载 KILL 所有其他系统调用
2. **Landlock** 通过 `landlock-lsm/go-landlock`（官方）— 将文件系统访问限制为只读 `/usr`、`/lib`、`/bin` 以及仅可读写沙箱目录。在旧内核上使用 `BestEffort()` 优雅降级
3. **rlimits** 同 Tier 1
4. **syd/sydbox** 配合 Go 绑定，实现最复杂的非特权沙箱

### Tier 3：macOS 开发环境

1. **rlimits**（部分支持：RLIMIT_CPU、RLIMIT_FSIZE、RLIMIT_NOFILE 可用；RLIMIT_AS 可能不可用）
2. **嵌入式运行时** — Goja 和 wazero 在 macOS 上运行方式完全相同（纯 Go）
3. **Deno 子进程** — 在 macOS 上使用相同权限模型工作
4. `shoenig/go-landlock` 在非 Linux 平台提供无操作实现，方便跨平台构建

### Go 库一览

| 库 | 用途 | 平台 |
|---------|---------|---------|
| `golang.org/x/sys/unix` | prlimit、setrlimit、prctl 封装 | 全平台 |
| `github.com/elastic/go-seccomp-bpf` | 纯 Go seccomp 过滤器构建器（无 CGo） | 仅 Tier 2 |
| `github.com/landlock-lsm/go-landlock` | 官方 Landlock 绑定，支持 BestEffort 降级 | 仅 Tier 2 |
| `github.com/tetratelabs/wazero` | 零依赖 WASM 运行时 | 全平台 |
| `github.com/dop251/goja` | 纯 Go JS 引擎 | 全平台 |
| `github.com/rogchap/v8go` | Go 中的 V8 isolate（CGo） | Linux/macOS |

---

## 核心洞察

**Lambda 的安全模型有意阻止嵌套沙箱**——Firecracker 就是沙箱，AWS 屏蔽了那些会允许在其中构建第二个沙箱的原语。这是一个刻意的设计选择，目的是减少 guest 内核针对 Firecracker 本身的攻击面，而非疏漏。

对于 Shimmy，这意味着放弃在 Lambda 模式下寻找内核级内层沙箱，转而从可用的原语构建实用的纵深防御栈。分级架构确保当运行在自托管或独立模式时——seccomp、Landlock 和可能的 syd 变为可用——系统自动升级到真正的内核级沙箱。

最值得探索的机会是 **wazero + 编译为 WASM 的语言解释器**：真正的内存安全沙箱，在所有部署模式和 macOS 上运行方式完全相同，无任何内核功能依赖。
