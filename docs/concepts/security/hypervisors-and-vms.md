# 虚拟机与 Hypervisor

**前置知识**：了解操作系统和进程的基本概念（指南第二章）；知道"特权级别"（Ring 0 / Ring 3）是什么意思有帮助。

**你将学到**：
- Type 1 vs Type 2 Hypervisor 的区别
- 硬件虚拟化：Intel VT-x / AMD-V 是什么，为什么它们很重要
- VM exit 是什么，为什么代价很高
- microVM：Firecracker 如何把 VM 启动时间压缩到 125ms
- KVM 和 QEMU 的关系
- 虚拟机的隔离优势与代价

---

## 1. 为什么需要虚拟机

想象你需要同时为 100 个不同客户运行代码：他们的代码可能互相攻击，可能有 bug，可能是恶意的。

最强的隔离方案：给每个客户一台**专属物理机**。

但这代价太高了。

虚拟机（Virtual Machine，VM）的出现解决了这个问题：在一台物理机上，**模拟**出多台"虚拟计算机"，每台虚拟计算机有自己的 CPU、内存、磁盘和网络，互相完全隔离。

> 💡 **虚拟机（Virtual Machine，VM）**
> 通过软件模拟的完整计算机系统，有自己的（虚拟）CPU、内存、I/O 设备。VM 里运行的操作系统（Guest OS）认为自己在真实硬件上运行，但实际上被 Hypervisor 管理和隔离。

类比：虚拟机就像电影《盗梦空间》里的"梦中梦"——在一台真实的电脑里，再运行一台"虚拟电脑"，虚拟电脑里的程序以为自己在操控真实硬件。

## 2. Hypervisor：虚拟机的管理者

**Hypervisor**（也叫 VMM，Virtual Machine Monitor）是管理虚拟机的软件，负责：
- 在多个 VM 之间分配物理 CPU、内存和 I/O 资源
- 拦截 VM 对硬件的访问，进行安全检查
- 保证一个 VM 不能影响另一个 VM

> 💡 **Hypervisor / VMM（Virtual Machine Monitor）**
> 管理多个虚拟机的软件层。它对每个 VM 提供"虚拟硬件"的抽象，同时控制 VM 对真实硬件的访问。

### 2.1 Type 1 Hypervisor（裸金属型）

**Type 1** Hypervisor 直接运行在物理硬件上，没有宿主操作系统：

```
物理硬件（CPU / 内存 / 磁盘 / 网卡）
         │
         ▼
  ┌─────────────────────────────────────────────────┐
  │              Type 1 Hypervisor                   │
  │         （直接运行在硬件上，权限最高）             │
  │  VMX root mode / EL2（ARM）                      │
  └─────────────────────────────────────────────────┘
         │              │              │
         ▼              ▼              ▼
    ┌────────┐     ┌────────┐     ┌────────┐
    │  VM 1  │     │  VM 2  │     │  VM 3  │
    │ Linux  │     │ Windows│     │ FreeBSD│
    └────────┘     └────────┘     └────────┘
```

**代表**：VMware ESXi、Microsoft Hyper-V、Xen、KVM（Linux 内核集成）

Type 1 的特点：
- 性能好（少一层软件）
- 稳定（宿主不受 Guest 影响）
- 用于数据中心、云计算（AWS、Azure、GCP 都是 Type 1）

### 2.2 Type 2 Hypervisor（托管型）

**Type 2** Hypervisor 运行在宿主操作系统之上，作为普通应用程序：

```
物理硬件
    │
    ▼
宿主操作系统（Host OS）
    │
    ▼
Type 2 Hypervisor（作为宿主 OS 的一个进程）
    │
    ▼
    ├── VM 1（Guest OS 1：Linux）
    └── VM 2（Guest OS 2：Windows）
```

**代表**：VirtualBox、VMware Workstation / Fusion、QEMU（无 KVM 时）

Type 2 的特点：
- 安装简单，适合开发者本机
- 性能比 Type 1 差（多一层）
- 宿主 OS 崩溃会影响所有 VM

### 2.3 KVM：模糊了 Type 1 / Type 2 的界限

**KVM**（Kernel-based Virtual Machine）是 Linux 内核的一个模块，把 Linux 内核本身变成了一个 Type 1 Hypervisor：

```
物理硬件
    │
    ▼
Linux 内核（包含 KVM 模块）
    │                │
    ▼                ▼
普通 Linux 进程   KVM 虚拟机（Guest OS）
（宿主程序）      （Linux/Windows/...）
```

KVM 的工作原理：
- KVM 利用 CPU 硬件虚拟化指令（Intel VT-x / AMD-V）
- `/dev/kvm` 是 KVM 提供的接口
- QEMU 通过 `/dev/kvm` 创建和管理 VM
- KVM 处理硬件层的虚拟化，QEMU 处理设备模拟

