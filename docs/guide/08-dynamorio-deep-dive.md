# 第八章：DynamoRIO 深度剖析

> 本章深入 DynamoRIO 的内部机制，以及 Shimmy Sandbox 的 DynamoRIO 插件（`shimmy_client.so`）的具体实现。这是整个系统最技术性的章节。

## 8.1 DynamoRIO 架构总览

**DynamoRIO**（Dynamic Instrumentation Framework）是一个开源的动态二进制插桩框架，最初由麻省理工学院开发，现由 Google 等维护。它通过一个独立的**插件**（client）机制让用户注册回调函数，在程序执行的关键点触发。

### 整体架构图

```
程序启动命令:
  drrun -c shimmy_client.so -- python3 student_code.py

┌─────────────────────────────────────────────────────────────────┐
│                         内存空间                                 │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              DynamoRIO 核心（不对程序可见）                  │ │
│  │                                                            │ │
│  │  • 代码缓存（已翻译的基本块）                               │ │
│  │  • 调度器（dispatcher）                                    │ │
│  │  • 翻译引擎（decoder + encoder）                           │ │
│  │  • 插件管理器（shimmy_client.so 的回调注册表）             │ │
│  │  • 每线程上下文（drcontext）                               │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │      shimmy_client.so（Shimmy 的 DynamoRIO 插件）           │ │
│  │                                                            │ │
│  │  dr_client_main() 注册:                                    │ │
│  │  • drmgr_register_pre_syscall_event(event_pre_syscall)     │ │
│  │  • drmgr_register_bb_instrumentation_event(bb_hook)        │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │      程序原始代码（python3）                                 │ │
│  │      只读：DynamoRIO 从这里读取指令，但 CPU 不在这里执行    │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### DynamoRIO 插件的入口点

DynamoRIO 插件不是普通的 `main()` 程序，而是一个共享库（`.so`），入口点是 `dr_client_main()`：

```c
// shimmy_client.c - 入口点
#include "dr_api.h"
#include "drmgr.h"
#include "drutil.h"
#include <stdatomic.h>

// 全局状态
static char session_dir[PATH_MAX];
static atomic_int fork_count = 0;
#define MAX_FORK 5

// DynamoRIO 插件入口点（替代 main()）
DR_EXPORT void dr_client_main(client_id_t id, int argc, const char *argv[]) {
    // 初始化扩展库
    drmgr_init();
    drutil_init();

    // 从参数或环境变量获取会话目录
    const char *env_session = getenv("SHIMMY_SESSION_DIR");
    if (env_session) {
        strncpy(session_dir, env_session, sizeof(session_dir) - 1);
    } else {
        snprintf(session_dir, sizeof(session_dir), "/tmp/dr-sandbox/%s", generate_uuid());
    }
    dr_create_dir(session_dir);  // 创建会话目录

    // 注册系统调用前置回调
    drmgr_register_pre_syscall_event(event_pre_syscall);

    // 注册系统调用后置回调（用于返回值修改）
    drmgr_register_post_syscall_event(event_post_syscall);

    // 注册基本块翻译回调（可选：用于指令级插桩）
    drmgr_register_bb_instrumentation_event(
        NULL,        // bb_analysis_event (不需要)
        bb_event,    // bb_instrumentation_event
        NULL         // priority
    );

    // 注册退出回调
    dr_register_exit_event(event_exit);

    dr_log(NULL, DR_LOG_ALL, 1, "Shimmy client 初始化完成，会话目录: %s\n", session_dir);
}
```

## 8.2 pre_syscall 回调的完整实现

`event_pre_syscall` 是整个沙箱的核心：

```c
// 系统调用号常量（来自 <sys/syscall.h>）
// 在 x86-64 Linux 上:
// SYS_open = 2, SYS_openat = 257, SYS_socket = 41
// SYS_connect = 42, SYS_fork = 57, SYS_execve = 59
// SYS_mmap = 9, SYS_clone = 56, SYS_io_uring_setup = 425

