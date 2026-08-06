import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { ArticleRepository } from "../app/data/article-repository";
import type { Article, StoredArticle } from "../app/types";

type DeskSection = "today" | "inbox" | "library" | "review" | "experiments";
type ReviewAction = "agree" | "changed" | "experiment";

type DesktopWorkbenchProps = {
  repository: ArticleRepository;
  onRepositoryChange?: () => void;
};

const sections: Array<{
  id: DeskSection;
  label: string;
  symbol: string;
  description: string;
}> = [
  { id: "today", label: "今日", symbol: "◫", description: "回到正在发生的事情" },
  { id: "inbox", label: "收集箱", symbol: "⌄", description: "还没来得及整理的念头" },
  { id: "library", label: "全部内容", symbol: "▤", description: "搜索与浏览全部记录" },
  { id: "review", label: "待复盘", symbol: "↻", description: "重新遇见过去的判断" },
  { id: "experiments", label: "实验", symbol: "△", description: "准备拿到现实里验证" },
];

const collectionOptions = [
  ["thoughts", "想法与随笔"],
  ["learning", "学习与知识"],
  ["tools", "工具与工作流"],
  ["templates", "模板"],
  ["reviews", "复盘"],
  ["projects", "项目"],
] as const;

const stageOptions = ["种子", "幼苗", "实验", "常青", "标本", "作品"] as const;

const emptyDraft: Article = {
  id: "",
  slug: "",
  collection: "thoughts",
  collectionLabel: "想法与随笔",
  title: "",
  created: "",
  updated: "",
  branch: "待分类",
  subbranch: "待分类",
  stage: "种子",
  validity: "待验证",
  category: "想法与随笔",
  tags: [],
  type: "记录",
  project: "",
  confidence: "低",
  source: ["私人记录"],
  reviewDate: "",
  summary: "",
  next: "",
  body: "",
};

