<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { archiveDraft, formatDraft, getArticle, getDraft, getHealth, updateArticle, updateDraft } from './apiClient'
import {
  archiveTargetFor,
  branches,
  sourceTypes,
  subbranchesFor,
  validities
} from './contentSchema'

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
  'tags',
  'type',
  'project',
  'confidence',
  'source',
  'reviewDate',
  'summary',
  'next'
]

const slug = ref('')
const collection = ref('drafts')
const loading = ref(true)
const saving = ref(false)
const formatting = ref(false)
const archiving = ref(false)
const error = ref('')
const result = ref('')
const archiveLink = ref('')
const healthMessage = ref('')
const healthOk = ref(false)
const aiUnavailable = ref(false)
const originalMeta = ref<Record<string, unknown>>({})
const aiResult = ref<null | {
  formattedMarkdown: string
  suggestedFrontmatter: Record<string, unknown>
  suggestedTitle: string
  suggestedSummary: string
  suggestedTags: string[]
  suggestedNext: string
}>(null)

const form = reactive({
  title: '',
  branch: '待分类',
  subbranch: '',
  stage: '草稿',
  validity: '待验证',
  type: '记录',
  project: '',
  confidence: '低',
  source: '复盘',
  reviewDate: '',
  tags: '',
  summary: '',
  next: '',
  body: ''
})

const isDraft = computed(() => collection.value === 'drafts')
const pageTitle = computed(() => (isDraft.value ? '编辑草稿' : '编辑正式文章'))
const canSave = computed(() => Boolean(slug.value) && !saving.value)
const canFormat = computed(() => form.body.trim().length > 0 && !formatting.value && !aiUnavailable.value)
const canArchive = computed(() => isDraft.value && Boolean(slug.value) && !archiving.value)
const archiveTarget = computed(() => archiveTargetFor(form.branch, form.subbranch, form.type))
const availableSubbranches = computed(() => subbranchesFor(form.branch))

function parseFrontmatter(markdown: string) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return {}

  const meta: Record<string, unknown> = {}
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
      meta[key] = raw.replace(/^"|"$/g, '')
    }
  }
  return meta
}

function stripFrontmatter(markdown: string) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}

function tagsToInput(tags: unknown) {
  return Array.isArray(tags) ? tags.join(' ') : String(tags || '')
}

function fillForm(meta: Record<string, unknown>, body: string) {
  originalMeta.value = meta
  form.title = String(meta.title || '')
  form.branch = String(meta.branch || '待分类')
  form.subbranch = String(meta.subbranch || '')
  form.stage = String(meta.stage || (isDraft.value ? '草稿' : '已整理'))
  form.validity = String(meta.validity || '待验证')
  form.type = String(meta.type || '记录')
  form.project = String(meta.project || '')
  form.confidence = String(meta.confidence || '低')
  form.source = Array.isArray(meta.source) ? String(meta.source[0] || '复盘') : String(meta.source || '复盘')
  form.reviewDate = String(meta.reviewDate || '')
  form.tags = tagsToInput(meta.tags)
  form.summary = String(meta.summary || '')
  form.next = String(meta.next || '')
  form.body = body
}

function mergedFrontmatter() {
  const meta: Record<string, unknown> = { ...originalMeta.value }
  for (const field of frontmatterFields) {
    if (meta[field] === undefined) meta[field] = ''
  }
  meta.title = form.title
  meta.branch = form.branch
  meta.subbranch = form.subbranch
  meta.stage = form.stage
  meta.validity = form.validity
  meta.type = form.type
  meta.project = form.project
  meta.confidence = form.confidence
  meta.source = form.source
  meta.reviewDate = form.reviewDate
  meta.tags = form.tags
  meta.summary = form.summary
  meta.next = form.next
  return meta
}

async function checkHealth() {
  try {
    const health = await getHealth()
    healthOk.value = true
    healthMessage.value = health.deepseekConfigured
      ? `本地 API 已连接，AI 整理使用 ${health.model}。`
      : '本地 API 已连接，但 DeepSeek key 未配置，AI 整理不可用，普通保存仍可用。'
    aiUnavailable.value = !health.deepseekConfigured
  } catch {
    healthOk.value = false
    aiUnavailable.value = true
    healthMessage.value = '本地 API 未连接，请运行 npm run workbench'
  }
}

async function loadContent() {
  loading.value = true
  error.value = ''
  result.value = ''
  archiveLink.value = ''

  try {
    const data = isDraft.value ? await getDraft(slug.value) : await getArticle(collection.value, slug.value)
    const meta = { ...parseFrontmatter(data.markdown), ...data.meta }
    fillForm(meta, stripFrontmatter(data.markdown))
  } catch (err) {
    error.value = err instanceof Error ? err.message : '读取内容失败'
  } finally {
    loading.value = false
  }
}

async function saveContent() {
  if (!canSave.value) return

  saving.value = true
  error.value = ''
  result.value = ''

  const payload = {
    slug: slug.value,
    title: form.title,
    branch: form.branch,
    subbranch: form.subbranch,
    stage: form.stage,
    validity: form.validity,
    type: form.type,
    project: form.project,
    confidence: form.confidence,
    source: form.source,
    reviewDate: form.reviewDate,
    tags: form.tags,
    summary: form.summary,
    next: form.next,
    body: form.body,
    frontmatter: mergedFrontmatter()
  }

  try {
    const data = isDraft.value
      ? await updateDraft(payload)
      : await updateArticle({ ...payload, collection: collection.value })
    result.value = `已保存 ${data.path}，原文件已备份到 ${data.backupPath}`
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存失败，当前输入已保留'
  } finally {
    saving.value = false
  }
}

