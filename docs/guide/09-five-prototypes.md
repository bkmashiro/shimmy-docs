# 第九章：五种原型设计

> Shimmy Sandbox 在最终选择 DynamoRIO 方案之前，探索了五种不同的原型。本章详细分析每种原型的实现方式、安全性、性能数据，以及适用场景。

## 9.1 概述：为什么要有五种原型

没有任何单一技术能在所有维度上完胜其他方案。五种原型代表了不同的权衡点：

```
原型    技术基础           强项              弱项
─────────────────────────────────────────────────────────────────
A       rlimits            零开销，简单       只能限制资源，无法拦截
B       WASM (wazero)      最强隔离，零syscall  需要预编译，CPython慢
C       JS (Goja)          极快（290μs）      仅限 JavaScript
D       DynamoRIO          全语言，机器码级   ~20-30% 开销，实现复杂
E       QEMU user-mode     透明，无需改程序   5.3× 开销，无文件系统隔离
```

## 9.2 原型 A：rlimits（资源限制）

### 设计思路

**原型 A** 基于一个保守的假设：不试图拦截系统调用，只通过操作系统的**资源限制**（rlimits）来限制恶意代码能造成的破坏上限，同时清理危险的环境变量。

这是最简单的方案，也是最快的——没有任何运行时开销。

### rlimits 配置

**`setrlimit()`** 是 Linux 提供的资源限制机制，即使在 Lambda 中也完全可用：

```c
// rlimits_backend.c - 原型 A 的核心

#include <sys/resource.h>
#include <unistd.h>

void apply_rlimits(void) {
    struct rlimit rl;

    // 1. CPU 时间限制：10 秒
    // 超过软限制 → SIGXCPU；超过硬限制 → SIGKILL
    rl.rlim_cur = 10;   // 软限制: 10秒后 SIGXCPU
    rl.rlim_max = 11;   // 硬限制: 11秒后 SIGKILL
    setrlimit(RLIMIT_CPU, &rl);

    // 2. 虚拟地址空间：256MB
    // malloc 超过此限制 → ENOMEM
    rl.rlim_cur = 256 * 1024 * 1024;
    rl.rlim_max = 256 * 1024 * 1024;
    setrlimit(RLIMIT_AS, &rl);

    // 3. 子进程数量：最多 10 个
    // fork 超过此限制 → EAGAIN（看起来像内存不足）
    rl.rlim_cur = 10;
    rl.rlim_max = 10;
    setrlimit(RLIMIT_NPROC, &rl);

    // 4. 单个文件最大写入：50MB
    // write 超过此限制 → SIGXFSZ（或 EIO）
    rl.rlim_cur = 50 * 1024 * 1024;
    rl.rlim_max = 50 * 1024 * 1024;
    setrlimit(RLIMIT_FSIZE, &rl);

    // 5. 同时打开的文件描述符：20 个
    // open 超过此限制 → EMFILE
    rl.rlim_cur = 20;
    rl.rlim_max = 20;
    setrlimit(RLIMIT_NOFILE, &rl);

    // 6. 核心转储大小：0（禁止生成 core 文件，防止写入大文件）
    rl.rlim_cur = 0;
    rl.rlim_max = 0;
    setrlimit(RLIMIT_CORE, &rl);
}
```

### 环境变量清理

```go
// env_sanitize.go - 清理敏感环境变量

var dangerousEnvVars = []string{
    // AWS 凭证
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_DELEGATION_TOKEN",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    // 其他敏感配置
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    // Lambda 内部变量
    "_AWS_XRAY_DAEMON_ADDRESS",
    "_AWS_XRAY_DAEMON_PORT",
}

func sanitizeEnvironment(env []string) []string {
    dangerous := make(map[string]bool)
    for _, v := range dangerousEnvVars {
        dangerous[v] = true
    }

    var clean []string
    for _, kv := range env {
        parts := strings.SplitN(kv, "=", 2)
        if len(parts) < 1 || !dangerous[parts[0]] {
            clean = append(clean, kv)
        }
    }

    // 用假值替换（让依赖这些变量的代码不会 panic）
    clean = append(clean, "AWS_ACCESS_KEY_ID=SANDBOXED")
    clean = append(clean, "AWS_SECRET_ACCESS_KEY=SANDBOXED")
    return clean
}
```

