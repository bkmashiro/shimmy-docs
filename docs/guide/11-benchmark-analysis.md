# 第十一章：基准测试分析

> 本章深入解读 Shimmy Sandbox 的基准测试数据，理解数字背后的含义，并将其与学术文献和生产环境的实际需求对照。

## 11.1 理解"开销"的含义

在讨论性能数据之前，先建立共同的语言。

### 什么是执行开销（Overhead）

**开销**（overhead）是沙箱化带来的额外时间消耗，用相对于基准（原生执行）的百分比表示。

```
计算公式:
  开销 = (沙箱时间 - 原生时间) / 原生时间 × 100%

例子:
  原生执行: 100ms
  沙箱执行: 167ms
  开销 = (167 - 100) / 100 × 100% = 67%

另一种表述:
  67% 开销 ≠ 2 倍慢
  2× 慢（倍率）= 100% 开销

注意区分:
  +67% 开销 → 1.67× 慢（原来 1 秒，现在 1.67 秒）
  +100% 开销 → 2× 慢（原来 1 秒，现在 2 秒）
  +433% 开销 → 5.33× 慢（原来 1 秒，现在 5.33 秒）
```

### 不同视角下的开销影响

```
场景分析: 学生代码原生执行 1 秒

评测系统的时间限制通常是: 原生时间 × 2~3（安全裕量）
如果原生时间 1s，评测时限通常是 3s

沙箱后:
  Proto A (rlimits):   1.000s → 时间限制 3s → 通过（97% 余量）✓
  Proto C (Goja):     +290μs → 1.000s → 几乎不影响 ✓
  Proto D (DynamoRIO): 1.67s → 时间限制 3s → 仍然通过（44% 余量）✓
  Proto E (QEMU):      5.33s → 时间限制 3s → 超时！✗

→ DynamoRIO 的 +67% 开销在时限有合理裕量的情况下完全可接受
→ QEMU 的 5.33× 开销使得许多合法程序都会超时
```

## 11.2 测试环境分析：GitHub Actions vs Lambda vCPU

Shimmy Sandbox 的基准测试在 **GitHub Actions** 上进行，测量到 DynamoRIO 开销为 **+67%**。但这个数字可能不代表生产环境的实际性能。

### GitHub Actions 的性能特点

GitHub Actions 的 runner 是共享的虚拟机：

```
GitHub Actions Runner:
• 托管在 Azure 虚拟机上（通常是 Standard_D4s_v3）
• 4 个 vCPU（共享的，与其他用户竞争）
• 内存：16GB
• 调度器噪音：高（多个 runner 共享物理核心）
• 上下文切换频率：高（CI 工作负载多样且频繁）

Lambda vCPU（生产环境）:
• 专用 Firecracker 微虚拟机
• 独立物理核心（配置为 128MB Lambda 时约 0.08 vCPU，但独占）
• 内存：128-10240MB（根据配置）
• 调度器噪音：低（微虚拟机隔离）
• 上下文切换频率：低（单函数运行）
```

### 调度器噪音对 DynamoRIO 的影响

DynamoRIO 的代码缓存是**热敏感**（cache-sensitive）的：

```
代码缓存工作方式:
  第一次执行某个基本块 → 翻译（慢）→ 存入缓存
  后续执行 → 直接从缓存取（快）

缓存大小: 约 32MB（L3 Cache 通常 8-32MB）

GitHub Actions（高调度器噪音）:
  进程被频繁抢占 → 上下文切换 → L3 Cache 被其他进程污染
  → DynamoRIO 代码缓存命中率下降
  → 更多翻译需求 → 更高开销

Lambda vCPU（低调度器噪音）:
  进程几乎不被抢占（Lambda 函数通常独占）
  → DynamoRIO 代码缓存保持热状态
  → 更高命中率 → 更低开销
```

**保守估计**：在 Lambda 的专用核心上，DynamoRIO 开销约为 **+20-30%**（与 DBI 学术文献一致）。

## 11.3 与学术文献的对比

### seccomp-bpf 的开销

学术文献数据（来自多篇论文的综合）：

```
seccomp-bpf 开销: ~5%
原因: BPF 程序在内核中执行，在 CPU 的快速路径上
    系统调用本身也有进入/退出内核的开销（约 100-300ns）
    seccomp 增加的 BPF 执行开销约为 5-15ns
    相对于整个系统调用开销（100-300ns），增加约 5%

参考:
• Ghavamnia et al., "Confine: Automated System Call Policy..." (RAID 2020)
• Shu et al., "Designing New Operating Primitives to Improve Fuzzing..." (CCS 2017)
```

### ptrace 的开销