async function formatCurrentContent() {
  if (!canFormat.value) return

  formatting.value = true
  error.value = ''
  result.value = ''
  aiResult.value = null

  try {
    aiResult.value = await formatDraft({
    rawText: form.body,
    title: form.title,
    branch: form.branch,
    subbranch: form.subbranch
  })
  } catch (err) {
    const apiError = err as Error & { status?: number; reason?: string }
    if (apiError.status === 503 || apiError.reason === 'missing_deepseek_api_key') {
      aiUnavailable.value = true
      error.value = 'AI 整理暂不可用，请在 .env 中配置 DEEPSEEK_API_KEY。'
    } else {
      error.value = err instanceof Error ? err.message : 'AI 整理失败'
    }
  } finally {
    formatting.value = false
  }
}

function applyAiResult() {
  if (!aiResult.value) return

  const aiMeta = {
    ...originalMeta.value,
    ...aiResult.value.suggestedFrontmatter,
    ...parseFrontmatter(aiResult.value.formattedMarkdown)
  }
  aiMeta.category = originalMeta.value.category
  const aiBody = stripFrontmatter(aiResult.value.formattedMarkdown)

  fillForm(aiMeta, aiBody)
  result.value = '已应用 AI 版本到编辑器，尚未保存。'
}

async function archiveCurrentDraft() {
  if (!canArchive.value) return

  if (!archiveTarget.value.collection) {
    error.value = '归档前请先设置知识树主线。'
    return
  }

  const confirmed = window.confirm(
    `确认归档《${form.title || slug.value}》吗？\n知识树位置：${form.branch} / ${form.subbranch || '待分类'}\n存储目录：${archiveTarget.value.dir}`
  )
  if (!confirmed) return

  archiving.value = true
  error.value = ''
  result.value = ''
  archiveLink.value = ''

  try {
    const data = await archiveDraft({
      slug: slug.value,
      branch: form.branch,
      subbranch: form.subbranch,
      type: form.type
    })
    result.value = `已归档到 ${data.archivedPath}，原草稿已备份到 ${data.backupPath}`
    archiveLink.value = data.link
  } catch (err) {
    error.value = err instanceof Error ? err.message : '归档失败，原草稿已保留'
  } finally {
    archiving.value = false
  }
}

onMounted(() => {
  const params = new URLSearchParams(window.location.search)
  slug.value = params.get('file') || ''
  collection.value = params.get('collection') || 'drafts'
  if (!slug.value) {
    loading.value = false
    error.value = '缺少 file 参数，请从草稿箱或知识库进入编辑页'
    return
  }
  checkHealth()
  loadContent()
})
</script>

<template>
  <section class="write-panel edit-panel">
    <p class="api-status" :class="{ ok: healthOk && !aiUnavailable, warn: !healthOk || aiUnavailable }">
      {{ healthMessage }}
    </p>

    <div class="draft-toolbar">
      <p>{{ pageTitle }}</p>
      <a v-if="archiveLink" class="text-link" :href="archiveLink">查看正式文章</a>
      <a v-if="archiveLink" class="text-link" href="/drafts/">返回草稿箱</a>
    </div>

    <p v-if="loading" class="write-result">正在读取内容...</p>
    <p v-if="error" class="write-result error">{{ error }}</p>
    <p v-if="result" class="write-result success">{{ result }}</p>

    <div v-if="!loading && slug" class="write-grid compact-edit-grid">
      <label class="write-field">
        <span>标题</span>
        <input v-model="form.title" type="text" />
      </label>

      <label class="write-field">
        <span>有效性</span>
        <select v-model="form.validity">
          <option v-for="validity in validities" :key="validity">{{ validity }}</option>
        </select>
      </label>

      <label class="write-field">
        <span>所属主线</span>
        <select v-model="form.branch">
          <option v-for="branch in branches" :key="branch">{{ branch }}</option>
        </select>
      </label>

      <label class="write-field">
        <span>子分支</span>
        <select v-model="form.subbranch">
          <option value="">待分类</option>
          <option v-for="subbranch in availableSubbranches" :key="subbranch">{{ subbranch }}</option>
        </select>
      </label>

      <label class="write-field">
        <span>来源</span>
        <select v-model="form.source">
          <option v-for="source in sourceTypes" :key="source">{{ source }}</option>
        </select>
      </label>

      <label class="write-field wide">
        <span>正文内容</span>
        <textarea v-model="form.body" rows="16" />
      </label>
    </div>

    <div v-if="!loading && slug" class="write-actions">
      <button type="button" :disabled="!canSave" @click="saveContent">
        {{ saving ? '保存中...' : '保存修改' }}
      </button>
      <button v-if="isDraft" type="button" class="secondary" :disabled="!canArchive" @click="archiveCurrentDraft">
        {{ archiving ? '归档中...' : '按知识树归档' }}
      </button>
      <button type="button" class="secondary" :disabled="!canFormat" @click="formatCurrentContent">
        {{ formatting ? '整理中...' : 'AI 重新整理' }}
      </button>
      <button type="button" class="secondary" @click="loadContent">重新读取</button>
    </div>

    <section v-if="aiResult" class="ai-preview">
      <div class="ai-preview-header">
        <div>
          <span class="kb-badge warm">AI 整理预览</span>
          <h2>{{ aiResult.suggestedTitle }}</h2>
          <p>{{ aiResult.suggestedSummary }}</p>
        </div>
        <button type="button" @click="applyAiResult">应用到编辑器</button>
      </div>

      <div class="ai-preview-meta">
        <span v-for="tag in aiResult.suggestedTags" :key="tag">{{ tag }}</span>
      </div>

      <pre>{{ aiResult.formattedMarkdown }}</pre>
    </section>
  </section>
</template>
