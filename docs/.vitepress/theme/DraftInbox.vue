<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { archiveDraft, deleteDraft, formatDraft, getDraft, getHealth, listDrafts, type DraftSummary } from './apiClient'
import { archiveTargetFor } from './contentSchema'

const drafts = ref<DraftSummary[]>([])
const selectedDraft = ref<DraftSummary | null>(null)
const selectedTitle = ref('')
const selectedMarkdown = ref('')
const formattedMarkdown = ref('')
const loading = ref(true)
const formatting = ref(false)
const formattingSlug = ref('')
const deletingSlug = ref('')
const archivingSlug = ref('')
const error = ref('')
const success = ref('')
const formatError = ref('')
const healthMessage = ref('')
const healthOk = ref(false)
const aiUnavailable = ref(false)
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

async function loadDrafts() {
  loading.value = true
  error.value = ''
  try {
    const data = await listDrafts()
    drafts.value = data.drafts || []
  } catch (err) {
    error.value = err instanceof Error ? err.message : '读取草稿失败'
  } finally {
    loading.value = false
  }
}

function editLink(draft: DraftSummary) {
  return `/edit?file=${encodeURIComponent(draft.slug)}`
}

async function openDraft(draft: DraftSummary) {
  selectedDraft.value = draft
  selectedTitle.value = draft.title
  selectedMarkdown.value = ''
  formattedMarkdown.value = ''
  formatError.value = ''
  try {
    const data = await getDraft(draft.slug)
    selectedMarkdown.value = data.markdown
  } catch (err) {
    selectedMarkdown.value = err instanceof Error ? err.message : '读取草稿内容失败'
  }
}

async function formatDraftForDraft(draft: DraftSummary) {
  if (formatting.value || aiUnavailable.value) return

  formatting.value = true
  formattingSlug.value = draft.slug
  formatError.value = ''
  formattedMarkdown.value = ''

  try {
    const data = selectedDraft.value?.slug === draft.slug && selectedMarkdown.value
      ? { markdown: selectedMarkdown.value }
      : await getDraft(draft.slug)

    selectedDraft.value = draft
    selectedTitle.value = draft.title
    selectedMarkdown.value = data.markdown

    const result = await formatDraft({
      rawText: data.markdown,
      title: draft.title,
      type: draft.type,
      branch: draft.branch,
      subbranch: draft.subbranch,
      project: draft.project,
      tags: draft.tags.join(' ')
    })
    formattedMarkdown.value = result.formattedMarkdown
  } catch (err) {
    const apiError = err as Error & { status?: number; reason?: string }
    if (apiError.status === 503 || apiError.reason === 'missing_deepseek_api_key') {
      aiUnavailable.value = true
      formatError.value = 'AI 整理暂不可用'
    } else {
      formatError.value = err instanceof Error ? err.message : 'AI 整理失败'
    }
  } finally {
    formatting.value = false
    formattingSlug.value = ''
  }
}

async function deleteSelectedDraft(draft: DraftSummary) {
  if (deletingSlug.value) return

  const confirmed = window.confirm(`确认删除草稿《${draft.title}》吗？它会移动到 docs/.trash/，不会永久删除。`)
  if (!confirmed) return

  deletingSlug.value = draft.slug
  error.value = ''
  success.value = ''

  try {
    const result = await deleteDraft(draft.slug)
    success.value = `已移动到 ${result.path}`
    if (selectedDraft.value?.slug === draft.slug) {
      selectedDraft.value = null
      selectedTitle.value = ''
      selectedMarkdown.value = ''
      formattedMarkdown.value = ''
      formatError.value = ''
    }
    await loadDrafts()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '删除草稿失败'
  } finally {
    deletingSlug.value = ''
  }
}