static bool event_pre_syscall(void *drcontext, int sysnum) {
    // sysnum: 此次系统调用的系统调用号（RAX 的值）
    // drcontext: 每线程不透明上下文，用于访问该线程的寄存器等

    switch (sysnum) {

    // ─────────────────────────────────────────────────────────────
    // 文件系统操作：需要路径重映射
    // ─────────────────────────────────────────────────────────────
    case SYS_open: {
        // open(const char *pathname, int flags, mode_t mode)
        // RDI = pathname（指针！需要从程序内存读取字符串）
        const char *path_ptr = (const char *)dr_syscall_get_param(drcontext, 0);
        return handle_path_syscall(drcontext, sysnum, path_ptr, -1);
    }

    case SYS_openat: {
        // openat(int dirfd, const char *pathname, int flags, mode_t mode)
        // RDI = dirfd, RSI = pathname
        int dirfd = (int)dr_syscall_get_param(drcontext, 0);
        const char *path_ptr = (const char *)dr_syscall_get_param(drcontext, 1);
        return handle_path_syscall(drcontext, sysnum, path_ptr, dirfd);
    }

    case SYS_stat:
    case SYS_lstat:
    case SYS_access:
    case SYS_unlink:
    case SYS_mkdir:
    case SYS_rmdir:
        // 所有涉及路径的系统调用都需要路径检查
        return handle_generic_path_syscall(drcontext, sysnum);

    // ─────────────────────────────────────────────────────────────
    // 网络操作：阻断
    // ─────────────────────────────────────────────────────────────
    case SYS_socket: {
        int domain = (int)dr_syscall_get_param(drcontext, 0);
        int type   = (int)dr_syscall_get_param(drcontext, 1);

        // 允许 Unix domain socket（AF_UNIX），阻断网络套接字
        if (domain == AF_UNIX) {
            return true;  // 允许
        }
        // 阻断 AF_INET, AF_INET6, AF_NETLINK 等
        dr_syscall_set_result(drcontext, -EPERM);
        return false;  // 跳过系统调用，使用我们设置的返回值
    }

    case SYS_connect: {
        // 检查目标地址
        struct sockaddr *addr_ptr = (struct sockaddr *)dr_syscall_get_param(drcontext, 1);
        socklen_t addrlen = (socklen_t)dr_syscall_get_param(drcontext, 2);

        struct sockaddr addr;
        size_t bytes_read;
        if (!dr_safe_read(addr_ptr, sizeof(addr), &addr, &bytes_read)) {
            // 无法读取地址：拒绝
            dr_syscall_set_result(drcontext, -EFAULT);
            return false;
        }

        // 特别阻断 169.254.169.254（AWS IMDS）
        if (addr.sa_family == AF_INET) {
            struct sockaddr_in *in_addr = (struct sockaddr_in *)&addr;
            uint32_t ip = ntohl(in_addr->sin_addr.s_addr);
            // 169.254.169.254 = 0xA9FEA9FE
            if (ip == 0xA9FEA9FE) {
                dr_syscall_set_result(drcontext, -ECONNREFUSED);
                return false;
            }
        }

        // 阻断所有外部网络连接
        dr_syscall_set_result(drcontext, -EPERM);
        return false;
    }

    // ─────────────────────────────────────────────────────────────
    // 进程操作：有限允许
    // ─────────────────────────────────────────────────────────────
    case SYS_fork: {
        int count = atomic_fetch_add(&fork_count, 1) + 1;
        if (count > MAX_FORK) {
            atomic_fetch_sub(&fork_count, 1);
            dr_syscall_set_result(drcontext, -EPERM);
            return false;  // 超出 fork 限制
        }
        return true;  // 允许，但计数
    }

    case SYS_clone: {
        // clone 可以创建线程（CLONE_THREAD）或进程
        unsigned long flags = (unsigned long)dr_syscall_get_param(drcontext, 0);

        if (flags & CLONE_THREAD) {
            // 线程创建：允许（但要限制线程数——通过 fork 计数器近似）
            int count = atomic_fetch_add(&fork_count, 1) + 1;
            if (count > MAX_FORK) {
                atomic_fetch_sub(&fork_count, 1);
                dr_syscall_set_result(drcontext, -EPERM);
                return false;
            }
            return true;
        }

        // 进程 fork：检查限制
        int count = atomic_fetch_add(&fork_count, 1) + 1;
        if (count > MAX_FORK) {
            atomic_fetch_sub(&fork_count, 1);
            dr_syscall_set_result(drcontext, -EPERM);
            return false;
        }
        return true;
    }

    case SYS_execve:
    case SYS_execveat: {
        // 完全阻断 exec（替换当前进程为另一个程序）
        // 允许受信任的子进程执行，但不允许学生代码 exec
        // 注意：Python 自身可能需要 exec 某些工具，这需要白名单
        const char *path_ptr = (const char *)dr_syscall_get_param(drcontext, 0);
        char path[PATH_MAX];
        size_t bytes_read;

        if (!dr_safe_read(path_ptr, PATH_MAX, path, &bytes_read)) {
            dr_syscall_set_result(drcontext, -EFAULT);
            return false;
        }
        path[bytes_read < PATH_MAX ? bytes_read : PATH_MAX - 1] = '\0';

        // 如果是 /bin/sh 或其他 shell，直接阻断
        if (is_shell_path(path) || is_blocked_binary(path)) {
            dr_syscall_set_result(drcontext, -EPERM);
            return false;
        }

        return true;  // 其他程序暂时允许（可收紧）
    }

    // ─────────────────────────────────────────────────────────────
    // 内存操作：阻断可执行内存映射
    // ─────────────────────────────────────────────────────────────
    case SYS_mmap: {
        int prot = (int)dr_syscall_get_param(drcontext, 2);
        int flags = (int)dr_syscall_get_param(drcontext, 3);

        // 阻断 PROT_EXEC 映射（防止 JIT 生成 syscall 指令）
        if (prot & PROT_EXEC) {
            // 移除 PROT_EXEC 标志，允许映射但不允许执行
            // DynamoRIO 自己需要 PROT_EXEC，所以要区分是 DynamoRIO 的请求还是程序的请求
            // DynamoRIO 内部通过不同的 drcontext 标记区分
            dr_syscall_set_param(drcontext, 2, prot & ~PROT_EXEC);
            // 注意：这允许映射，但移除了执行权限
            // 程序如果之后用 mprotect 添加 PROT_EXEC，会被 mprotect 钩子拦截
        }
        return true;
    }

    case SYS_mprotect: {
        int prot = (int)dr_syscall_get_param(drcontext, 2);
        if (prot & PROT_EXEC) {
            // 阻断程序把内存标记为可执行
            // 这会禁用 JIT，但防止代码注入
            dr_syscall_set_result(drcontext, -EPERM);
            return false;
        }
        return true;
    }

    // ─────────────────────────────────────────────────────────────
    // io_uring：完全阻断
    // ─────────────────────────────────────────────────────────────
    case SYS_io_uring_setup:
    case SYS_io_uring_enter:
    case SYS_io_uring_register: {
        dr_syscall_set_result(drcontext, -EPERM);
        return false;
    }

    // ─────────────────────────────────────────────────────────────
    // 默认：允许
    // ─────────────────────────────────────────────────────────────
    default:
        return true;
    }
}
```

## 8.3 dr_syscall_get_param 和 dr_syscall_set_param

DynamoRIO 提供了干净的 API 来读写系统调用参数（寄存器值）：

```c
// 读取第 N 个参数（N 从 0 开始）
// 对应寄存器: RDI(0), RSI(1), RDX(2), R10(3), R8(4), R9(5)
reg_t dr_syscall_get_param(void *drcontext, int param_num);

