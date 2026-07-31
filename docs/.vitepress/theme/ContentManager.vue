<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import {
  deleteContent,
  formatDraft,
  getContent,
  getHealth,
  listContents,
  updateContent,
  type ContentSummary
} from './apiClient'
import { branches, subbranchesFor, validities } from './contentSchema'

const contents = ref<ContentSummary[]>([])
const loading = ref(true)
const error = ref('')
const success = ref('')
const query = ref('')
const activeBranch = ref('')
const aiUnavailable = ref(false)
const healthMessage = ref('')
const busyId = ref('')
const contentDrafts = reactive<Record<string, { branch: string; subbranch: string; validity: string }>>({})
const aiPreview = ref<null | {
  id: string
  title: string
  summary: string
  markdown: string
}>(null)

function stripFrontmatter(markdown: string) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}

function parseFrontmatter(markdown: string) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const meta: Record<string, unknown> = {}
  if (!match) return meta
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index === -1) continue
    const key = line.slice(0, index).trim()
    const raw = line.slice(index + 1).trim()
    meta[key] = raw.startsWith('[') && raw.endsWith(']')
      ? raw.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean)
      : raw
  }
  return meta
}

function initLocalState(item: ContentSummary) {
  contentDrafts[item.id] = {
    branch: item.branch,
    subbranch: item.subbranch,
    validity: item.validity
  }
}

function cleanTag(tag: string) {
  return String(tag || '').trim().replace(/\\+/g, '').replace(/^"+|"+$/g, '')
}

function displayTags(item: ContentSummary) {
  return [...new Set(item.tags.map(cleanTag).filter(Boolean))]
}

function displayDate(item: ContentSummary) {
  return item.updated || item.created || '未记录时间'
}

function resetSubbranch(item: ContentSummary) {
  contentDrafts[item.id].subbranch = ''
}

function countItems(field: 'branch', value: string) {
  return contents.value.filter((item) => item[field] === value).length
}

const filteredContents = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contents.value.filter((item) => {
    if (activeBranch.value && item.branch !== activeBranch.value) return false
    if (!keyword) return true

    const haystack = [
      item.title,
      item.summary,
      item.branch,
      item.subbranch,
      item.validity,
      displayTags(item).join(' ')
    ].join(' ').toLowerCase()
    return haystack.includes(keyword)
  })
})

async function checkHealth() {
  try {
    const health = await getHealth()
    aiUnavailable.value = !health.deepseekConfigured
    healthMessage.value = health.deepseekConfigured
      ? `本地 API 已连接，AI 整理使用 ${health.model}。`
      : '本地 API 已连接，但 DeepSeek key 未配置，AI 整理不可用。'
  } catch {
    aiUnavailable.value = true
    healthMessage.value = '本地 API 未连接，请运行 npm run workbench。'
  }
}

async function loadContents() {
  loading.value = true
  error.value = ''
  try {
    const data = await listContents()
    contents.value = data.contents || []
    contents.value.forEach(initLocalState)
  } catch (err) {
    error.value = err instanceof Error ? err.message : '读取内容失败'
  } finally {
    loading.value = false
  }
}

async function saveAdjustments(item: ContentSummary) {
  const draft = contentDrafts[item.id]
  if (!draft) return
  busyId.value = item.id
  error.value = ''
  success.value = ''
  try {
    const result = await updateContent({
      id: item.id,
      branch: draft.branch,
      subbranch: draft.subbranch,
      validity: draft.validity
    })
    success.value = `已保存知识树位置，备份到 ${result.backupPath}`
    await loadContents()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存调整失败'
  } finally {
    busyId.value = ''
  }
}

async function removeContent(item: ContentSummary) {
  const confirmed = window.confirm(`确认删除《${item.title}》吗？它会移动到 docs/.trash/，不会永久删除。`)
  if (!confirmed) return
  busyId.value = item.id
  error.value = ''
  success.value = ''
  try {
    const result = await deleteContent(item.id)
    success.value = `已移动到 ${result.path}`
    await loadContents()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '删除失败'
  } finally {
    busyId.value = ''
  }
}

