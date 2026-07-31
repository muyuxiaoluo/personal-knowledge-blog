<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vitepress'
import { listContents, type ContentSummary } from './apiClient'

const route = useRoute()
const contents = ref<ContentSummary[]>([])
const loading = ref(true)
const error = ref('')
const selectedBranch = ref('经验整理')
const selectedSubbranch = ref('')

function syncSelection() {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)
  selectedBranch.value = params.get('branch') || selectedBranch.value
  selectedSubbranch.value = params.get('subbranch') || ''
}

const selectedContents = computed(() => {
  return contents.value.filter((item) => {
    if (item.branch !== selectedBranch.value) return false
    if (!selectedSubbranch.value) return true
    return (item.subbranch || '待分类') === selectedSubbranch.value
  })
})

async function loadContents() {
  loading.value = true
  error.value = ''
  try {
    const data = await listContents()
    contents.value = data.contents || []
    syncSelection()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '读取知识树失败'
  } finally {
    loading.value = false
  }
}

onMounted(loadContents)
watch(() => route.path, syncSelection)

function openContent(link: string) {
  window.location.href = link
}

function cleanTag(tag: string) {
  return String(tag || '').trim().replace(/\\+/g, '').replace(/^"+|"+$/g, '')
}

function displayTags(item: ContentSummary) {
  return [...new Set(item.tags.map(cleanTag).filter(Boolean))]
}
</script>

<template>
  <section class="knowledge-tree-content">
    <main class="content-panel">
      <div class="panel-heading large">
        <div>
          <span>{{ selectedBranch }}</span>
          <h2>{{ selectedSubbranch || '全部内容' }}</h2>
        </div>
        <p>{{ selectedContents.length }} 篇</p>
      </div>

      <div v-if="!loading && selectedContents.length === 0" class="empty-state">
        <h2>这个分支还没有内容</h2>
        <p>从写入页保存草稿，或在管理页把旧内容补上 branch/subbranch</p>
      </div>

      <div class="content-card-grid">
        <article
          v-for="item in selectedContents"
          :key="item.id"
          class="content-card clickable"
          role="link"
          tabindex="0"
          @click="openContent(item.link)"
          @keydown.enter="openContent(item.link)"
        >
          <h3>{{ item.title }}</h3>
          <p>{{ item.summary || '暂无摘要' }}</p>
          <div class="content-meta-row">
            <span>{{ item.updated || item.created || '未记录时间' }}</span>
          </div>
          <div class="draft-tags">
            <span v-for="tag in displayTags(item)" :key="tag">{{ tag }}</span>
          </div>
        </article>
      </div>
    </main>
  </section>
</template>