// 修改第 N 个参数
void dr_syscall_set_param(void *drcontext, int param_num, reg_t new_val);

// 设置系统调用返回值（当 event_pre_syscall 返回 false 时使用）
void dr_syscall_set_result(void *drcontext, reg_t result);
```

**关键语义**：
- `event_pre_syscall` 返回 `true`：让系统调用正常执行（内核会覆盖 RAX）
- `event_pre_syscall` 返回 `false`：跳过系统调用，用 `dr_syscall_set_result` 设置的值作为返回值

## 8.4 dr_safe_read：安全地读取程序内存

系统调用的参数通常是**指针**——比如 `open(path, flags)` 中的 `path` 是一个指向字符串的指针。要读取路径字符串，需要从程序的内存空间读取。

**为什么不能直接解引用**？因为：
1. 指针可能是 NULL（程序 bug）
2. 指针可能指向已 `munmap` 的内存（use-after-free）
3. 直接解引用无效指针会导致 DynamoRIO 自身崩溃，整个沙箱失效

**`dr_safe_read`** 提供了安全的读取方式：

```c
// dr_safe_read 签名
bool dr_safe_read(const void *base, size_t size, void *out_buf, size_t *bytes_read);

// 使用示例：安全读取路径字符串
static bool safe_read_path(void *drcontext, const char *ptr, char *buf, size_t bufsz) {
    if (ptr == NULL) return false;

    size_t bytes_read = 0;
    if (!dr_safe_read(ptr, bufsz - 1, buf, &bytes_read)) {
        return false;  // 读取失败（无效指针）
    }

    // 确保 NUL 终止
    buf[bytes_read] = '\0';

    // 路径字符串以 '\0' 结尾，找到结尾
    // （dr_safe_read 读取的可能比字符串更多）
    return true;
}
```

## 8.5 路径重映射算法

路径重映射是 Shimmy DynamoRIO 插件最复杂的部分之一：它需要在不调用操作系统的情况下解析路径（因为在 pre_syscall 回调中，不能发出新的系统调用来解析路径——那会递归触发回调）。

### 路径规范化（Path Canonicalization）

**路径遍历攻击**（path traversal）的目标是用 `..` 跳出允许的目录：

```
/tmp/sandbox/../../../etc/passwd
→ 规范化后 → /etc/passwd
```

Shimmy 的路径规范化使用**基于栈的纯字符串算法**，不需要任何文件系统操作：

```c
// 规范化路径（不调用任何系统调用）
// 解析 ./ 和 ../ 以及多余的 /
static void canonicalize_path(const char *input, char *output, size_t outsz) {
    // 使用组件栈
    const char *components[256];  // 最多 256 层目录
    int depth = 0;

    char buf[PATH_MAX];
    strncpy(buf, input, PATH_MAX - 1);

    char *token = strtok(buf, "/");
    while (token != NULL) {
        if (strcmp(token, ".") == 0) {
            // 当前目录：忽略
        } else if (strcmp(token, "..") == 0) {
            // 上级目录：弹出栈
            if (depth > 0) depth--;
            // 如果 depth == 0，.. 到根目录以上的操作被忽略
        } else if (strlen(token) > 0) {
            // 普通组件：压栈
            components[depth++] = token;
        }
        token = strtok(NULL, "/");
    }

    // 重组路径
    output[0] = '\0';
    for (int i = 0; i < depth; i++) {
        strncat(output, "/", outsz - strlen(output) - 1);
        strncat(output, components[i], outsz - strlen(output) - 1);
    }
    if (output[0] == '\0') {
        strncpy(output, "/", outsz);
    }
}
```

### 完整的路径处理逻辑

```c
// 处理路径相关系统调用
static bool handle_path_syscall(void *drcontext, int sysnum,
                                 const char *path_ptr, int dirfd) {
    char raw_path[PATH_MAX] = {0};
    char canonical_path[PATH_MAX] = {0};
    char remapped_path[PATH_MAX] = {0};

    // 1. 安全读取路径字符串
    if (!safe_read_path(drcontext, path_ptr, raw_path, PATH_MAX)) {
        dr_syscall_set_result(drcontext, -EFAULT);
        return false;
    }

    // 2. 处理相对路径（如果 dirfd 不是 AT_FDCWD，需要解析）
    if (raw_path[0] != '/' && dirfd == AT_FDCWD) {
        // 相对路径：相对于当前工作目录
        // 需要知道 cwd...但这里不能调用 getcwd()！
        // 解决方案：在 chdir/fchdir 系统调用时追踪 cwd 变化
        char cwd[PATH_MAX];
        get_tracked_cwd(drcontext, cwd, PATH_MAX);
        snprintf(raw_path, PATH_MAX, "%s/%s", cwd, raw_path);
    }

    // 3. 规范化路径（解析 ..）
    canonicalize_path(raw_path, canonical_path, PATH_MAX);

    // 4. 检查是否在阻断列表中
    if (is_blocked_path(canonical_path)) {
        // 直接阻断，返回 EPERM
        dr_log(NULL, DR_LOG_ALL, 2,
               "BLOCKED: open(\"%s\")\n", canonical_path);
        dr_syscall_set_result(drcontext, -EPERM);
        return false;
    }

    // 5. 路径重映射
    if (should_remap_path(canonical_path)) {
        // 把路径重映射到会话目录
        // /tmp/data.txt → /tmp/dr-sandbox/<session-id>/tmp/data.txt
        snprintf(remapped_path, PATH_MAX, "%s%s",
                 session_dir, canonical_path);

        // 确保目标目录存在
        ensure_parent_dir(remapped_path);

        // 把新路径写回程序内存！
        // 需要找一块程序的可写内存来存放新路径字符串
        // DynamoRIO 提供 dr_nonheap_alloc 分配对程序可见的内存
        char *new_path_in_app = allocate_in_app_memory(strlen(remapped_path) + 1);
        memcpy(new_path_in_app, remapped_path, strlen(remapped_path) + 1);

        // 修改系统调用的路径参数
        if (sysnum == SYS_open) {
            dr_syscall_set_param(drcontext, 0, (reg_t)new_path_in_app);
        } else if (sysnum == SYS_openat) {
            dr_syscall_set_param(drcontext, 1, (reg_t)new_path_in_app);
        }

        dr_log(NULL, DR_LOG_ALL, 2,
               "REMAP: \"%s\" → \"%s\"\n", canonical_path, remapped_path);
    }

    // 6. 允许系统调用（使用可能修改过的参数）
    return true;
}
```

### 阻断路径列表

```c
// 检查路径是否应该被阻断
static bool is_blocked_path(const char *path) {
    // 完全阻断的路径前缀
    static const char *blocked_prefixes[] = {
        "/proc/",           // /proc 下所有路径（含 self/environ）
        "/etc/passwd",
        "/etc/shadow",
        "/etc/sudoers",
        "/root/",
        "/home/",           // 其他用户的 home 目录
        "/var/",            // 大部分系统数据
        "/.ssh/",
        NULL,
    };

    for (int i = 0; blocked_prefixes[i] != NULL; i++) {
        if (strncmp(path, blocked_prefixes[i],
                    strlen(blocked_prefixes[i])) == 0) {
            return true;
        }
    }

    // 允许的路径（白名单优先级高于黑名单前缀）
    static const char *allowed_prefixes[] = {
        "/tmp/dr-sandbox/",  // 会话目录（重映射目标）
        "/opt/",             // Lambda 层（只读共享库等）
        "/usr/lib/",         // 系统库
        "/lib/",
        "/lib64/",
        "/dev/null",         // 空设备
        "/dev/urandom",      // 随机数
        NULL,
    };

    for (int i = 0; allowed_prefixes[i] != NULL; i++) {
        if (strncmp(path, allowed_prefixes[i],
                    strlen(allowed_prefixes[i])) == 0) {
            return false;  // 在白名单中：允许
        }
    }

    // /tmp 路径：重映射（不阻断）
    if (strncmp(path, "/tmp/", 5) == 0) {
        return false;  // 允许（但会被重映射）
    }

    // 默认阻断
    return true;
}
```

## 8.6 io_uring 为什么必须完全封堵

io_uring 的工作机制决定了它可以完全绕过 `event_pre_syscall` 钩子：

```
普通系统调用路径（DynamoRIO 可以拦截）:
  程序 → syscall 指令 → CPU 进入 Ring 0
              ↑ DynamoRIO 在翻译这条指令时插入了钩子！

