export const branches = ['经验整理', '思考随笔', '复盘记录', '待分类'] as const

export const subbranchesByBranch: Record<string, string[]> = {
  经验整理: ['工具经验', '学习经验', '代码经验', '写作经验', '提示词与模板', '工作流方法'],
  思考随笔: ['AI时代与焦虑', '信息茧房', '学习与成长', '效率与工具', '创作与变现', '生活观察'],
  复盘记录: ['日复盘', '周复盘', '月复盘', '项目复盘', '工具测试复盘', '决策复盘'],
  待分类: ['待分类']
}

export const contentTypes = ['记录', '复盘', '评测', '模板', '思考'] as const
export const stages = ['草稿', '已整理', '待复查', '已过时', '归档'] as const
export const validities = ['有效', '部分有效', '待验证', '已过时'] as const
export const confidenceLevels = ['低', '中', '高'] as const
export const sourceTypes = ['实测', '阅读', '观察', '二手信息', '复盘'] as const

export const collectionLabels: Record<string, string> = {
  drafts: '草稿区',
  reviews: '复盘日志',
  tools: '工具评测与工作流',
  learning: '学习方法与知识整理',
  templates: '提示词与模板库',
  thoughts: '思考随笔',
  projects: '项目档案'
}

const collectionDirs: Record<string, string> = {
  reviews: 'docs/reviews/',
  tools: 'docs/tools/',
  learning: 'docs/learning/',
  templates: 'docs/templates/',
  thoughts: 'docs/thoughts/'
}

const experienceCollections: Record<string, string> = {
  工具经验: 'tools',
  工作流方法: 'tools',
  提示词与模板: 'templates',
  学习经验: 'learning',
  代码经验: 'learning',
  写作经验: 'learning'
}

export function subbranchesFor(branch: string) {
  return subbranchesByBranch[branch] || subbranchesByBranch.待分类
}

export function normalizeBranch(value: string | undefined) {
  const branch = String(value || '').trim()
  return branches.includes(branch as (typeof branches)[number]) ? branch : '待分类'
}

export function normalizeSubbranch(branch: string, value: string | undefined) {
  const subbranch = String(value || '').trim()
  return subbranch || (branch === '待分类' ? '待分类' : '')
}

export function collectionForTreePosition(branch: string, subbranch: string, type = '') {
  if (branch === '复盘记录') return 'reviews'
  if (branch === '思考随笔') return 'thoughts'
  if (branch !== '经验整理') return ''

  return experienceCollections[subbranch] || (type === '模板' ? 'templates' : type === '评测' ? 'tools' : 'learning')
}

export function archiveTargetFor(branch: string, subbranch: string, type = '') {
  const collection = collectionForTreePosition(branch, subbranch, type)
  return {
    collection,
    label: collectionLabels[collection] || '',
    dir: collectionDirs[collection] || ''
  }
}

export function normalizeList(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean)
  }

  return String(value || '')
    .split(/[,，、\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean)
}
