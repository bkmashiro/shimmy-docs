# 第十章：Shimmy 系统架构

> 本章把前九章的所有知识整合起来，展示 Shimmy Sandbox 作为一个完整系统的架构设计——从 Lambda 请求到沙箱执行到结果返回的全链路追踪。

## 10.1 分层防御模型（Defense in Depth）

**纵深防御**（Defense in Depth）是安全系统设计的核心原则：不依赖任何单一防御机制，而是设置多道防线，使攻击者必须突破所有层才能得手。

Shimmy Sandbox 的四层防御模型：

```
┌─────────────────────────────────────────────────────────────────┐
│              Shimmy Sandbox 分层防御模型                         │
│                                                                  │
│  Layer 0: Firecracker 微虚拟机                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ • 独立 Linux 5.10 内核                                      │ │
│  │ • 即使代码完全逃出 Lambda，还在 Firecracker 的沙箱里        │ │
│  │ • AWS 管理，无需我们配置                                     │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Layer 1: 环境清理（启动时一次性）                               │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ • 清除 AWS_ACCESS_KEY_ID 等敏感环境变量                     │ │
│  │ • 用假值替换（SANDBOXED）                                   │ │
│  │ • 防御: /proc/self/environ 读取不到真实凭证                 │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Layer 2: 资源限制（rlimits，进程级别）                          │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ • RLIMIT_CPU: 10s → SIGKILL                                 │ │
│  │ • RLIMIT_AS: 256MB 虚拟地址空间                              │ │
│  │ • RLIMIT_NPROC: 10 子进程                                   │ │
│  │ • RLIMIT_FSIZE: 50MB 文件写入                               │ │
│  │ • RLIMIT_NOFILE: 20 个文件描述符                            │ │
│  │ • 防御: 资源耗尽类攻击                                       │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Layer 3: 系统调用拦截（DynamoRIO / wazero / Goja）              │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ • 机器码级别拦截所有 syscall 指令                           │ │
│  │ • 路径重映射：/tmp → /tmp/dr-sandbox/<session>/tmp         │ │
│  │ • 阻断: /proc, /etc, socket, connect, execve, io_uring     │ │
│  │ • Fork 计数器：最多 5 个并发子进程                          │ │
│  │ • 防御: 所有信息窃取、网络攻击、进程逃逸                    │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

每一层都独立防御一类攻击。即使 Layer 3 的 DynamoRIO 出现 bug，Layer 1 和 Layer 2 仍然提供基本保护；即使环境变量被读取，DynamoRIO 的网络拦截阻止了数据外泄。

## 10.2 Go 包装器架构

Shimmy Sandbox 的协调器是一个 Go 程序（`shimmy-sandbox` CLI），定义了后端接口，实现多种沙箱后端的统一管理：

```go
// backend.go - 核心接口定义

package shimmy

import (
    "context"
    "io"
    "time"
)

// ExecutionResult 包含沙箱执行的所有结果
type ExecutionResult struct {
    Stdout      []byte        // 程序的标准输出
    Stderr      []byte        // 程序的标准错误
    ExitCode    int           // 退出码
    Duration    time.Duration // 实际执行时间
    MemoryUsage int64         // 峰值内存使用（字节）
    Killed      bool          // 是否被超时/资源限制终止
    KillReason  string        // 终止原因（"cpu_timeout", "memory", "fork_bomb"...）
}

// ExecutionRequest 包含执行请求的所有参数
type ExecutionRequest struct {
    Code       string            // 要执行的源代码
    Language   Language          // 语言类型
    Stdin      []byte            // 标准输入
    Timeout    time.Duration     // 执行超时（硬限制）
    MemoryMB   int               // 内存限制（MB）
    SessionID  string            // 调用唯一 ID
    TestCases  []TestCase        // 测试用例（可选）
}