export function DesktopWorkbench({
  repository,
  onRepositoryChange,
}: DesktopWorkbenchProps) {
  const [articles, setArticles] = useState<StoredArticle[]>([]);
  const [section, setSection] = useState<DeskSection>("today");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Article>({ ...emptyDraft });
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  const [quickText, setQuickText] = useState("");
  const [message, setMessage] = useState("");
  const messageTimer = useRef<number | null>(null);

  const today = useMemo(() => localDate(), []);

  const refresh = useCallback(async () => {
    const next = await repository.list();
    setArticles(next);
    return next;
  }, [repository]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    repository
      .list()
      .then((next) => {
        if (active) setArticles(next);
      })
      .catch((error) => {
        if (active) showMessage(error instanceof Error ? error.message : "无法读取本地内容");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [repository]);

  useEffect(() => {
    const openCapture = () => setQuickCaptureOpen(true);
    let unlisten: UnlistenFn | undefined;
    window.addEventListener("mind-garden:quick-capture", openCapture);
    void listen("open-quick-capture", openCapture).then((dispose) => {
      unlisten = dispose;
    });
    return () => {
      window.removeEventListener("mind-garden:quick-capture", openCapture);
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape" && quickCaptureOpen) {
        setQuickCaptureOpen(false);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && editing) {
        event.preventDefault();
        void saveDraft();
      }
    }
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  });

  const counts = useMemo(() => {
    const inbox = articles.filter(isInboxArticle).length;
    const review = articles.filter((article) => isReviewArticle(article, today)).length;
    const experiments = articles.filter(isExperimentArticle).length;
    const changedToday = articles.filter(
      (article) => article.updated.slice(0, 10) === today || article.created.slice(0, 10) === today,
    ).length;
    return {
      today: changedToday,
      inbox,
      library: articles.length,
      review,
      experiments,
    };
  }, [articles, today]);

  const visibleArticles = useMemo(() => {
    let next = articles;
    if (section === "today") {
      const current = articles.filter(
        (article) => article.updated.slice(0, 10) === today || article.created.slice(0, 10) === today,
      );
      next = current.length ? current : articles.slice(0, 12);
    } else if (section === "inbox") {
      next = articles.filter(isInboxArticle);
    } else if (section === "review") {
      next = articles.filter((article) => isReviewArticle(article, today));
    } else if (section === "experiments") {
      next = articles.filter(isExperimentArticle);
    }

    const needle = query.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return next;
    return next.filter((article) => articleSearchText(article).includes(needle));
  }, [articles, query, section, today]);

  const selected = useMemo(
    () => articles.find((article) => article.id === selectedId) ?? null,
    [articles, selectedId],
  );

  const dailyEcho = useMemo(() => {
    const candidates = articles.filter(
      (article) => article.created.slice(0, 10) < today && article.reviewDate !== today,
    );
    if (!candidates.length) return articles[0] ?? null;
    return candidates[hashText(today) % candidates.length];
  }, [articles, today]);

  function showMessage(text: string) {
    setMessage(text);
    if (messageTimer.current) window.clearTimeout(messageTimer.current);
    messageTimer.current = window.setTimeout(() => setMessage(""), 3200);
  }

  function switchSection(next: DeskSection) {
    setSection(next);
    setSelectedId(null);
    setEditing(false);
    setQuery("");
  }

  function openArticle(article: StoredArticle) {
    setSelectedId(article.id);
    setDraft(toEditableArticle(article));
    setEditing(false);
  }

  function startNewArticle() {
    setSelectedId(null);
    setDraft({ ...emptyDraft, tags: [], source: ["私人记录"], created: localDate() });
    setEditing(true);
  }

  function startEditing(article: StoredArticle) {
    setDraft(toEditableArticle(article));
    setEditing(true);
  }

  async function persist(article: Article, success: string) {
    setSaving(true);
    try {
      const saved = await repository.save(article);
      await refresh();
      setSelectedId(saved.id);
      onRepositoryChange?.();
      showMessage(success);
      return saved;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "保存失败");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function saveDraft() {
    const title = draft.title.trim();
    const body = draft.body.trim();
    if (!title || !body) {
      showMessage("请先填写标题和正文。");
      return;
    }
    const saved = await persist(
      {
        ...draft,
        title,
        body,
        summary: draft.summary.trim() || body.replace(/\s+/g, " ").slice(0, 88),
      },
      draft.id ? "修改已经保存。" : "已经放进本地资料库。",
    );
    if (saved) {
      setDraft(toEditableArticle(saved));
      setEditing(false);
    }
  }

  async function quickCapture(event: FormEvent) {
    event.preventDefault();
    const body = quickText.trim();
    if (!body) return;
    const saved = await persist(
      {
        ...emptyDraft,
        tags: [],
        source: ["快速记录"],
        title: captureTitle(body),
        body,
        summary: body.replace(/\s+/g, " ").slice(0, 88),
        created: localDate(),
      },
      "已经收进收集箱，之后再慢慢整理。",
    );
    if (saved) {
      setQuickText("");
      setQuickCaptureOpen(false);
      setSection("inbox");
    }
  }

  async function recordReview(article: StoredArticle, action: ReviewAction) {
    const copy: Record<ReviewAction, string> = {
      agree: "再次读到这条记录，我仍然认同当时的判断。",
      changed: "现在的想法已经发生变化，值得重新补充。",
      experiment: "把这条内容带回当前生活或项目中，实际验证一次。",
    };
    const nextStage = action === "changed" ? "标本" : action === "experiment" ? "实验" : normalizeStage(article.stage);
    const updated: Article = {
      ...toEditableArticle(article),
      stage: nextStage,
      validity: action === "agree" ? "仍然认同" : action === "changed" ? "观点已变化" : "验证中",
      reviewDate: today,
      next: action === "experiment" ? copy[action] : article.next,
      source: Array.from(new Set([...article.source, "回声回顾"])),
      body: `${article.body.trim()}\n\n## ${today} · 回看\n\n${copy[action]}`,
    };
    await persist(updated, action === "experiment" ? "已经加入实验，等待实际验证。" : "这次回看已经写回原记录。 ");
  }

  async function removeArticle(article: StoredArticle) {
    if (!window.confirm(`确认移除《${article.title}》吗？本次删除会进入同步队列。`)) return;
    setSaving(true);
    try {
      await repository.remove(article.id);
      await refresh();
      setSelectedId(null);
      setEditing(false);
      onRepositoryChange?.();
      showMessage("内容已经移除。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "移除失败");
    } finally {
      setSaving(false);
    }
  }

  const activeSection = sections.find((item) => item.id === section) ?? sections[0];

  return (
    <main className="desktop-workbench">
      <aside className="workbench-sidebar">
        <div className="sidebar-brand">
          <span className="sidebar-brand-mark">思</span>
          <span>
            <strong>人生攻略库</strong>
            <small>PRIVATE MIND GARDEN</small>
          </span>
        </div>

        <nav className="sidebar-navigation" aria-label="资料库导航">
          <span className="sidebar-caption">工作台</span>
          {sections.map((item) => (
            <button
              className={section === item.id ? "active" : ""}
              key={item.id}
              onClick={() => switchSection(item.id)}
            >
              <i>{item.symbol}</i>
              <span>{item.label}</span>
              <small>{counts[item.id]}</small>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button className="capture-entry" onClick={() => setQuickCaptureOpen(true)}>
            <span>＋</span>
            快速记录
          </button>
          <p><kbd>Ctrl</kbd><i>+</i><kbd>Shift</kbd><i>+</i><kbd>Space</kbd></p>
          <small>本地优先 · 自动进入同步队列</small>
        </div>
      </aside>

      <section className="workbench-list-pane">
        <header className="list-pane-head">
          <div>
            <span>{activeSection.symbol}</span>
            <strong>{activeSection.label}</strong>
          </div>
          <button onClick={startNewArticle} aria-label="新建内容">＋</button>
          <p>{activeSection.description}</p>
        </header>

        <label className="desktop-search">
          <span>⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、正文、标签…"
          />
          {query && <button onClick={() => setQuery("")} aria-label="清空搜索">×</button>}
        </label>

        <div className="article-list" aria-live="polite">
          {loading ? (
            <div className="list-empty"><span>正在整理书桌…</span></div>
          ) : visibleArticles.length ? (
            visibleArticles.map((article) => (
              <button
                className={selectedId === article.id ? "article-list-item active" : "article-list-item"}
                key={article.id}
                onClick={() => openArticle(article)}
              >
                <span className={`sync-dot ${article.storage.syncStatus}`} />
                <span className="list-item-main">
                  <strong>{article.title}</strong>
                  <p>{article.summary || plainExcerpt(article.body)}</p>
                  <small>
                    <i>{normalizeStage(article.stage)}</i>
                    <span>{formatRelativeDate(article.updated || article.created)}</span>
                  </small>
                </span>
              </button>
            ))
          ) : (
            <div className="list-empty">
              <span>{query ? "没有找到相关内容" : "这里暂时是空的"}</span>
              <button onClick={startNewArticle}>写下第一条</button>
            </div>
          )}
        </div>

        <footer className="list-pane-foot">
          <span>{visibleArticles.length} 条内容</span>
          <span>● 本地资料库</span>
        </footer>
      </section>

      <section className="workbench-main-pane">
        {editing ? (
          <ArticleEditor
            draft={draft}
            saving={saving}
            onChange={setDraft}
            onCancel={() => {
              setEditing(false);
              if (!selectedId) setDraft({ ...emptyDraft });
            }}
            onSave={() => void saveDraft()}
          />
        ) : selected ? (
          <ArticleReader
            article={selected}
            saving={saving}
            onBack={() => setSelectedId(null)}
            onEdit={() => startEditing(selected)}
            onRemove={() => void removeArticle(selected)}
            onReview={(action) => void recordReview(selected, action)}
          />
        ) : (
          <TodayDashboard
            articles={articles}
            dailyEcho={dailyEcho}
            counts={counts}
            today={today}
            onCapture={() => setQuickCaptureOpen(true)}
            onNew={startNewArticle}
            onOpen={openArticle}
            onReview={(article, action) => void recordReview(article, action)}
          />
        )}
      </section>

      {quickCaptureOpen && (
        <div className="capture-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setQuickCaptureOpen(false);
        }}>
          <form className="capture-dialog" onSubmit={quickCapture}>
            <header>
              <span>QUICK CAPTURE</span>
              <button type="button" onClick={() => setQuickCaptureOpen(false)} aria-label="关闭快速记录">×</button>
            </header>
            <h2>先把它留下来</h2>
            <p>不必分类、不必写完整，稍后会在收集箱里等你。</p>
            <textarea
              autoFocus
              value={quickText}
              onChange={(event) => setQuickText(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="一句念头、一段感受，或突然想写下的东西……"
            />
            <footer>
              <span><kbd>Ctrl</kbd> + <kbd>Enter</kbd> 保存</span>
              <button disabled={saving || !quickText.trim()} type="submit">
                {saving ? "正在收好…" : "放进收集箱"}
              </button>
            </footer>
          </form>
        </div>
      )}

      {message && <div className="desktop-toast" role="status">{message}</div>}
    </main>
  );
}

function TodayDashboard({
  articles,
  dailyEcho,
  counts,
  today,
  onCapture,
  onNew,
  onOpen,
  onReview,
}: {
  articles: StoredArticle[];
  dailyEcho: StoredArticle | null;
  counts: Record<DeskSection, number>;
  today: string;
  onCapture: () => void;
  onNew: () => void;
  onOpen: (article: StoredArticle) => void;
  onReview: (article: StoredArticle, action: ReviewAction) => void;
}) {
  return (
    <div className="today-dashboard">
      <header className="dashboard-heading">
        <div>
          <span>{formatLongDate(today)}</span>
          <h1>{greeting()}，今天想留下些什么？</h1>
          <p>这里不是档案终点，而是让旧想法重新参与今天。</p>
        </div>
        <button onClick={onNew}>新建长文</button>
      </header>

      <button className="dashboard-capture" onClick={onCapture}>
        <span>＋</span>
        <span><strong>快速记下一闪而过的念头</strong><small>不用整理，先让它存在</small></span>
        <kbd>Ctrl ⇧ Space</kbd>
      </button>

      <div className="dashboard-stats">
        <div><span>今日触碰</span><strong>{counts.today}</strong><small>条内容</small></div>
        <div><span>等待整理</span><strong>{counts.inbox}</strong><small>个念头</small></div>
        <div><span>正在验证</span><strong>{counts.experiments}</strong><small>项实验</small></div>
        <div><span>全部积累</span><strong>{articles.length}</strong><small>条记录</small></div>
      </div>

      <section className="daily-echo">
        <header>
          <span>今日回声</span>
          <small>从过去随机捞起一条</small>
        </header>
        {dailyEcho ? (
          <div className="daily-echo-content">
            <button className="echo-open" onClick={() => onOpen(dailyEcho)}>
              <small>{formatDate(dailyEcho.created)} · {normalizeStage(dailyEcho.stage)}</small>
              <strong>{dailyEcho.title}</strong>
              <p>{dailyEcho.summary || plainExcerpt(dailyEcho.body)}</p>
            </button>
            <footer>
              <span>现在再看，它还成立吗？</span>
              <div>
                <button onClick={() => onReview(dailyEcho, "agree")}>仍然认同</button>
                <button onClick={() => onReview(dailyEcho, "changed")}>想法变了</button>
                <button onClick={() => onReview(dailyEcho, "experiment")}>拿去试试</button>
              </div>
            </footer>
          </div>
        ) : (
          <div className="echo-empty">
            <p>等你留下一些内容后，过去的想法会在这里重新出现。</p>
            <button onClick={onCapture}>写下第一条</button>
          </div>
        )}
      </section>
    </div>
  );
}

function ArticleReader({
  article,
  saving,
  onBack,
  onEdit,
  onRemove,
  onReview,
}: {
  article: StoredArticle;
  saving: boolean;
  onBack: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onReview: (action: ReviewAction) => void;
}) {
  return (
    <article className="desktop-reader">
      <header className="reader-toolbar">
        <button className="reader-back" onClick={onBack}>← 今日工作台</button>
        <div>
          <button disabled={saving} onClick={onRemove}>移除</button>
          <button className="primary" onClick={onEdit}>编辑</button>
        </div>
      </header>
      <div className="reader-scroll">
        <div className="reader-document">
          <div className="reader-kicker">
            <span>{article.collectionLabel}</span>
            <i>{normalizeStage(article.stage)}</i>
            <small>{formatDate(article.updated || article.created)}</small>
          </div>
          <h1>{article.title}</h1>
          {article.summary && <p className="reader-summary">{article.summary}</p>}
          <div className="reader-tags">
            {article.tags.map((tag) => <span key={tag}>#{tag}</span>)}
            {article.branch && <span>{article.branch}</span>}
            <span className={`reader-sync ${article.storage.syncStatus}`}>
              {article.storage.syncStatus === "synced" ? "已同步" : article.storage.syncStatus === "conflict" ? "冲突副本" : "等待同步"}
            </span>
          </div>
          <MarkdownBody body={article.body} />
          {article.next && (
            <aside className="reader-next">
              <span>下一步</span>
              <p>{article.next}</p>
            </aside>
          )}
          <section className="reader-review">
            <span>重新遇见这条记录</span>
            <h2>现在的你怎么看？</h2>
            <div>
              <button disabled={saving} onClick={() => onReview("agree")}>仍然认同</button>
              <button disabled={saving} onClick={() => onReview("changed")}>想法变了</button>
              <button disabled={saving} onClick={() => onReview("experiment")}>拿去试试</button>
            </div>
          </section>
        </div>
      </div>
    </article>
  );
}

function ArticleEditor({
  draft,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Article;
  saving: boolean;
  onChange: (article: Article) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  function update<Key extends keyof Article>(key: Key, value: Article[Key]) {
    onChange({ ...draft, [key]: value });
  }

  return (
    <div className="workbench-editor">
      <header className="editor-toolbar">
        <div>
          <button onClick={onCancel}>取消</button>
          <span>{draft.id ? "编辑记录" : "新建记录"}</span>
        </div>
        <div>
          <small><kbd>Ctrl</kbd> + <kbd>S</kbd></small>
          <button className="primary" disabled={saving} onClick={onSave}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </header>
      <div className="editor-scroll">
        <div className="editor-paper">
          <input
            className="editor-title"
            autoFocus
            value={draft.title}
            onChange={(event) => update("title", event.target.value)}
            placeholder="这条记录的标题"
          />
          <textarea
            className="editor-body"
            value={draft.body}
            onChange={(event) => update("body", event.target.value)}
            placeholder="从这里开始写。支持使用 Markdown 标题、引用和列表……"
          />

          <section className="editor-metadata">
            <header>
              <strong>整理信息</strong>
              <span>现在不想分类也没关系</span>
            </header>
            <div className="metadata-grid">
              <label>
                <span>归档位置</span>
                <select
                  value={draft.collection}
                  onChange={(event) => {
                    const option = collectionOptions.find(([value]) => value === event.target.value) ?? collectionOptions[0];
                    onChange({ ...draft, collection: option[0], collectionLabel: option[1], category: option[1] });
                  }}
                >
                  {collectionOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>
              <label>
                <span>生长阶段</span>
                <select value={normalizeStage(draft.stage)} onChange={(event) => update("stage", event.target.value)}>
                  {stageOptions.map((stage) => <option key={stage}>{stage}</option>)}
                </select>
              </label>
              <label>
                <span>分支</span>
                <input value={draft.branch} onChange={(event) => update("branch", event.target.value)} />
              </label>
              <label>
                <span>标签</span>
                <input
                  value={draft.tags.join("，")}
                  onChange={(event) => update("tags", splitTags(event.target.value))}
                  placeholder="用逗号分隔"
                />
              </label>
            </div>
            <label>
              <span>一句摘要</span>
              <input value={draft.summary} onChange={(event) => update("summary", event.target.value)} placeholder="留空时会从正文自动提取" />
            </label>
            <label>
              <span>下一步行动</span>
              <input value={draft.next} onChange={(event) => update("next", event.target.value)} placeholder="如果它值得行动，就留一个最小的下一步" />
            </label>
          </section>
        </div>
      </div>
    </div>
  );
}

function MarkdownBody({ body }: { body: string }) {
  const blocks = body.split(/\n{2,}/).filter(Boolean);
  return (
    <div className="desktop-markdown">
      {blocks.map((block, index) => {
        const text = block.trim();
        if (text.startsWith("### ")) return <h3 key={index}>{text.slice(4)}</h3>;
        if (text.startsWith("## ")) return <h2 key={index}>{text.slice(3)}</h2>;
        if (text.startsWith("# ")) return <h1 key={index}>{text.slice(2)}</h1>;
        if (text.startsWith("> ")) return <blockquote key={index}>{text.replace(/^> ?/gm, "")}</blockquote>;
        if (text.startsWith("```") && text.endsWith("```")) {
          return <pre key={index}><code>{text.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "")}</code></pre>;
        }
        if (text.split("\n").every((line) => /^[-*] /.test(line))) {
          return <ul key={index}>{text.split("\n").map((line, lineIndex) => <li key={lineIndex}>{line.slice(2)}</li>)}</ul>;
        }
        return <p key={index}>{text}</p>;
      })}
    </div>
  );
}

function isInboxArticle(article: StoredArticle) {
  const stage = normalizeStage(article.stage);
  return stage === "种子" || stage === "幼苗" || article.branch === "待分类";
}

function isReviewArticle(article: StoredArticle, today: string) {
  const date = (article.updated || article.created).slice(0, 10);
  return Boolean(date && date < today && article.reviewDate !== today);
}

function isExperimentArticle(article: StoredArticle) {
  return normalizeStage(article.stage) === "实验" || Boolean(article.next.trim());
}

function articleSearchText(article: StoredArticle) {
  return [
    article.title,
    article.summary,
    article.body,
    article.branch,
    article.subbranch,
    article.project,
    article.tags.join(" "),
  ].join(" ").toLocaleLowerCase("zh-CN");
}

function toEditableArticle(article: StoredArticle): Article {
  return {
    ...article,
    tags: [...article.tags],
    source: [...article.source],
  };
}

function normalizeStage(stage: string) {
  if (stage === "草稿") return "种子";
  if (stage === "已整理") return "常青";
  if (stage === "已发布") return "作品";
  return stage || "种子";
}

function splitTags(value: string) {
  return Array.from(new Set(value.split(/[，,]/).map((item) => item.trim()).filter(Boolean)));
}

function captureTitle(text: string) {
  const first = text.split("\n").find((line) => line.trim())?.trim() || "一条未命名灵感";
  return first.length > 34 ? `${first.slice(0, 34)}…` : first;
}

function plainExcerpt(text: string) {
  return text.replace(/[#>*`\-]/g, "").replace(/\s+/g, " ").trim().slice(0, 82);
}

function localDate(value = new Date()) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}

function formatDate(value: string) {
  return value ? value.slice(0, 10).replaceAll("-", ".") : "未记录日期";
}

function formatLongDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
}

function formatRelativeDate(value: string) {
  if (!value) return "未记录";
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  const diff = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return `${diff} 天前`;
  return formatDate(value);
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function hashText(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
