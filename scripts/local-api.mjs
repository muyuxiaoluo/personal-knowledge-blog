import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const draftsDir = path.join(root, 'docs', 'drafts')
const trashDir = path.join(root, 'docs', '.trash')
const backupsDir = path.join(root, 'docs', '.backups')

const articleCollections = {
  reviews: { label: '复盘日志', dir: path.join(root, 'docs', 'reviews') },
  tools: { label: '工具评测与工作流', dir: path.join(root, 'docs', 'tools') },
  learning: { label: '学习方法与知识整理', dir: path.join(root, 'docs', 'learning') },
  templates: { label: '提示词与模板库', dir: path.join(root, 'docs', 'templates') },
  thoughts: { label: '思考随笔', dir: path.join(root, 'docs', 'thoughts') },
  projects: { label: '项目档案', dir: path.join(root, 'docs', 'projects') }
}

const categoryToCollection = {
  复盘日志: 'reviews',
  工具评测与工作流: 'tools',
  工具评测: 'tools',
  学习方法与知识整理: 'learning',
  学习方法: 'learning',
  提示词与模板库: 'templates',
  模板库: 'templates',
  思考随笔: 'thoughts',
  项目档案: 'projects'
}

const experienceCollections = {
  工具经验: 'tools',
  工作流方法: 'tools',
  提示词与模板: 'templates',
  学习经验: 'learning',
  代码经验: 'learning',
  写作经验: 'learning'
}

const branchValues = ['经验整理', '思考随笔', '复盘记录', '待分类']
const typeValues = ['记录', '复盘', '评测', '模板', '思考']
const stageValues = ['草稿', '已整理', '待复查', '已过时', '归档']
const validityValues = ['有效', '部分有效', '待验证', '已过时']

const collectionToBranch = {
  reviews: '复盘记录',
  tools: '经验整理',
  learning: '经验整理',
  templates: '经验整理',
  thoughts: '思考随笔'
}

const legacyTypeMap = {
  过程: '记录',
  结论: '记录',
  资产: '模板',
  观察: '思考'
}

const formatModeInstructions = {
  保守整理: '尽量保留用户原话，只做标题、frontmatter 和段落结构整理，不扩写。',
  深度复盘: '突出背景、尝试过程、有效/无效做法、当前判断和下一步。',
  工具评测: '突出需求、使用过程、效果、成本、局限、替代方案和是否继续使用。',
  学习笔记: '突出知识点、理解过程、可复习结构、仍不懂的问题和后续复习动作。',
  技术问题记录: '突出问题现象、环境、排查过程、原因、解决方案和避免复发。',
  思考随笔: '突出触发事件、观察、暂时判断、不确定处和对未来行动的影响。',
  提示词收藏: '突出适用场景、提示词正文、输入示例、输出效果、局限和优化方向。'
}

await loadEnv(path.join(root, '.env'))

const port = Number(process.env.KB_API_PORT || 8787)
const deepSeekBase = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com'
const deepSeekModel = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro'

const frontmatterFields = [
  'title',
  'created',
  'updated',
  'updateCount',
  'updateHistory',
  'branch',
  'subbranch',
  'stage',
  'validity',
  'category',
  'tags',
  'type',
  'project',
  'confidence',
  'source',
  'reviewDate',
  'summary',
  'next'
]