// Language 枚举
type Language string
const (
    LanguagePython     Language = "python3"
    LanguageJavaScript Language = "javascript"
    LanguageGo         Language = "go"
    LanguageRust       Language = "rust"
    LanguageC          Language = "c"
    LanguageCPP        Language = "cpp"
    LanguageWASM       Language = "wasm"  // 预编译的 WASM 二进制
)

// Backend 是所有沙箱后端的接口
type Backend interface {
    // Execute 在沙箱中执行代码
    Execute(ctx context.Context, req ExecutionRequest) (*ExecutionResult, error)

    // Name 返回后端名称（用于日志和监控）
    Name() string

    // SupportedLanguages 返回此后端支持的语言列表
    SupportedLanguages() []Language

    // Close 释放后端资源
    Close() error
}
```

### RlimitsBackend（原型 A）

```go
// rlimits_backend.go

type RlimitsBackend struct {
    config RlimitsConfig
}

type RlimitsConfig struct {
    CPUSeconds   uint64 // RLIMIT_CPU
    MemoryMB     uint64 // RLIMIT_AS（MB）
    MaxProcs     uint64 // RLIMIT_NPROC
    MaxFileSizeMB uint64 // RLIMIT_FSIZE（MB）
    MaxOpenFiles  uint64 // RLIMIT_NOFILE
}

func (b *RlimitsBackend) Execute(ctx context.Context, req ExecutionRequest) (*ExecutionResult, error) {
    // 1. 清理环境变量
    cleanEnv := sanitizeEnvironment(os.Environ())

    // 2. 根据语言选择解释器
    interpreter, args := languageInterpreter(req.Language, req.Code)

    // 3. 创建临时文件存放代码
    sessionDir := filepath.Join("/tmp", "shimmy-"+req.SessionID)
    os.MkdirAll(sessionDir, 0700)
    defer os.RemoveAll(sessionDir)

    codeFile := filepath.Join(sessionDir, "code"+languageExt(req.Language))
    os.WriteFile(codeFile, []byte(req.Code), 0600)

    // 4. 创建子进程，在子进程中设置 rlimits
    cmd := exec.CommandContext(ctx, interpreter, append(args, codeFile)...)
    cmd.Env = cleanEnv
    cmd.Stdin = bytes.NewReader(req.Stdin)

    var stdout, stderr bytes.Buffer
    cmd.Stdout = &stdout
    cmd.Stderr = &stderr

    // 5. 在子进程 fork 后、exec 前设置 rlimits
    cmd.SysProcAttr = &syscall.SysProcAttr{
        Setpgid: true,
    }

    // 使用 pdeathsig 确保父进程死亡时子进程也死亡
    cmd.SysProcAttr.Pdeathsig = syscall.SIGKILL

    // 设置资源限制（通过 /proc/.../limits 或 preexec 函数）
    // Go 的 exec.Cmd 通过 SysProcAttr 设置
    // 实际实现需要 fork 后在子进程中调用 setrlimit

    startTime := time.Now()
    err := cmd.Run()
    duration := time.Since(startTime)

    return &ExecutionResult{
        Stdout:   stdout.Bytes(),
        Stderr:   stderr.Bytes(),
        ExitCode: cmd.ProcessState.ExitCode(),
        Duration: duration,
        Killed:   !cmd.ProcessState.Success() && ctx.Err() != nil,
    }, nil
}
```

### DynamoRIOBackend（原型 D）

```go
// dynamorio_backend.go

type DynamoRIOBackend struct {
    drrunPath  string // /opt/bin/drrun
    clientPath string // /opt/dr-clients/shimmy_client.so
    config     DynamoRIOConfig
}