```
ptrace 开销: ~900-1000%（约 10× 慢）
原因: 每次系统调用需要:
    1. 暂停子进程（1 次 CPU 上下文切换）
    2. 切换到父进程（调度切换）
    3. 父进程读取子进程状态（ptrace 系统调用本身）
    4. 父进程决策（可能修改寄存器）
    5. 切换回子进程
    
    每个系统调用 = 2 次上下文切换 + 额外系统调用开销
    典型系统调用: 100ns → ptrace 模式下: 1000-3000ns

参考:
• Jain et al., "Container Security" (2020)
• Watanabe et al., "Comparing Linux Sandboxes..." (IEICE 2019)
```

### DBI 框架的开销

```
DBI 框架开销（一般文献）: 10-100%

DynamoRIO 具体数据:
• 纯计算密集型（无 syscall）: ~5-10%
  （代码缓存命中率高，翻译本身的摊销开销低）
• 混合负载（计算 + 适量 syscall）: ~20-30%
• I/O 密集型（频繁 syscall）: ~50-70%
  （每个 syscall 触发 pre_syscall 回调，增加 Go/C 切换开销）

Shimmy 实测（GitHub Actions）: +67%
  → 处于 "I/O 密集" 范围，合理
  → Python 启动时有大量文件 I/O（import 标准库）

参考:
• Bruening, "Efficient, Transparent, and Comprehensive Runtime Code Manipulation" (MIT PhD, 2004)
• Luk et al., "Pin: Building Customized Program Analysis Tools..." (PLDI 2005)
```

### 开销对比总结

```
机制                  开销      在 Lambda 可用
──────────────────────────────────────────────────
rlimits              ~0%       ✓
LD_PRELOAD           ~0%       ✓（但覆盖不全）
seccomp-bpf          ~5%       ✗（EPERM）
Goja（JS）           +290μs    ✓
DynamoRIO            ~20-30%   ✓（预计生产环境）
DynamoRIO            +67%      ✓（GitHub Actions，噪音）
ptrace               ~900%     ✗（EPERM）
QEMU user-mode       +433%     ✓（但不安全）
VM（完整虚拟机）     ~10%      ✗（嵌套虚拟化不可用）
WASM (wazero)        <1ms      ✓（需预编译）
```

## 11.4 49/49 测试结果的深入解读

Shimmy Sandbox 的测试套件包含 49 个测试用例，覆盖 26 种攻击类型。

### 测试套件的结构

```
测试分类                      数量  说明
──────────────────────────────────────────────────────────
资源耗尽攻击测试               6    CPU/内存/fork/fd/磁盘/线程
文件系统攻击测试               7    各种敏感路径读取
进程逃逸测试                   5    execve/daemonize/setsid等
网络攻击测试                   5    socket/connect/DNS外泄等
高级绕过测试（inline asm等）   4    inline syscall/static binary
特殊机制测试（io_uring等）     3    io_uring/mmap+exec
功能性测试（合法代码）         19   确保正常代码不被误伤
────────────────────────────────────────────────────────────
总计                           49
```

### 原型 A 的 49/49 含义

一个常见的误解：原型 A（仅 rlimits）也通过了 49/49，是否意味着它和 DynamoRIO 一样安全？

**答案：否。**

原型 A 的 49/49 是因为那 13 个 rlimits 无法防御的攻击（文件读取、网络连接等）在测试套件中被标记为 **SKIP**：

```
Proto A 测试结果详情:
  资源耗尽攻击: 6/6 PASS       ← rlimits 擅长的领域
  文件系统攻击: 7/7 SKIP       ← rlimits 防不住，所以跳过这些测试
  进程逃逸: 5/5 SKIP
  网络攻击: 5/5 SKIP
  高级绕过: 4/4 SKIP
  特殊机制: 3/3 SKIP
  功能性: 19/19 PASS

报告为: 49/49 通过（但实际上 36 个是 SKIP，不是 PASS）
```

**相比之下，Proto D（DynamoRIO）的 49/49**：
```
Proto D 测试结果详情:
  资源耗尽攻击: 6/6 PASS
  文件系统攻击: 7/7 PASS       ← 全部真正通过！
  进程逃逸: 5/5 PASS
  网络攻击: 5/5 PASS
  高级绕过: 4/4 PASS
  特殊机制: 3/3 PASS
  功能性: 19/19 PASS

报告为: 49/49 通过（其中 0 个 SKIP，全部真正通过）
```

这解释了为什么 Proto A 的测试数字看起来和 Proto D 一样好，但实际安全性差距极大。

### 原型 E 的 49/49 陷阱

原型 E（QEMU user-mode）也报告 49/49，但有另一个问题：**测试套件不包含检测文件系统隔离的测试**。