### 原型 A 的安全分析

```
攻击向量                  A 能防御？  说明
──────────────────────────────────────────────────────────
CPU 死循环                ✓          RLIMIT_CPU 超时 SIGKILL
内存炸弹                  ✓          RLIMIT_AS 限制虚拟地址空间
Fork 炸弹                 ✓          RLIMIT_NPROC 限制子进程数
文件描述符耗尽            ✓          RLIMIT_NOFILE
磁盘写爆                  ✓          RLIMIT_FSIZE
读 /proc/self/environ     ✗          rlimits 无法阻止文件读取
读 /etc/passwd            ✗          rlimits 无法阻止文件读取
读 AWS IMDS               ✗          rlimits 无法阻止网络连接
Socket 连接               ✗          rlimits 无法阻止 socket
execve/shell 弹出         ✗          rlimits 无法阻止 exec
inline syscall 绕过       N/A        Proto A 本来就不拦截 syscall
io_uring 绕过             N/A        同上
```

**测试结果**：49/49 通过（其中 13 个测试被标记为 SKIP，因为它们测试的是 rlimits 无法覆盖的攻击）

**开销**：< 1ms（可以忽略不计）

### 适用场景

原型 A 单独使用不足以保护含 AWS 凭证的 Lambda 环境，但它是所有其他原型的**基础层**。所有原型都在 A 的基础上叠加额外防护。

## 9.3 原型 B：WebAssembly（wazero）

### 设计思路

**WebAssembly**（WASM）是一种为浏览器设计的字节码格式，后来发展为通用的沙箱执行标准。WASM 程序只能访问显式导入的**宿主函数**（host functions），没有能力发出系统调用。

```
WASM 程序 vs 原生程序:

原生 C 程序:
  代码 → libc open() → syscall 指令 → Linux 内核
                      ↑ 任何时候都可以直接调用内核

WASM 程序:
  代码 → (想要打开文件) → 查找导入的宿主函数
                        → wazero 运行时提供的 "wasi_snapshot_preview1.fd_open"
                        → 只有 wazero 明确实现并暴露的功能才可用
                        ↑ WASM 指令集中根本没有 syscall 指令！
```

**WASI**（WebAssembly System Interface）是 WASM 访问系统资源的标准接口——类似于 WASM 世界的 POSIX。

### wazero：纯 Go 的 WASM 运行时

```go
// wasm_backend.go - 原型 B 的核心

import (
    "context"
    "github.com/tetratelabs/wazero"
    "github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
    "github.com/tetratelabs/wazero/sys"
)

func RunWASM(ctx context.Context, wasmBytes []byte, stdin []byte) (stdout, stderr []byte, err error) {
    // 创建全新的 WASM 运行时（每次调用都是全新实例）
    // wazero 是纯 Go 实现，零 CGo 依赖
    runtime := wazero.NewRuntime(ctx)
    defer runtime.Close(ctx)

    // 创建 WASI 能力配置（这里决定 WASM 程序可以访问什么）
    config := wazero.NewModuleConfig().
        // 禁止对宿主文件系统的任何访问
        WithFS(nil).
        // 禁止网络访问（wazero 没有实现 WASI 网络接口）
        // 允许标准 I/O
        WithStdin(bytes.NewReader(stdin)).
        WithStdout(&stdoutBuf).
        WithStderr(&stderrBuf).
        // 设置资源限制
        WithArgs("program").
        // 禁止环境变量访问
        // （不调用 WithEnv，WASM 程序看不到任何环境变量）
        WithSysNanosleep().  // 允许 sleep
        // 禁止时钟精度调用（防止时间侧信道）

    // 实例化 WASI 宿主环境（决定哪些 WASI 函数被实现）
    wasi_snapshot_preview1.MustInstantiate(ctx, runtime)

    // 加载并实例化 WASM 模块
    mod, err := runtime.InstantiateWithConfig(ctx, wasmBytes, config)
    if err != nil {
        return nil, nil, fmt.Errorf("WASM 实例化失败: %w", err)
    }
    defer mod.Close(ctx)

    // 调用 WASM 程序的主函数 _start（WASI 约定）
    _, err = mod.ExportedFunction("_start").Call(ctx)
    // ...

    return stdoutBuf.Bytes(), stderrBuf.Bytes(), nil
}
```

