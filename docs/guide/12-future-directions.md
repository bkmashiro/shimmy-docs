# 第十二章：未来方向与研究展望

> 本章是整个文档的最终章。我们将从已有的工作出发，系统梳理 Shimmy Sandbox 尚存在的已知缺陷、中短期可以改进的研究方向、长期的前沿探索，以及整个沙箱安全领域的行业趋势。最后，给出针对本毕设项目的具体建议。
>
> 本章的目标读者是：已经读完前十一章、对系统有全局认识的你。我们会从零解释每个新概念，但也会毫不回避其背后的技术深度。

---

## 12.1 已知缺陷与近期改进方向

### 先回顾：当前系统的安全边界

在讨论缺陷之前，先明确现有系统 **能做什么、不能做什么**。

Shimmy Sandbox 的四层防御（Firecracker + 环境清理 + rlimits + DynamoRIO 拦截）在正常情况下提供了相当强的隔离。但任何安全系统都有弱点，诚实地记录这些弱点是工程师的职业操守，也是学术写作的基本要求。

```
已知攻击面（按危险程度排序）:

1. 【高危】原始系统调用旁路（Raw Syscall Bypass）
   ─ DynamoRIO 的 syscall 钩子只拦截通过正常 syscall/sysenter 指令发出的调用
   ─ 恶意程序可以手写汇编，直接编码 syscall 指令，绕过用户空间的所有控制

2. 【中危】mmap(PROT_EXEC) 拦截失效
   ─ 攻击者可以 mmap 一块内存，写入 shellcode，然后标记为可执行
   ─ 当前版本无法阻止这个序列，JIT 引擎本身也需要此能力

3. 【中危】符号链接 / 硬链接逃逸
   ─ 路径规范化（path canonicalization）在符号链接存在时可能失效
   ─ 例：/tmp/evil -> /etc/passwd 可能使路径白名单失效

4. 【低危】rlimits 与 DynamoRIO 相互干扰
   ─ DynamoRIO 本身消耗内存和进程资源，会"压缩"留给被沙箱程序的配额
   ─ 两者目前没有协同校准
```

下面逐一深入分析，并给出改进思路。

---

### 12.1.1 原始系统调用旁路（Raw Syscall Bypass）

**问题的本质**

DynamoRIO 的拦截机制依赖于：程序在翻译后的代码缓存中执行，每条 `syscall` 指令都被替换为跳转到 DynamoRIO 的调度器，再由调度器调用我们注册的 `event_pre_syscall` 回调。

```
正常流程（DynamoRIO 控制下）:

  程序代码: syscall      ← DynamoRIO 翻译时将这条指令替换掉
                          ↓
  代码缓存: CALL dr_syscall_handler
                          ↓
  我们的回调: event_pre_syscall() → 检查、可能阻断
                          ↓
  实际内核调用（或被拦截返回 -EPERM）
```

但 x86-64 Linux 上，`syscall` 只是一条普通的 2 字节指令（`0F 05`）。恶意程序可以这样做：

```c
// 恶意程序手写内联汇编
#include <unistd.h>

void evil_openat(void) {
    // 直接发出 openat 系统调用，不经过任何库函数
    // DynamoRIO 理论上也会翻译这段代码……
    // 但如果这段代码是动态生成的（JIT），情况就复杂了
    long ret;
    asm volatile (
        "mov $257, %%rax\n"   // SYS_openat
        "mov $-100, %%rdi\n"  // AT_FDCWD
        "lea path(%%rip), %%rsi\n"
        "xor %%rdx, %%rdx\n"
        "syscall\n"
        : "=a"(ret) :: "memory"
    );
}
```

上面这个例子中，DynamoRIO **实际上会** 翻译并拦截这条 `syscall`，因为它是静态存在于二进制中的。

真正的危险在于 **动态生成的代码（JIT 代码）**：

```
攻击序列:

  1. 用 mmap(PROT_READ|PROT_WRITE) 申请一块内存
  2. 向这块内存写入 syscall 指令字节: 0x0F, 0x05
  3. 用 mprotect(PROT_READ|PROT_EXEC) 将这块内存标记为可执行
  4. 跳转到这块内存执行

  这块新生成的代码，DynamoRIO 是否会重新翻译？
  → 取决于 DynamoRIO 版本和配置
  → 在某些配置下，DynamoRIO 可能直接执行而不经过 JIT 引擎
```

**改进方案：强制重翻译**

正确的做法是：

1. 拦截所有 `mprotect(PROT_EXEC)` 和 `mmap(PROT_EXEC)` 调用
2. 在这些调用成功后，**主动告知 DynamoRIO 该内存区域已更改**，强制其在下次执行时重新翻译
3. DynamoRIO 提供了 `dr_unmap_executable_area()` 和 `dr_flush_region()` API 来实现这一点

```c
// 改进后的 mprotect 拦截（伪代码）

bool event_pre_syscall(void *drcontext, int sysnum) {
    if (sysnum == SYS_mprotect) {
        void  *addr = (void *)dr_syscall_get_param(drcontext, 0);
        size_t len  = dr_syscall_get_param(drcontext, 1);
        int    prot = dr_syscall_get_param(drcontext, 2);

        if (prot & PROT_EXEC) {
            // 记录这个地址范围，待 syscall 成功后处理
            pending_exec_flush_push(addr, len);
        }
    }
    return true; // 允许继续执行
}

void event_post_syscall(void *drcontext, int sysnum) {
    if (sysnum == SYS_mprotect && pending_exec_flush_has()) {
        exec_region_t *r = pending_exec_flush_pop();
        if (dr_syscall_get_result(drcontext) == 0) {
            // syscall 成功，强制 DynamoRIO 重新翻译这块内存
            dr_flush_region(r->addr, r->len);
            // 现在任何对这块内存的执行都会经过 JIT 引擎
        }
    }
}
```

::: warning 注意
`dr_flush_region()` 会使代码缓存中对应区域的翻译失效，下次执行时 DynamoRIO 会重新翻译并检查其中的 `syscall` 指令。但这个操作本身有性能代价，需要谨慎使用。
:::

---

### 12.1.2 mmap(PROT_EXEC) 阻断失效

**问题描述**

当前实现尝试阻断所有 `mmap()` 调用中包含 `PROT_EXEC` 标志的情况，但这个策略**过于激进且实现不完整**：

- **过于激进**：Python、V8 等 JIT 引擎需要 `mmap(PROT_EXEC)` 来存放它们自己生成的机器码。完全阻断会导致解释器崩溃。
- **实现不完整**：即使阻断了 `mmap(PROT_EXEC)`，攻击者还可以先 `mmap(PROT_READ|PROT_WRITE)`，再 `mprotect(PROT_EXEC)`，达到同样效果。