## 3. 硬件虚拟化：Intel VT-x / AMD-V

在没有硬件支持时，Hypervisor 必须用软件**模拟**每条 CPU 指令——这极其缓慢。

2005 年，Intel 和 AMD 同时推出了**硬件虚拟化扩展**，让 CPU 原生支持虚拟化，大幅降低开销。

> 💡 **Intel VT-x（Virtualization Technology for IA-32/64）/ AMD-V（AMD Virtualization）**
> CPU 硬件提供的虚拟化支持。它增加了新的特权级别，让 Guest OS 可以"直接"在 CPU 上运行（而不是被完全模拟），同时 Hypervisor 仍能保持控制。

### 3.1 VMX 模式

Intel VT-x 引入了两种新的 CPU 运行模式：

```
传统 Ring 层次：
  Ring 0：OS 内核（最高特权）
  Ring 3：用户程序（最低特权）

VT-x 新增：
  VMX root mode（非受限模式）：Hypervisor 运行在这里
    └── Ring 0：Hypervisor 内核
    └── Ring 3：Hypervisor 用户态（QEMU 进程）

  VMX non-root mode（受限模式）：Guest OS 运行在这里
    └── Ring 0：Guest OS 内核（Linux、Windows...）
    └── Ring 3：Guest 用户程序
```

关键点：**Guest OS 的内核（Ring 0）运行在 VMX non-root 模式**，它以为自己有完整的硬件控制权，但实际上被硬件虚拟化层"透明地"监控。

### 3.2 VMCS：虚拟机控制结构

**VMCS**（Virtual Machine Control Structure）是一块内存区域，存储 VM 的所有状态：Guest 的寄存器值、控制位、VM exit 的原因等。

```c
// Hypervisor 通过 VMLAUNCH / VMRESUME 指令进入 VM：
vmlaunch  // 首次进入 VM（从 VMCS 恢复 Guest 状态）
vmresume  // VM exit 后重新进入 VM

// VM exit 时，CPU 自动把 Guest 状态保存到 VMCS
// 并跳回 Hypervisor（VMX root mode）
```

## 4. VM Exit：代价最高的操作

**VM exit** 是 VM 从 Guest（VMX non-root）切回 Hypervisor（VMX root）的过程。

类比：VM exit 就像你在做梦时突然被叫醒——你需要时间"从梦境回到现实"，整理思路，处理一下现实的事情，然后再"入睡"继续梦境。

> 💡 **VM exit**
> Guest OS 执行了某个特权操作（如修改控制寄存器、访问硬件设备），CPU 自动中止 Guest 的执行，保存 Guest 状态，跳回 Hypervisor 处理。处理完后通过 `vmresume` 返回 Guest。

### 4.1 哪些操作触发 VM exit

```
触发 VM exit 的常见原因（可配置）：
  ├── I/O 操作（访问 I/O 端口）
  ├── 访问未虚拟化的 MSR（机器状态寄存器）
  ├── 修改 CR0/CR3/CR4（控制寄存器）
  ├── 执行 CPUID 指令（查询 CPU 信息）
  ├── 执行 HLT 指令（CPU 暂停）
  ├── 外部中断（定时器、网卡等）
  ├── APIC（高级可编程中断控制器）访问
  └── EPT violation（扩展页表缺页，类似缺页中断）
```

### 4.2 VM exit 的代价

一次 VM exit 的开销约为 **1000~10000 纳秒**（1~10 微秒），包括：

```
VM exit 的开销分解：

1. 保存 Guest 状态到 VMCS
   （所有通用寄存器 + 段寄存器 + 控制寄存器）
   → ~100 ns

2. 切换到 Hypervisor 的 TLB 上下文
   （如果没有 VPID，需要完全刷新 TLB）
   → ~200~500 ns

3. Hypervisor 处理 VM exit 原因
   （识别原因 + 执行相应处理）
   → ~200~500 ns

4. 返回 Guest（vmresume）
   → ~100~200 ns

总计：~600~1300 ns（情况好时）
      ~数千 ns（TLB 刷新严重时）
```

对比：一次正常的系统调用约需 100~300 ns。VM exit 比系统调用贵 3~30 倍。

### 4.3 减少 VM exit 的技术

- **VPID**（Virtual Processor Identifier）：给每个 VM 一个 ID，TLB 条目带 VPID 标记，VM exit 时无需完全刷新 TLB
- **EPT**（Extended Page Tables）：硬件辅助的 Guest 物理内存 → 主机物理内存的映射，减少内存访问时的 VM exit
- **APIC 虚拟化**：让 Guest 的 APIC 操作（最频繁的中断控制器访问）不触发 VM exit
- **最小化设备**：设备越少，触发 VM exit 的机会越少（这是 Firecracker 的核心思路）

