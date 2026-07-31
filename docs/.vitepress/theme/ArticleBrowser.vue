<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { deleteContent, listArticles, type ArticleSummary } from './apiClient'

const props = withDefaults(
  defineProps<{
    mode?: 'library' | 'review' | 'project'
    collection?: string
    project?: string
    limit?: number
  }>(),
  {
    mode: 'library',
    collection: '',
    project: '',
    limit: 0
  }
)

const articles = ref<ArticleSummary[]>([])
const loading = ref(true)
const error = ref('')
const deletingId = ref('')

function isDue(dateText: string) {
  return Boolean(dateText) && dateText <= new Date().toISOString().slice(0, 10)
}

function needsReview(article: ArticleSummary) {
  const weakValidity = article.validity === '待验证' || article.validity === '部分有效'
  const staleNext = Boolean(article.next) && (!article.updated || article.updateCount === 0)
  return weakValidity || isDue(article.reviewDate) || staleNext
}

const filteredArticles = computed(() => {
  let result = articles.value

  if (props.collection) {
    result = result.filter((article) => article.collection === props.collection)
  }

  if (props.mode === 'project' && props.project) {
    result = result.filter((article) => article.project === props.project)
  }

  if (props.mode === 'review') {
    result = result.filter(needsReview)
  }

  if (props.limit > 0) {
    result = result.slice(0, props.limit)
  }

  return result
})

function editLink(article: ArticleSummary) {
  return `/edit?collection=${encodeURIComponent(article.collection)}&file=${encodeURIComponent(article.slug)}`
}

function articleId(article: ArticleSummary) {
  return `${article.collection}/${article.slug}`
}

function cleanTag(tag: string) {
  return String(tag || '').trim().replace(/\\+/g, '').replace(/^"+|"+$/g, '')
}

function displayTags(article: ArticleSummary) {
  return [...new Set(article.tags.map(cleanTag).filter(Boolean))]
}

function openArticle(article: ArticleSummary) {
  window.location.href = article.link
}

async function removeArticle(article: ArticleSummary) {
  const id = articleId(article)
  const confirmed = window.confirm(`确认删除《${article.title}》吗？它会移动到 docs/.trash/，不会永久删除。`)
  if (!confirmed) return

  deletingId.value = id
  error.value = ''
  try {
    await deleteContent(id)
    articles.value = articles.value.filter((item) => articleId(item) !== id)
  } catch (err) {
    error.value = err instanceof Error ? err.message : '删除文章失败'
  } finally {
    deletingId.value = ''
  }
}

async function loadArticles() {
  loading.value = true
  error.value = ''
  try {
    const data = await listArticles()
    articles.value = data.articles || []
  } catch (err) {
    error.value = err instanceof Error ? err.message : '读取正式文章失败'
  } finally {
    loading.value = false
  }
}

onMounted(loadArticles)
</script>

<template>
  <section class="article-browser">
    <div class="draft-toolbar">
      <p>{{ loading ? '正在读取文章...' : `共 ${filteredArticles.length} 篇` }}</p>
      <button type="button" @click="loadArticles">刷新</button>
    </div>

    <p v-if="error" class="write-result error">{{ error }}。请确认已运行 npm run api 或 npm run workbench。</p>

    <div v-if="!loading && filteredArticles.length === 0 && !error" class="empty-state">
      <h2>暂时没有匹配的文章</h2>
      <p>先从草稿箱归档一篇正式文章，它会出现在这里。</p>
    </div>

    <div class="draft-grid">
      <article
        v-for="article in filteredArticles"
        :key="`${article.collection}/${article.slug}`"
        class="draft-card article-card"
        role="link"
        tabindex="0"
        @click="openArticle(article)"
        @keydown.enter="openArticle(article)"
      >
        <span class="draft-date">{{ article.updated || article.created || '待补充日期' }}</span>
        <strong>{{ article.title }}</strong>
        <span class="draft-summary">{{ article.summary || '暂无摘要' }}</span>
        <span class="draft-meta">
          <span>{{ article.branch || article.collectionLabel }}</span>
          <span>{{ article.subbranch || '待分类' }}</span>
          <span>{{ article.validity || '待验证' }}</span>
          <span>{{ article.project || '无关联项目' }}</span>
        </span>
        <span class="draft-tags">
          <span v-for="tag in displayTags(article)" :key="tag">{{ tag }}</span>
        </span>
        <span class="draft-card-actions">
          <a :href="editLink(article)" @click.stop>编辑</a>
          <button type="button" class="danger" :disabled="deletingId === articleId(article)" @click.stop="removeArticle(article)">
            {{ deletingId === articleId(article) ? '删除中...' : '删除' }}
          </button>
        </span>
      </article>
    </div>
  </section>
</template>
