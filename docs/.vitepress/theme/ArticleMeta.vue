<script setup lang="ts">
import { computed } from 'vue'
import { useData } from 'vitepress'

const { frontmatter } = useData()

function formatValue(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10)
  }

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return value.slice(0, 10)
  }

  return String(value)
}

const items = computed(() => {
  const data = frontmatter.value
  return [
    ['主线', data.branch],
    ['子分支', data.subbranch],
    ['有效性', data.validity],
    ['来源', data.source],
    ['更新', data.updated || data.created]
  ]
    .filter((item): item is [string, unknown] => item[1] !== undefined && item[1] !== null && item[1] !== '')
    .map(([label, value]) => [label, formatValue(value)] as [string, string])
})

const breadcrumb = computed(() => {
  const data = frontmatter.value
  return ['人生攻略库', data.branch, data.subbranch, data.title].filter(Boolean).map(formatValue)
})

const shouldShow = computed(() => {
  return frontmatter.value.layout !== 'home' && frontmatter.value.hideMeta !== true && items.value.length > 0
})
</script>

<template>
  <section v-if="shouldShow" class="article-meta-panel" aria-label="文章元信息">
    <nav class="article-breadcrumb" aria-label="当前位置">
      <span v-for="(item, index) in breadcrumb" :key="`${item}-${index}`">
        {{ item }}
      </span>
    </nav>
    <div class="article-meta-grid">
      <span v-for="[label, value] in items" :key="label" class="article-meta-chip">
        <span class="article-meta-label">{{ label }}</span>
        <span class="article-meta-value">{{ value }}</span>
      </span>
    </div>
  </section>
</template>
