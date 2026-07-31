<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vitepress'
import { listContents, type ContentSummary } from './apiClient'
import { branches, subbranchesFor } from './contentSchema'

const route = useRoute()
const contents = ref<ContentSummary[]>([])
const loading = ref(true)
const error = ref('')
const activeBranch = ref('经验整理')
const activeSubbranch = ref('')
const expanded = ref<Record<string, boolean>>({
  经验整理: true,
  思考随笔: false,
  复盘记录: false,
  待分类: false
})

function syncSelection() {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)
  activeBranch.value = params.get('branch') || activeBranch.value
  activeSubbranch.value = params.get('subbranch') || ''
  expanded.value = {
    ...expanded.value,
    [activeBranch.value]: true
  }
}

function hrefFor(branch: string, subbranch = '') {
  const params = new URLSearchParams({ branch })
  if (subbranch) {
    params.set('subbranch', subbranch)
  }
  return `/tree?${params.toString()}`
}

function setActive(branch: string, subbranch = '') {
  activeBranch.value = branch
  activeSubbranch.value = subbranch
}

function toggle(branch: string) {
  expanded.value = {
    ...expanded.value,
    [branch]: !expanded.value[branch]
  }
}

function countBranch(branch: string) {
  return contents.value.filter((item) => item.branch === branch).length
}

function countSubbranch(branch: string, subbranch: string) {
  return contents.value.filter((item) => item.branch === branch && (item.subbranch || '待分类') === subbranch).length
}

const treeBranches = computed(() => {
  return branches.map((branch) => {
    const existing = new Set(
      contents.value
        .filter((item) => item.branch === branch)
        .map((item) => item.subbranch || '待分类')
    )
    const subbranches = [...subbranchesFor(branch), ...existing].filter(
      (item, index, array) => item && array.indexOf(item) === index && countSubbranch(branch, item) > 0
    )
    return { branch, subbranches }
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
</script>

<template>
  <section class="sidebar-tree" aria-label="个人知识树">
    <div class="sidebar-tree-heading">
      <span>个人知识树</span>
      <button type="button" @click="loadContents">刷新</button>
    </div>

    <p v-if="loading" class="sidebar-tree-muted">读取中...</p>
    <p v-if="error" class="sidebar-tree-error">{{ error }}</p>

    <div v-for="group in treeBranches" :key="group.branch" class="sidebar-tree-group">
      <div class="sidebar-tree-row">
        <button type="button" class="sidebar-tree-toggle" @click="toggle(group.branch)">
          {{ expanded[group.branch] ? '−' : '+' }}
        </button>
        <a
          class="sidebar-tree-link"
          :class="{ active: activeBranch === group.branch && !activeSubbranch }"
          :href="hrefFor(group.branch)"
          @click="setActive(group.branch)"
        >
          <strong>{{ group.branch }}</strong>
          <em>{{ countBranch(group.branch) }}</em>
        </a>
      </div>

      <div v-if="expanded[group.branch]" class="sidebar-subtree">
        <a
          v-for="subbranch in group.subbranches"
          :key="`${group.branch}-${subbranch}`"
          class="sidebar-tree-link subbranch"
          :class="{ active: activeBranch === group.branch && activeSubbranch === subbranch }"
          :href="hrefFor(group.branch, subbranch)"
          @click="setActive(group.branch, subbranch)"
        >
          <strong>{{ subbranch }}</strong>
          <em>{{ countSubbranch(group.branch, subbranch) }}</em>
        </a>
      </div>
    </div>
  </section>
</template>