QEMU 的系统调用转发没有路径过滤，恶意代码可以直接读取 `/proc/self/environ`，但测试套件恰好没有测试这个攻击（因为 Proto E 的测试是在知道其局限的情况下设计的）。

**教训**：测试套件的通过率反映的是测试的质量，而不仅仅是系统的安全性。需要结合威胁模型理解测试结果的含义。

## 11.5 Goja 的 290μs：意义与局限

```
Goja 的 290μs 执行时间分解（典型 Hello World）:

  goja.New()（创建新运行时）:     ~100μs
    ├── 初始化 JS 全局对象:         ~50μs
    ├── 注册内置函数:               ~30μs
    └── 初始化 GC:                 ~20μs

  运行 Lockdown（删除危险对象）:  ~40μs
    └── vm.Set(各个对象 = undefined)

  vm.RunString(code)（执行代码）: ~150μs
    ├── 词法分析 + 语法分析:        ~80μs
    ├── 字节码生成:                 ~30μs
    └── 字节码解释执行:             ~40μs
  ───────────────────────────────────────
  总计: ~290μs

对比 Node.js 子进程:
  fork + exec:                   ~5-10ms
  Node.js 初始化（V8 + libuv）:  ~20-25ms
  JavaScript 解析执行:           ~1ms
  ───────────────────────────────────────
  总计: ~28-35ms（约 30ms）

速度比: 30ms / 290μs ≈ 103×（约 100 倍更快）
```

### Goja 的性能局限

Goja 的 1/20 V8 计算性能在某些场景下是个问题：

```python
# 计算密集型 JavaScript
code = """
// 计算 Fibonacci(40)
function fib(n) {
    if (n <= 1) return n;
    return fib(n-1) + fib(n-2);
}
console.log(fib(40));
"""

# V8 (Node.js): ~100ms
# Goja:         ~2000ms（20× 慢）

# 但对于算法题（通常不超过 fib(30) 规模的计算）:
# V8: ~1ms
# Goja: ~20ms
# 两者都在时间限制内
```

**结论**：对于典型的算法评测题（时间复杂度不超过 O(n²)，n≤10000），Goja 的计算性能完全够用。对于高度计算密集的场景（n=10^7 的数组排序），可能需要 Node.js + DynamoRIO 方案。

## 11.6 DynamoRIO 的 +67% 是否可接受

这是一个业务问题，不只是技术问题。让我们从评测系统的角度来看：

### 代码评测的时间限制设计

```
典型算法评测平台（LeetCode/Codeforces）的时间限制设计:

  测题者估算: 最优算法 100ms
  时间限制设置: 1000ms（10× 裕量）
  原因:
    - 不同语言的性能差异: Python 比 C++ 慢约 10-50×
    - 评测机调度噪音
    - 测试用例本身的运行时差异

Shimmy Sandbox 的场景（教学评测）:
  学生代码: O(n²) 排序，n=10000，原生约 100ms
  评测时限: 2-3 秒（教学用，较宽松）
  
  DynamoRIO 后: ~167ms（67% 开销）
  仍然远在 2-3 秒限制内 → 完全不影响评测结果

结论: +67% 的开销（+20-30% 在 Lambda 上）对于评测场景完全可接受
```

### 与人感知阈值对比

```
人类感知响应时间阈值:
  < 100ms: 感觉即时
  100ms - 1s: 感觉有轻微延迟
  1s - 10s: 可接受，明显等待
  > 10s: 需要进度指示器

Shimmy 的典型响应时间:
  正常学生代码: 原生 50-200ms → DynamoRIO 83-334ms
  全链路延迟（含 Lambda 调用）: ~500ms - 2s

用户体验: 在"有轻微延迟"到"可接受等待"范围内
  对于评测这样的批量异步任务（学生提交后等结果）: 完全可接受
```

## 11.7 具体基准数据表

以下是 Shimmy Sandbox 在 GitHub Actions 上实测的性能数据（处理器：Intel Xeon E5-2697 v2 @ 2.70GHz，Ubuntu 22.04，Python 3.11，DynamoRIO 10.x）：

```
测试程序: hello_world.py (print("Hello"))
───────────────────────────────────────────────────────
Backend      平均时间    P50     P95     P99     最大
Proto A      12ms        11ms    15ms    19ms    23ms
Proto D      20ms        19ms    25ms    31ms    38ms
开销         +67%

测试程序: fibonacci.py (fib(30))
───────────────────────────────────────────────────────
Backend      平均时间    P50     P95     开销
原生         45ms        44ms    51ms    -
Proto D      72ms        71ms    82ms    +60%

测试程序: file_io.py (写 1MB 文件，读回)
───────────────────────────────────────────────────────
Backend      平均时间    开销
原生         18ms        -
Proto D      30ms        +67%

测试程序: sorting.py (排序 10^5 个随机整数)
───────────────────────────────────────────────────────
Backend      平均时间    开销
原生         120ms       -
Proto D      195ms       +63%

JavaScript (Goja) vs Node.js
───────────────────────────────────────────────────────
测试          Goja      Node.js（子进程）  Goja 优势
Hello World   290μs     30ms              103× 快
Simple math   1.2ms     31ms              26× 快
fib(30)       8ms       33ms              4× 快（计算开销追上来了）
fib(40)       1600ms    112ms             14× 慢（Goja 计算慢）
```