### WASM 的隔离原理

```
WASM 线性内存模型:

┌─────────────────────────────────────────────────────┐
│                 WASM 线性内存 (64KB 页)              │
│  地址 0 ─────────────────────────────── 最大地址    │
│  [所有程序数据都在这里]                              │
│                                                     │
│  特点:                                              │
│  • 边界检查: 访问超界 → 立即 trap（类型安全）        │
│  • 与宿主内存完全隔离                               │
│  • 不能解引用指针到 WASM 内存之外                   │
│  • WASM 程序看不到 wazero 的内存、Go 的内存         │
└─────────────────────────────────────────────────────┘
```

### 语言支持矩阵

| 语言 | 编译到 WASM | 运行时支持 | 启动时间 | 说明 |
|------|-----------|-----------|---------|------|
| C/C++ | ✓（Emscripten/clang）| ✓ | < 10ms | 编译到 WASM-WASI |
| Rust | ✓（`--target wasm32-wasi`）| ✓ | < 10ms | Rust 官方支持 |
| Go | ✓（`GOOS=wasip1`）| ✓ | ~50ms | Go 1.21+ 官方支持 |
| JavaScript | ✓（QuickJS-WASM）| ✓ | ~100ms | QuickJS 编译到 WASM |
| Python | ✓（CPython-WASI）| ✓ | **500ms+** | 启动过慢！ |
| Java | 部分（TeaVM）| 限制 | 很慢 | 不完整支持 |

**Python 的问题**：CPython 编译到 WASM 需要在 WASM 内部执行完整的 Python 解释器初始化，这需要读取大量文件（标准库 .py 文件）。通过 WASI 的虚拟文件系统一次次触发文件读取操作，启动时间超过 500ms，这对代码评测系统来说太慢了。

### 原型 B 的安全分析

```
攻击向量              B 能防御？  原因
──────────────────────────────────────────────────────
读 /proc/self/environ  ✓          WASM 没有 /proc 概念
读 /etc/passwd         ✓          WithFS(nil) 无文件系统
Socket 连接            ✓          WASI 无网络接口
execve                 ✓          WASM 指令集无 exec
fork 炸弹              ✓          WASM 无 fork 概念
内联汇编 syscall       ✓          WASM 是虚拟机，无物理 syscall 指令
io_uring               ✓          同上
静态链接绕过           ✓          WASM 程序内部无宿主 syscall 接口
内存炸弹               ✓（部分）  线性内存有大小限制
CPU 死循环             ✓          可通过 Go context 取消执行
```

**WASM 的隔离是最强的**——原则上零系统调用泄露。代价是语言限制（需要预编译到 WASM）。

**测试结果**：49/49 通过（暖启动 < 1ms，冷启动视语言而定）

### 适用场景

原型 B 最适合：
- C/C++/Rust 等可以离线预编译到 WASM 的语言
- 对安全性要求极高的场景
- 不需要支持 Python 的场景

## 9.4 原型 C：JavaScript（Goja）

### 设计思路

对于 JavaScript 提交，与其在沙箱中运行 Node.js，不如在同一个 Go 进程内嵌入一个 JS 引擎，完全避免进程创建的开销。

**Goja** 是一个纯 Go 实现的 ES5.1 JavaScript 引擎，没有 CGo 依赖，没有 JIT 编译器，直接解释执行 JavaScript 字节码。

### 290μs vs 30ms：为什么快这么多

```
传统方案（Node.js 子进程）:

  Go handler 收到请求
    ↓ os.Exec("/usr/bin/node", ...)
  fork() → clone() → execve()
    ↓ Linux 创建新进程（约 5-10ms）
  Node.js 启动
    ↓ V8 初始化（约 20-25ms）
  JavaScript 代码开始执行
  ───────────────────────────
  总计: ~30ms（每次调用）

Goja 方案（进程内执行）:

  Go handler 收到请求
    ↓ goja.New()（约 100μs）
  创建 Goja 运行时（纯 Go，已在内存中）
    ↓ vm.RunString(code)（约 190μs）
  JavaScript 代码开始执行
  ───────────────────────────
  总计: ~290μs（每次调用，约 100× 快）
```

### Goja 的安全加固（Lockdown）

