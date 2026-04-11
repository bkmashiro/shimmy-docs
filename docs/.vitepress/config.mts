import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Shimmy Sandbox 技术文档',
  description: '从零开始理解受限环境中的沙箱技术',
  cleanUrls: true,

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '指南', link: '/guide/01-what-is-a-program' },
    ],

    sidebar: [
      {
        text: '基础知识',
        items: [
          { text: '第一章：什么是程序', link: '/guide/01-what-is-a-program' },
          { text: '第二章：Linux 与内核', link: '/guide/02-linux-and-the-kernel' },
          { text: '第三章：系统调用', link: '/guide/03-system-calls' },
          { text: '第四章：为什么系统调用危险', link: '/guide/04-why-syscalls-are-dangerous' },
        ],
      },
      {
        text: '传统沙箱技术',
        items: [
          { text: '第五章：传统沙箱机制', link: '/guide/05-traditional-sandboxing' },
          { text: '第六章：AWS Lambda 与 Firecracker', link: '/guide/06-aws-lambda-and-firecracker' },
        ],
      },
      {
        text: 'Shimmy Sandbox 核心',
        items: [
          { text: '第七章：二进制插桩', link: '/guide/07-binary-instrumentation' },
          { text: '第八章：DynamoRIO 深度剖析', link: '/guide/08-dynamorio-deep-dive' },
          { text: '第九章：五种原型设计', link: '/guide/09-five-prototypes' },
          { text: '第十章：Shimmy 系统架构', link: '/guide/10-shimmy-architecture' },
        ],
      },
      {
        text: '评估与展望',
        items: [
          { text: '第十一章：基准测试分析', link: '/guide/11-benchmark-analysis' },
          { text: '第十二章：未来方向', link: '/guide/12-future-directions' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/bkmashiro/shimmy-docs' },
    ],

    footer: {
      message: '基于 MIT 许可证发布',
      copyright: 'Copyright © 2024 Shimmy Sandbox Project',
    },
  },
})