func (b *DynamoRIOBackend) Execute(ctx context.Context, req ExecutionRequest) (*ExecutionResult, error) {
    // 1. 创建会话目录
    sessionDir := filepath.Join("/tmp/dr-sandbox", req.SessionID)
    if err := os.MkdirAll(sessionDir, 0700); err != nil {
        return nil, fmt.Errorf("创建会话目录失败: %w", err)
    }
    defer os.RemoveAll(sessionDir)  // 调用结束后清理

    // 2. 写入代码文件
    codeFile := filepath.Join(sessionDir, "code"+languageExt(req.Language))
    if err := os.WriteFile(codeFile, []byte(req.Code), 0600); err != nil {
        return nil, err
    }

    // 3. 清理环境变量
    cleanEnv := sanitizeEnvironment(os.Environ())
    cleanEnv = append(cleanEnv, "SHIMMY_SESSION_DIR="+sessionDir)

    // 4. 构建 drrun 命令
    interpreter, interpArgs := languageInterpreter(req.Language, "")
    drrunArgs := []string{
        "-c", b.clientPath,   // 加载 shimmy_client.so
        "--",                  // 分隔符：后面是被插桩的程序
        interpreter,
    }
    drrunArgs = append(drrunArgs, interpArgs...)
    drrunArgs = append(drrunArgs, codeFile)

    cmd := exec.CommandContext(ctx, b.drrunPath, drrunArgs...)
    cmd.Env = cleanEnv
    cmd.Stdin = bytes.NewReader(req.Stdin)

    var stdout, stderr bytes.Buffer
    cmd.Stdout = &stdout
    cmd.Stderr = &stderr

    // 5. 设置进程属性（rlimits 通过 preexec 设置）
    cmd.SysProcAttr = &syscall.SysProcAttr{
        Setpgid:    true,
        Pdeathsig:  syscall.SIGKILL,
    }

    // 6. 在子进程中设置 rlimits（通过 SysProcAttr.Rlimit）
    // 注意：这里设置的 rlimits 会被 drrun 进程及其子进程（即学生代码）继承
    cmd.SysProcAttr.Rlimit = []syscall.Rlimit{
        {Type: syscall.RLIMIT_CPU, Cur: 10, Max: 11},
        {Type: syscall.RLIMIT_AS, Cur: 268435456, Max: 268435456},  // 256MB
        {Type: syscall.RLIMIT_NPROC, Cur: 10, Max: 10},
        {Type: syscall.RLIMIT_FSIZE, Cur: 52428800, Max: 52428800}, // 50MB
        {Type: syscall.RLIMIT_NOFILE, Cur: 20, Max: 20},
    }

    startTime := time.Now()
    err := cmd.Run()
    duration := time.Since(startTime)

    // 7. 解析结果
    exitCode := 0
    killed := false
    killReason := ""

    if cmd.ProcessState != nil {
        exitCode = cmd.ProcessState.ExitCode()
        if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok {
            if status.Signaled() {
                killed = true
                switch status.Signal() {
                case syscall.SIGKILL:
                    killReason = "cpu_timeout_or_memory"
                case syscall.SIGXCPU:
                    killReason = "cpu_timeout"
                case syscall.SIGXFSZ:
                    killReason = "file_size_exceeded"
                }
            }
        }
    }

    return &ExecutionResult{
        Stdout:     stdout.Bytes(),
        Stderr:     stderr.Bytes(),
        ExitCode:   exitCode,
        Duration:   duration,
        Killed:     killed,
        KillReason: killReason,
    }, nil
}
```

### GojaBackend（原型 C）

```go
// goja_backend.go

type GojaBackend struct {
    // Goja 是进程内执行，无需外部进程
    maxMemoryMB int
}

func (b *GojaBackend) Execute(ctx context.Context, req ExecutionRequest) (*ExecutionResult, error) {
    if req.Language != LanguageJavaScript {
        return nil, ErrUnsupportedLanguage
    }

    startTime := time.Now()

    // 使用 goroutine + channel 实现超时
    resultCh := make(chan gojaResult, 1)

    go func() {
        result, err := runGojaLocked(req.Code, req.Stdin, req.Timeout)
        resultCh <- gojaResult{result, err}
    }()

    select {
    case result := <-resultCh:
        return &ExecutionResult{
            Stdout:   result.stdout,
            Stderr:   result.stderr,
            ExitCode: result.exitCode,
            Duration: time.Since(startTime),
        }, result.err
    case <-ctx.Done():
        return nil, ctx.Err()
    }
}
```

## 10.3 语言路由：选择正确的后端

```go
// router.go - 根据语言和代码选择后端

