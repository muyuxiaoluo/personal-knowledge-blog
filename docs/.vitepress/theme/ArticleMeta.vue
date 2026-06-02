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
    ['阶段', data.stage],
    ['有效性', data.validity],
    ['类型', data.type],
    ['项目', data.project],
    ['置信度', data.confidence],
    ['复查', data.reviewDate]
  ]
    .filter((item): item is [string, unknown] => Boolean(item[1]))
    .map(([label, value]) => [label, formatValue(value)] as [string, string])
})

const shouldShow = computed(() => {
  return frontmatter.value.layout !== 'home' && frontmatter.value.hideMeta !== true && items.value.length > 0
})
</script>

<template>
  <section v-if="shouldShow" class="article-meta-panel" aria-label="文章元信息">
    <span v-for="[label, value] in items" :key="label" class="article-meta-chip">
      <span class="article-meta-label">{{ label }}</span>
      <span class="article-meta-value">{{ value }}</span>
    </span>
  </section>
</template>