io_uring 路径（DynamoRIO 无法拦截单个操作）:
  程序 → io_uring_setup(2个共享内存环) → CPU Ring 0
  内核创建提交队列(SQ)和完成队列(CQ)

  后续操作（不需要 syscall 指令！）:
  程序 → 向 SQ 写入 sqe 结构体（openat 请求）
                  │ 共享内存，内核可见
                  ▼
  内核 io_uring 工作线程 → 从 SQ 读取 → 执行 openat
                  │
                  ▼
  内核 → 向 CQ 写入结果
  程序 → 从 CQ 读取 fd 号

  // 整个 openat 操作，程序没有执行任何 syscall 指令！
  // DynamoRIO 的 event_pre_syscall 永远不会触发！
```

**解决方案**：封堵 `io_uring_setup()`（系统调用号 425）。这是 io_uring 唯一必须通过 `syscall` 指令的入口点。一旦阻断初始化，后续的所有 io_uring 操作都无法工作。

```c
case SYS_io_uring_setup:
    // io_uring_setup() 失败 → 整个 io_uring 机制无法初始化
    // 程序会回退到普通的 read/write 系统调用（可以正常拦截）
    dr_syscall_set_result(drcontext, -EPERM);
    return false;
```

## 8.7 多线程处理

每个线程有自己的 `drcontext`（每线程上下文），包含该线程的寄存器状态。代码缓存是共享的，但受读写锁保护。

```c
// 线程创建时，DynamoRIO 自动为新线程初始化 drcontext
// 插件可以注册线程创建/销毁事件