```
当前策略（有缺陷）:

  mmap(PROT_EXEC)  → 阻断 ✗ (但破坏了 Python JIT)
  mmap(PROT_READ|PROT_WRITE) + mprotect(PROT_EXEC)  → 未处理 ✗

正确策略应该是:

  允许 mmap/mprotect 创建可执行内存，
  但确保 DynamoRIO 会重新翻译这块内存中的所有 syscall 指令
  （见 12.1.1 的改进方案）
```

**分层策略设计**

更精细的做法是区分**受信任的 JIT 代码**和**潜在恶意的 shellcode**：

```
判断依据:

  受信任 JIT 调用方:
    - 调用栈中有 python3 解释器的帧 → 这是 Python 的 JIT，允许
    - 调用栈中有 libstdc++ 帧 → 可能是 C++ 运行时，允许

  可疑调用:
    - 调用栈来自匿名内存区域（之前 mmap 的内存）→ 高度可疑
    - 调用时机在 Python 解释器初始化完成之后 → 非常可疑
```

当然，这种启发式方法有误报的风险，目前仍是研究课题。

---

### 12.1.3 符号链接与硬链接逃逸

**什么是符号链接（Symlink）？**

在 Linux 中，**符号链接**（symbolic link，简称 symlink）是一种特殊文件，它的内容是另一个路径。就像 Windows 的快捷方式：

```bash
# 创建一个符号链接
ln -s /etc/passwd /tmp/evil_file

# 现在 /tmp/evil_file 和 /etc/passwd 是同一个文件
cat /tmp/evil_file     # 读到的是 /etc/passwd 的内容！
```

**硬链接**（hard link）更隐蔽：它让两个文件名指向同一个 inode（磁盘上的实际数据块），没有"目标路径"可以检查：

```bash
# 如果权限允许，创建硬链接
ln /etc/passwd /tmp/innocent_name
# /tmp/innocent_name 就是 /etc/passwd，完全等同
```

**如何绕过 Shimmy 的路径检查？**

Shimmy 的 DynamoRIO 插件对文件路径做白名单检查：只允许访问 `/tmp/dr-sandbox/<session>/` 下的路径。但：

```
攻击序列（符号链接）:

  1. open("/tmp/dr-sandbox/sess1/tmp/evil", O_WRONLY|O_CREAT) → 允许
     （在沙箱目录内创建文件，合法）

  2. 某种方式（比如程序启动前预置）让这个路径是个符号链接:
     /tmp/dr-sandbox/sess1/tmp/evil -> /etc/cron.d/backdoor

  3. 现在 open() 实际打开的是 /etc/cron.d/backdoor
     但 DynamoRIO 检查的是字符串 "/tmp/dr-sandbox/sess1/tmp/evil"
     → 路径检查通过，但实际写入了危险位置！
```

**路径规范化（Path Canonicalization）的重要性**

正确的解决方案是在检查路径之前，先解析所有符号链接，得到**真实路径**（canonical path）：

```c
// 错误的做法（当前实现的简化版）
bool path_is_allowed(const char *path) {
    return strncmp(path, SANDBOX_ROOT, strlen(SANDBOX_ROOT)) == 0;
    // 问题：path 可能包含符号链接！
}

// 正确的做法
bool path_is_allowed_safe(const char *path) {
    char real[PATH_MAX];

    // realpath() 解析所有符号链接，返回绝对真实路径
    // 如果路径不存在，返回 NULL（需要特殊处理 O_CREAT 情况）
    if (realpath(path, real) == NULL) {
        // 文件不存在时，解析父目录，再拼接文件名
        char parent[PATH_MAX];
        char *last_slash = strrchr(path, '/');
        if (!last_slash) return false;

        strncpy(parent, path, last_slash - path);
        parent[last_slash - path] = '\0';

        if (realpath(parent, real) == NULL) return false;
        strncat(real, last_slash, PATH_MAX - strlen(real) - 1);
    }

    return strncmp(real, SANDBOX_ROOT, strlen(SANDBOX_ROOT)) == 0;
}
```

::: tip 关于 TOCTOU 竞争条件
即使使用了 `realpath()`，仍然存在一个微妙的竞争条件（Time-Of-Check to Time-Of-Use，TOCTOU）：在 `realpath()` 检查和实际 `open()` 之间，攻击者可能将文件替换成符号链接。

真正安全的做法是使用 `openat()` 配合 `O_NOFOLLOW` 标志，或者使用 Linux 5.6+ 的 `openat2()` 系统调用（支持 `RESOLVE_NO_SYMLINKS` 标志）：

```c
struct open_how how = {
    .flags = O_RDONLY,
    .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH,
};
int fd = syscall(SYS_openat2, AT_FDCWD, path, &how, sizeof(how));
```

`RESOLVE_BENEATH` 确保路径解析不会超出指定的根目录，从根本上防止逃逸。
:::

---

### 12.1.4 让 rlimits 与 DynamoRIO 协同工作

**当前问题：配额冲突**

第十章提到，Shimmy 使用 rlimits 限制进程的资源使用（内存 256MB、文件描述符 20 个等）。但 DynamoRIO 本身也会消耗这些资源：

```
资源消耗分析（估算）:

  DynamoRIO 本身需要:
    • 内存: ~30-50MB（代码缓存 + 内部数据结构）
    • 文件描述符: ~5-10 个（日志文件、内部管道等）
    • 子进程: 0（单进程）

  如果 rlimit_AS = 256MB，那么实际上留给被沙箱程序的只有 ~200MB
  如果 rlimit_NOFILE = 20，那么实际上只有 ~10-15 个可用

  这会导致:
    1. 原本应该能运行的程序因内存不足崩溃
    2. 难以调试（错误看起来像程序 bug 而不是配额问题）
    3. 基准测试结果不准确（评测时限需要额外放宽）
```

**改进方案：动态校准**

正确的做法是在启动时测量 DynamoRIO 的基础开销，然后在设置 rlimits 时加上这个偏移量：

```go
// Go 伪代码：动态校准 rlimits

func calibrateDynamoRIOOverhead() ResourceUsage {
    // 用 DynamoRIO 运行一个极简的程序（仅 exit(0)）
    // 测量其内存、fd 使用量
    cmd := exec.Command("drrun", "-c", "shimmy_client.so", "--", "/bin/true")
    // 通过 /proc/self/status 或 getrusage() 读取峰值资源使用
    return measureResourceUsage(cmd)
}

func applyRlimitsWithOffset(target ResourceLimits, overhead ResourceUsage) {
    // 目标是给程序留出 target 的空间，所以总配额 = target + overhead
    setrlimit(RLIMIT_AS, target.Memory + overhead.Memory + safetyMargin)
    setrlimit(RLIMIT_NOFILE, target.FDs + overhead.FDs + 5)
    // ...
}
```

更简单的近期改进是在文档中明确标注"配置的 rlimits 是对被沙箱程序的承诺，内部已加上 DynamoRIO 开销的裕量"，并将这个裕量硬编码为保守的固定值（如额外 100MB 内存）。