type Router struct {
    dynamorio *DynamoRIOBackend
    wazero    *WazeroBackend
    goja      *GojaBackend
    rlimits   *RlimitsBackend  // 备选方案
}

func (r *Router) Route(req ExecutionRequest) Backend {
    switch req.Language {
    case LanguageJavaScript:
        // JavaScript → Goja（极低延迟，进程内执行）
        return r.goja

    case LanguageWASM:
        // 预编译 WASM → wazero（最强隔离）
        return r.wazero

    case LanguagePython, LanguageGo, LanguageRust, LanguageC, LanguageCPP:
        // 其他语言 → DynamoRIO（通用覆盖）
        return r.dynamorio

    default:
        // 未知语言 → 拒绝
        return nil
    }
}
```

### 语言路由决策表

```
语言          后端         原因
──────────────────────────────────────────────────────────────────
Python 3      DynamoRIO    CPython 动态链接，DBI 完美覆盖
              （不用 WASM）  CPython-WASI 启动 500ms+ 太慢
JavaScript    Goja         290μs vs 30ms（Node.js），100× 快
C/C++         DynamoRIO    支持静态链接（Go/clang 都能编译）
Go            DynamoRIO    Go 二进制静态链接，LD_PRELOAD 失效
                            DynamoRIO 在机器码级覆盖
Rust          DynamoRIO    同 Go，静态链接
C（离线模式） wazero WASM  预编译到 WASM32-WASI，最强隔离
```

## 10.4 Lambda Layer 打包

Shimmy Sandbox 以 Lambda Layer 的形式部署，安装在 `/opt` 目录（只读）：

```
shimmy-layer/
└── opt/
    ├── bin/
    │   ├── drrun                    (DynamoRIO 运行器, 5.2MB)
    │   └── shimmy-sandbox           (Go 协调器, 7.8MB)
    ├── lib/
    │   ├── libdynamorio.so          (DynamoRIO 核心, 3.1MB)
    │   ├── libdrmgr.so              (DynamoRIO 扩展, 0.8MB)
    │   └── libdrutil.so             (DynamoRIO 工具, 0.4MB)
    └── dr-clients/
        └── shimmy_client.so         (Shimmy 插件, 0.2MB)

总大小: ~18MB（压缩后 ~7MB，符合 Lambda Layer 限制）
```

Lambda 函数的 handler：

```python
# handler.py - Lambda 函数入口

import subprocess
import json
import os
import uuid

SHIMMY_PATH = "/opt/bin/shimmy-sandbox"

def grade(event, context):
    """
    Lambda 函数处理器：接受学生代码提交，返回评测结果
    """
    code = event.get("code", "")
    language = event.get("language", "python3")
    test_cases = event.get("test_cases", [])
    stdin_data = event.get("stdin", "")

    session_id = str(uuid.uuid4())

    # 构建 shimmy-sandbox 命令
    # shimmy-sandbox 会内部调用 drrun + shimmy_client.so
    cmd = [
        SHIMMY_PATH,
        "--language", language,
        "--session-id", session_id,
        "--timeout", "10",  # 秒
        "--memory", "256",  # MB
    ]

    # 把代码通过 stdin 传给 shimmy-sandbox
    request_json = json.dumps({
        "code": code,
        "stdin": stdin_data,
    })

    try:
        result = subprocess.run(
            cmd,
            input=request_json.encode(),
            capture_output=True,
            timeout=15,  # 外层超时（比内层多 5 秒）
        )

        response = json.loads(result.stdout)
        return {
            "statusCode": 200,
            "body": json.dumps({
                "stdout": response.get("stdout", ""),
                "stderr": response.get("stderr", ""),
                "exit_code": response.get("exit_code", -1),
                "duration_ms": response.get("duration_ms", 0),
                "killed": response.get("killed", False),
                "kill_reason": response.get("kill_reason", ""),
            })
        }
    except subprocess.TimeoutExpired:
        return {
            "statusCode": 200,
            "body": json.dumps({
                "error": "execution_timeout",
                "kill_reason": "outer_timeout",
            })
        }