async function loadEnv(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const index = trimmed.indexOf('=')
      if (index === -1) continue
      const key = trimmed.slice(0, index).trim()
      const rawValue = trimmed.slice(index + 1).trim()
      const value = rawValue.replace(/^["']|["']$/g, '')
      if (key && process.env[key] === undefined) {
        process.env[key] = value
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function timestamp() {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 19).replace('T', ' ')
}

function slugify(input) {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)

  return normalized || `draft-${Date.now()}`
}

function escapeYaml(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '\\"')
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value.map((tag) => String(tag).trim()).filter(Boolean)
  }

  return String(value ?? '')
    .split(/[,，、\s]+/u)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function normalizeHistory(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean)
  }

  return String(value ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeSource(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean)
  }

  return String(value ?? '')
    .split(/[,，、\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeBranch(value, collection = '') {
  const branch = String(value || '').trim()
  if (branchValues.includes(branch)) {
    return branch
  }
  return collectionToBranch[collection] || '待分类'
}

function normalizeSubbranch(value, branch) {
  const subbranch = String(value || '').trim()
  return subbranch || (branch === '待分类' ? '待分类' : '')
}

function normalizeType(value, collection = '') {
  const rawType = String(value || '').trim()
  if (collection === 'reviews' && (!rawType || rawType === '过程' || rawType === '结论')) {
    return '复盘'
  }
  const mapped = legacyTypeMap[rawType] || rawType
  return typeValues.includes(mapped) ? mapped : '记录'
}

function normalizeStage(value, fallback = '草稿') {
  const stage = String(value || '').trim()
  if (stage === '已发布') return '已整理'
  if (stage === '已归档') return '归档'
  return stageValues.includes(stage) ? stage : fallback
}

function normalizeValidity(value) {
  const validity = String(value || '').trim()
  return validityValues.includes(validity) ? validity : '待验证'
}

function normalizeUpdateCount(value) {
  const count = Number.parseInt(String(value ?? '0'), 10)
  return Number.isFinite(count) ? count : 0
}

function buildMarkdown(payload) {
  const created = today()
  const title = String(payload.title || '').trim() || `未命名经验 ${created}`
  const tags = normalizeTags(payload.tags)
  const summary = String(payload.content || '').trim().slice(0, 80) || '待补充'
  const frontmatter = {
    title,
    created,
    updated: '',
    updateCount: 0,
    updateHistory: [],
    branch: payload.branch || '待分类',
    subbranch: payload.subbranch || '',
    stage: '草稿',
    validity: '待验证',
    category: payload.category || '草稿区',
    tags,
    type: normalizeType(payload.type),
    project: payload.project || '',
    confidence: '低',
    source: normalizeSource(payload.source || '复盘'),
    reviewDate: '',
    summary,
    next: '整理为正式文章，补充结论、适用场景和下一步行动。'
  }

  return `---\n${serializeFrontmatter(frontmatter)}\n---\n\n# ${title}\n\n## 原始经验描述\n\n${String(payload.content || '').trim()}\n\n## 待整理\n\n- 关键问题：待补充\n- 当前判断：待验证\n- 下一步：整理为正式文章\n`
}

function normalizeMarkdownForSave(payload) {
  const formatted = String(payload.formattedMarkdown || '').trim()
  if (!formatted) {
    return buildMarkdown(payload)
  }

  return `${formatted}\n`
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!match) {
    return {}
  }

  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index === -1) continue
    const key = line.slice(0, index).trim()
    const raw = line.slice(index + 1).trim()
    if (raw.startsWith('[') && raw.endsWith(']')) {
      meta[key] = raw
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    } else {
      meta[key] = raw
    }
  }
  return meta
}