Goja 的一个大优势是：沙箱化就是删除全局对象。JavaScript 中一切危险操作都需要通过全局对象（`process`、`fetch`、`require` 等）：

```go
// goja_backend.go - 原型 C 的核心

func RunJavaScript(code string, stdin []byte, timeout time.Duration) (string, error) {
    // 创建新的 Goja 运行时
    vm := goja.New()

    // ─────────────────────────────────────────────────────────────
    // 删除所有危险的全局对象（Lockdown）
    // ─────────────────────────────────────────────────────────────

    // 删除 Node.js 全局对象（如果有）
    vm.Set("process", goja.Undefined())
    vm.Set("require", goja.Undefined())
    vm.Set("module", goja.Undefined())
    vm.Set("exports", goja.Undefined())
    vm.Set("__dirname", goja.Undefined())
    vm.Set("__filename", goja.Undefined())

    // 删除网络相关
    vm.Set("fetch", goja.Undefined())
    vm.Set("XMLHttpRequest", goja.Undefined())
    vm.Set("WebSocket", goja.Undefined())

    // 删除文件系统相关
    vm.Set("Deno", goja.Undefined())

    // 删除代码执行相关（防止绕过沙箱）
    vm.Set("eval", goja.Undefined())
    vm.Set("Function", goja.Undefined())   // ← 阻断 new Function("...")
    vm.Set("AsyncFunction", goja.Undefined())
    vm.Set("GeneratorFunction", goja.Undefined())

    // 删除定时器（防止后台任务）
    vm.Set("setTimeout", goja.Undefined())
    vm.Set("setInterval", goja.Undefined())
    vm.Set("setImmediate", goja.Undefined())
    vm.Set("clearTimeout", goja.Undefined())
    vm.Set("clearInterval", goja.Undefined())

    // 删除 Buffer（Node.js 的二进制数据类型，可能用于缓冲区溢出）
    vm.Set("Buffer", goja.Undefined())

    // 删除全局 global（防止通过 global.eval 绕过）
    vm.Set("global", goja.Undefined())
    vm.Set("globalThis", vm.NewObject())  // 替换为空对象

    // ─────────────────────────────────────────────────────────────
    // 注入安全的替代品
    // ─────────────────────────────────────────────────────────────

    // 提供安全的 console.log（输出到 Go 的 stdoutBuf）
    var stdoutBuf strings.Builder
    console := vm.NewObject()
    console.Set("log", func(args ...goja.Value) {
        parts := make([]string, len(args))
        for i, v := range args {
            parts[i] = v.String()
        }
        stdoutBuf.WriteString(strings.Join(parts, " ") + "\n")
    })
    vm.Set("console", console)

    // ─────────────────────────────────────────────────────────────
    // 超时控制
    // ─────────────────────────────────────────────────────────────
    timer := time.AfterFunc(timeout, func() {
        vm.Interrupt("执行超时")
    })
    defer timer.Stop()

    // ─────────────────────────────────────────────────────────────
    // 运行代码
    // ─────────────────────────────────────────────────────────────
    _, err := vm.RunString(code)
    if err != nil {
        if isTimeout(err) {
            return "", ErrTimeout
        }
        return "", err
    }

    return stdoutBuf.String(), nil
}
```

### Goja 的安全分析

```
攻击向量              C 能防御？  说明
──────────────────────────────────────────────────────
读文件系统             ✓          Goja 没有 fs 模块（已删除）
Socket 连接            ✓          fetch/WebSocket 已删除
execve                 ✓          无 child_process 模块
eval 绕过              ✓          eval 已删除
new Function 绕过      ✓          Function 已删除
process.env 读取       ✓          process 已删除
内存炸弹               ✓（部分）  Goja 在 Go 堆上分配，受 Go GC 控制
CPU 死循环             ✓          vm.Interrupt() 超时终止
```

**原型 C 的已知局限**：
- 只支持 JavaScript（ES5.1，不支持 ES6+，无 async/await 等）
- Goja 计算性能约是 V8 的 1/20（对于计算密集型代码是问题）
- 没有 Node.js 的标准库（无 `path`、`crypto` 等模块）

**测试结果**：49/49 通过；平均执行时间 290μs

### 适用场景

原型 C 专为 JavaScript 评测设计，在响应速度方面无与伦比。如果评测系统需要支持大量 JS 提交，Goja 是首选。