## 5. QEMU vs KVM：分工合作

```
QEMU 负责：                    KVM 负责：
  - 设备模拟                     - CPU 虚拟化（利用 VT-x）
    （虚拟磁盘、网卡、显卡）       - 内存虚拟化（EPT）
  - VM 生命周期管理               - 处理 VM exit
  - 用户态的 VM exit 处理        - 提供 /dev/kvm 接口

         用户态                        内核态
┌───────────────────────┐    ┌──────────────────────────┐
│  QEMU 进程             │    │  Linux 内核 + KVM 模块    │
│                       │    │                          │
│  设备后端              │    │  CPU 虚拟化引擎           │
│  VM 控制逻辑           │◄──►│  内存虚拟化（EPT）        │
│  用户态 VM exit 处理   │    │  VM exit 分发            │
│                       │    │                          │
└───────────────────────┘    └──────────────────────────┘
             │                             │
             └─────── /dev/kvm ────────────┘
                      (ioctl 接口)
```

QEMU 通过 `ioctl(/dev/kvm, KVM_RUN)` 启动 VM，KVM 让 Guest 在硬件上运行，VM exit 时返回 QEMU 处理。

## 6. Firecracker：125ms 启动的 microVM

**Firecracker** 是 AWS 开源的 microVM 项目，为 Lambda 和 Fargate 等无服务器产品服务。

> 💡 **microVM**
> 一种极度精简的虚拟机，只包含运行无服务器函数所必需的最少硬件模拟。相比传统 VM（模拟上百种设备），microVM 只模拟几种核心设备，从而大幅减少启动时间和内存占用。

### 6.1 传统 VM 为什么启动慢

```
传统 VM（如 QEMU + KVM）启动过程：
  1. 初始化虚拟 BIOS / UEFI              ~1000 ms
  2. 枚举虚拟 PCI 总线（几十种设备）      ~500 ms
  3. 加载 Guest 操作系统内核              ~1000 ms
  4. 内核初始化（驱动、文件系统等）        ~2000 ms
  5. 用户态服务启动                       ~1000 ms
  ─────────────────────────────────────
  总计：~5000~10000 ms（5~10 秒）
```

### 6.2 Firecracker 的精简策略

```
Firecracker 的设计原则：去掉一切不必要的东西

只保留的设备：
  ├── 1~32 个 virtio-net（网络接口）
  ├── 1 个 virtio-block（磁盘）
  ├── 1 个 serial（串口，用于日志）
  └── KVM clock（时钟）

去掉的东西：
  ✗ BIOS / UEFI（直接跳到 Linux 内核入口）
  ✗ PCI 总线（不需要枚举数百个设备）
  ✗ USB、声卡、显卡、...（全部不需要）
  ✗ 传统 IDE/SATA 磁盘控制器
  ✗ VGA 显示（用 serial 代替）

安全约束：
  只允许 24 个系统调用（超级严格的 seccomp 过滤）
  不允许 snapshot/restore（减少攻击面）
  Rust 编写（内存安全语言）
```

### 6.3 Firecracker 的启动流程

```
Firecracker 启动过程（目标 < 150ms）：

  0ms: Firecracker 进程启动
  10ms: KVM 初始化，设置 vCPU
  20ms: 配置 virtio 设备（只有 3~4 个）
  30ms: 加载 Linux 内核镜像到 Guest 内存
  40ms: 设置 Guest 内存（EPT 映射）
  50ms: KVM_RUN：Guest 开始执行
  50~125ms: Linux 内核极简初始化
    - 只初始化 Firecracker 提供的设备驱动
    - 无 ACPI 表解析
    - 无 PCI 设备探测
  125ms: 用户态可以开始执行函数
```

2018 年 AWS 论文（Firecracker NSDI 2020）报告的数据：
- **创建 VM 时间**：< 125 ms（包括内核启动）
- **内存占用**：每个 VM 约 5MB（不含 Guest OS 和用户代码）
- **密度**：单台服务器可运行 **4000+** Firecracker VM

### 6.4 Firecracker 的安全设计

```
Firecracker 的安全模型（纵深防御）：

                      互联网请求
                          │
                          ▼
                  负载均衡 / API 网关
                          │
                          ▼
                 Firecracker 进程
               （被严格 seccomp 过滤：只允许 24 个 syscall）
                          │
                          ▼ KVM_RUN
              ┌────────────────────────────┐
              │     Guest VM（用户代码）   │
              │  Linux + 用户 Lambda 函数  │
              └────────────────────────────┘
                          │ VM exit
                          ▼
              Firecracker 处理（严格检查）
                          │
                          ▼
              真实硬件（通过 KVM）

攻击者要逃逸，必须同时突破：
  1. Guest OS 内核漏洞
  2. KVM hypervisor 漏洞
  3. Firecracker 本身的处理逻辑
  3 层防御，攻击面极小
```