function stripFrontmatter(markdown) {
  return String(markdown || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}

function serializeFrontmatter(meta) {
  return frontmatterFields
    .map((field) => {
      const value = meta[field]
      if (field === 'tags' || field === 'updateHistory' || field === 'source') {
        const items =
          field === 'tags' ? normalizeTags(value) : field === 'source' ? normalizeSource(value) : normalizeHistory(value)
        return `${field}: [${items.map((item) => escapeYaml(item)).join(', ')}]`
      }
      return `${field}: ${escapeYaml(value)}`
    })
    .join('\n')
}

function buildMarkdownFromParts(meta, body) {
  return `---\n${serializeFrontmatter(meta)}\n---\n\n${String(body || '').trim()}\n`
}

function getDraftTarget(input) {
  const slug = String(input || '')
    .trim()
    .replace(/\.md$/u, '')
    .replace(/[\\/]/g, '')

  if (!slug || slug === '.' || slug === '..') {
    throw new Error('slug is required')
  }

  return {
    slug,
    filename: `${slug}.md`,
    fullPath: path.join(draftsDir, `${slug}.md`)
  }
}

function cleanSlug(input, name = 'slug') {
  const slug = String(input || '')
    .trim()
    .replace(/\.md$/u, '')
    .replace(/[\\/]/g, '')

  if (!slug || slug === '.' || slug === '..') {
    throw new Error(`${name} is required`)
  }

  return slug
}

function getCollection(input) {
  const collection = String(input || '').trim()
  if (!Object.prototype.hasOwnProperty.call(articleCollections, collection)) {
    throw new Error('unsupported collection')
  }
  return collection
}

function getArticleTarget(collectionInput, slugInput) {
  const collection = getCollection(collectionInput)
  const slug = cleanSlug(slugInput)
  const filename = `${slug}.md`
  return {
    collection,
    slug,
    filename,
    fullPath: path.join(articleCollections[collection].dir, filename)
  }
}

function getContentTarget(idInput) {
  const id = String(idInput || '').trim()
  const [collectionInput, slugInput] = id.split('/')
  const collection = String(collectionInput || '').trim()
  if (collection === 'drafts') {
    const target = getDraftTarget(slugInput)
    return {
      ...target,
      id: `drafts/${target.slug}`,
      collection: 'drafts',
      collectionLabel: '草稿区',
      kind: 'draft'
    }
  }

  const target = getArticleTarget(collection, slugInput)
  return {
    ...target,
    id: `${target.collection}/${target.slug}`,
    collectionLabel: articleCollections[target.collection].label,
    kind: 'article'
  }
}

function ensureManageableContent(target) {
  if (target.slug === 'index') {
    throw new Error('index pages are not manageable content')
  }
  if (target.collection === 'examples' || target.fullPath.includes(`${path.sep}.trash${path.sep}`) || target.fullPath.includes(`${path.sep}.backups${path.sep}`)) {
    throw new Error('protected content cannot be modified')
  }
}

function getCollectionForCategory(category) {
  const normalized = String(category || '').trim()
  const collection = categoryToCollection[normalized]
  if (!collection) {
    throw new Error('target category is required')
  }
  return collection
}

function getCollectionForTreePosition(branchInput, subbranchInput, typeInput) {
  const branch = normalizeBranch(branchInput)
  const subbranch = normalizeSubbranch(subbranchInput, branch)
  const type = normalizeType(typeInput)

  if (branch === '复盘记录') return 'reviews'
  if (branch === '思考随笔') return 'thoughts'
  if (branch === '经验整理') {
    return experienceCollections[subbranch] || (type === '模板' ? 'templates' : type === '评测' ? 'tools' : 'learning')
  }

  throw new Error('归档前请先设置知识树主线')
}

function linkForArticle(collection, slug) {
  return `/${collection}/${encodeURIComponent(slug)}`
}

function linkForContent(collection, slug) {
  return collection === 'drafts' ? `/edit?file=${encodeURIComponent(slug)}` : linkForArticle(collection, slug)
}

function editLinkForContent(collection, slug) {
  const file = encodeURIComponent(slug)
  return collection === 'drafts' ? `/edit?file=${file}` : `/edit?collection=${encodeURIComponent(collection)}&file=${file}`
}

function relativePath(fullPath) {
  return path.relative(root, fullPath).replace(/\\/g, '/')
}

function summarizeContent({ collection, collectionLabel, slug, filename, fullPath, markdown, kind }) {
  const meta = parseFrontmatter(markdown)
  const branch = normalizeBranch(meta.branch, collection)
  const stageFallback = kind === 'article' ? '已整理' : '草稿'
  return {
    id: `${collection}/${slug}`,
    kind,
    collection,
    collectionLabel,
    slug,
    filename,
    title: meta.title || filename,
    created: meta.created || '',
    updated: meta.updated || '',
    updateCount: normalizeUpdateCount(meta.updateCount),
    updateHistory: normalizeHistory(meta.updateHistory),
    branch,
    subbranch: normalizeSubbranch(meta.subbranch, branch),
    stage: normalizeStage(meta.stage, stageFallback),
    validity: normalizeValidity(meta.validity),
    type: normalizeType(meta.type, collection),
    project: meta.project || '',
    tags: normalizeTags(meta.tags),
    summary: meta.summary || '',
    category: meta.category || collectionLabel,
    confidence: meta.confidence || '',
    source: normalizeSource(meta.source),
    reviewDate: meta.reviewDate || '',
    next: meta.next || '',
    path: relativePath(fullPath),
    link: linkForContent(collection, slug),
    editLink: editLinkForContent(collection, slug)
  }
}

function summarizeContentDetail(summary, markdown) {
  return {
    ...summary,
    markdown,
    body: stripFrontmatter(markdown),
    meta: parseFrontmatter(markdown)
  }
}

async function uniqueMarkdownPath(dir, preferredName) {
  await fs.mkdir(dir, { recursive: true })
  const safeBase = cleanSlug(preferredName || `article-${Date.now()}`, 'filename')
  let filename = `${safeBase}.md`
  let fullPath = path.join(dir, filename)

  try {
    await fs.access(fullPath)
    filename = `${safeBase}-${Date.now()}.md`
    fullPath = path.join(dir, filename)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }

  return { filename, fullPath, slug: filename.replace(/\.md$/u, '') }
}

function touchMeta(meta, updates = {}) {
  const updatedAt = timestamp()
  const updateHistory = [...normalizeHistory(meta.updateHistory), updatedAt]
  return {
    ...meta,
    ...updates,
    updated: updatedAt,
    updateCount: normalizeUpdateCount(meta.updateCount) + 1,
    updateHistory
  }
}

function buildUpdatedMarkdown(payload, existingMarkdown) {
  if (String(payload.markdown || '').trim()) {
    return `${String(payload.markdown).trim()}\n`
  }

  const existingMeta = parseFrontmatter(existingMarkdown)
  const incomingMeta = payload.frontmatter || {}
  const updatedAt = timestamp()
  const updateHistory = [...normalizeHistory(existingMeta.updateHistory || incomingMeta.updateHistory), updatedAt]
  const updateCount = normalizeUpdateCount(existingMeta.updateCount || incomingMeta.updateCount) + 1
  const nextMeta = ensureFrontmatter(
    {
      ...existingMeta,
      ...incomingMeta,
      title: payload.title ?? incomingMeta.title ?? existingMeta.title,
      branch: payload.branch ?? incomingMeta.branch ?? existingMeta.branch,
      subbranch: payload.subbranch ?? incomingMeta.subbranch ?? existingMeta.subbranch,
      type: payload.type ?? incomingMeta.type ?? existingMeta.type,
      stage: payload.stage ?? incomingMeta.stage ?? existingMeta.stage,
      validity: payload.validity ?? incomingMeta.validity ?? existingMeta.validity,
      category: payload.category ?? incomingMeta.category ?? existingMeta.category,
      project: payload.project ?? incomingMeta.project ?? existingMeta.project,
      confidence: payload.confidence ?? incomingMeta.confidence ?? existingMeta.confidence,
      source: payload.source ?? incomingMeta.source ?? existingMeta.source,
      reviewDate: payload.reviewDate ?? incomingMeta.reviewDate ?? existingMeta.reviewDate,
      tags: payload.tags ?? incomingMeta.tags ?? existingMeta.tags,
      summary: payload.summary ?? incomingMeta.summary ?? existingMeta.summary,
      next: payload.next ?? incomingMeta.next ?? existingMeta.next,
      updated: updatedAt,
      updateCount,
      updateHistory
    },
    payload
  )
  const body = payload.body ?? payload.content ?? stripFrontmatter(existingMarkdown)
  return buildMarkdownFromParts(nextMeta, body)
}

function ensureFrontmatter(data, payload) {
  const created = today()
  const rawTags = Array.isArray(data.tags) ? data.tags : normalizeTags(data.tags || payload.tags)
  const collection = payload.collection || ''
  const branch = normalizeBranch(data.branch || payload.branch, collection)
  return {
    title: data.title || payload.title || `未命名经验 ${created}`,
    created: data.created || created,
    updated: data.updated || '',
    updateCount: normalizeUpdateCount(data.updateCount),
    updateHistory: normalizeHistory(data.updateHistory),
    branch,
    subbranch: normalizeSubbranch(data.subbranch || payload.subbranch, branch),
    stage: normalizeStage(data.stage || payload.stage, payload.kind === 'article' ? '已整理' : '草稿'),
    validity: normalizeValidity(data.validity || payload.validity),
    category: data.category || payload.category || '草稿区',
    tags: rawTags,
    type: normalizeType(data.type || payload.type, collection),
    project: data.project || payload.project || '',
    confidence: data.confidence || '低',
    source: normalizeSource(data.source || payload.source || '复盘'),
    reviewDate: data.reviewDate || '',
    summary: data.summary || '待补充',
    next: data.next || '补充细节并复查结论。'
  }
}

function normalizeAiResult(result, payload) {
  const frontmatter = ensureFrontmatter(result.suggestedFrontmatter || {}, payload)
  const markdown = String(result.formattedMarkdown || '').trim()
  const markdownMeta = parseFrontmatter(markdown)
  const suggestedFrontmatter = ensureFrontmatter({ ...frontmatter, ...markdownMeta }, payload)
  return {
    formattedMarkdown: markdown,
    suggestedFrontmatter,
    suggestedTitle: result.suggestedTitle || suggestedFrontmatter.title,
    suggestedSummary: result.suggestedSummary || suggestedFrontmatter.summary,
    suggestedTags: Array.isArray(result.suggestedTags) ? result.suggestedTags : suggestedFrontmatter.tags,
    suggestedNext: result.suggestedNext || suggestedFrontmatter.next
  }
}

function extractJson(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed)
  }

  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (match) {
    return JSON.parse(match[1])
  }

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1))
  }

  throw new Error('DeepSeek response did not contain valid JSON')
}