## 9.5 原型 D：DynamoRIO（完整系统调用拦截）

这是 Shimmy Sandbox 的主方案，已在第八章详细讲解。本节补充完整的系统调用策略表。

### 系统调用策略完整表

```
系统调用             策略          说明
───────────────────────────────────────────────────────────────────────
read (0)             ALLOW         允许从已打开的 fd 读取
write (1)            ALLOW         允许写入已打开的 fd
open (2)             VIRTUALIZE    路径检查 + 重映射
close (3)            ALLOW         关闭 fd 总是允许
stat (4)             VIRTUALIZE    路径检查
fstat (5)            ALLOW         通过 fd 获取文件信息，已经有 fd 就没问题
lstat (6)            VIRTUALIZE    路径检查
poll (7)             ALLOW         I/O 多路复用
mmap (9)             RESTRICT      移除 PROT_EXEC 标志
mprotect (10)        RESTRICT      阻断 PROT_EXEC
munmap (11)          ALLOW
brk (12)             ALLOW         堆管理
rt_sigaction (13)    ALLOW         信号处理（DynamoRIO 自己需要）
rt_sigprocmask (14)  ALLOW
ioctl (16)           RESTRICT      阻断特权 ioctl，允许终端 ioctl
pread64 (17)         ALLOW
pwrite64 (18)        ALLOW
readv (19)           ALLOW
writev (20)          ALLOW
access (21)          VIRTUALIZE    路径检查
pipe (22)            ALLOW         管道，允许（IPC 内部）
select (23)          ALLOW
sched_yield (24)     ALLOW
mremap (25)          ALLOW
msync (26)           ALLOW
madvise (28)         ALLOW
dup (32)             ALLOW         fd 复制，允许
dup2 (33)            ALLOW
getpid (39)          ALLOW         获取自己的 PID，允许
socket (41)          RESTRICT      仅允许 AF_UNIX（AF_INET → EPERM）
connect (42)         BLOCK         阻断所有网络连接
accept (43)          BLOCK         阻断接受连接
sendto (44)          RESTRICT      只允许 Unix socket
recvfrom (45)        RESTRICT      同上
clone (56)           RESTRICT      检查 fork 计数器
fork (57)            RESTRICT      检查 fork 计数器
vfork (58)           RESTRICT      检查 fork 计数器
execve (59)          RESTRICT      路径白名单检查
exit (60)            ALLOW
wait4 (61)           ALLOW
kill (62)            RESTRICT      只允许对自己的子进程发信号
uname (63)           ALLOW
fcntl (72)           ALLOW
fsync (74)           ALLOW
fdatasync (75)       ALLOW
truncate (76)        VIRTUALIZE    路径检查
ftruncate (77)       ALLOW
getdents (78)        VIRTUALIZE    路径检查（目录读取）
getcwd (79)          ALLOW
chdir (80)           VIRTUALIZE    追踪 cwd 变化
mkdir (83)           VIRTUALIZE    路径检查 + 重映射
rmdir (84)           VIRTUALIZE    路径检查
unlink (87)          VIRTUALIZE    路径检查
readlink (89)        VIRTUALIZE    路径检查
chmod (90)           VIRTUALIZE    路径检查
gettimeofday (96)    ALLOW         时间（可通过 VDSO，不一定是系统调用）
getrlimit (97)       ALLOW
getuid (102)         ALLOW
syslog (103)         BLOCK         不允许读取内核日志
getgid (104)         ALLOW
setuid (105)         BLOCK         不允许改变用户 ID
setgid (106)         BLOCK
geteuid (107)        ALLOW
getegid (108)        ALLOW
setpgid (109)        BLOCK         不允许改变进程组
setsid (112)         BLOCK         阻断守护进程化
prctl (157)          RESTRICT      阻断 PR_SET_NO_NEW_PRIVS（无意义但阻断以防万一）
arch_prctl (158)     ALLOW         线程本地存储设置（DynamoRIO 需要）
gettid (186)         ALLOW
futex (202)          ALLOW         线程同步原语
sched_setaffinity (203) BLOCK      不允许修改 CPU 亲和性
sched_getaffinity (204) ALLOW
io_uring_setup (425) BLOCK         完全阻断 io_uring
io_uring_enter (426) BLOCK
io_uring_register (427) BLOCK
```

