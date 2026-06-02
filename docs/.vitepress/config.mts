import { defineConfig } from 'vitepress'

export default defineConfig({
  title: '人生攻略库',
  description: '一个本地优先的个人知识库博客，用来复盘、整理经验和沉淀可复用资产。',
  lang: 'zh-CN',
  cleanUrls: true,
  themeConfig: {
    logo: '/logo.svg',
    search: {
      provider: 'local'
    },
    nav: [
      { text: '首页', link: '/' },
      { text: '复盘', link: '/reviews/' },
      { text: '工具', link: '/tools/' },
      { text: '学习', link: '/learning/' },
      { text: '模板', link: '/templates/' },
      { text: '思考', link: '/thoughts/' },
      { text: '项目', link: '/projects/' },
      {
        text: '更多',
        items: [
          { text: '草稿区', link: '/drafts/' },
          { text: '示例存档', link: '/examples/' }
        ]
      }
    ],
    sidebar: {
      '/': [
        {
          text: '知识库入口',
          items: [
            { text: '复盘日志', link: '/reviews/' },
            { text: '工具评测与工作流', link: '/tools/' },
            { text: '学习方法与知识整理', link: '/learning/' },
            { text: '提示词与模板库', link: '/templates/' },
            { text: '思考随笔', link: '/thoughts/' },
            { text: '项目档案', link: '/projects/' }
          ]
        }
      ],
      '/reviews/': [
        { text: '复盘日志', link: '/reviews/' },
        { text: '周复盘模板', link: '/reviews/weekly-review-template' }
      ],
      '/tools/': [
        { text: '工具评测与工作流', link: '/tools/' },
        { text: '豆包录音总结体验', link: '/tools/doubao-audio-summary' },
        { text: '工具评测模板', link: '/tools/tool-review-template' }
      ],
      '/learning/': [
        { text: '学习方法与知识整理', link: '/learning/' },
        { text: 'AI 辅助学习工作流笔记', link: '/learning/ai-learning-workflow-notes' }
      ],
      '/templates/': [
        { text: '提示词与模板库', link: '/templates/' },
        { text: '提示词收藏模板', link: '/templates/prompt-template' },
        { text: '问题记录模板', link: '/templates/problem-template' },
        { text: '周复盘模板', link: '/templates/weekly-review-template' }
      ],
      '/thoughts/': [
        { text: '思考随笔', link: '/thoughts/' },
        { text: '为什么这不是普通博客', link: '/thoughts/why-this-is-not-a-normal-blog' }
      ],
      '/projects/': [
        { text: '项目档案', link: '/projects/' },
        { text: '个人知识库博客', link: '/projects/personal-knowledge-blog' },
        { text: 'AI 辅助学习工作流', link: '/projects/ai-learning-workflow' }
      ],
      '/drafts/': [
        { text: '草稿区', link: '/drafts/' }
      ],
      '/examples/': [
        { text: '示例存档', link: '/examples/' },
        { text: 'VitePress 示例文章', link: '/examples/default-example' }
      ]
    },
    outline: {
      level: [2, 3],
      label: '页面目录'
    },
    docFooter: {
      prev: '上一篇',
      next: '下一篇'
    }
  }
})
