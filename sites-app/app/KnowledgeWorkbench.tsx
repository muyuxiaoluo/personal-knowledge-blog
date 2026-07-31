"use client";

import { useEffect, useMemo, useState } from "react";
import {
  toStoredArticle,
  type ArticleRepository,
} from "./data/article-repository";
import { HttpArticleRepository } from "./data/http-article-repository";
import type { Article, StoredArticle } from "./types";

type View = "desk" | "stream" | "garden" | "lab" | "article" | "edit";
type EchoAction = "agree" | "changed" | "experiment";

const branches: Record<string, string[]> = {
  经验整理: ["工具经验", "工作流方法", "提示词与模板", "学习经验", "代码经验", "写作经验"],
  思考随笔: ["AI时代与焦虑", "信息茧房", "生活观察", "认知变化"],
  复盘记录: ["周复盘", "项目复盘", "工具测试", "决策记录"],
  待分类: ["待分类"],
};

const collections = [
  ["learning", "学习与知识"],
  ["tools", "工具与工作流"],
  ["templates", "模板"],
  ["thoughts", "想法与随笔"],
  ["reviews", "复盘"],
  ["projects", "项目"],
] as const;

const stages = [
  ["种子", "刚刚记下，允许它还不完整", "✦"],
  ["幼苗", "值得继续展开和连接", "⌇"],
  ["实验", "准备放进生活或项目里验证", "△"],
  ["常青", "经过使用，值得长期保留", "∞"],
  ["标本", "观点已经变化，但仍值得留存", "◇"],
  ["作品", "已经整理成相对完整的表达", "□"],
] as const;

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

const stageAliases: Record<string, string> = {
  草稿: "种子",
  已整理: "常青",
  已发布: "作品",
};

function normalizeStage(stage: string) {
  return stageAliases[stage] || stage || "种子";
}

function localDate(value = new Date()) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}