### 原型 D 的安全分析

```
攻击向量                  D 能防御？  说明
──────────────────────────────────────────────────────────────
读 /proc/self/environ     ✓          /proc 在阻断列表
读 /etc/passwd            ✓          /etc 路径被阻断
读 AWS IMDS               ✓          connect() 完全阻断
socket TCP 连接           ✓          AF_INET → EPERM
Fork 炸弹                 ✓          原子计数器限制
内联汇编 syscall          ✓          机器码级拦截，覆盖所有情况
静态链接绕过              ✓          DBI 覆盖静态链接代码
io_uring                  ✓          io_uring_setup → EPERM
mmap(PROT_EXEC)           ✓          移除 EXEC 标志
路径遍历 (../)            ✓          规范化后检查
execve(/bin/sh)           ✓          shell 路径黑名单
```

**测试结果**：49/49 通过（含 13 个之前被 Proto A 跳过的测试）

**性能数据**：
- GitHub Actions（调度器噪音大）：+67% 开销
- 预计 Lambda vCPU（专用核心）：+20-30% 开销

## 9.6 原型 E：QEMU User-Mode

### 设计思路

**QEMU user-mode**（`qemu-user`）是 QEMU 的一种特殊运行模式：不模拟完整的计算机，只翻译用户态程序的指令集，并把系统调用转发到宿主系统。

```
普通 QEMU（全系统模拟）:
  qemu-system-x86_64 → 模拟完整 x86_64 计算机（包括内核）

QEMU user-mode:
  qemu-x86_64 ./program → 只翻译 ./program 的 x86_64 指令
                          系统调用由 QEMU 转发到宿主 Linux
```

对于同架构（x86_64 → x86_64），QEMU user-mode 使用 **TCG**（Tiny Code Generator）来翻译指令：原理与 DynamoRIO 类似，但 QEMU 的主要优化目标是正确性（多架构支持），不是性能。

### 原型 E 的关键特点

**隐式系统调用过滤**：QEMU user-mode 在转发系统调用给宿主内核之前，会做一些翻译（主要是地址翻译）。对于 QEMU 不认识的系统调用号，它会返回 `ENOSYS`（功能未实现）。这形成了一种隐式的过滤。

**无文件系统隔离**：这是原型 E 最大的缺陷。QEMU user-mode 直接转发路径相关的系统调用，不做任何路径重映射或过滤：

```c
// QEMU user-mode 的系统调用转发（简化）
long handle_syscall(int sysnum, long a1, long a2, ...) {
    switch (sysnum) {
    case SYS_openat:
        // 直接转发到宿主内核！
        return syscall(SYS_openat, a1, a2, ...);
        // 没有路径检查！
        // 恶意代码可以读取 /proc/self/environ 等
    }
}
```

**QEMU 自己的安全声明**：QEMU 文档明确指出，user-mode 不是一个安全沙箱，不应该用来运行不可信代码。这进一步限制了原型 E 的可用性。

### 性能数据

原型 E 是五种原型中**最慢**的：

| 测试类型 | 原生执行 | QEMU user-mode | 开销 |
|---------|---------|----------------|------|
| 计算密集 | 100ms | 533ms | **+433%（5.3×）** |
| I/O 密集 | 50ms | 265ms | +430% |
| 启动时间 | 5ms | 27ms | +440% |

QEMU TCG 的开销远高于 DynamoRIO，因为：
1. QEMU 的优化目标是跨架构正确性，不是性能
2. QEMU 需要模拟完整的 CPU 状态（包括标志寄存器的精确计算）
3. QEMU 的代码缓存（TranslationBlock）不如 DynamoRIO 的代码缓存高效

### 原型 E 的安全分析

```
攻击向量              E 能防御？  说明
──────────────────────────────────────────────────────────
读 /proc/self/environ  ✗          直接转发 openat，无过滤！
读 /etc/passwd         ✗          同上
Socket 连接            △          转发给宿主，宿主有网络访问
execve                 ✓（部分）  QEMU 拦截 execve，但不一定阻断
CPU 死循环             ✓          由宿主 rlimits 控制
内存炸弹               ✓          由宿主 rlimits 控制
io_uring               ✓（意外）  QEMU 不支持 io_uring，返回 ENOSYS
inline syscall         ✓          QEMU 翻译所有指令，包括 syscall
```