static void event_thread_init(void *drcontext) {
    // 为每个线程分配私有数据
    thread_data_t *tdata = dr_thread_alloc(drcontext, sizeof(thread_data_t));
    tdata->syscall_count = 0;
    drmgr_set_tls_field(drcontext, tls_idx, tdata);
}

static void event_thread_exit(void *drcontext) {
    thread_data_t *tdata = drmgr_get_tls_field(drcontext, tls_idx);
    // 子进程/线程退出时减少计数器
    atomic_fetch_sub(&fork_count, 1);
    dr_thread_free(drcontext, tdata, sizeof(thread_data_t));
}
```

**fork 计数器的原子操作**：

```c
// 使用 C11 原子操作，保证多线程安全
static atomic_int fork_count = ATOMIC_VAR_INIT(0);
#define MAX_FORK 5

static bool check_and_increment_fork(void) {
    // atomic_fetch_add 返回旧值
    int old = atomic_fetch_add_explicit(&fork_count, 1, memory_order_seq_cst);
    if (old >= MAX_FORK) {
        // 超出限制，回滚
        atomic_fetch_sub_explicit(&fork_count, 1, memory_order_seq_cst);
        return false;
    }
    return true;
}
```

## 8.8 构建 DynamoRIO 插件

### CMakeLists.txt

```cmake
cmake_minimum_required(VERSION 3.14)
project(shimmy_client C)