async function previewAi(item: ContentSummary) {
  if (aiUnavailable.value) return
  busyId.value = item.id
  error.value = ''
  success.value = ''
  aiPreview.value = null
  try {
    const detail = await getContent(item.id)
    const result = await formatDraft({
      rawText: detail.content.body,
      title: item.title,
      branch: item.branch,
      subbranch: item.subbranch
    })
    aiPreview.value = {
      id: item.id,
      title: result.suggestedTitle,
      summary: result.suggestedSummary,
      markdown: result.formattedMarkdown
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'AI 整理失败'
  } finally {
    busyId.value = ''
  }
}

async function applyAiPreview() {
  if (!aiPreview.value) return
  busyId.value = aiPreview.value.id
  error.value = ''
  success.value = ''
  try {
    const meta = parseFrontmatter(aiPreview.value.markdown)
    const body = stripFrontmatter(aiPreview.value.markdown)
    const result = await updateContent({
      id: aiPreview.value.id,
      frontmatter: meta,
      body
    })
    success.value = `已应用 AI 版本，备份到 ${result.backupPath}`
    aiPreview.value = null
    await loadContents()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '应用 AI 版本失败'
  } finally {
    busyId.value = ''
  }
}

onMounted(() => {
  checkHealth()
  loadContents()
})
</script>

<template>
  <section class="manage-panel">
    <p class="api-status" :class="{ warn: aiUnavailable }">{{ healthMessage }}</p>

    <div class="manager-toolbar">
      <input v-model="query" type="search" placeholder="搜索标题、摘要、标签..." />
      <button type="button" @click="loadContents">刷新</button>
    </div>

    <div class="manage-filter-panel" aria-label="内容筛选">
      <div class="manage-filter-group">
        <span>主线</span>
        <button type="button" :class="{ active: !activeBranch }" @click="activeBranch = ''">全部</button>
        <button
          v-for="branch in branches"
          :key="branch"
          type="button"
          :class="{ active: activeBranch === branch }"
          @click="activeBranch = branch"
        >
          {{ branch }} <em>{{ countItems('branch', branch) }}</em>
        </button>
      </div>
    </div>

    <p v-if="loading" class="write-result">正在读取内容...</p>
    <p v-if="error" class="write-result error">{{ error }}</p>
    <p v-if="success" class="write-result success">{{ success }}</p>

    <div class="manage-list">
      <article v-for="item in filteredContents" :key="item.id" class="manage-row">
        <span class="manage-date">{{ displayDate(item) }}</span>
        <div class="manage-main">
          <div class="content-card-top">
            <span class="kb-badge warm">{{ item.branch }}</span>
            <span class="kb-badge">{{ item.subbranch || '待分类' }}</span>
          </div>
          <h3>{{ item.title }}</h3>
          <p>{{ item.summary || '暂无摘要' }}</p>
          <div class="draft-tags">
            <span v-for="tag in displayTags(item)" :key="tag">{{ tag }}</span>
          </div>
        </div>

        <div class="manage-controls">
          <label>
            <span>有效性</span>
            <select v-model="contentDrafts[item.id].validity">
              <option v-for="validity in validities" :key="validity">{{ validity }}</option>
            </select>
          </label>
          <label>
            <span>主线</span>
            <select v-model="contentDrafts[item.id].branch" @change="resetSubbranch(item)">
              <option v-for="branch in branches" :key="branch">{{ branch }}</option>
            </select>
          </label>
          <label>
            <span>子分支</span>
            <select v-model="contentDrafts[item.id].subbranch">
              <option value="">待分类</option>
              <option v-for="subbranch in subbranchesFor(contentDrafts[item.id].branch)" :key="subbranch">
                {{ subbranch }}
              </option>
            </select>
          </label>
        </div>

        <div class="manage-actions">
          <a :href="item.link">查看</a>
          <a :href="item.editLink">编辑</a>
          <button type="button" :disabled="busyId === item.id" @click="saveAdjustments(item)">保存调整</button>
          <button type="button" :disabled="aiUnavailable || busyId === item.id" @click="previewAi(item)">AI 整理</button>
          <button type="button" class="danger" :disabled="busyId === item.id" @click="removeContent(item)">删除</button>
        </div>
      </article>
    </div>

    <section v-if="aiPreview" class="ai-preview">
      <div class="ai-preview-header">
        <div>
          <span class="kb-badge warm">AI 整理预览</span>
          <h2>{{ aiPreview.title }}</h2>
          <p>{{ aiPreview.summary }}</p>
        </div>
        <button type="button" :disabled="busyId === aiPreview.id" @click="applyAiPreview">确认应用</button>
      </div>
      <pre>{{ aiPreview.markdown }}</pre>
    </section>
  </section>
</template>