```

## 10.5 每次调用的完整生命周期

```
时间轴: 一次完整的代码评测调用

t=0ms     HTTP 请求到达 API Gateway
           ↓
t=5ms     Lambda 函数被调用（暖启动复用容器）
           ↓
t=6ms     handler.py 开始执行
           生成 session_id = "a1b2c3d4-..."
           调用 shimmy-sandbox CLI
           ↓
t=7ms     shimmy-sandbox 进程启动
           清理环境变量（AWS_ACCESS_KEY_ID → SANDBOXED）
           创建 /tmp/dr-sandbox/a1b2c3d4/ 目录
           写入代码文件 /tmp/dr-sandbox/a1b2c3d4/code.py
           设置 rlimits（CPU=10s, AS=256MB, NPROC=10...）
           ↓
t=8ms     fork + exec drrun
           命令: drrun -c /opt/dr-clients/shimmy_client.so -- python3 code.py
           ↓
t=9ms     DynamoRIO 初始化
           shimmy_client.so 的 dr_client_main() 被调用
           注册 event_pre_syscall 回调
           读取 SHIMMY_SESSION_DIR=/tmp/dr-sandbox/a1b2c3d4/
           ↓
t=12ms    Python 解释器启动（被 DynamoRIO 翻译执行）
           CPython 加载标准库（大量 openat 调用被路径重映射）
           所有 /usr/lib/python3.x/*.py → 允许（在白名单中）
           ↓
t=50ms    学生代码开始执行（Python import 完成）
           ↓
           ===== 假设学生代码尝试攻击 =====
           ↓
t=51ms    [攻击尝试 1] open("/proc/self/environ", O_RDONLY)
           → DynamoRIO event_pre_syscall(SYS_openat=257)
           → safe_read_path → "/proc/self/environ"
           → canonicalize → "/proc/self/environ"
           → is_blocked_path("/proc/self/environ") → true（/proc 在黑名单）
           → dr_syscall_set_result(drcontext, -EPERM)
           → return false（跳过系统调用）
           → Python 收到 PermissionError: [Errno 1] Operation not permitted
           ↓
t=52ms    [攻击尝试 2] socket(AF_INET, SOCK_STREAM, 0)
           → event_pre_syscall(SYS_socket=41)
           → domain=AF_INET（不是 AF_UNIX）
           → dr_syscall_set_result(-EPERM)
           → return false
           → Python 收到 PermissionError
           ↓
t=53ms    [正常操作] open("/tmp/output.txt", O_WRONLY|O_CREAT, 0644)
           → event_pre_syscall(SYS_openat=257)
           → safe_read_path → "/tmp/output.txt"
           → canonicalize → "/tmp/output.txt"
           → is_blocked_path → false（/tmp 不在黑名单）
           → should_remap_path → true
           → remapped = "/tmp/dr-sandbox/a1b2c3d4/tmp/output.txt"
           → dr_syscall_set_param(drcontext, 1, remapped_ptr)
           → return true（允许，但路径已重映射）
           → 内核创建 /tmp/dr-sandbox/a1b2c3d4/tmp/output.txt
           → Python 成功写入文件
           ↓
t=200ms   学生代码执行完毕
           Python 退出（exit(0)）
           ↓
t=201ms   drrun 退出，shimmy-sandbox 收集结果
           读取 stdout/stderr/exit_code/duration
           ↓
t=202ms   清理：os.RemoveAll("/tmp/dr-sandbox/a1b2c3d4/")
           会话目录及所有创建的文件被删除
           ↓
t=203ms   shimmy-sandbox 把 JSON 结果写入 stdout
           handler.py 读取结果
           ↓
t=205ms   Lambda 函数返回 HTTP 响应
           ↓
t=210ms   API Gateway 返回给客户端（总延迟 ~210ms）
```

## 10.6 完整的端到端追踪：open("/etc/passwd")

让我们用一个具体的例子，追踪 `open("/etc/passwd")` 从学生 Python 代码到被阻断的完整路径：

```python
# 学生提交的 Python 代码
try:
    f = open("/etc/passwd")
    print(f.read())
except PermissionError as e:
    print(f"被阻断: {e}")
```

**完整调用链**：

```
[学生 Python 代码]
open("/etc/passwd")
    ↓
[Python 解释器（CPython）]
调用 CPython 内置 open() 函数
    ↓
[CPython C 实现（Modules/_io/fileio.c）]
raw_open() 函数
    ↓
[glibc 动态库]
open() → 包装 openat() 系统调用
RAX = 257（SYS_openat）
RDI = AT_FDCWD（-100）
RSI = 指向 "/etc/passwd" 字符串的指针
RDX = O_RDONLY
    ↓
[x86-64 指令: syscall（0F 05）]
    ↑
    │  DynamoRIO 的代码缓存中，这条 syscall 指令
    │  已被替换为:
    │    call [DynamoRIO_pre_syscall_dispatch]
    │  这个 call 指令触发了:
    ↓
[DynamoRIO: event_pre_syscall(drcontext, 257)]
sysnum = 257 (SYS_openat)
    ↓
[Shimmy client: handle_path_syscall()]
    path_ptr = dr_syscall_get_param(drcontext, 1)  // RSI 的值
    ↓
[dr_safe_read(path_ptr, PATH_MAX, raw_path, &bytes)]
    → 安全地从程序内存读取字符串 "/etc/passwd"
    ↓
[canonicalize_path("/etc/passwd", canonical_path)]
    → 输入: "/etc/passwd"
    → 没有 ".." → 规范化结果: "/etc/passwd"（不变）
    ↓
[is_blocked_path("/etc/passwd")]
    → 检查 blocked_prefixes 数组
    → "/etc/" 不在列表中（只有 /etc/passwd, /etc/shadow 完整路径）
    → "/etc/passwd" == blocked_prefixes[1] → true！
    ↓
[dr_syscall_set_result(drcontext, -EPERM)]
    → 把即将成为 RAX 的值设为 -1 (EPERM)
    → return false（告诉 DynamoRIO：跳过内核的 openat 调用）
    ↓
[DynamoRIO 不执行 syscall 指令]
    → RAX 被设为 -1（EPERM 的负值）
    → 程序继续执行（就好像 syscall 返回了 -1）
    ↓
[glibc 的 openat() 封装]
    → 看到返回值 -1
    → errno = -RAX = EPERM = 1
    → 返回 -1 给调用者
    ↓
[CPython 的 raw_open()]
    → open() 返回 -1
    → 检查 errno = 1（EPERM）
    → 抛出 Python 异常: PermissionError: [Errno 1] Operation not permitted: '/etc/passwd'
    ↓
[学生 Python 代码]
    → except PermissionError as e:
    → print(f"被阻断: {e}")
    → 输出: "被阻断: [Errno 1] Operation not permitted: '/etc/passwd'"
```

整个过程对 Python 解释器是透明的——它认为是内核拒绝了请求，而实际上 DynamoRIO 在用户空间就短路了这次调用，内核根本没有收到这个系统调用。

## 10.7 暖启动安全机制

```go
// Lambda 暖启动时，/tmp 目录可能残留上一次调用的文件
// Shimmy 的保护机制:

func ensureCleanSession(sessionID string) (string, error) {
    sessionDir := filepath.Join("/tmp/dr-sandbox", sessionID)

    // 每次调用都使用全新的 UUID session 目录
    // 即使 /tmp/dr-sandbox/ 本身存在，子目录 <UUID> 是全新的
    if err := os.MkdirAll(sessionDir, 0700); err != nil {
        return "", err
    }

    // 确保目录权限正确（只有当前用户可访问）
    if err := os.Chmod(sessionDir, 0700); err != nil {
        return "", err
    }

    return sessionDir, nil
}

func cleanup(sessionDir string) {
    // 使用 defer 确保即使 panic 也会清理
    if err := os.RemoveAll(sessionDir); err != nil {
        // 记录错误，但不影响返回结果
        log.Printf("WARNING: 清理会话目录失败: %v", err)
    }
}
```

**为什么 UUID 足够**：即使上一次调用的数据残留在 `/tmp/dr-sandbox/`，新调用使用不同的 UUID 目录，两次调用之间完全隔离，无法互相读取对方的文件。

## 10.8 监控与可观测性

```go
// metrics.go - 性能监控

type ExecutionMetrics struct {
    SessionID    string
    Language     Language
    Backend      string
    Duration     time.Duration
    Killed       bool
    KillReason   string
    BlockedCalls map[string]int  // 哪些系统调用被阻断了，阻断了多少次
}

// DynamoRIO 客户端把阻断记录写入一个共享内存区域
// shimmy-sandbox 读取并汇总

func collectMetrics(sessionDir string) map[string]int {
    metricsFile := filepath.Join(sessionDir, ".shimmy-metrics")
    data, err := os.ReadFile(metricsFile)
    if err != nil {
        return nil
    }

    var metrics map[string]int
    json.Unmarshal(data, &metrics)
    return metrics
    // 示例: {"openat_blocked": 5, "socket_blocked": 2, "connect_blocked": 1}
}
```

这些指标可以用来：
- 识别频繁触发拦截的学生代码（可能的攻击尝试）
- 调试过于严格的拦截策略（误阻断合法代码）
- 监控 DynamoRIO 的性能开销

## 10.9 错误处理与安全降级

当 DynamoRIO 不可用时（比如在不同的 Lambda 运行时版本），Shimmy 可以安全降级：

```go
// 降级策略
func (r *Router) RouteWithFallback(req ExecutionRequest) (Backend, bool) {
    primary := r.Route(req)
    if primary == nil {
        return nil, false
    }

    // 测试后端是否可用
    if !primary.IsAvailable() {
        log.Printf("WARN: %s 不可用，降级到 rlimits 后端", primary.Name())
        // 降级：只用 rlimits（原型 A），但发送警报
        sendAlert("backend_unavailable", primary.Name())
        return r.rlimits, true
    }

    return primary, true
}
```

**安全降级原则**：宁可降级到功能受限但可用的方案（Proto A），也不能让学生代码在没有任何沙箱的情况下运行。

## 小结

```
Shimmy 系统架构总结:

分层防御:
  Layer 0: Firecracker（AWS 管理）
  Layer 1: 环境变量清理（启动时）
  Layer 2: rlimits（进程级限制）
  Layer 3: DynamoRIO / Goja / wazero（系统调用拦截）

关键设计决策:
  • 每调用独立 UUID 会话目录 → 暖启动隔离
  • defer 清理 → 即使崩溃也不留残留
  • 语言路由 → 每种语言用最合适的后端
  • 安全降级 → 后端不可用时回退而非失效

端到端流程:
  HTTP 请求
    → Lambda handler
      → shimmy-sandbox CLI（Go）
        → 环境清理 + 会话目录
        → fork drrun（设置 rlimits）
          → DynamoRIO 翻译执行
            → event_pre_syscall 拦截每个 syscall
    → 清理会话目录
  → HTTP 响应
```

下一章：基准测试数据的详细分析和解读——那 +67% 的 DynamoRIO 开销在生产环境到底意味着什么？