**P50 / P95 / P99 的含义**：
- **P50**（第 50 百分位数，中位数）：50% 的请求比这快，50% 比这慢
- **P95**（第 95 百分位数）：95% 的请求比这快，只有 5% 比这慢
- **P99**：99% 的请求比这快，只有 1% 比这慢

高 P99 通常表示偶发的调度延迟（Linux 调度器把进程换出 CPU）或代码缓存冷 miss。

## 11.8 DynamoRIO 代码缓存的预热效应

```
第一次调用（冷启动，代码缓存为空）:
  每个基本块都需要翻译 → 高翻译开销
  Python 解释器约有 100,000+ 个基本块
  翻译开销集中在前 1-2 秒

后续调用（热启动，代码缓存已有 Python 解释器的翻译）:
  Lambda 暖启动：drrun 进程可能被复用
  但 DynamoRIO 的代码缓存随进程存在
  
  注意：Shimmy 每次调用都 fork 一个新的 drrun 进程
  → 每次调用都是"冷"代码缓存！
  → 每次调用都需要重新翻译 Python 解释器的代码

优化机会: 使用 DynamoRIO 的持久化代码缓存（pcache）功能
  drrun -persist_gen
  → 把翻译结果写入磁盘
  → 下次 drrun 直接加载，不需要重新翻译
  预计可节省 30-50% 的开销
  但增加了磁盘 I/O 和缓存失效管理的复杂性
```

## 11.9 26 种攻击向量的防御效果统计

```
按 Proto D 的防御效果分类:

完全阻断（攻击无任何效果）:
  • 所有文件读取类（/proc/self/environ, /etc/*）
  • 网络连接类（socket, connect）
  • 进程逃逸类（execve, setsid）
  • 高级绕过类（inline asm, io_uring）

有限制但不完全阻断（攻击受限但有影响）:
  • 资源耗尽类（rlimits 有时延，可能影响同一容器的其他调用）
  • 路径遍历（规范化后阻断，但性能开销存在）

被检测记录但允许（有监控）:
  • 频繁 fork（超过限制后阻断，前几次允许）
  • /dev/null, /dev/urandom（允许，属正常操作）

假阳性（合法代码被误拦截）:
  • 经测试：0 个误拦截（在测试套件中）
  • 已知限制：JIT 代码（mmap(PROT_EXEC)被阻断）
    影响: 在 DynamoRIO 下运行的 PyPy 或任何 JIT Python 无法使用 JIT
    解决: 使用 CPython（不使用 JIT）
```

## 11.10 总结：数字的完整含义

```
DynamoRIO (+67% GitHub Actions, ~+20-30% Lambda vCPU):
  ✓ 完全在学术文献的 DBI 开销范围内（10-100%）
  ✓ 对评测系统的时间限制设计（通常 10× 裕量）无实质影响
  ✓ GitHub Actions 的高调度器噪音使结果偏高
  ✓ Lambda 专用核心预计更接近 20-30%
  ? 需要在真实 Lambda 上验证（见第十二章）

Goja (290μs vs 30ms Node.js):
  ✓ 对 JavaScript 评测的响应延迟有显著改善（100× 快）
  ⚠ 计算密集型代码 Goja 是 V8 的 1/20，需要调整时间限制
  ✓ 进程内执行消除了进程创建开销（最大收益来源）

wazero (<1ms 暖启动):
  ✓ 一旦 WASM 模块编译完成，实例化极快
  ⚠ Python-WASI 冷启动 500ms+ 是实际障碍
  ✓ C/Rust 代码理论上可以达到最高安全性 + 低开销的组合

QEMU (+433%):
  ✗ 5.3× 慢在任何评测场景都不可接受
  ✗ 无文件系统隔离使其不适合安全场景
  → 仅适合研究和参考基线
```

**最终判断**：对于 Python/Go/Rust/C 等语言的代码评测，DynamoRIO 方案的 20-30%（预计生产）开销是完全可以接受的代价，换来的是覆盖所有 26 种攻击向量的全面防御。

下一章：未来的改进方向——Lambda 升级内核后如何利用 Landlock，以及其他尚未实现的优化。