::: info 这是一个经典的工程问题
rlimits 是一个相对粗糙的工具，它不区分"谁用了这块内存"。在将来引入 cgroup 时，可以更精确地隔离 DynamoRIO 本身的资源使用与被监控程序的资源使用。
:::

---

## 12.2 中期研究方向

### 什么叫"中期"？

在毕设语境中，"中期"指 **毕设完成后到博士/工作的头两年**，或者由导师指导的延续性研究。这些问题比近期修复更有深度，但已经有清晰的研究路径。

---

### 12.2.1 监控 Lambda 内核版本升级（Landlock 的前景）

**什么是 Landlock？**

Landlock 是 Linux 内核 5.13 版本（2021 年 6 月发布）引入的一个全新安全模块。它允许 **非特权进程**（不需要 root）为自身设置文件系统访问限制。

在 Landlock 之前，Linux 上的文件系统隔离选项：

| 技术 | 需要权限 | 可用于非 root？ |
|------|----------|----------------|
| chroot | 需要 root | 否 |
| 挂载命名空间 | 需要 CAP_SYS_ADMIN | 否（默认）|
| seccomp | 不需要特权 | 是，但只管系统调用 |
| **Landlock** | **不需要特权** | **是！** |

Landlock 的工作方式：

```
┌──────────────────────────────────────────────────────┐
│  Landlock 使用示例（C 代码）                           │
│                                                        │
│  1. 创建一个规则集（ruleset）:                         │
│     描述"我想限制哪些文件操作"                         │
│                                                        │
│  2. 向规则集添加规则:                                  │
│     "允许读取 /tmp/sandbox/"                          │
│     "允许写入 /tmp/sandbox/"                          │
│     "允许读取 /usr/lib/"（运行时库）                  │
│     （没有被允许的路径默认被拒绝）                     │
│                                                        │
│  3. 启用规则集:                                        │
│     prctl(PR_SET_NO_NEW_PRIVS, 1, ...)                │
│     landlock_restrict_self(ruleset_fd, 0)             │
│                                                        │
│  4. 从此，这个进程（及其子进程）只能访问允许的路径     │
└──────────────────────────────────────────────────────┘
```

```c
// Landlock 示例代码（需要 Linux 5.13+）
#include <linux/landlock.h>
#include <sys/syscall.h>

int setup_landlock_sandbox(void) {
    struct landlock_ruleset_attr rs_attr = {
        .handled_access_fs =
            LANDLOCK_ACCESS_FS_READ_FILE  |
            LANDLOCK_ACCESS_FS_WRITE_FILE |
            LANDLOCK_ACCESS_FS_READ_DIR   |
            LANDLOCK_ACCESS_FS_MAKE_REG,
    };

    // 创建规则集
    int rs_fd = syscall(SYS_landlock_create_ruleset,
                        &rs_attr, sizeof(rs_attr), 0);

    // 允许访问沙箱目录
    int dir_fd = open("/tmp/sandbox/", O_PATH | O_DIRECTORY);
    struct landlock_path_beneath_attr path_attr = {
        .allowed_access = LANDLOCK_ACCESS_FS_READ_FILE |
                          LANDLOCK_ACCESS_FS_WRITE_FILE,
        .parent_fd = dir_fd,
    };
    syscall(SYS_landlock_add_rule, rs_fd,
            LANDLOCK_RULE_PATH_BENEATH, &path_attr, 0);
    close(dir_fd);

    // 激活（不可逆）
    prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
    syscall(SYS_landlock_restrict_self, rs_fd, 0);
    close(rs_fd);

    return 0;
}
```

**Landlock 如何改变沙箱格局？**

如果 Lambda 的内核升级到 5.13+，Shimmy 可以：

```
当前（DynamoRIO 路径检查）:
  用户程序发出 open("/etc/passwd")
  → DynamoRIO 回调检查路径字符串
  → 如果路径规范化有 bug → 可能被绕过

未来（Landlock）:
  在沙箱启动时，用 Landlock 声明允许的路径
  → 内核直接拒绝任何不在白名单内的文件操作
  → 无论用什么技术（raw syscall、动态生成的代码），内核层面都会拒绝
  → 无法被用户空间的 bug 绕过
```

Landlock 是内核实施的，比用户空间的 DynamoRIO 钩子**从根本上更难绕过**。

**当前 Lambda 的内核版本**

截至 2026 年初，AWS Lambda 使用基于 Linux 5.10 的 Firecracker 微虚拟机，尚未支持 Landlock（需要 5.13+）。但内核版本的升级只是时间问题。

**行动建议：设置监控**

```bash
# 在 Lambda 函数的初始化阶段检测内核版本
import os
kernel = os.uname().release  # 例如 "5.10.68-62.173.amzn2.x86_64"
major, minor = map(int, kernel.split('.')[:2])

if major > 5 or (major == 5 and minor >= 13):
    use_landlock_sandbox()
else:
    use_dynamorio_sandbox()
```

这是一个"低成本监控、高价值升级"的典型例子：不需要现在实现，但应该在代码中预留判断点。

---

### 12.2.2 在真实 Lambda 上验证 DynamoRIO

**当前 CI 环境的问题**

Shimmy 的 CI（持续集成）运行在 GitHub Actions 上，而不是真实的 Lambda 环境：

```
环境对比:

  GitHub Actions Runner:
  • Azure VM，通用 x86-64 服务器
  • 内核：Ubuntu 22.04 默认内核（5.15 或更新）
  • CPU：共享的 Intel Xeon，支持所有扩展指令集
  • 无 Firecracker 虚拟化

  AWS Lambda (Firecracker):
  • 微虚拟机，特定 5.10.x 内核
  • CPU：暴露给 Firecracker 的指令集可能有所裁剪
  • 有 vCPU 切换开销
  • 内存带宽受限（Firecracker 的 virtio-balloon）
```

DynamoRIO 对 CPU 特性非常敏感。例如：

- 某些 x86 指令在 Firecracker 暴露的虚拟 CPU 上可能行为不同
- CPUID 指令的返回值在 Firecracker 中被拦截和修改
- TSC（时间戳计数器）读取在 vCPU 上有额外延迟

**验证计划**

中期应该实现在真实 Lambda 上运行的测试套件：

```python
# lambda_validation_test.py
# 部署为 Lambda 函数，运行 DynamoRIO 兼容性检查

import subprocess
import json

def handler(event, context):
    results = {}

    # 1. 检测内核版本
    with open('/proc/version') as f:
        results['kernel'] = f.read().strip()

    # 2. 运行 DynamoRIO smoke test
    proc = subprocess.run(
        ['drrun', '-c', 'shimmy_client.so', '--',
         '/bin/echo', 'hello'],
        capture_output=True, text=True, timeout=10
    )
    results['dynamorio_ok'] = (proc.returncode == 0)
    results['stdout'] = proc.stdout

    # 3. 测量 DynamoRIO 在 Lambda vCPU 上的真实开销
    import time
    t0 = time.perf_counter()
    for _ in range(100):
        subprocess.run(['drrun', '-c', 'shimmy_client.so', '--',
                        '/bin/true'], capture_output=True)
    t1 = time.perf_counter()
    results['avg_overhead_ms'] = (t1 - t0) / 100 * 1000

    return {'statusCode': 200, 'body': json.dumps(results)}
```