function buildFormatPrompt(payload) {
  const created = today()
  const tags = normalizeTags(payload.tags).join(', ') || '待补充'
  const formatMode = String(payload.mode || '保守整理').trim()
  const modeInstruction = formatModeInstructions[formatMode] || formatModeInstructions.保守整理
  return `请把用户的自然语言经验整理成本站规范 Markdown。必须只返回 JSON，不要返回额外解释。

JSON 字段：
{
  "formattedMarkdown": "完整 Markdown，必须包含 frontmatter 和正文",
  "suggestedFrontmatter": {
    "title": "",
    "created": "${created}",
    "updated": "",
    "updateCount": 0,
    "updateHistory": [],
    "branch": "${payload.branch || '待分类'}",
    "subbranch": "${payload.subbranch || ''}",
    "stage": "草稿",
    "validity": "待验证",
    "tags": [],
    "type": "${payload.type || '记录'}",
    "project": "",
    "confidence": "低",
    "source": ["复盘"],
    "reviewDate": "",
    "summary": "",
    "next": ""
  },
  "suggestedTitle": "",
  "suggestedSummary": "",
  "suggestedTags": [],
  "suggestedNext": ""
}

统一 frontmatter 必须包含：
title, created, updated, updateCount, updateHistory, branch, subbranch, stage, validity, tags, type, project, confidence, source, reviewDate, summary, next

时间规则：
- 新文章只需要 created。
- updated 初始为空。
- reviewDate 初始为空，除非用户明确说了要复查的日期。
- updateCount 初始为 0。
- updateHistory 初始为空数组。

正文结构：
- type 为“记录”：当前结论 / 背景 / 尝试过程 / 发现 / 后续行动
- type 为“复盘”：背景 / 目标 / 过程 / 结果 / 问题 / 下一步
- type 为“评测”：需求 / 使用过程 / 效果 / 成本 / 局限 / 是否继续使用
- type 为“模板”：用途 / 模板内容 / 使用方法 / 示例 / 更新记录
- type 为“思考”：触发事件 / 我的观察 / 暂时判断 / 仍需验证

写作要求：
- 不要编造用户没说过的经历。
- 不确定的信息标记为“待补充”。
- 适合中文个人知识库阅读，不要像营销文章。
- 标题要具体，但不要夸张。
- 只输出整理后的正文，不要附加用户原文副本。

用户提供的元信息：
- 标题：${payload.title || '待补充'}
- 主线：${payload.branch || '待分类'}
- 子分支：${payload.subbranch || '待补充'}
- 类型：${payload.type || '记录'}
- 项目：${payload.project || '待补充'}
- 标签：${tags}
- 整理模式：${formatMode}
- 模式要求：${modeInstruction}

用户原始经验：
${payload.rawText || payload.content || ''}`
}