## 7. 虚拟机的隔离优势

### 7.1 为什么 VM 隔离比容器强

```
容器（Docker）隔离：
  ┌────────────────────────────────────────┐
  │         宿主机 Linux 内核              │
  │  ┌─────────┐     ┌─────────┐          │
  │  │  容器 A  │     │  容器 B  │          │
  │  │ namespace│     │ namespace│          │
  │  │  cgroup  │     │  cgroup  │          │
  └──└─────────┘─────└─────────┘──────────┘
                  共享同一个内核！
  → 如果内核有漏洞，攻击者可以从容器逃逸到宿主机

VM 隔离：
  ┌────────────────────────────────────────┐
  │    宿主机内核（Host OS + KVM）          │
  │  ┌─────────────┐  ┌─────────────┐     │
  │  │    VM A     │  │    VM B     │     │
  │  │  Guest OS A │  │  Guest OS B │     │
  │  │  用户代码   │  │  用户代码   │     │
  └──└─────────────┘──└─────────────┘─────┘
                  不共享内核！
  → 攻击者必须突破 Guest OS + KVM + Host OS 三层
```

### 7.2 VM 逃逸的攻击面

VM 之间的攻击面主要来自以下几个路径：

```
VM 逃逸的可能路径：

  Guest 用户代码
    │ 漏洞
    ▼
  Guest 内核（Ring 0 in VMX non-root）
    │ VM exit
    ▼
  Hypervisor 处理逻辑
    │ 漏洞（历史案例：VENOM 漏洞，CVE-2015-3456）
    ▼
  Host 内核（Ring 0 in VMX root）
    │ 成功逃逸！

VENOM（CVE-2015-3456）：
  QEMU 的虚拟软盘控制器（FDC）有缓冲区溢出
  攻击者在 Guest 里向软盘控制器发送特制命令
  → 堆溢出 → 代码执行 → 逃逸到 Host
  → 修复：删除 FDC 模拟代码（Firecracker 根本没有 FDC）
```

Firecracker 的 "最小化设备" 策略直接消灭了这类攻击面：没有 FDC，就没有 FDC 漏洞。

## 小结

```
Type 1 Hypervisor：直接在硬件上运行（ESXi、KVM、Xen）
Type 2 Hypervisor：运行在宿主 OS 上（VirtualBox、VMware Workstation）

硬件虚拟化（VT-x / AMD-V）：
  引入 VMX root / non-root 模式
  让 Guest OS 几乎直接在硬件上运行
  VM exit 时才回到 Hypervisor

VM exit 代价：
  ~1000~10000 ns（比 syscall 贵 3~30 倍）
  优化：VPID（减少 TLB 刷新）、EPT、APIC 虚拟化

Firecracker microVM：
  精简到只有 3~4 个虚拟设备
  启动时间：~125ms（传统 VM：~5~10 秒）
  内存：~5MB（传统 VM：数百 MB）
  每台服务器可运行 4000+ 实例

KVM + QEMU 分工：
  KVM（内核）：CPU + 内存虚拟化
  QEMU（用户态）：设备模拟 + VM 管理

VM 隔离优势：
  VM 之间不共享内核
  攻击面：Guest 内核漏洞 + KVM 漏洞（两层防御）
```

## 与 Shimmy/沙箱设计的联系

Shimmy Sandbox 本身运行在 AWS Lambda 的 **Firecracker microVM** 内部。理解 Firecracker 的设计对理解 Shimmy 的约束至关重要：

1. **为什么 Lambda 里什么都被限制**：Firecracker 的 seccomp 配置只允许 24 个系统调用，`prctl`、`ptrace`、带 `CLONE_NEW*` 的 `clone` 全被阻断，这直接导致所有传统沙箱工具失效。

2. **Firecracker 提供了第一层隔离**：不同 Lambda 函数之间由 Firecracker VM 隔离（不共享内核），Shimmy 提供的是函数内部的细粒度资源访问控制。两层叠加，形成更深度的防御。

3. **Firecracker 的设计启发了 Shimmy**：极简主义（最小攻击面）是 Firecracker 的核心哲学，也是 Shimmy 在设计白名单时的参考：只允许绝对必要的系统调用，拒绝一切可疑的。

指南第六章（AWS Lambda 与 Firecracker）详细讲解了 Firecracker 的内部机制，以及它对 Shimmy 设计决策的具体影响。