这个验证步骤的重要性不亚于任何功能开发——**未经验证的生产环境假设是系统性风险**。

---

### 12.2.3 选择性 JIT 钩子：正确处理可执行内存

这是 12.1.2 讨论的改进方案的技术细化。

**JIT 引擎的内存使用模式**

Python 的 Cython 扩展、NumPy 等库会使用 `mmap(PROT_EXEC)` 加载预编译的 `.so` 文件。这是合法的，必须被允许。但我们需要区分：

```
合法的 PROT_EXEC 使用：
  • dlopen() 加载共享库 → 操作系统 loader 管理，有签名
  • Python 的 mmap 模块显式操作 → 应该被允许但监控

可疑的 PROT_EXEC 使用：
  • 匿名 mmap + mprotect(PROT_EXEC) 序列
  • mmap 后立即 mprotect，调用栈没有 dlopen 帧
  • 将之前用于数据的页面标记为可执行
```

**hook mprotect(PROT_EXEC) + 强制重翻译**

```
改进后的处理流程:

  程序调用 mprotect(addr, len, PROT_READ|PROT_EXEC)
              │
              ▼
  DynamoRIO 的 pre-syscall 钩子记录 (addr, len)
              │
              ▼ 允许 syscall 执行
              │
  DynamoRIO 的 post-syscall 钩子
              │
              ▼
  调用 dr_flush_region(addr, len)
  → 使 DynamoRIO 代码缓存中对应区域失效
              │
              ▼
  下次跳转到 addr 执行时
  → DynamoRIO 重新翻译这块内存
  → 其中的 syscall 指令被替换为我们的钩子
  → 安全！
```

这个机制的关键洞察是：**我们不需要阻止可执行内存的创建，只需要确保其中的代码经过 DynamoRIO 的翻译**。

---

### 12.2.4 优化 Python-in-WASM 的启动时间

**当前状况**

原型 B 使用 wazero 运行编译为 WebAssembly 的 Python（CPython-WASM）。这个方案提供了最强的隔离，但有一个致命缺陷：

```
启动时间测量（原型 B，CPython-WASM in wazero）:

  冷启动（首次运行）: 1500-2000ms
  热启动（同一进程复用）: 500-800ms

  对比原生 Python 启动: 80-120ms

  问题: 对于评测系统，学生提交的每个程序都需要一次"冷启动"
  → 500ms 的固定开销对于运行 1ms 的算法题来说是 500× 的开销
```

**为什么这么慢？**

CPython-WASM 的启动过程：

```
启动序列（每次运行）:

  1. wazero 加载 WASM 模块（~20MB）: ~200ms
  2. CPython 初始化 Python 虚拟机: ~300ms
  3. 导入 site.py 等默认模块: ~500ms
  4. 用户代码开始执行: ←── 从这里才是"真正的运行"

  合计: ~1000-2000ms 固定开销
```

**改进方向：Snapshot + Restore**

V8 JavaScript 引擎使用了一种叫 **堆快照**（Heap Snapshot）的技术来加速启动：在初始化完成后，将整个 WASM/VM 状态序列化到磁盘，下次直接加载这个状态，跳过初始化过程。

```
优化后的流程:

  一次性准备（构建时/Lambda 初始化时）:
    启动 Python-WASM
    → 完成所有初始化（import sys, site, etc.）
    → 序列化 WASM 线性内存到文件（snapshot.bin）

  每次运行:
    从 snapshot.bin 恢复内存状态（~50ms）
    → 注入用户代码
    → 执行
    → 退出
```

wazero 目前没有内置快照支持，但 WASM 规范本身支持内存导入/导出，可以在应用层实现。这是一个有价值的工程研究课题。

---

### 12.2.5 io_uring 的安全处理

**什么是 io_uring？**

`io_uring` 是 Linux 5.1（2019 年）引入的新一代异步 I/O 接口，由 Linux 内核核心开发者 Jens Axboe 设计。它的设计思想是：**通过共享内存环形缓冲区，让用户空间和内核之间的 I/O 操作完全无需系统调用**。

```
传统 I/O 模型（每次 I/O 都需要 syscall）:

  用户程序 → read() syscall → 内核 → 数据 → 用户程序
            [切换到内核模式]       [切换回用户模式]

io_uring 模型:

  ┌───────────────────────────────────────────────┐
  │           共享内存（用户+内核都能访问）          │
  │                                               │
  │  提交队列 SQ: [read req][write req][...]      │
  │  完成队列 CQ: [result1 ][result2  ][...]      │
  └───────────────────────────────────────────────┘

  用户程序把请求写入 SQ →（无需 syscall！）→ 内核处理
  内核把结果写入 CQ →（用户程序轮询，无需 syscall）→ 完成

  对于高吞吐量服务，io_uring 可以将 I/O 吞吐量提升 2-3 倍
```

**io_uring 对沙箱的威胁**

io_uring 是 DynamoRIO 的噩梦，原因有三：

1. **大量操作不经过 syscall**：DynamoRIO 的钩子是在 `syscall` 指令层面工作的。如果操作完全不发出 `syscall`，钩子就没有机会拦截。

2. **操作集合极其丰富**：io_uring 不仅支持文件 I/O，还支持网络套接字、进程信号、`openat`、`mkdirat` 等大量操作。这意味着一个程序可以通过 io_uring 做几乎所有它想做的事，而完全绕过我们的 `open`/`connect` 等系统调用的拦截。

3. **内核版本碎片化**：io_uring 的功能集在不同内核版本间差异很大，安全策略很难保持一致性。

**当前处理方式**

Shimmy 目前直接阻断 `io_uring_setup` 系统调用：

```c
case SYS_io_uring_setup:
    DENY("io_uring not allowed in sandbox");
    break;
```

这是最简单最安全的选择，但代价是：任何依赖 io_uring 的现代异步框架（如 Rust 的 tokio 在某些配置下、某些版本的 liburing）将无法运行。

**未来的改进**

Linux 6.x 内核对 io_uring 做了大量安全加固，包括限制匿名环的使用、增加更细粒度的权限控制。随着内核演进，**有选择性地允许 io_uring 的只读操作**将成为可能。

研究方向：

