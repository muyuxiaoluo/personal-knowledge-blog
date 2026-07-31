export const apiBase = 'http://127.0.0.1:8787'

export type HealthStatus = {
  ok: boolean
  deepseekConfigured: boolean
  model: string
  apiBase: string
}

export type FormatPayload = {
  rawText: string
  title?: string
  branch?: string
  subbranch?: string
  type?: string
  category?: string
  project?: string
  tags?: string
  mode?: string
}

export type FormatResult = {
  formattedMarkdown: string
  suggestedFrontmatter: Record<string, unknown>
  suggestedTitle: string
  suggestedSummary: string
  suggestedTags: string[]
  suggestedNext: string
}

export type SaveDraftPayload = {
  title?: string
  branch?: string
  subbranch?: string
  type?: string
  category?: string
  project?: string
  tags?: string
  content?: string
  formattedMarkdown?: string
}

export type DraftSummary = {
  id?: string
  kind?: 'draft' | 'article'
  collection?: string
  collectionLabel?: string
  slug: string
  filename?: string
  title: string
  created: string
  updated?: string
  updateCount?: number
  updateHistory?: string[]
  branch?: string
  subbranch?: string
  type: string
  project: string
  tags: string[]
  summary: string
  category: string
  stage?: string
  validity?: string
  confidence?: string
  source?: string[] | string
  reviewDate?: string
  next?: string
  path?: string
  link?: string
  editLink?: string
}

export type ArticleSummary = DraftSummary & {
  collection: string
  collectionLabel: string
  stage: string
  validity: string
  confidence: string
  source: string
  reviewDate: string
  next: string
  path: string
  link: string
}

export type ContentSummary = {
  id: string
  kind: 'draft' | 'article'
  collection: string
  collectionLabel: string
  slug: string
  filename: string
  title: string
  created: string
  updated: string
  updateCount: number
  updateHistory: string[]
  branch: string
  subbranch: string
  type: string
  stage: string
  validity: string
  category: string
  project: string
  tags: string[]
  confidence: string
  source: string[]
  reviewDate: string
  summary: string
  next: string
  path: string
  link: string
  editLink: string
}

export type ContentDetail = ContentSummary & {
  markdown: string
  body: string
  meta: Record<string, unknown>
}

export type UpdateDraftPayload = {
  slug: string
  title?: string
  branch?: string
  subbranch?: string
  type?: string
  category?: string
  project?: string
  stage?: string
  validity?: string
  confidence?: string
  source?: string[] | string
  reviewDate?: string
  tags?: string[] | string
  summary?: string
  next?: string
  body?: string
  frontmatter?: Record<string, unknown>
  markdown?: string
}

export type UpdateArticlePayload = UpdateDraftPayload & {
  collection: string
}

export type ArchiveDraftPayload = {
  slug: string
  branch?: string
  subbranch?: string
  type?: string
  targetFilename?: string
}

export type UpdateContentPayload = {
  id: string
  title?: string
  branch?: string
  subbranch?: string
  type?: string
  stage?: string
  validity?: string
  category?: string
  project?: string
  tags?: string[] | string
  confidence?: string
  source?: string[] | string
  reviewDate?: string
  summary?: string
  next?: string
  body?: string
  frontmatter?: Record<string, unknown>
  markdown?: string
}

export type MoveContentPayload = {
  id: string
  targetCollection?: string
  targetCategory?: string
  targetFilename?: string
}

async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers
    }
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || `API request failed: ${response.status}`) as Error & {
      status?: number
      reason?: string
    }
    error.status = response.status
    error.reason = data.reason
    throw error
  }
  return data as T
}

export async function getHealth() {
  return requestJson<HealthStatus>('/api/health')
}

export async function formatDraft(payload: FormatPayload) {
  return requestJson<FormatResult>('/api/format', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export async function saveDraft(payload: SaveDraftPayload) {
  return requestJson<{ ok: true; slug: string; path: string }>('/api/save-draft', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export async function listDrafts() {
  return requestJson<{ drafts: DraftSummary[] }>('/api/drafts')
}

export async function getDraft(slug: string) {
  return requestJson<{ slug: string; filename?: string; markdown: string; meta: Record<string, unknown> }>(
    `/api/drafts/${encodeURIComponent(slug)}`
  )
}

export async function listArticles() {
  return requestJson<{ articles: ArticleSummary[] }>('/api/articles')
}

export async function listContents() {
  return requestJson<{ contents: ContentSummary[] }>('/api/contents')
}

export async function getContent(id: string) {
  return requestJson<{ content: ContentDetail }>(`/api/content?id=${encodeURIComponent(id)}`)
}

export async function getArticle(collection: string, slug: string) {
  return requestJson<{
    collection: string
    slug: string
    filename?: string
    markdown: string
    meta: Record<string, unknown>
  }>(`/api/articles/${encodeURIComponent(collection)}/${encodeURIComponent(slug)}`)
}

export async function updateDraft(payload: UpdateDraftPayload) {
  return requestJson<{ ok: true; slug: string; path: string; backupPath: string }>('/api/update-draft', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export async function updateArticle(payload: UpdateArticlePayload) {
  return requestJson<{ ok: true; collection: string; slug: string; path: string; backupPath: string; link: string }>(
    '/api/update-article',
    {
      method: 'POST',
      body: JSON.stringify(payload)
    }
  )
}

export async function updateContent(payload: UpdateContentPayload) {
  return requestJson<{ ok: true; id: string; path: string; backupPath: string; link: string }>('/api/update-content', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export async function moveContent(payload: MoveContentPayload) {
  return requestJson<{
    ok: true
    id: string
    oldPath: string
    newPath: string
    backupPath: string
    link: string
  }>('/api/move-content', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export async function archiveDraft(payload: ArchiveDraftPayload) {
  return requestJson<{
    ok: true
    category: string
    collection: string
    oldPath: string
    newPath: string
    archivedPath: string
    backupPath: string
    link: string
  }>('/api/archive-draft', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export async function deleteDraft(slug: string) {
  return requestJson<{ ok: true; slug: string; path: string }>('/api/delete-draft', {
    method: 'POST',
    body: JSON.stringify({ slug })
  })
}

export async function deleteContent(id: string) {
  return requestJson<{ ok: true; id: string; path: string }>('/api/delete-content', {
    method: 'POST',
    body: JSON.stringify({ id })
  })
}
