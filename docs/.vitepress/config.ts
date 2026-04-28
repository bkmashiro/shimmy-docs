import { defineConfig } from 'vitepress'

// https://vitepress.vuejs.org/config/app-configs
export default defineConfig({
  base: '/shimmy-docs/',
  title: 'Shimmy Docs',
  description: 'Shimmy 沙箱系统文档',

  themeConfig: {
    nav: [
      { text: '指南', link: '/guide/01-what-is-a-program' },
      { text: 'Papers', link: '/papers/zpoline' },
      { text: 'Research', link: '/research/approaches-survey' },
      { text: 'SoK', link: '/sok/overview' },
    ],

    sidebar: [
      {
        text: '指南',
        items: [
          { text: '第一章：什么是程序', link: '/guide/01-what-is-a-program' },
          { text: '第二章：Linux 与内核', link: '/guide/02-linux-and-the-kernel' },
          { text: '第三章：系统调用', link: '/guide/03-system-calls' },
          { text: '第四章：为什么系统调用危险', link: '/guide/04-why-syscalls-are-dangerous' },
          { text: '第五章：传统沙箱机制', link: '/guide/05-traditional-sandboxing' },
          { text: '第六章：AWS Lambda 与 Firecracker', link: '/guide/06-aws-lambda-and-firecracker' },
          { text: '第七章：二进制插桩', link: '/guide/07-binary-instrumentation' },
          { text: '第八章：DynamoRIO 深度剖析', link: '/guide/08-dynamorio-deep-dive' },
          { text: '第九章：五种原型设计', link: '/guide/09-five-prototypes' },
          { text: '第十章：Shimmy 系统架构', link: '/guide/10-shimmy-architecture' },
          { text: '第十一章：基准测试分析', link: '/guide/11-benchmark-analysis' },
          { text: '第十二章：未来方向与研究展望', link: '/guide/12-future-directions' },
        ]
      },
      {
        text: 'Papers',
        items: [
          { text: 'zpoline (ATC 2023)', link: '/papers/zpoline' },
          { text: 'lazypoline (DSN 2024)', link: '/papers/lazypoline' },
          { text: 'K23 / Clair Obscur (Middleware 2025)', link: '/papers/k23' },
          { text: 'Firecracker (NSDI 2020)', link: '/papers/firecracker' },
          { text: 'Faasm (ATC 2020)', link: '/papers/faasm' },
          { text: 'SigmaOS (SOSP 2024)', link: '/papers/sigmaos' },
          { text: 'Dandelion (SOSP 2025)', link: '/papers/dandelion' },
          { text: 'Enclosure (ASPLOS 2021)', link: '/papers/enclosure' },
          { text: 'Light-Weight Contexts (OSDI 2016)', link: '/papers/light-weight-contexts' },
          { text: 'Seccomp-eBPF (arXiv 2023)', link: '/papers/seccomp-ebpf' },
        ]
      },
      {
        text: 'Research',
        items: [
          { text: 'Approaches Survey', link: '/research/approaches-survey' },
          { text: 'What Works in Lambda', link: '/research/what-works' },
          { text: 'Annotated Bibliography', link: '/research/annotated-bibliography' },
        ]
      },
      {
        text: '核心概念',
        items: [
          { text: '进程与内存空间', link: '/concepts/os/process-and-memory' },
          { text: '内核态与用户态', link: '/concepts/os/kernel-userspace' },
          { text: '系统调用深度解析', link: '/concepts/os/syscall-deep-dive' },
          { text: 'Linux 命名空间与 cgroups', link: '/concepts/os/linux-namespaces-cgroups' },
          { text: '信号与异常', link: '/concepts/os/signals-and-exceptions' },
          { text: '虚拟内存进阶', link: '/concepts/os/virtual-memory-advanced' },
          { text: 'ABI、链接与动态库', link: '/concepts/os/abi-and-linking' },
        ]
      },
      {
        text: '汇编语言入门',
        items: [
          { text: '第一章：为什么要学汇编？', link: '/assembly/01-why-assembly' },
          { text: '第二章：CPU 和寄存器', link: '/assembly/02-cpu-and-registers' },
          { text: '第三章：内存布局与栈', link: '/assembly/03-memory-and-stack' },
          { text: '第四章：基本指令', link: '/assembly/04-basic-instructions' },
          { text: '第五章：调用约定（ABI）', link: '/assembly/05-calling-convention' },
          { text: '第六章：用汇编发起系统调用', link: '/assembly/06-syscalls-in-assembly' },
          { text: '第七章：读懂反汇编输出', link: '/assembly/07-reading-disassembly' },
          { text: '第八章：汇编与沙箱技术的联系', link: '/assembly/08-assembly-and-sandboxing' },
        ]
      },
      {
        text: 'SoK Paper',
        items: [
          { text: 'Overview (500 words)', link: '/sok/overview' },
          { text: 'Full Paper', link: '/sok/full' },
        ]
      },
    ],

    outline: {
      level: [2, 3],
      label: '本页目录'
    },

    docFooter: {
      prev: '上一章',
      next: '下一章'
    }
  }
})