```
io_uring 选择性允许策略:

  阻断:
    IORING_OP_CONNECT    → 网络连接，必须阻断
    IORING_OP_SOCKET     → 创建套接字，必须阻断
    IORING_OP_OPENAT     → 需要路径检查，复杂
    IORING_OP_MKDIRAT    → 文件系统修改，需要检查

  谨慎允许:
    IORING_OP_READ       → 如果 fd 已经过检查，可以允许
    IORING_OP_WRITE      → 同上
    IORING_OP_POLL_ADD   → 轮询，通常安全

  关键挑战:
    io_uring 的 SQE（提交队列条目）在共享内存中，
    DynamoRIO 无法拦截"写入 SQE"这个动作，
    只能拦截 io_uring_enter() 系统调用——
    但届时请求已经在队列里了，还需要检查队列内容。
```

这是一个活跃的安全研究领域，目前没有完美解决方案。

---

## 12.3 长期研究方向

### 什么叫"长期"？

这些方向可能需要 **博士级别的研究投入**，或者至少是多年的工程实践。它们不是你毕设需要完成的内容，而是 Shimmy 作为研究平台可以演化的空间。

---

### 12.3.1 DynamoRIO 系统调用策略的形式化验证

**什么是形式化验证（Formal Verification）？**

普通的软件测试是**经验性的**：我们运行一些测试案例，如果它们通过了，就认为系统可能正确。但测试无法穷举所有情况。

**形式化验证**是**数学性的**：通过数学证明，**在所有可能的执行路径上**，系统的某个属性成立。

```
测试 vs 形式化验证:

  测试:
    运行 1000 个恶意输入
    → 都被阻断了
    → 结论: "可能安全的"（置信度有限）

  形式化验证:
    定义属性 P: "不存在任何执行路径使得
                  危险系统调用（execve、connect 等）被实际执行"
    用数学工具证明 P 在所有输入下成立
    → 结论: "已证明安全的"（在模型假设范围内）
```

**Shimmy 的具体验证目标**

对于 Shimmy 的 DynamoRIO 策略，可以形式化验证的属性包括：

1. **不存在允许的系统调用序列导致 execve 被调用**
2. **不存在合法的文件路径字符串经过路径检查且指向沙箱外**
3. **fork 计数器在任何情况下不超过限制**

**适用工具**

| 工具 | 类型 | 适用场景 |
|------|------|---------|
| TLA+ | 模型检测 | 并发协议、状态机 |
| Coq | 定理证明 | 算法的数学正确性 |
| Lean 4 | 定理证明 | 编程语言研究 |
| CBMC | 有界模型检测 | C 代码的有界验证 |
| seL4 验证框架 | 完整系统验证 | 操作系统内核 |

对于 C 代码的 DynamoRIO 插件，最实际的起点是 **CBMC**（C Bounded Model Checker），它可以自动分析 C 函数，在有界的探索深度内验证断言。

```c
// 用 CBMC 验证路径检查函数的示例

#include <cbmc/cbmc.h>

// 验证目标: path_is_allowed() 永远不会对 /etc/passwd 返回 true
void verify_path_check(void) {
    char path[256];
    // __CPROVER_assume: CBMC 特殊指令，约束输入
    __CPROVER_assume(strcmp(path, "/etc/passwd") == 0);

    bool result = path_is_allowed(path);

    // __CPROVER_assert: CBMC 验证这个断言
    __CPROVER_assert(result == false,
                     "/etc/passwd should never be allowed");
}
```

这是学术界非常活跃的交叉领域（系统安全 + 形式方法），毕设将其作为"未来工作"提及，是非常有分量的学术定位。

---

### 12.3.2 QEMU 系统模式包装器：终极隔离方案

**回顾：原型 E 的问题**

第九章分析了原型 E（QEMU user-mode）的 5.3× 性能开销。但 QEMU 还有另一种模式：**系统模式**（system mode），它模拟一台完整的计算机，包括 CPU、内存、硬件设备。

```
QEMU 两种模式对比:

  User Mode（原型 E）:
  ┌─────────────────────────────────────────────┐
  │ Linux 主机内核                               │
  │  ┌────────────────────────────────────────┐ │
  │  │ QEMU user-mode                         │ │
  │  │   ┌─────────────────────────────────┐  │ │
  │  │   │ 被翻译的用户程序                  │  │ │
  │  │   └─────────────────────────────────┘  │ │
  │  │ 系统调用直接传递到主机内核（有问题！）   │ │
  │  └────────────────────────────────────────┘ │
  └─────────────────────────────────────────────┘

  System Mode（长期方案）:
  ┌─────────────────────────────────────────────┐
  │ Lambda 主机内核                              │
  │  ┌────────────────────────────────────────┐ │
  │  │ QEMU system-mode（完整虚拟机）           │ │
  │  │  ┌─────────────────────────────────┐   │ │
  │  │  │ Alpine Linux 最小化 Guest        │   │ │
  │  │  │  • 加固内核（无网络驱动）         │   │ │
  │  │  │  • EROFS 只读根文件系统           │   │ │
  │  │  │  • 用户程序在 Guest 内运行        │   │ │
  │  │  └─────────────────────────────────┘   │ │
  │  └────────────────────────────────────────┘ │
  └─────────────────────────────────────────────┘
```

**Alpine + EROFS 的组合**

- **Alpine Linux**：基于 musl libc 的极简 Linux 发行版，整个根文件系统只有 ~5MB
- **EROFS**（Extendable Read-Only File System）：Linux 5.4 引入的只读压缩文件系统，专为容器镜像设计，挂载后无法修改

这个组合的好处是：即使 Guest 内的程序获得了 root 权限，它也：
1. 无法修改根文件系统（EROFS 只读）
2. 无法进行网络通信（Guest 内核没有网络驱动）
3. 无法"看到"主机的任何文件（完全隔离的虚拟磁盘）
4. 无法逃出 QEMU（需要利用 QEMU 本身的 CVE）

**性能问题**

System mode 的开销比 user mode 还要大（当前 5.3× → 可能 10-20×），主要原因是：

- 每次 Guest 内核的系统调用都经过 QEMU 的设备模拟层
- 内存访问需要经过地址翻译（Guest 物理地址 → 主机虚拟地址）
- 设备 I/O 完全由软件模拟

不过，随着 KVM 加速（在 Firecracker 内部嵌套 KVM 目前不可用）和 TCG 优化的进展，这个开销有望逐步降低。

---

### 12.3.3 Shimmy Go SDK：沙箱即库

**当前接口**

目前 Shimmy 是一个 CLI 工具，调用方式是：

```bash
shimmy-sandbox run --backend=dynamorio --timeout=10s -- python3 user_code.py
```

这对评测系统来说不够灵活，每次调用都需要启动一个新进程。

**Go SDK 的设计**

长期目标是将 Shimmy 包装为一个 Go 库，提供高层次的 API：