async function formatWithDeepSeek(payload) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    return {
      status: 503,
      body: {
        error: 'AI 整理暂不可用',
        reason: 'missing_deepseek_api_key'
      }
    }
  }

  const response = await fetch(`${deepSeekBase.replace(/\/$/u, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: deepSeekModel,
      messages: [
        {
          role: 'system',
          content:
            '你是个人知识库文章整理助手。你只做结构化整理，不编造事实。必须返回可解析 JSON。'
        },
        {
          role: 'user',
          content: buildFormatPrompt(payload)
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      stream: false
    })
  })

  const data = await response.json()
  if (!response.ok) {
    return {
      status: response.status,
      body: {
        error: data?.error?.message || 'DeepSeek API request failed',
        reason: 'deepseek_error'
      }
    }
  }

  const content = data?.choices?.[0]?.message?.content
  if (!content) {
    return {
      status: 502,
      body: {
        error: 'DeepSeek response is empty',
        reason: 'empty_deepseek_response'
      }
    }
  }

  return {
    status: 200,
    body: normalizeAiResult(extractJson(content), payload)
  }
}

async function readRequestBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function listDrafts() {
  await fs.mkdir(draftsDir, { recursive: true })
  const files = await fs.readdir(draftsDir)
  const drafts = []

  for (const file of files.filter((name) => name.endsWith('.md') && name !== 'index.md')) {
    const fullPath = path.join(draftsDir, file)
    const markdown = await fs.readFile(fullPath, 'utf8')
    const slug = file.replace(/\.md$/u, '')
    drafts.push({
      ...summarizeContent({
        collection: 'drafts',
        collectionLabel: '草稿区',
        slug,
        filename: file,
        fullPath,
        markdown,
        kind: 'draft'
      }),
      slug: file.replace(/\.md$/u, ''),
    })
  }

  return drafts.sort((a, b) => String(b.created).localeCompare(String(a.created)))
}

async function listArticles() {
  const articles = []

  for (const [collection, config] of Object.entries(articleCollections)) {
    await fs.mkdir(config.dir, { recursive: true })
    const files = await fs.readdir(config.dir)
    for (const file of files.filter((name) => name.endsWith('.md') && name !== 'index.md')) {
      const fullPath = path.join(config.dir, file)
      const markdown = await fs.readFile(fullPath, 'utf8')
      const slug = file.replace(/\.md$/u, '')
      articles.push(summarizeContent({
        collection,
        collectionLabel: config.label,
        slug,
        filename: file,
        fullPath,
        markdown,
        kind: 'article'
      }))
    }
  }

  return articles.sort((a, b) => String(b.updated || b.created).localeCompare(String(a.updated || a.created)))
}

async function listContents() {
  const [drafts, articles] = await Promise.all([listDrafts(), listArticles()])
  return [...drafts, ...articles].sort((a, b) =>
    String(b.updated || b.created).localeCompare(String(a.updated || a.created))
  )
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  res.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {})
    return
  }

  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)

    if (req.method === 'GET' && req.url === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        deepseekConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
        model: deepSeekModel,
        apiBase: deepSeekBase
      })
      return
    }

    if (req.method === 'POST' && req.url === '/api/save-draft') {
      const payload = JSON.parse(await readRequestBody(req))
      if (!String(payload.content || payload.formattedMarkdown || '').trim()) {
        sendJson(res, 400, { error: 'content is required' })
        return
      }

      await fs.mkdir(draftsDir, { recursive: true })
      const formattedMeta = parseFrontmatter(String(payload.formattedMarkdown || ''))
      const title = String(payload.title || formattedMeta.title || '').trim() || `未命名经验 ${today()}`
      const baseSlug = slugify(title)
      const filename = `${baseSlug}-${Date.now()}.md`
      const fullPath = path.join(draftsDir, filename)
      const markdown = normalizeMarkdownForSave(payload)
      await fs.writeFile(fullPath, markdown, 'utf8')
      sendJson(res, 201, {
        ok: true,
        slug: filename.replace(/\.md$/u, ''),
        path: `docs/drafts/${filename}`
      })
      return
    }

    if (req.method === 'GET' && req.url === '/api/drafts') {
      sendJson(res, 200, { drafts: await listDrafts() })
      return
    }

    if (req.method === 'GET' && req.url === '/api/articles') {
      sendJson(res, 200, { articles: await listArticles() })
      return
    }

    if (req.method === 'GET' && req.url === '/api/contents') {
      sendJson(res, 200, { contents: await listContents() })
      return
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/content') {
      const target = getContentTarget(requestUrl.searchParams.get('id'))
      ensureManageableContent(target)
      const markdown = await fs.readFile(target.fullPath, 'utf8')
      const summary = summarizeContent({
        collection: target.collection,
        collectionLabel: target.collectionLabel,
        slug: target.slug,
        filename: target.filename,
        fullPath: target.fullPath,
        markdown,
        kind: target.kind
      })
      sendJson(res, 200, { content: summarizeContentDetail(summary, markdown) })
      return
    }

    if (req.method === 'GET' && req.url?.startsWith('/api/articles/')) {
      const [collection, slug] = req.url.replace('/api/articles/', '').split('/')
      const target = getArticleTarget(decodeURIComponent(collection), decodeURIComponent(slug || ''))
      const markdown = await fs.readFile(target.fullPath, 'utf8')
      sendJson(res, 200, {
        collection: target.collection,
        slug: target.slug,
        filename: target.filename,
        markdown,
        meta: parseFrontmatter(markdown)
      })
      return
    }

    if (req.method === 'GET' && req.url?.startsWith('/api/drafts/')) {
      const target = getDraftTarget(decodeURIComponent(req.url.replace('/api/drafts/', '')))
      const markdown = await fs.readFile(target.fullPath, 'utf8')
      sendJson(res, 200, { slug: target.slug, filename: target.filename, markdown, meta: parseFrontmatter(markdown) })
      return
    }

    if (req.method === 'POST' && req.url === '/api/update-draft') {
      const payload = JSON.parse(await readRequestBody(req))
      const target = getDraftTarget(payload.slug || payload.filename)
      const existingMarkdown = await fs.readFile(target.fullPath, 'utf8')
      const backupName = `${target.slug}-${Date.now()}.md`
      const backupPath = path.join(backupsDir, backupName)
      const markdown = buildUpdatedMarkdown(payload, existingMarkdown)

      await fs.mkdir(backupsDir, { recursive: true })
      await fs.copyFile(target.fullPath, backupPath)
      await fs.writeFile(target.fullPath, markdown, 'utf8')
      sendJson(res, 200, {
        ok: true,
        slug: target.slug,
        path: `docs/drafts/${target.filename}`,
        backupPath: `docs/.backups/${backupName}`
      })
      return
    }

    if (req.method === 'POST' && req.url === '/api/archive-draft') {
      const payload = JSON.parse(await readRequestBody(req))
      const target = getDraftTarget(payload.slug || payload.filename)
      const existingMarkdown = await fs.readFile(target.fullPath, 'utf8')
      const existingMeta = parseFrontmatter(existingMarkdown)
      const branch = normalizeBranch(payload.branch ?? existingMeta.branch)
      const subbranch = normalizeSubbranch(payload.subbranch ?? existingMeta.subbranch, branch)
      const type = normalizeType(payload.type ?? existingMeta.type)
      const collection = getCollectionForTreePosition(branch, subbranch, type)
      const targetCategory = articleCollections[collection].label
      const preferredFilename = payload.targetFilename
        ? cleanSlug(payload.targetFilename, 'targetFilename')
        : target.slug
      const destination = await uniqueMarkdownPath(articleCollections[collection].dir, preferredFilename)
      const backupName = `${target.slug}-${Date.now()}.md`
      const backupPath = path.join(backupsDir, backupName)
      const archivedMeta = ensureFrontmatter(
        touchMeta(existingMeta, {
          stage: '已整理',
          branch,
          subbranch,
          type,
          category: targetCategory
        }),
        {
          ...payload,
          collection,
          kind: 'article'
        }
      )
      const archivedMarkdown = buildMarkdownFromParts(archivedMeta, stripFrontmatter(existingMarkdown))

      await fs.mkdir(backupsDir, { recursive: true })
      await fs.copyFile(target.fullPath, backupPath)
      await fs.writeFile(destination.fullPath, archivedMarkdown, 'utf8')
      await fs.unlink(target.fullPath)
      sendJson(res, 200, {
        ok: true,
        category: targetCategory,
        collection,
        oldPath: `docs/drafts/${target.filename}`,
        newPath: relativePath(destination.fullPath),
        archivedPath: relativePath(destination.fullPath),
        backupPath: `docs/.backups/${backupName}`,
        link: linkForArticle(collection, destination.slug)
      })
      return
    }

    if (req.method === 'POST' && req.url === '/api/update-article') {
      const payload = JSON.parse(await readRequestBody(req))
      const target = getArticleTarget(payload.collection, payload.slug || payload.filename)
      const existingMarkdown = await fs.readFile(target.fullPath, 'utf8')
      const backupName = `${target.collection}-${target.slug}-${Date.now()}.md`
      const backupPath = path.join(backupsDir, backupName)
      const markdown = buildUpdatedMarkdown(payload, existingMarkdown)

      await fs.mkdir(backupsDir, { recursive: true })
      await fs.copyFile(target.fullPath, backupPath)
      await fs.writeFile(target.fullPath, markdown, 'utf8')
      sendJson(res, 200, {
        ok: true,
        collection: target.collection,
        slug: target.slug,
        path: relativePath(target.fullPath),
        backupPath: `docs/.backups/${backupName}`,
        link: linkForArticle(target.collection, target.slug)
      })
      return
    }

    if (req.method === 'POST' && req.url === '/api/update-content') {
      const payload = JSON.parse(await readRequestBody(req))
      const target = getContentTarget(payload.id)
      ensureManageableContent(target)
      const existingMarkdown = await fs.readFile(target.fullPath, 'utf8')
      const backupName = `${target.collection}-${target.slug}-${Date.now()}.md`
      const backupPath = path.join(backupsDir, backupName)
      const markdown = buildUpdatedMarkdown(
        {
          ...payload,
          collection: target.collection,
          slug: target.slug,
          kind: target.kind
        },
        existingMarkdown
      )

      await fs.mkdir(backupsDir, { recursive: true })
      await fs.copyFile(target.fullPath, backupPath)
      await fs.writeFile(target.fullPath, markdown, 'utf8')
      sendJson(res, 200, {
        ok: true,
        id: target.id,
        path: relativePath(target.fullPath),
        backupPath: `docs/.backups/${backupName}`,
        link: linkForContent(target.collection, target.slug)
      })
      return
    }

    if (req.method === 'POST' && req.url === '/api/delete-draft') {
      const payload = JSON.parse(await readRequestBody(req))
      const target = getDraftTarget(payload.slug || payload.filename)
      let trashName = target.filename
      let trashPath = path.join(trashDir, trashName)

      await fs.mkdir(trashDir, { recursive: true })
      try {
        await fs.access(trashPath)
        trashName = `${target.slug}-${Date.now()}.md`
        trashPath = path.join(trashDir, trashName)
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error
        }
      }

      await fs.rename(target.fullPath, trashPath)
      sendJson(res, 200, {
        ok: true,
        slug: target.slug,
        path: `docs/.trash/${trashName}`
      })
      return
    }

    if (req.method === 'POST' && req.url === '/api/delete-content') {
      const payload = JSON.parse(await readRequestBody(req))
      const target = getContentTarget(payload.id)
      ensureManageableContent(target)
      let trashName = `${target.collection}-${target.filename}`
      let trashPath = path.join(trashDir, trashName)

      await fs.mkdir(trashDir, { recursive: true })
      try {
        await fs.access(trashPath)
        trashName = `${target.collection}-${target.slug}-${Date.now()}.md`
        trashPath = path.join(trashDir, trashName)
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error
        }
      }

      await fs.rename(target.fullPath, trashPath)
      sendJson(res, 200, {
        ok: true,
        id: target.id,
        path: `docs/.trash/${trashName}`
      })
      return
    }

    if (req.method === 'POST' && req.url === '/api/move-content') {
      const payload = JSON.parse(await readRequestBody(req))
      const target = getContentTarget(payload.id)
      ensureManageableContent(target)
      const targetCollection = payload.targetCollection || getCollectionForCategory(payload.targetCategory)
      const collection = getCollection(targetCollection)
      const destination = await uniqueMarkdownPath(
        articleCollections[collection].dir,
        payload.targetFilename ? cleanSlug(payload.targetFilename, 'targetFilename') : target.slug
      )
      const existingMarkdown = await fs.readFile(target.fullPath, 'utf8')
      const existingMeta = parseFrontmatter(existingMarkdown)
      const backupName = `${target.collection}-${target.slug}-${Date.now()}.md`
      const backupPath = path.join(backupsDir, backupName)
      const movedMeta = ensureFrontmatter(
        touchMeta(existingMeta, {
          category: payload.targetCategory || articleCollections[collection].label,
          stage: target.kind === 'draft' ? '已整理' : existingMeta.stage
        }),
        {
          ...payload,
          collection,
          kind: 'article'
        }
      )
      const movedMarkdown = buildMarkdownFromParts(movedMeta, stripFrontmatter(existingMarkdown))

      await fs.mkdir(backupsDir, { recursive: true })
      await fs.copyFile(target.fullPath, backupPath)
      await fs.writeFile(destination.fullPath, movedMarkdown, 'utf8')
      await fs.unlink(target.fullPath)
      sendJson(res, 200, {
        ok: true,
        id: `${collection}/${destination.slug}`,
        oldPath: relativePath(target.fullPath),
        newPath: relativePath(destination.fullPath),
        backupPath: `docs/.backups/${backupName}`,
        link: linkForArticle(collection, destination.slug)
      })
      return
    }

    if (req.method === 'POST' && req.url === '/api/format') {
      const payload = JSON.parse(await readRequestBody(req))
      if (!String(payload.rawText || payload.content || '').trim()) {
        sendJson(res, 400, { error: 'rawText is required' })
        return
      }

      const result = await formatWithDeepSeek(payload)
      sendJson(res, result.status, result.body)
      return
    }

    sendJson(res, 404, { error: 'not found' })
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : 'unknown error' })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Knowledge workbench API running at http://127.0.0.1:${port}`)
  console.log(`DeepSeek configured: ${Boolean(process.env.DEEPSEEK_API_KEY)}`)
  console.log(`DeepSeek model: ${deepSeekModel}`)
  console.log(`DeepSeek API base: ${deepSeekBase}`)
})