async function archiveSelectedDraft(draft: DraftSummary) {
  if (archivingSlug.value) return

  const target = archiveTargetFor(draft.branch || '待分类', draft.subbranch || '', draft.type)
  if (!target.collection) {
    error.value = '归档前请先进入编辑页，设置知识树主线。'
    return
  }

  const confirmed = window.confirm(
    `确认归档《${draft.title}》吗？\n知识树位置：${draft.branch || '待分类'} / ${draft.subbranch || '待分类'}\n存储目录：${target.dir}`
  )
  if (!confirmed) return

  archivingSlug.value = draft.slug
  error.value = ''
  success.value = ''

  try {
    const result = await archiveDraft({
      slug: draft.slug,
      branch: draft.branch,
      subbranch: draft.subbranch,
      type: draft.type
    })
    success.value = `已归档到 ${result.archivedPath}，可打开 ${result.link} 查看。`
    if (selectedDraft.value?.slug === draft.slug) {
      selectedDraft.value = null
      selectedTitle.value = ''
      selectedMarkdown.value = ''
      formattedMarkdown.value = ''
      formatError.value = ''
    }
    await loadDrafts()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '归档失败，原草稿已保留'
  } finally {
    archivingSlug.value = ''
  }
}

onMounted(() => {
  checkHealth()
  loadDrafts()
})
</script>

<template>
  <section class="draft-inbox">
    <p class="api-status" :class="{ ok: healthOk && !aiUnavailable, warn: !healthOk || aiUnavailable }">
      {{ healthMessage }}
    </p>

    <div class="draft-toolbar">
      <p>{{ loading ? '正在读取草稿...' : `共 ${drafts.length} 条草稿` }}</p>
      <button type="button" @click="loadDrafts">刷新</button>
    </div>

    <p v-if="error" class="write-result error">{{ error }}。请确认已运行 npm run api 或 npm run workbench。</p>
    <p v-if="success" class="write-result success">{{ success }}</p>

    <div v-if="!loading && drafts.length === 0 && !error" class="empty-state">
      <h2>草稿箱暂时是空的</h2>
      <p>去写入页保存第一条经验，它会出现在这里。</p>
      <a class="kb-card" href="/write">写一条新经验</a>
    </div>

    <div class="draft-grid">
      <article v-for="draft in drafts" :key="draft.slug" class="draft-card">
        <span class="draft-date">{{ draft.created || '待补充日期' }}</span>
        <strong>{{ draft.title }}</strong>
        <span class="draft-summary">{{ draft.summary || '暂无摘要' }}</span>
        <span class="draft-meta">
          <span>{{ draft.branch || '待分类' }}</span>
          <span>{{ draft.subbranch || '待分类' }}</span>
          <span>{{ draft.type || '未分类' }}</span>
          <span>{{ draft.project || '无关联项目' }}</span>
        </span>
        <span class="draft-tags">
          <span v-for="tag in draft.tags" :key="tag">{{ tag }}</span>
        </span>
        <span class="draft-card-actions">
          <button type="button" @click="openDraft(draft)">查看</button>
          <a :href="editLink(draft)">编辑</a>
          <button type="button" :disabled="archivingSlug === draft.slug" @click="archiveSelectedDraft(draft)">
            {{ archivingSlug === draft.slug ? '归档中...' : '归档' }}
          </button>
          <button type="button" :disabled="formatting || aiUnavailable" @click="formatDraftForDraft(draft)">
            {{ formattingSlug === draft.slug ? '整理中...' : 'AI 整理' }}
          </button>
          <button type="button" class="danger" :disabled="deletingSlug === draft.slug" @click="deleteSelectedDraft(draft)">
            {{ deletingSlug === draft.slug ? '删除中...' : '删除' }}
          </button>
        </span>
      </article>
    </div>

    <article v-if="selectedMarkdown" class="draft-preview">
      <div class="draft-preview-header">
        <h2>{{ selectedTitle }}</h2>
        <button
          type="button"
          :disabled="formatting || aiUnavailable || !selectedDraft"
          @click="selectedDraft && formatDraftForDraft(selectedDraft)"
        >
          {{ formatting ? '整理中...' : formattedMarkdown ? 'AI 重新整理' : 'AI 重新整理' }}
        </button>
      </div>
      <p v-if="formatError" class="write-result error">
        {{ formatError }}<span v-if="aiUnavailable">，请在 .env 中配置 DEEPSEEK_API_KEY。</span>
      </p>
      <pre>{{ selectedMarkdown }}</pre>
    </article>

    <article v-if="formattedMarkdown" class="draft-preview ai-preview">
      <h2>AI 整理预览</h2>
      <pre>{{ formattedMarkdown }}</pre>
    </article>
  </section>
</template>