```go
package main

import (
    "context"
    "fmt"
    shimmy "github.com/your-org/shimmy-go"
)

func main() {
    // 创建沙箱池（复用进程，减少冷启动开销）
    pool, _ := shimmy.NewSandboxPool(shimmy.Config{
        Backend:    shimmy.BackendDynamoRIO,
        PoolSize:   10,
        Timeout:    10 * time.Second,
        MemoryMB:   128,
    })
    defer pool.Close()

    // 提交代码执行
    result, err := pool.Run(context.Background(), shimmy.Job{
        Language: "python3",
        Code:     `print(sum(range(1, 101)))`,
        Stdin:    "5050\n",
    })

    fmt.Printf("stdout: %s\nexitCode: %d\n",
               result.Stdout, result.ExitCode)
}
```

关键技术挑战：**沙箱池的生命周期管理**。被沙箱的进程执行完一段代码后，其内部状态可能已被污染（全局变量、文件描述符等）。如何安全地"重置"一个沙箱进程以供下一次使用？

两种方案：
1. **进程复用 + 状态重置**：利用 Python 的 `importlib` 重置模块状态（困难，可能不完整）
2. **进程池预热**：保持一批"干净"的进程待命，每次使用后丢弃，从池中取新的（实现简单，内存开销大）

---

### 12.3.4 自动策略合成：ML 辅助的系统调用白名单生成

**问题背景**

Shimmy 的系统调用白名单是手工维护的：

```c
// 当前手工白名单（部分）
static const int allowed_syscalls[] = {
    SYS_read, SYS_write, SYS_mmap, SYS_brk,
    SYS_futex, SYS_clock_gettime, SYS_exit_group,
    // ... 手工逐个添加
};
```

问题：不同语言、不同版本的运行时需要不同的系统调用集合。Python 3.12 可能使用了 Python 3.10 没有使用的系统调用。手工维护这个列表既费力又容易出错。

**自动策略合成的思路**

```
自动生成方法:

  方法一：静态分析（保守）
    分析 Python 解释器二进制及其所有动态库
    找出所有可能发出的系统调用
    生成包含所有这些调用的白名单
    → 白名单可能过于宽松（包含从未实际用到的调用）

  方法二：动态分析（精确但不完整）
    用 strace 运行大量典型 Python 程序，收集实际系统调用
    统计每种调用的出现频率
    生成覆盖 99% 测试案例的最小白名单
    → 可能遗漏罕见但合法的调用

  方法三：ML 辅助（研究前沿）
    训练一个分类器，输入: 程序类型/语言/框架
    输出: 预测需要的系统调用集合
    结合人工审查和动态验证
    → 自动适应新语言和运行时版本
```