# 找到 DynamoRIO
find_package(DynamoRIO REQUIRED)

# 构建插件（共享库）
add_library(shimmy_client SHARED
    shimmy_client.c
    path_utils.c
    syscall_policy.c
)

# 配置 DynamoRIO 扩展
use_DynamoRIO_extension(shimmy_client drmgr)
use_DynamoRIO_extension(shimmy_client drutil)

# 编译选项
target_compile_options(shimmy_client PRIVATE
    -Wall -Wextra
    -fvisibility=hidden        # 默认隐藏符号
    -fstack-protector-strong   # 栈保护
    -D_FORTIFY_SOURCE=2
)

# 安装
install(TARGETS shimmy_client
    LIBRARY DESTINATION ${CMAKE_INSTALL_PREFIX}/dr-clients)
```

### 构建命令

```bash
# 在 DynamoRIO 安装目录中
mkdir build && cd build
cmake .. \
    -DDynamoRIO_DIR=/opt/dynamorio/cmake \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX=/opt/shimmy

make -j$(nproc)
make install
```

### 运行

```bash
# 基本用法
drrun -c /opt/shimmy/dr-clients/shimmy_client.so \
      -- python3 /tmp/student_code.py

# 指定日志级别
drrun -c /opt/shimmy/dr-clients/shimmy_client.so \
      -loglevel 2 \
      -- python3 /tmp/student_code.py

# 环境变量
SHIMMY_SESSION_DIR=/tmp/dr-sandbox/$(uuidgen) \
drrun -c /opt/shimmy/dr-clients/shimmy_client.so \
      -- python3 /tmp/student_code.py
