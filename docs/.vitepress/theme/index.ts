import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { h } from 'vue'
import ArticleMeta from './ArticleMeta.vue'
import ArticleBrowser from './ArticleBrowser.vue'
import ContentManager from './ContentManager.vue'
import DraftInbox from './DraftInbox.vue'
import EditDraft from './EditDraft.vue'
import HeroQuote from './HeroQuote.vue'
import KnowledgeTree from './KnowledgeTree.vue'
import KnowledgeTreeSidebar from './KnowledgeTreeSidebar.vue'
import ProjectHub from './ProjectHub.vue'
import RelatedContent from './RelatedContent.vue'
import ReviewSearch from './ReviewSearch.vue'
import WriteDraft from './WriteDraft.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('ArticleBrowser', ArticleBrowser)
    app.component('ContentManager', ContentManager)
    app.component('DraftInbox', DraftInbox)
    app.component('EditDraft', EditDraft)
    app.component('HeroQuote', HeroQuote)
    app.component('KnowledgeTree', KnowledgeTree)
    app.component('KnowledgeTreeSidebar', KnowledgeTreeSidebar)
    app.component('ProjectHub', ProjectHub)
    app.component('RelatedContent', RelatedContent)
    app.component('ReviewSearch', ReviewSearch)
    app.component('WriteDraft', WriteDraft)
  },
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'sidebar-nav-before': () => h(KnowledgeTreeSidebar),
      'doc-after': () => [h(ArticleMeta), h(RelatedContent)]
    })
  }
} satisfies Theme