**测试结果**：49/49 通过（测试套件中的 49 个测试恰好不包含文件系统读取检查，这掩盖了原型 E 的实际安全漏洞）

## 9.7 五种原型的综合对比

### 防御矩阵（26 种攻击向量）

```
攻击向量                 A    B    C    D    E
──────────────────────────────────────────────────────────────
CPU 死循环               ✓    ✓    ✓    ✓    ✓
内存炸弹                 ✓    ✓    ✓    ✓    ✓
Fork 炸弹                ✓    ✓    ✓    ✓    ✓
文件描述符耗尽           ✓    ✓    ✓    ✓    ✓
磁盘写爆                 ✓    ✓    ✓    ✓    ✓
线程洪水                 ✓    ✓    ✓    ✓    ✓
读 /proc/self/environ    ✗    ✓    ✓    ✓    ✗
读 /etc/passwd           ✗    ✓    ✓    ✓    ✗
读 /etc/shadow           ✗    ✓    ✓    ✓    ✗
读 ~/.ssh/id_rsa         ✗    ✓    ✓    ✓    ✗
读 /proc/self/maps       ✗    ✓    ✓    ✓    ✗
execve 弹 shell          ✗    ✓    ✓    ✓    △
进程后台化（daemonize）  ✗    ✓    ✓    ✓    △
进程组逃逸               ✗    ✓    ✓    ✓    ✗
TCP 连接外部             ✗    ✓    ✓    ✓    ✗
TCP 连接 IMDS            ✗    ✓    ✓    ✓    ✗
DNS 数据外泄             ✗    ✓    ✓    ✓    ✗
UDP 数据外泄             ✗    ✓    ✓    ✓    ✗
内联汇编 syscall         N/A  ✓    ✓    ✓    ✓
静态链接绕过             N/A  ✓    ✓    ✓    ✓
io_uring                 N/A  ✓    ✓    ✓    ✓（意外）
mmap(PROT_EXEC)+JIT      N/A  ✓    ✓    ✓    ✓
路径遍历（../）          ✗    ✓    ✓    ✓    ✗
暖启动 /tmp 泄露         ✗    ✓    ✓    ✓    ✗
AWS 凭证读取             ✗    ✓    ✓    ✓    ✗
进程间 /tmp 共享         ✗    ✓    ✓    ✓    ✗
──────────────────────────────────────────────────────────────
防御数量（/26）          6    26   26   26   11
语言覆盖                 全   C/Rust/Go/JS  JS  全   全
执行开销                 ~0   <1ms 290μs  20-30% 5.3×
实现复杂度               低   中   低   高   低
Lambda 可用              ✓    ✓    ✓    ✓    ✓
```

### 推荐使用场景

| 场景 | 推荐方案 |
|------|---------|
| 所有语言，最强安全 | **D（DynamoRIO）** 作为主方案 |
| 仅 JavaScript，极低延迟 | **C（Goja）** |
| C/C++/Rust，离线评测 | **B（wazero WASM）** |
| 任何场景的基础层 | **A（rlimits）** 与其他组合 |
| 不推荐生产使用 | **E（QEMU）** 仅作研究 |

实际上，Shimmy Sandbox 的生产部署是：
- **Python 提交** → D（DynamoRIO）+ A（rlimits 基础层）
- **JavaScript 提交** → C（Goja）+ A（rlimits 基础层）
- **C/Rust 离线编译** → B（wazero）+ A
- **Go 静态二进制** → D（DynamoRIO）+ A

## 小结

```
五种原型的核心洞察:

Proto A: 必要但不充分。rlimits 是基础，但阻止不了信息窃取。

Proto B: 安全性最高，但 Python 启动太慢（500ms+），限制了适用性。
         适合有预编译阶段的离线评测。

Proto C: JavaScript 的最优解。290μs 的延迟让在线评测成为可能。
         ES5.1 限制是主要权衡点。

Proto D: 通用最优解。覆盖所有语言，20-30% 开销可接受。
         实现最复杂，但安全性有保证。

Proto E: 实验性。5.3× 开销不可接受，无文件系统隔离是安全缺陷。
         QEMU 文档明确不建议用作沙箱。
```