```

## 8.9 后置系统调用钩子（post_syscall）

除了 pre_syscall，DynamoRIO 也提供 post_syscall——在系统调用执行完毕、返回用户空间之前触发：

```c
static void event_post_syscall(void *drcontext, int sysnum) {
    // 系统调用已执行，RAX 包含返回值

    switch (sysnum) {
    case SYS_fork:
    case SYS_clone: {
        // fork 返回后：
        // 在父进程中：返回值 = 子进程 PID（> 0）
        // 在子进程中：返回值 = 0
        reg_t retval = dr_syscall_get_result(drcontext);

        if (retval == 0) {
            // 这是子进程！
            // 需要重置子进程的某些状态
            // 比如：子进程的 fork_count 应该继承父进程的值
            // DynamoRIO 会自动为子进程初始化新的 drcontext
        }
        break;
    }

    case SYS_openat:
    case SYS_open: {
        // 检查打开的 fd 数量
        reg_t fd = dr_syscall_get_result(drcontext);
        if ((long)fd >= 0) {
            // 成功打开了一个文件，记录到 fd 追踪器
            track_fd_open(drcontext, (int)fd);
        }
        break;
    }

    case SYS_close: {
        int fd = (int)dr_syscall_get_param(drcontext, 0);
        track_fd_close(drcontext, fd);
        break;
    }
    }
}
```

## 8.10 JIT 代码的竞争窗口问题

当 V8（Node.js）运行时：

```
时间线:
t0: V8 调用 mmap(PROT_WRITE)           → 分配内存
t1: V8 把机器码写入分配的内存页         → 包含 syscall 指令
t2: V8 调用 mprotect(PROT_READ|PROT_EXEC) → 标记可执行
    ↑ DynamoRIO 的 mprotect 钩子触发！
    DynamoRIO 知道有新的可执行代码了，
    下次执行到这里时会翻译
t3: V8 跳转到新生成的代码
    ↑ DynamoRIO 检测到进入未翻译区域 → 立即翻译
    翻译时找到 syscall 指令 → 插入钩子

问题：如果 t2 和 t3 之间有另一个线程直接跳到 t1 写的地址？
    （这在多线程 JIT 中是可能的）
    ↑ 那条 syscall 指令在翻译完成之前被执行了！
```

**Shimmy 的解决方案**：完全阻断 `mmap(PROT_EXEC)` 和 `mprotect(PROT_EXEC)`。代价是 JIT 无法工作，但消除了竞争窗口。

对于需要 JavaScript 的场景，Shimmy 使用 Goja（纯 Go 解释执行，不使用 JIT），完全回避这个问题。

## 8.11 性能优化：减少不必要的翻译开销

DynamoRIO 的默认行为会翻译所有代码，包括 libc 中的每一个函数。Shimmy 做了几个优化：

**优化 1：对系统库使用黑匣子模式**

```c
// 告诉 DynamoRIO：libc 是可信的，不需要检查其内部代码
// 只检查 API 边界（即系统调用）
// 注意：这样做的风险是 libc 内部的 inline syscall 不会被拦截
// 但 glibc 不使用 inline syscall，所以这是安全的

// DynamoRIO API（概念性）
dr_set_module_as_trusted("/lib/x86_64-linux-gnu/libc.so.6");
```

**优化 2：代码缓存调整**

```c
// 增大代码缓存，减少因容量不足导致的重新翻译
dr_options_t opts;
opts.code_cache_initial_size = 4 * 1024 * 1024;  // 4MB 初始大小
opts.code_cache_max_size = 64 * 1024 * 1024;     // 64MB 最大
```

**优化 3：只在 syscall 处插桩**

不使用 bb_event（基本块级别的指令插桩），只使用 pre/post_syscall 事件。这大大减少了回调触发频率：

```c
// 不注册 bb 插桩（更快）:
// drmgr_register_bb_instrumentation_event(NULL, bb_event, NULL);  // 注释掉！

// 只注册 syscall 事件:
drmgr_register_pre_syscall_event(event_pre_syscall);
```

## 小结

本章展示了 DynamoRIO 插件的完整实现逻辑：

```
dr_client_main()
    ↓ 注册
event_pre_syscall()
    ↓ 按系统调用号分发

文件路径:
    safe_read_path → canonicalize_path → is_blocked_path
    → 阻断(EPERM) 或 路径重映射 → 修改 RDI/RSI → 允许

网络:
    socket(AF_INET) → EPERM
    connect(169.254.169.254) → ECONNREFUSED

进程:
    fork/clone → 检查原子计数器 → 超限 EPERM

内存:
    mmap(PROT_EXEC) → 去掉 PROT_EXEC
    mprotect(PROT_EXEC) → EPERM

io_uring:
    io_uring_setup → EPERM（一刀切阻断）

关键工具:
    dr_safe_read: 安全读取程序内存（避免 SIGSEGV）
    dr_syscall_get_param / set_param: 读写寄存器参数
    dr_syscall_set_result: 设置返回值
    atomic_fetch_add: 线程安全 fork 计数
```

下一章：五种原型设计——在 DynamoRIO 之外，还有哪些方案，各自的权衡是什么？
