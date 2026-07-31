<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { formatDraft as formatDraftApi, getHealth, saveDraft as saveDraftApi } from './apiClient'
import { branches, contentTypes, subbranchesFor } from './contentSchema'

const form = reactive({
  title: '',
  branch: '经验整理',
  subbranch: '工具经验',
  type: '记录',
  project: '个人知识库博客',
  tags: '',
  content: '',
  formatMode: '保守整理'
})

const formatModes = ['保守整理', '深度复盘', '工具评测', '学习笔记', '技术问题记录', '思考随笔', '提示词收藏']

const saving = ref(false)
const formatting = ref(false)
const result = ref('')
const error = ref('')
const aiUnavailable = ref(false)
const healthMessage = ref('')
const healthOk = ref(false)
const aiResult = ref<null | {
  formattedMarkdown: string
  suggestedTitle: string
  suggestedSummary: string
  suggestedTags: string[]
  suggestedNext: string
}>(null)

const availableSubbranches = computed(() => subbranchesFor(form.branch))
const canSave = computed(() => form.content.trim().length > 0 && !saving.value)
const canFormat = computed(() => form.content.trim().length > 0 && !formatting.value && !aiUnavailable.value)

watch(
  () => form.branch,
  () => {
    form.subbranch = availableSubbranches.value[0] || ''
  }
)

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

async function saveDraft(mode: 'raw' | 'ai' = 'raw') {
  if (!canSave.value) return

  saving.value = true
  result.value = ''
  error.value = ''

  try {
    const data = await saveDraftApi({
      ...form,
      title: mode === 'ai' ? aiResult.value?.suggestedTitle || form.title : form.title,
      formattedMarkdown: mode === 'ai' ? aiResult.value?.formattedMarkdown : undefined
    })

    result.value = `已保存到 ${data.path}`
    form.title = ''
    form.tags = ''
    form.content = ''
    aiResult.value = null
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存失败'
  } finally {
    saving.value = false
  }
}

async function formatDraft() {
  if (!canFormat.value) return

  formatting.value = true
  result.value = ''
  error.value = ''
  aiUnavailable.value = false

  try {
    aiResult.value = await formatDraftApi({
      rawText: form.content,
      title: form.title,
      type: form.type,
      branch: form.branch,
      subbranch: form.subbranch,
      project: form.project,
      tags: form.tags,
      mode: form.formatMode
    })
  } catch (err) {
    const apiError = err as Error & { status?: number; reason?: string }
    if (apiError.status === 503 || apiError.reason === 'missing_deepseek_api_key') {
      aiUnavailable.value = true
      error.value = 'AI 整理暂不可用'
    } else {
      error.value = err instanceof Error ? err.message : 'AI 整理失败'
    }
  } finally {
    formatting.value = false
  }
}

onMounted(checkHealth)
</script>

<template>
  <section class="write-panel">
    <p class="api-status" :class="{ ok: healthOk && !aiUnavailable, warn: !healthOk || aiUnavailable }">
      {{ healthMessage }}
    </p>

    <div class="write-grid">
      <label class="write-field">
        <span>标题，可选</span>
        <input v-model="form.title" type="text" placeholder="留空时会自动生成未命名经验" />
      </label>

      <label class="write-field">
        <span>内容类型</span>
        <select v-model="form.type">
          <option v-for="type in contentTypes" :key="type">{{ type }}</option>
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
        <span>关联项目</span>
        <input v-model="form.project" type="text" placeholder="例如：AI 辅助学习工作流" />
      </label>

      <label class="write-field">
        <span>AI 整理模式</span>
        <select v-model="form.formatMode">
          <option v-for="mode in formatModes" :key="mode">{{ mode }}</option>
        </select>
      </label>

      <label class="write-field wide">
        <span>标签</span>
        <input v-model="form.tags" type="text" placeholder="用空格、逗号或顿号分隔，例如：AI 学习 复盘" />
      </label>

      <label class="write-field wide">
        <span>原始经验描述</span>
        <textarea
          v-model="form.content"
          rows="12"
          placeholder="直接用自然语言写：发生了什么、为什么重要、你尝试了什么、现在怎么判断、下一步想做什么。"
        />
      </label>
    </div>

    <div class="write-actions">
      <button type="button" :disabled="!canSave" @click="saveDraft('raw')">
        {{ saving ? '保存中...' : '继续保存原始草稿' }}
      </button>
      <button type="button" class="secondary" :disabled="!canFormat" @click="formatDraft">
        {{ formatting ? '整理中...' : aiResult ? '重新整理' : 'AI 整理' }}
      </button>
      <p v-if="result" class="write-result success">{{ result }}</p>
      <p v-if="error" class="write-result error">
        {{ error }}<span v-if="aiUnavailable">，请在 .env 中配置 DEEPSEEK_API_KEY。</span
        ><span v-else>。请确认已运行 npm run api 或 npm run workbench。</span>
      </p>
    </div>

    <section v-if="aiResult" class="ai-preview">
      <div class="ai-preview-header">
        <div>
          <span class="kb-badge warm">AI 整理预览</span>
          <h2>{{ aiResult.suggestedTitle }}</h2>
          <p>{{ aiResult.suggestedSummary }}</p>
        </div>
        <button type="button" :disabled="saving" @click="saveDraft('ai')">
          {{ saving ? '保存中...' : '使用 AI 版本保存' }}
        </button>
      </div>

      <div class="ai-preview-meta">
        <span v-for="tag in aiResult.suggestedTags" :key="tag">{{ tag }}</span>
      </div>

      <p class="ai-next">下一步：{{ aiResult.suggestedNext }}</p>

      <pre>{{ aiResult.formattedMarkdown }}</pre>
    </section>
  </section>
</template>
