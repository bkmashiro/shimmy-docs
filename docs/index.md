---
layout: home

hero:
  name: Shimmy Sandbox
  text: 在受限的星空下
  tagline: 如何安全地运行不可信的代码——从计算机原理到工业级沙箱技术的完整旅程
  actions:
    - theme: brand
      text: 开始阅读
      link: /guide/01-what-is-a-program
    - theme: alt
      text: GitHub
      link: https://github.com/bkmashiro/shimmy-docs

features:
  - title: 从零出发
    details: 从"什么是程序"开始，逐步建立理解计算机系统所需的全部基础概念。每一个术语都在使用前完整定义。
  - title: 深入内核
    details: 解析 Linux 系统调用接口、进程隔离机制、内存管理，以及为什么这些机制既是程序运行的基础，也是攻击者的突破口。
  - title: 工业级方案
    details: 在 AWS Lambda + Firecracker 的严苛约束下，DynamoRIO 动态二进制插桩如何拦截每一条 syscall 指令，构建出可在生产环境运行的学生代码沙箱。
---

## 这份文档是什么

**Shimmy Sandbox** 是一个在 AWS Lambda 上安全运行学生代码提交的沙箱系统。本文档记录了该系统从需求分析到工程实现的完整技术旅程。

如果你刚刚学完冒泡排序，还不清楚"系统调用"是什么意思——没关系，这份文档从最基础的计算机原理讲起，带你一步步理解：

- 程序是什么，CPU 如何执行指令
- 操作系统如何隔离不同进程
- 为什么运行不可信代码如此危险
- 传统沙箱技术（seccomp、ptrace、namespaces）如何工作
- 为什么这些技术在 Lambda 环境中全部失效
- DynamoRIO 如何在机器码层面拦截所有危险操作
- 五种原型设计的权衡取舍与性能数据

如果你是正在研究沙箱技术的研究生，本文档同样提供足够深度的技术细节，可作为 MSc 论文的参考资料。

## 章节导览

| 章节 | 主题 | 难度 |
|------|------|------|
| [第一章](/guide/01-what-is-a-program) | 什么是程序：从源码到机器码 | ⭐ 入门 |
| [第二章](/guide/02-linux-and-the-kernel) | Linux 与内核：进程、内存、文件描述符 | ⭐⭐ 基础 |
| [第三章](/guide/03-system-calls) | 系统调用：用户态与内核态的唯一桥梁 | ⭐⭐ 基础 |
| [第四章](/guide/04-why-syscalls-are-dangerous) | 为什么系统调用危险：真实攻击场景 | ⭐⭐⭐ 进阶 |
| [第五章](/guide/05-traditional-sandboxing) | 传统沙箱：seccomp、ptrace、namespaces | ⭐⭐⭐ 进阶 |
| [第六章](/guide/06-aws-lambda-and-firecracker) | Lambda 与 Firecracker：嵌套沙箱的悖论 | ⭐⭐⭐ 进阶 |
| [第七章](/guide/07-binary-instrumentation) | 二进制插桩：在机器码层面拦截 | ⭐⭐⭐⭐ 高级 |
| [第八章](/guide/08-dynamorio-deep-dive) | DynamoRIO 深度剖析 | ⭐⭐⭐⭐ 高级 |
| [第九章](/guide/09-five-prototypes) | 五种原型设计与对比 | ⭐⭐⭐⭐ 高级 |
| [第十章](/guide/10-shimmy-architecture) | Shimmy 完整系统架构 | ⭐⭐⭐⭐ 高级 |
| [第十一章](/guide/11-benchmark-analysis) | 基准测试分析与解读 | ⭐⭐⭐⭐⭐ 专家 |
| [第十二章](/guide/12-future-directions) | 未来方向与改进空间 | ⭐⭐⭐⭐⭐ 专家 |
