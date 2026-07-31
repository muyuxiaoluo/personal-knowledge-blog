<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { listContents, type ContentSummary } from './apiClient'
import { branches, contentTypes, stages, validities } from './contentSchema'

const contents = ref<ContentSummary[]>([])
const loading = ref(true)
const error = ref('')
const today = new Date().toISOString().slice(0, 10)
const filters = reactive({
  keyword: '',
  branch: '',
  subbranch: '',
  project: '',
  type: '',
  stage: '',
  validity: '',
  tag: '',
  startDate: '',
  endDate: '',
  dueOnly: false
})

function isReviewContent(item: ContentSummary) {
  if (item.collection === 'reviews') return true
  if (item.branch === '复盘记录') return true
  if ((item.collection === 'tools' || item.collection === 'thoughts') && ['复盘', '评测'].includes(item.type)) return true
  return false
}

function matchesKeyword(item: ContentSummary) {
  const keyword = filters.keyword.trim().toLowerCase()
  if (!keyword) return true
  const haystack = [
    item.title,
    item.summary,
    item.branch,
    item.subbranch,
    item.project,
    item.type,
    item.stage,
    item.validity,
    item.tags.join(' ')
  ].join(' ').toLowerCase()
  return haystack.includes(keyword)
}

function withinDateRange(item: ContentSummary) {
  const date = item.updated || item.created
  if (filters.startDate && (!date || date < filters.startDate)) return false
  if (filters.endDate && (!date || date > filters.endDate)) return false
  return true
}

const projects = computed(() => {
  return [...new Set(contents.value.map((item) => item.project).filter(Boolean))].sort()
})

const tags = computed(() => {
  return [...new Set(contents.value.flatMap((item) => item.tags))].sort()
})

const subbranches = computed(() => {
  return [...new Set(contents.value.map((item) => item.subbranch).filter(Boolean))].sort()
})

const results = computed(() => {
  return contents.value.filter((item) => {
    if (!isReviewContent(item)) return false
    if (!matchesKeyword(item)) return false
    if (filters.branch && item.branch !== filters.branch) return false
    if (filters.subbranch && item.subbranch !== filters.subbranch) return false
    if (filters.project && item.project !== filters.project) return false
    if (filters.type && item.type !== filters.type) return false
    if (filters.stage && item.stage !== filters.stage) return false
    if (filters.validity && item.validity !== filters.validity) return false
    if (filters.tag && !item.tags.includes(filters.tag)) return false
    if (filters.dueOnly && (!item.reviewDate || item.reviewDate > today)) return false
    return withinDateRange(item)
  })
})

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function highlight(value: string) {
  const text = escapeHtml(value || '')
  const keyword = filters.keyword.trim()
  if (!keyword) return text
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(escaped, 'gi'), (match) => `<mark>${match}</mark>`)
}

function resetFilters() {
  filters.keyword = ''
  filters.branch = ''
  filters.subbranch = ''
  filters.project = ''
  filters.type = ''
  filters.stage = ''
  filters.validity = ''
  filters.tag = ''
  filters.startDate = ''
  filters.endDate = ''
  filters.dueOnly = false
}

async function loadContents() {
  loading.value = true
  error.value = ''
  try {
    const data = await listContents()
    contents.value = data.contents || []
  } catch (err) {
    error.value = err instanceof Error ? err.message : '读取复盘内容失败'
  } finally {
    loading.value = false
  }
}

onMounted(loadContents)
</script>

<template>
  <section class="review-search-panel">
    <div class="search-filters">
      <label class="wide">
        <span>关键词</span>
        <input v-model="filters.keyword" type="search" placeholder="搜索标题、摘要、标签、项目..." />
      </label>
      <label>
        <span>主线</span>
        <select v-model="filters.branch">
          <option value="">全部</option>
          <option v-for="branch in branches" :key="branch">{{ branch }}</option>
        </select>
      </label>
      <label>
        <span>子分支</span>
        <select v-model="filters.subbranch">
          <option value="">全部</option>
          <option v-for="subbranch in subbranches" :key="subbranch">{{ subbranch }}</option>
        </select>
      </label>
      <label>
        <span>项目</span>
        <select v-model="filters.project">
          <option value="">全部</option>
          <option v-for="project in projects" :key="project">{{ project }}</option>
        </select>
      </label>
      <label>
        <span>类型</span>
        <select v-model="filters.type">
          <option value="">全部</option>
          <option v-for="type in contentTypes" :key="type">{{ type }}</option>
        </select>
      </label>
      <label>
        <span>阶段</span>
        <select v-model="filters.stage">
          <option value="">全部</option>
          <option v-for="stage in stages" :key="stage">{{ stage }}</option>
        </select>
      </label>
      <label>
        <span>有效性</span>
        <select v-model="filters.validity">
          <option value="">全部</option>
          <option v-for="validity in validities" :key="validity">{{ validity }}</option>
        </select>
      </label>
      <label>
        <span>标签</span>
        <select v-model="filters.tag">
          <option value="">全部</option>
          <option v-for="tag in tags" :key="tag">{{ tag }}</option>
        </select>
      </label>
      <label>
        <span>开始</span>
        <input v-model="filters.startDate" type="date" />
      </label>
      <label>
        <span>结束</span>
        <input v-model="filters.endDate" type="date" />
      </label>
      <label class="checkline">
        <input v-model="filters.dueOnly" type="checkbox" />
        <span>只看复查到期</span>
      </label>
      <button type="button" @click="resetFilters">清空筛选</button>
    </div>

    <div class="draft-toolbar">
      <p>{{ loading ? '正在读取复盘...' : `共 ${results.length} 条结果` }}</p>
      <button type="button" @click="loadContents">刷新</button>
    </div>

    <p v-if="error" class="write-result error">{{ error }}。请确认已运行 npm run workbench。</p>

    <div v-if="!loading && results.length === 0 && !error" class="empty-state">
      <h2>没有匹配的复盘内容</h2>
      <p>换一组筛选条件，或先从写入页记录一条复盘。</p>
    </div>

    <div class="content-card-grid">
      <article v-for="item in results" :key="item.id" class="content-card">
        <div class="content-card-top">
          <span class="kb-badge warm">{{ item.branch }}</span>
          <span class="kb-badge">{{ item.subbranch || '待分类' }}</span>
          <span class="kb-badge">{{ item.type }}</span>
          <span class="kb-badge">{{ item.validity }}</span>
        </div>
        <h3><a :href="item.link" v-html="highlight(item.title)"></a></h3>
        <p v-html="highlight(item.summary || '暂无摘要')"></p>
        <div class="content-meta-row">
          <span>{{ item.stage }}</span>
          <span>{{ item.updated || item.created || '未记录时间' }}</span>
          <span>{{ item.reviewDate ? `复查 ${item.reviewDate}` : '未设复查' }}</span>
        </div>
        <div class="draft-tags">
          <span v-for="tag in item.tags" :key="tag">{{ tag }}</span>
        </div>
      </article>
    </div>
  </section>
</template>