function formatDate(value: string) {
  if (!value) return "未记录日期";
  return value.slice(0, 10).replaceAll("-", ".");
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function captureTitle(text: string) {
  const firstLine = text.split("\n").find((line) => line.trim())?.trim() || "一条未命名灵感";
  return firstLine.length > 34 ? `${firstLine.slice(0, 34)}…` : firstLine;
}

function MarkdownBody({ body }: { body: string }) {
  const blocks = body.split(/\n{2,}/).filter(Boolean);
  return (
    <div className="article-body">
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

export function KnowledgeWorkbench({
  initialArticles,
  repository,
  onRepositoryChange,
}: {
  initialArticles: Article[];
  repository?: ArticleRepository;
  onRepositoryChange?: () => void;
}) {
  const [articleRepository] = useState<ArticleRepository>(
    () => repository ?? new HttpArticleRepository(),
  );
  const [articles, setArticles] = useState<StoredArticle[]>(() =>
    initialArticles.map(toStoredArticle),
  );
  const [today] = useState(() => localDate());
  const [greeting] = useState(() => getGreeting());
  const [view, setView] = useState<View>("desk");
  const [selected, setSelected] = useState<Article | null>(null);
  const [draft, setDraft] = useState<Article>(emptyDraft);
  const [quickText, setQuickText] = useState("");
  const [echoNote, setEchoNote] = useState("");
  const [query, setQuery] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function refresh() {
    const nextArticles = await articleRepository.list();
    setArticles(nextArticles);
    return nextArticles;
  }

  useEffect(() => {
    let active = true;
    articleRepository
      .list()
      .then((nextArticles) => {
        if (active) setArticles(nextArticles);
      })
      .catch(() => {
        if (active) setMessage("当前显示本地文章快照；启动本地资料库后即可继续写入。");
      });
    return () => {
      active = false;
    };
  }, [articleRepository]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return articles.filter((article) => {
      if (stageFilter && normalizeStage(article.stage) !== stageFilter) return false;
      if (!keyword) return true;
      return [article.title, article.summary, article.body, article.project, article.tags.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
  }, [articles, query, stageFilter]);

  const dailyEcho = useMemo(() => {
    if (!articles.length) return null;
    const candidates = articles.filter((article) => {
      const date = article.updated || article.created;
      return date && date.slice(0, 10) < today && article.reviewDate !== today;
    });
    const pool = candidates.length ? candidates : articles;
    const dayKey = Number(today.replaceAll("-", ""));
    return pool[dayKey % pool.length];
  }, [articles, today]);

  const seeds = useMemo(
    () => articles.filter((article) => ["种子", "幼苗"].includes(normalizeStage(article.stage))).slice(0, 4),
    [articles],
  );

  const experiments = useMemo(
    () => articles.filter((article) => normalizeStage(article.stage) === "实验" || article.next.trim()).slice(0, 5),
    [articles],
  );

  const related = useMemo(() => {
    if (!selected) return [];
    return articles
      .filter((article) => article.id !== selected.id)
      .map((article) => ({
        article,
        score:
          article.tags.filter((tag) => selected.tags.includes(tag)).length * 2 +
          Number(Boolean(article.project && article.project === selected.project)) +
          Number(article.branch === selected.branch),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((item) => item.article);
  }, [articles, selected]);

  function navigate(next: View) {
    setView(next);
    setSelected(null);
    setMessage("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openArticle(article: Article) {
    setSelected(article);
    setView("article");
    setEchoNote("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startEdit(article?: Article) {
    setDraft(article ? { ...article, tags: [...article.tags], source: [...article.source] } : { ...emptyDraft, tags: [], source: ["私人记录"] });
    setView("edit");
    setMessage("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function persistArticle(article: Article, successMessage: string) {
    setSaving(true);
    setMessage("");
    try {
      await articleRepository.save(article);
      const nextArticles = await refresh();
      if (selected?.id === article.id) {
        setSelected(nextArticles.find((item) => item.id === article.id) || null);
      }
      onRepositoryChange?.();
      setMessage(successMessage);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function quickCapture() {
    const body = quickText.trim();
    if (!body) {
      setMessage("先留下一句话吧。");
      return;
    }
    const article = {
      ...emptyDraft,
      title: captureTitle(body),
      body,
      summary: body.replace(/\s+/g, " ").slice(0, 88),
      created: localDate(),
      stage: "种子",
    };
    if (await persistArticle(article, "已经收进灵感流，暂时不用急着整理。")) {
      setQuickText("");
    }
  }

  async function saveDraft() {
    if (!draft.title.trim() || !draft.body.trim()) {
      setMessage("请先填写标题和正文。");
      return;
    }
    if (await persistArticle(draft, draft.id ? "内容已经更新。" : "已经保存到私人资料库。")) {
      navigate("stream");
    }
  }

  async function recordEcho(article: Article, action: EchoAction) {
    const today = localDate();
    const fallback: Record<EchoAction, string> = {
      agree: "再次读到这条记录，我仍然认同当时的判断。",
      changed: "现在的想法已经发生变化，值得重新补充。",
      experiment: "把这条内容带回当前生活或项目中，实际验证一次。",
    };
    const reflection = echoNote.trim() || fallback[action];
    const validity = action === "agree" ? "仍然认同" : action === "changed" ? "观点已变化" : "验证中";
    const nextStage = action === "changed" ? "标本" : action === "experiment" ? "实验" : normalizeStage(article.stage);
    const updated: Article = {
      ...article,
      stage: nextStage,
      validity,
      reviewDate: today,
      next: action === "experiment" ? reflection : article.next,
      source: Array.from(new Set([...article.source, "回声回顾"])),
      body: `${article.body.trim()}\n\n## ${today} · 回看\n\n${reflection}`,
    };
    if (await persistArticle(updated, action === "experiment" ? "已经带到实验室，等待你实际验证。" : "这次回看已经留在原记录里。")) {
      setEchoNote("");
    }
  }

  async function moveToStage(article: Article, stage: string) {
    await persistArticle({ ...article, stage }, `已经移动到「${stage}」。`);
  }

  async function removeArticle(article: Article) {
    if (!window.confirm(`确认移除《${article.title}》吗？`)) return;
    setSaving(true);
    try {
      await articleRepository.remove(article.id);
      await refresh();
      onRepositoryChange?.();
      navigate("stream");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "移除失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="private-shell">
      <header className="topbar">
        <button className="brand" onClick={() => navigate("desk")} aria-label="返回私人书桌">
          <span className="brand-orbit"><i>思</i></span>
          <span><strong>人生攻略库</strong><small>PRIVATE MIND GARDEN</small></span>
        </button>
        <nav aria-label="主导航">
          <NavButton active={view === "desk"} onClick={() => navigate("desk")}>此刻</NavButton>
          <NavButton active={view === "stream"} onClick={() => navigate("stream")}>灵感流</NavButton>
          <NavButton active={view === "garden"} onClick={() => navigate("garden")}>花园</NavButton>
          <NavButton active={view === "lab"} onClick={() => navigate("lab")}>实验室</NavButton>
          <button className="capture-button" onClick={() => startEdit()}>＋ 记录</button>
        </nav>
      </header>

      {message && <div className="notice" role="status"><span>✦</span>{message}<button onClick={() => setMessage("")} aria-label="关闭提示">×</button></div>}

      {view === "desk" && (
        <div className="desk">
          <section className="desk-intro">
            <span className="date-mark">{formatDate(today)}</span>
            <p>{greeting}，欢迎回到自己的书桌。</p>
            <h1>今天有什么<br /><em>值得留下？</em></h1>
            <div className="quick-capture">
              <textarea
                value={quickText}
                onChange={(event) => setQuickText(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void quickCapture();
                }}
                placeholder="一句念头、一段感受，或突然想写下的东西……"
                rows={4}
              />
              <div><span>不必分类，先让它存在</span><button disabled={saving} onClick={quickCapture}>{saving ? "收存中…" : "收进灵感流 ↗"}</button></div>
            </div>
          </section>

          <section className="desk-grid">
            <div className="echo-panel">
              <div className="panel-label"><span>01</span><p>TODAY&apos;S ECHO · 今日回声</p></div>
              {dailyEcho ? (
                <>
                  <button className="echo-copy" onClick={() => openArticle(dailyEcho)}>
                    <span>{formatDate(dailyEcho.updated || dailyEcho.created)} 留下</span>
                    <h2>{dailyEcho.title}</h2>
                    <p>{dailyEcho.summary || dailyEcho.body.slice(0, 150)}</p>
                  </button>
                  <textarea value={echoNote} onChange={(event) => setEchoNote(event.target.value)} placeholder="今天再看到它，你有什么不同的想法？" rows={3} />
                  <div className="echo-actions">
                    <button disabled={saving} onClick={() => recordEcho(dailyEcho, "agree")}>仍然认同</button>
                    <button disabled={saving} onClick={() => recordEcho(dailyEcho, "changed")}>已经改变</button>
                    <button className="strong" disabled={saving} onClick={() => recordEcho(dailyEcho, "experiment")}>带去验证</button>
                  </div>
                </>
              ) : (
                <div className="quiet-empty">等你留下第一条记录，未来的回声就会从这里开始。</div>
              )}
            </div>

            <aside className="desk-side">
              <div className="focus-note">
                <div className="panel-label"><span>02</span><p>正在发酵</p></div>
                <strong>{seeds.length || 0}</strong>
                <p>个还不必急着完成的念头</p>
                <button onClick={() => navigate("garden")}>去花园看看 →</button>
              </div>
              <div className="focus-note ink">
                <div className="panel-label"><span>03</span><p>等待验证</p></div>
                <strong>{experiments.length || 0}</strong>
                <p>件可以带回生活的事情</p>
                <button onClick={() => navigate("lab")}>进入实验室 →</button>
              </div>
            </aside>
          </section>

          <section className="desk-strip">
            <div className="strip-heading"><span>RECENT SPARKS</span><h2>最近的火花</h2><button onClick={() => navigate("stream")}>打开灵感流 →</button></div>
            <div className="spark-list">
              {articles.slice(0, 5).map((article, index) => (
                <button key={article.id} onClick={() => openArticle(article)}>
                  <span>0{index + 1}</span><strong>{article.title}</strong><small>{normalizeStage(article.stage)}</small>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {view === "stream" && (
        <section className="workspace stream-view">
          <ViewHeading eyebrow="PRIVATE STREAM" title="灵感流" copy="这里允许混乱。先留下，再决定它要长成什么。" action={() => startEdit()} actionLabel="＋ 写点什么" />
          <div className="stream-tools">
            <label><span>⌕</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索记忆中的某个词……" /></label>
            <div className="stage-filters">
              <button className={!stageFilter ? "active" : ""} onClick={() => setStageFilter("")}>全部</button>
              {stages.map(([stage]) => <button key={stage} className={stageFilter === stage ? "active" : ""} onClick={() => setStageFilter(stage)}>{stage}</button>)}
            </div>
          </div>
          <div className="stream-list">
            {filtered.map((article) => <StreamCard key={article.id} article={article} onOpen={openArticle} />)}
            {!filtered.length && <div className="quiet-empty">这里暂时没有匹配的内容。</div>}
          </div>
        </section>
      )}

      {view === "garden" && (
        <section className="workspace">
          <ViewHeading eyebrow="MIND GARDEN" title="思考花园" copy="内容不按文件夹被关起来，而是在不同的生长阶段里慢慢变化。" />
          <div className="garden-guide">
            {stages.map(([stage, hint, icon]) => (
              <div key={stage}><i>{icon}</i><strong>{stage}</strong><p>{hint}</p></div>
            ))}
          </div>
          <div className="garden-columns">
            {stages.map(([stage]) => {
              const items = articles.filter((article) => normalizeStage(article.stage) === stage);
              return (
                <section key={stage} className={`garden-stage stage-${stage}`}>
                  <header><span>{stage}</span><small>{items.length}</small></header>
                  <div>
                    {items.map((article) => <button key={article.id} onClick={() => openArticle(article)}><strong>{article.title}</strong><p>{article.summary || article.body.slice(0, 72)}</p><small>{formatDate(article.updated || article.created)}</small></button>)}
                    {!items.length && <p className="stage-empty">还没有内容生长到这里</p>}
                  </div>
                </section>
              );
            })}
          </div>
        </section>
      )}

      {view === "lab" && (
        <section className="workspace lab-view">
          <ViewHeading eyebrow="LIFE LAB" title="生活实验室" copy="知识只有被使用过，才真正属于你。这里放置等待验证的判断和下一步。" />
          <div className="lab-board">
            {experiments.map((article, index) => (
              <article key={article.id} className="experiment-card">
                <header><span>EXP.{String(index + 1).padStart(2, "0")}</span><em>{normalizeStage(article.stage) === "实验" ? "验证中" : "待行动"}</em></header>
                <button onClick={() => openArticle(article)}><h2>{article.title}</h2><p>{article.next || "还没有写下具体的验证方式。"}</p></button>
                <footer><small>来自 · {article.branch}</small>{normalizeStage(article.stage) !== "实验" && <button disabled={saving} onClick={() => moveToStage(article, "实验")}>开始验证</button>}</footer>
              </article>
            ))}
            {!experiments.length && <div className="lab-empty"><span>△</span><h2>实验台还是空的</h2><p>在回看一条内容时选择“带去验证”，它就会来到这里。</p></div>}
          </div>
        </section>
      )}

      {view === "article" && selected && (
        <article className="article-view">
          <button className="back" onClick={() => navigate("stream")}>← 回到灵感流</button>
          <header>
            <div className="article-kicker"><span>{normalizeStage(selected.stage)}</span><i>{selected.branch} / {selected.subbranch || "待分类"}</i></div>
            <h1>{selected.title}</h1>
            {selected.summary && <p>{selected.summary}</p>}
            <div className="article-meta"><span>{formatDate(selected.updated || selected.created)}</span><span>{selected.validity}</span>{selected.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>
          </header>
          <MarkdownBody body={selected.body} />
          {selected.next && <aside className="next-card"><span>NEXT EXPERIMENT</span><strong>下一步</strong><p>{selected.next}</p></aside>}

          <section className="article-reflect">
            <span>REVISIT · 回看</span>
            <h2>现在的你，会怎样回应当时的自己？</h2>
            <textarea value={echoNote} onChange={(event) => setEchoNote(event.target.value)} placeholder="补充一句新的理解……" rows={3} />
            <div>
              <button disabled={saving} onClick={() => recordEcho(selected, "agree")}>仍然认同</button>
              <button disabled={saving} onClick={() => recordEcho(selected, "changed")}>观点变了</button>
              <button className="strong" disabled={saving} onClick={() => recordEcho(selected, "experiment")}>转为实验</button>
            </div>
          </section>

          {related.length > 0 && <section className="related"><span>CONNECTED THOUGHTS</span><h2>沿着这条思路继续</h2>{related.map((article) => <button key={article.id} onClick={() => openArticle(article)}><strong>{article.title}</strong><small>{article.branch} →</small></button>)}</section>}

          <div className="article-actions"><button onClick={() => startEdit(selected)}>编辑这条内容</button><button className="danger" disabled={saving} onClick={() => removeArticle(selected)}>移除</button></div>
        </article>
      )}

      {view === "edit" && (
        <section className="workspace editor-view">
          <ViewHeading eyebrow={draft.id ? "EDIT THOUGHT" : "NEW THOUGHT"} title={draft.id ? "继续写下去" : "留下一段思考"} copy="先忠于此刻的想法，结构可以以后慢慢长出来。" />
          <div className="editor-paper">
            <input className="title-input" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="给它一个名字……" />
            <textarea className="body-input" rows={18} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} placeholder="从这里开始写。发生了什么？你感受到什么？现在怎样理解它？" />
            <label className="next-input"><span>下一步或待验证的问题</span><input value={draft.next} onChange={(event) => setDraft({ ...draft, next: event.target.value })} placeholder="如果暂时没有，也可以留空" /></label>
            <details>
              <summary>整理信息 <span>可选，稍后再做也可以</span></summary>
              <div className="organize-grid">
                <label><span>生长状态</span><select value={normalizeStage(draft.stage)} onChange={(event) => setDraft({ ...draft, stage: event.target.value })}>{stages.map(([stage]) => <option key={stage}>{stage}</option>)}</select></label>
                <label><span>主线</span><select value={draft.branch} onChange={(event) => setDraft({ ...draft, branch: event.target.value, subbranch: branches[event.target.value]?.[0] || "" })}>{Object.keys(branches).map((branch) => <option key={branch}>{branch}</option>)}</select></label>
                <label><span>子分支</span><select value={draft.subbranch} onChange={(event) => setDraft({ ...draft, subbranch: event.target.value })}>{(branches[draft.branch] || []).map((subbranch) => <option key={subbranch}>{subbranch}</option>)}</select></label>
                <label><span>内容形态</span><select value={draft.collection} onChange={(event) => { const match = collections.find(([value]) => value === event.target.value); setDraft({ ...draft, collection: event.target.value, collectionLabel: match?.[1] || "私人记录", category: match?.[1] || "私人记录" }); }}>{collections.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label className="wide"><span>摘要</span><input value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} placeholder="一句话概括，也可以留空" /></label>
                <label className="wide"><span>标签</span><input value={draft.tags.join(" ")} onChange={(event) => setDraft({ ...draft, tags: event.target.value.split(/[,，、\s]+/u).filter(Boolean) })} placeholder="用空格分隔" /></label>
              </div>
            </details>
          </div>
          <div className="editor-actions"><button className="secondary" onClick={() => navigate(draft.id ? "stream" : "desk")}>取消</button><button className="save" disabled={saving} onClick={saveDraft}>{saving ? "保存中…" : "保存这段思考"}</button></div>
        </section>
      )}

      <nav className="mobile-nav" aria-label="移动端导航">
        <NavButton active={view === "desk"} onClick={() => navigate("desk")}><span>⌂</span>此刻</NavButton>
        <NavButton active={view === "stream"} onClick={() => navigate("stream")}><span>≋</span>灵感</NavButton>
        <button className="mobile-capture" onClick={() => startEdit()}><span>＋</span>记录</button>
        <NavButton active={view === "garden"} onClick={() => navigate("garden")}><span>⌇</span>花园</NavButton>
        <NavButton active={view === "lab"} onClick={() => navigate("lab")}><span>△</span>实验</NavButton>
      </nav>
    </main>
  );
}

function NavButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className={active ? "active" : ""} onClick={onClick}>{children}</button>;
}

function ViewHeading({ eyebrow, title, copy, action, actionLabel }: { eyebrow: string; title: string; copy: string; action?: () => void; actionLabel?: string }) {
  return (
    <header className="view-heading">
      <div><span>{eyebrow}</span><h1>{title}</h1><p>{copy}</p></div>
      {action && <button onClick={action}>{actionLabel}</button>}
    </header>
  );
}

function StreamCard({ article, onOpen }: { article: Article; onOpen: (article: Article) => void }) {
  return (
    <button className="stream-card" onClick={() => onOpen(article)}>
      <span className="stream-date">{formatDate(article.updated || article.created)}</span>
      <div><em>{normalizeStage(article.stage)}</em><h2>{article.title}</h2><p>{article.summary || article.body.slice(0, 120)}</p>{article.tags.length > 0 && <small>{article.tags.slice(0, 3).map((tag) => `#${tag}`).join("  ")}</small>}</div>
      <i>↗</i>
    </button>
  );
}