实际上，Docker 的 **seccomp 配置文件**就是这个思路的工业实践：Docker 官方维护一份 [默认 seccomp 配置](https://github.com/moby/moby/blob/master/profiles/seccomp/default.json)，通过分析大量容器的实际需求生成。

---

### 12.3.5 跨架构支持：AArch64 Lambda

**背景**

AWS 在 2021 年为 Lambda 引入了 **Graviton2 处理器**（ARM64/AArch64 架构），并提供 20% 的价格优惠。许多 Lambda 用户正在将函数迁移到 ARM64 以节省成本。

DynamoRIO 支持 AArch64，但与 x86-64 支持的成熟度存在差距：

```
DynamoRIO 架构支持对比（截至 2025）:

  x86-64:   成熟，经过大量测试，文档完整
  AArch64:  基本功能可用，部分边缘情况未处理
              - 某些系统调用号与 x86-64 不同（需要完整的映射表）
              - JIT 代码翻译的某些指令模式有已知 bug
              - 缺乏 AArch64 特有的安全特性支持（如 PAC、BTI）
```

**AArch64 特有的安全特性**

ARM64 有一些 x86-64 没有的硬件安全特性：

- **PAC（Pointer Authentication Codes）**：在指针中嵌入加密签名，防止 ROP（Return-Oriented Programming）攻击
- **BTI（Branch Target Identification）**：限制间接跳转的目标，防止 JOP（Jump-Oriented Programming）攻击
- **MTE（Memory Tagging Extension）**：为每块内存分配一个标签，防止 use-after-free 和缓冲区溢出

在 AArch64 Lambda 上运行 DynamoRIO 时，这些特性与 JIT 引擎的交互是一个有价值的研究课题。

---

## 12.4 行业趋势与展望

这一节从更广阔的视角看沙箱技术的发展方向，将 Shimmy 放在整个行业的坐标系中定位。

### 12.4.1 WebAssembly System Interface（WASI Preview 2）

**什么是 WASI？**

WebAssembly 最初是为浏览器设计的：浏览器提供 WASM 运行时，WASM 模块无法直接访问文件系统或网络。

但在服务器端，程序需要读取文件、建立网络连接。**WASI**（WebAssembly System Interface）是 WebAssembly 在服务器端的标准 API，相当于 WASM 版本的 POSIX：

```
WASI 的设计哲学: 能力模型（Capability Model）

  传统 POSIX:
    进程生来拥有访问整个文件系统的能力
    安全性靠后来的权限检查（read/write位、DAC）

  WASI Capability Model:
    进程生来什么能力都没有
    宿主（runtime）向 WASM 模块"授予"特定资源的访问能力
    例如: "我给你一个指向 /tmp/sandbox/ 的目录句柄，
           你只能在这个目录范围内操作"
```

**WASI Preview 2 的改进**

WASI Preview 2（2024 年稳定）引入了 **组件模型**（Component Model），这是一个革命性的变化：

```
WASI Preview 1（旧）:
  每个 WASM 模块是一个独立的二进制黑盒
  模块间通信只能通过共享内存（不安全，容易犯错）

WASI Preview 2（新）:
  WASM 模块被定义为"组件"（Components）
  每个组件有明确的接口定义（WIT - WebAssembly Interface Types）
  组件可以安全地互相调用，类型系统保证边界安全

  例子:
  ┌─────────────────────────────────────────────────────┐
  │  用户代码组件（Component A）                         │
  │    import: filesystem: wasi:filesystem/types@0.2.0  │
  │    export: run: func() -> string                    │
  └──────────────────┬──────────────────────────────────┘
                     │ 只能通过接口交互
  ┌──────────────────▼──────────────────────────────────┐
  │  沙箱运行时组件（Component B）                       │
  │    implement: filesystem（受限制的版本）              │
  │    → 只允许访问 /tmp/sandbox/                        │
  └─────────────────────────────────────────────────────┘
```

**对 Shimmy 的影响**

WASI Preview 2 成熟后，原型 B（WASM 方案）的语言支持将显著改善。目前将 Python 编译为 WASM 需要大量 hack，但随着 WASI 标准化，更多语言会有官方支持的 WASM 目标。

---

### 12.4.2 eBPF LSM：可编程的内核安全策略

**什么是 eBPF？**

**eBPF**（extended Berkeley Packet Filter）是 Linux 内核中的一个虚拟机，允许用户在不修改内核代码、不加载内核模块的情况下，向内核注入小型、经过验证的程序。

```
eBPF 的执行模型:

  用户编写 eBPF 程序（类似 C 语言的受限子集）
              │
              ▼
  编译为 eBPF 字节码
              │
              ▼
  通过 bpf() 系统调用加载到内核
              │
              ▼
  内核验证器（Verifier）检查:
    • 没有无限循环（保证终止）
    • 没有越界内存访问
    • 没有未初始化的变量
    → 如果验证通过，允许加载
              │
              ▼
  JIT 编译为原生机器码（高性能）
              │
              ▼
  挂载到内核的"钩子点"（如网络包接收、系统调用入口等）
```

**eBPF LSM（Linux 5.7+）**

**LSM**（Linux Security Module）是 Linux 内核的安全框架，SELinux、AppArmor 都是 LSM 的实现。

eBPF LSM 允许通过 eBPF 程序实现安全策略，无需编写内核模块：

```c
// eBPF LSM 程序示例（使用 libbpf）
// 这段代码在内核中运行，拦截文件打开操作

SEC("lsm/file_open")
int BPF_PROG(restrict_file_open, struct file *file) {
    struct task_struct *task = bpf_get_current_task_btf();
    u32 pid = BPF_CORE_READ(task, pid);

    // 检查是否是被沙箱的进程（通过 cgroup 标记）
    if (!is_sandboxed_pid(pid)) {
        return 0; // 非沙箱进程，允许
    }

    // 获取文件路径
    char path[256];
    bpf_d_path(&file->f_path, path, sizeof(path));

    // 检查路径是否在沙箱目录内
    if (!path_starts_with(path, "/tmp/sandbox/")) {
        return -EPERM; // 拒绝！
    }

    return 0; // 允许
}
```

**eBPF LSM vs DynamoRIO**

| 维度 | DynamoRIO（当前）| eBPF LSM |
|------|-----------------|---------|
| 运行位置 | 用户空间（进程内） | 内核空间 |
| 可绕过性 | 原始 syscall 可绕过 | **不可绕过**（在系统调用进入内核后执行） |
| 需要特权 | 不需要 | 需要 CAP_BPF（通常需要 root）|
| 性能开销 | ~67%（翻译开销）| ~5-15%（内核直接执行）|
| 可见性 | 用户空间指令级 | 内核对象级（task、file、socket）|
| Lambda 可用性 | 现在可用 | **不可用**（Lambda 不允许加载 eBPF）|

eBPF LSM 是**理论上更强**的方案，但在 Lambda 的受限环境中无法使用。这是一个典型的"最优解与可行解不重合"的工程困境。

---

### 12.4.3 机密计算（Confidential Computing）

**什么是机密计算？**

传统云计算的信任模型：云服务商可以访问你的数据（从技术上讲）。**机密计算**（Confidential Computing）通过硬件机制，让云服务商也无法读取运行中程序的内存：

```
普通云计算:
  ┌────────────────────────────────────────────┐
  │ 云服务商管理的物理服务器                    │
  │  ┌──────────────────────────────────────┐  │
  │  │ Hypervisor（VMware, KVM 等）         │  │
  │  │  ┌──────────────────────────────┐   │  │
  │  │  │ 你的虚拟机/容器               │   │  │
  │  │  │  你的数据（明文）             │   │  │
  │  │  └──────────────────────────────┘   │  │
  │  │ Hypervisor 可以读取 VM 内存！        │  │
  │  └──────────────────────────────────────┘  │
  └────────────────────────────────────────────┘

机密计算（AMD SEV / Intel TDX）:
  ┌────────────────────────────────────────────┐
  │ 物理服务器                                  │
  │  ┌──────────────────────────────────────┐  │
  │  │ Hypervisor                            │  │
  │  │  ┌──────────────────────────────┐   │  │
  │  │  │ 可信执行环境（TEE）           │   │  │
  │  │  │  你的数据（CPU 硬件加密）     │   │  │
  │  │  │  Hypervisor 看到的是密文！   │   │  │
  │  │  └──────────────────────────────┘   │  │
  │  └──────────────────────────────────────┘  │
  └────────────────────────────────────────────┘
```

**AMD SEV（Secure Encrypted Virtualization）**：AMD EPYC 处理器支持，每个虚拟机的内存由硬件加密，Hypervisor 无法读取。

**Intel TDX（Trust Domain Extensions）**：Intel 的类似技术，提供"可信域"（TD）的隔离。

**与沙箱的关系**

机密计算解决的是**隐私**问题（防止云服务商偷看数据），而 Shimmy 解决的是**安全**问题（防止不受信任的代码破坏环境）。这是两个正交的问题：

```
未来的多租户代码执行平台可能需要同时满足:

  隐私: 用户 A 的代码逻辑和数据，用户 B 和平台方都看不到
       → 机密计算（AMD SEV / Intel TDX）

  安全: 用户 A 的代码不能破坏平台或访问用户 B 的数据
       → 沙箱技术（Shimmy, gVisor, Firecracker）

  两者结合: 隔离 + 加密的可信执行环境
```

---

### 12.4.4 Wasm 组件模型：沙箱模块间的安全互操作

**问题**：现有的 WASM 沙箱是"孤岛"——每个模块与外部世界的交互完全由宿主 API 控制，但模块间如何安全地互相调用？

**Wasm 组件模型**（Component Model）定义了一套类型系统，使不同语言编写的 WASM 模块可以安全互操作：

```
传统方式（函数调用跨越模块边界）:
  模块 A (Rust) → 调用 模块 B (Python/WASM)
  问题: 需要共享内存，类型不匹配，容易犯错

组件模型方式:
  定义接口（WIT 语言）:
    interface compute {
        run: func(input: string) -> result<string, string>
    }

  Rust 组件实现这个接口
  Python 组件也实现这个接口
  宿主只暴露这个接口给调用方
  → 类型安全，无需共享内存，语言无关
```

对于代码评测系统，这意味着可以构建**插件化的评测器**：每种语言的评测逻辑是一个独立的 WASM 组件，通过标准接口与核心系统交互，且相互隔离。

---

### 12.4.5 io_uring 的安全演进

如 12.2.5 所述，io_uring 是当前的一个棘手问题。但 Linux 内核社区正在积极改进：

```
io_uring 安全改进时间线:

  Linux 5.1 (2019): io_uring 引入
  Linux 5.10:       修复多个内核态漏洞（CVE-2021-xxxx 系列）
  Linux 6.0:        限制无特权用户的 io_uring 使用范围
  Linux 6.1:        io_uring 与 seccomp 的集成改善
  Linux 6.6+:       对某些 io_uring 操作实施更细粒度的 LSM 钩子

最终目标（尚未实现）:
  每个 io_uring 操作都有对应的 LSM 钩子
  → 可以用 eBPF LSM 精确控制 io_uring 的每个操作
  → 沙箱可以选择性允许 io_uring 的只读操作
```

随着内核演进，io_uring 的安全使用将成为可能。**密切跟踪内核版本和 LSM 钩子覆盖范围**是未来维护 Shimmy 的重要任务。

---

## 12.5 对你的毕设的建议

### 12.5.1 在剩余时间内应该做什么

现在到毕设提交还有有限的时间。以下是优先级排序的建议：

```
优先级矩阵（影响力 vs 实现难度）:

  高影响力，低难度（立即做）:
  ✓ 修复路径规范化（symlink escape）
    → 换用 realpath() + 边界检查
    → 预计 1-2 天工作量
    → 显著提升安全性

  ✓ 校准 rlimits 与 DynamoRIO 开销
    → 测量 DynamoRIO 基础消耗，调整配额
    → 预计 0.5 天工作量

  高影响力，中等难度（如果有时间）:
  ✓ mprotect(PROT_EXEC) + 强制重翻译
    → 实现 post-syscall hook
    → 预计 3-5 天工作量
    → 关闭 JIT shellcode 攻击面

  低影响力，任意难度（放到"未来工作"）:
  ✗ io_uring 选择性允许
  ✗ Landlock 集成（内核版本不满足）
  ✗ 形式化验证
```

**最重要的一条建议**：在 **真实的 Lambda 环境**上运行完整的测试套件，并记录结果。CI 数据 ≠ 生产数据，评委会问这个问题。

---

### 12.5.2 如何向导师汇报

向导师展示进展时，有几个值得特别强调的亮点：

**1. 技术深度**

```
重点展示:
  • DynamoRIO 插件的机器码级 syscall 拦截机制
  • 为什么这比 seccomp 更难实现，以及换来了什么优势
    （seccomp 无法做路径重映射，DynamoRIO 可以）
  • 五种原型的对比分析——展示你不是只想到了一个方案
```

**2. 诚实的安全评估**

```
重点展示:
  • 已知的三个安全缺陷（raw syscall bypass, mmap, symlinks）
  • 对这些缺陷的攻击难度分析（不是"我们有 bug"，而是"攻击者需要做到 X 才能利用"）
  • 与学术文献的对比（引用 Osterlund 等人关于 DBI 沙箱的论文）
```

**3. 实际测量数据**

```
重点展示:
  • 基准测试数字（+67% 开销）及其解释
  • 为什么 +67% 在评测系统中是可接受的（有裕量）
  • DynamoRIO vs QEMU 的对比（你选择了正确的方案）
```

**4. 未来工作的铺垫**

导师会问"如果继续做，你会怎么做？"。本章给了你完整的答案，按优先级从近期到长期娓娓道来，这体现了你对整个领域的深度理解。

---

### 12.5.3 如何框架你的贡献

毕设论文的贡献声明需要谨慎措辞——既不能过度声明（夸大原创性），也不能欠声明（埋没真实工作）。

::: tip 贡献声明模板

**本文的主要贡献如下**：

1. **系统性比较研究**：在 AWS Lambda 的受限执行环境下，系统地评估了五类沙箱方案（rlimits、WASM、JS 引擎、DBI、全系统模拟）的安全性与性能权衡，填补了现有文献缺乏 Lambda 特定环境分析的空白。

2. **DynamoRIO 插件实现**：设计并实现了一个用于生产环境代码评测的 DynamoRIO 系统调用拦截插件（`shimmy_client.so`），支持路径白名单、进程计数器、网络阻断等安全策略，在 GitHub Actions 环境下测得 +67% 的运行时开销。

3. **多后端统一框架**：实现了 Go 语言协调层（`shimmy-sandbox`），通过统一接口抽象不同沙箱后端，允许在不修改上层调用代码的情况下切换安全策略。

4. **安全分析与威胁建模**：对实现进行了系统的威胁建模，识别了三类已知的绕过向量（原始系统调用、动态代码生成、符号链接逃逸），并分析了改进路径。

:::

::: warning 避免的措辞
不要写"本文首次提出了在 Lambda 中使用 DynamoRIO 进行沙箱"——DynamoRIO 用于沙箱的思路并不新颖。正确的框架是**这个特定应用场景的系统设计与实测分析**是原创的。
:::

---

### 12.5.4 一个给自己的诚实评估

回顾整个项目，下表总结了 Shimmy Sandbox 在各维度上的表现：

| 维度 | 目标 | 实际结果 | 评价 |
|------|------|---------|------|
| 安全性 | 阻断所有危险 syscall | 阻断大多数，有已知 bypass | 良好，诚实 |
| 性能 | < 2× 开销 | +67%（即 1.67×） | 达标 |
| 语言覆盖 | Python, C, C++ | 所有原生二进制 | 超出预期 |
| 部署复杂度 | Lambda 可部署 | 可部署，但需要 Lambda Layer | 基本达标 |
| 代码质量 | 可维护 | 有技术债（rlimits 未校准等）| 需改进 |
| 测试覆盖 | 生产环境验证 | 仅 GitHub Actions CI | 待改进 |

**最重要的一条**：Shimmy Sandbox 证明了在 AWS Lambda 这个受限平台上实现机器码级系统调用拦截是**可行的**，性能开销是**可接受的**。这个结论是有实测数据支撑的，具有实际意义。

---

## 12.6 结语：沙箱安全是一场持续的对抗

这份文档从第一章的"什么是程序"开始，一路走到了形式化验证和机密计算。让我们在结尾处退一步，思考这一切的意义。

```
沙箱技术的本质矛盾:

  我们希望程序能够:    我们同时希望程序:
  ──────────────────────────────────────────
  运行任意代码         不能破坏系统
  使用系统资源         使用有限的资源
  尽可能快地执行       承受安全检查的开销
  支持所有库和框架     只使用安全的接口
  对用户透明运行       受到严密的监控
```

这个矛盾无法被完全消解，只能不断地在各维度上做出更好的权衡。DynamoRIO 是 2025 年在 Lambda 这个特定约束下的最佳实践点——但随着 Landlock 的可用、WASI 的成熟、eBPF LSM 的发展，这个最佳点会持续移动。

沙箱安全是**一场持续的对抗**，而不是一个可以被"解决"的问题。Shimmy Sandbox 是这场对抗中的一个诚实的尝试：清楚地知道自己保护了什么，也清楚地知道自己的边界在哪里。

这种清醒的工程判断，比任何单一的技术选择都更有价值。

---

::: info 全文索引
本文档各章节的内容索引：

- 第 1-3 章：基础概念（程序、Linux、系统调用）
- 第 4-5 章：威胁模型与传统沙箱方法
- 第 6 章：AWS Lambda 与 Firecracker 架构
- 第 7-8 章：二进制插桩与 DynamoRIO 深度剖析
- 第 9-10 章：五种原型设计与 Shimmy 系统架构
- 第 11 章：基准测试分析
- **第 12 章：未来方向与研究展望**（当前章节）
:::

---

*本章完。感谢你读完整份文档。*
