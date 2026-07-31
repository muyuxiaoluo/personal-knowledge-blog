<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useData } from 'vitepress'
import { listContents, type ContentSummary } from './apiClient'

const props = withDefaults(
  defineProps<{
    project?: string
  }>(),
  {
    project: ''
  }
)

const { frontmatter } = useData()
const contents = ref<ContentSummary[]>([])
const loading = ref(true)
const error = ref('')

const projectName = computed(() => props.project || String(frontmatter.value.project || frontmatter.value.title || ''))

const related = computed(() => {
  return contents.value.filter((item) => item.project === projectName.value)
})

function byType(types: string[]) {
  return related.value.filter((item) => types.includes(item.type))
}

const experiences = computed(() => byType(['记录', '评测', '思考']))
const reviews = computed(() => byType(['复盘']))
const templates = computed(() => byType(['模板']))

async function loadContents() {
  loading.value = true
  error.value = ''
  try {
    const data = await listContents()
    contents.value = (data.contents || []).filter((item) => item.kind === 'article')
  } catch (err) {
    error.value = err instanceof Error ? err.message : '读取项目内容失败'
  } finally {
    loading.value = false
  }
}

onMounted(loadContents)
</script>

<template>
  <section class="project-hub">
    <div class="panel-heading large">
      <div>
        <span>项目档案</span>
        <h2>{{ projectName }}</h2>
      </div>
      <p>{{ loading ? '读取中...' : `${related.length} 条关联内容` }}</p>
    </div>
    <p v-if="error" class="write-result error">{{ error }}</p>

    <div class="project-hub-grid">
      <section class="project-bucket">
        <h3>相关经验</h3>
        <a v-for="item in experiences" :key="item.id" :href="item.link">{{ item.title }}</a>
        <p v-if="!experiences.length" class="muted-text">暂无关联经验</p>
      </section>
      <section class="project-bucket">
        <h3>相关复盘</h3>
        <a v-for="item in reviews" :key="item.id" :href="item.link">{{ item.title }}</a>
        <p v-if="!reviews.length" class="muted-text">暂无关联复盘</p>
      </section>
      <section class="project-bucket">
        <h3>相关模板</h3>
        <a v-for="item in templates" :key="item.id" :href="item.link">{{ item.title }}</a>
        <p v-if="!templates.length" class="muted-text">暂无关联模板</p>
      </section>
    </div>
  </section>
</template>
