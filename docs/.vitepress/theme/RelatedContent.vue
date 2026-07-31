<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useData, useRoute } from 'vitepress'
import { listContents, type ContentSummary } from './apiClient'

const { frontmatter } = useData()
const route = useRoute()
const contents = ref<ContentSummary[]>([])
const loading = ref(false)

function normalizePath(value: string) {
  return decodeURIComponent(value || '').replace(/\/$/, '')
}

function score(item: ContentSummary) {
  const currentTags = Array.isArray(frontmatter.value.tags) ? frontmatter.value.tags : []
  return item.tags.filter((tag) => currentTags.includes(tag)).length
}

const currentPath = computed(() => normalizePath(route.path))

const related = computed(() => {
  return contents.value
    .filter((item) => normalizePath(item.link) !== currentPath.value)
    .map((item) => ({ item, score: score(item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((entry) => entry.item)
})

function uniqueTags(item: ContentSummary) {
  return [...new Set(item.tags)]
}

const shouldShow = computed(() => {
  return frontmatter.value.layout !== 'home' && frontmatter.value.hideMeta !== true && related.value.length > 0
})

async function loadContents() {
  loading.value = true
  try {
    const data = await listContents()
    contents.value = (data.contents || []).filter((item) => item.kind === 'article')
  } catch {
    contents.value = []
  } finally {
    loading.value = false
  }
}

onMounted(loadContents)
</script>

<template>
  <section v-if="shouldShow" class="related-panel" aria-label="相关内容">
    <div class="panel-heading">
      <span>相关内容</span>
      <p v-if="loading">读取中...</p>
    </div>
    <div class="related-grid">
      <a v-for="item in related" :key="item.id" class="related-card" :href="item.link">
        <strong>{{ item.title }}</strong>
        <span>{{ item.branch }} / {{ item.subbranch || '待分类' }}</span>
        <p>{{ item.summary || '暂无摘要' }}</p>
        <div class="draft-tags">
          <span v-for="tag in uniqueTags(item).slice(0, 4)" :key="tag">{{ tag }}</span>
        </div>
      </a>
    </div>
  </section>
</template>
