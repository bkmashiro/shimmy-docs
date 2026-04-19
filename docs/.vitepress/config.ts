import { defineConfig } from 'vitepress'

// https://vitepress.vuejs.org/config/app-configs
export default defineConfig({
  base: '/shimmy-docs/',
  title: 'Shimmy Docs',
  description: 'Shimmy 沙箱系统文档',

  themeConfig: {
    nav: [
      { text: '指南', link: '/guide/01-what-is-a-program' }
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
      }
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
