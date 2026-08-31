import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { IntegrationRepository } from "../app/data/integration-repository";
import type {
  GitHubCommit,
  GitHubRelease,
  GitHubRepositoryConfig,
  GitHubRepositorySnapshot,
  ModelBalance,
  SecretKind,
  UsageConsoleSnapshot,
} from "../app/integration-types";
import type { LinkOpenMode, QuickLink, ToolArea } from "../app/workspace-preferences";
import { BrandLogo, brandForLink } from "./BrandLogo";
import { desktopApi, openInternalUrl, openQuickLink } from "./integrationApi";
import "./styles/ai-tools.css";

type ToolTab = "ai" | "development" | "accounts" | "entertainment" | "web";

const tabs: Array<{ id: ToolTab; label: string }> = [
  { id: "ai", label: "AI模型" },
  { id: "development", label: "GitHub" },
  { id: "accounts", label: "账户用量" },
  { id: "entertainment", label: "娱乐" },
  { id: "web", label: "常用网站" },
];

export function ToolCenterPage({ repository, quickLinks, onSaveQuickLinks, onOpenAi }: {
  repository: IntegrationRepository;
  quickLinks: QuickLink[];
  onSaveQuickLinks: (links: QuickLink[]) => Promise<void>;
  onOpenAi: () => void;
}) {
  const [tab, setTab] = useState<ToolTab>("ai");
  const [repositories, setRepositories] = useState<GitHubRepositoryConfig[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, GitHubRepositorySnapshot>>({});
  const [repositoryErrors, setRepositoryErrors] = useState<Record<string, string>>({});
  const [balances, setBalances] = useState<Partial<Record<"deepseek" | "qwen", ModelBalance>>>({});
  const [usage, setUsage] = useState<Partial<Record<"deepseek" | "qwen", UsageConsoleSnapshot>>>({});
  const [notice, setNotice] = useState("");
  const [busyKey, setBusyKey] = useState("");

  const load = useCallback(async () => {
    const configs = await repository.listGitHubRepositories();
    setRepositories(configs);
    const cachedSnapshots: Record<string, GitHubRepositorySnapshot> = {};
    for (const config of configs) {
      const cached = await repository.getCache<GitHubRepositorySnapshot>(`github:${config.id}`);
      if (cached) cachedSnapshots[config.id] = cached.value;
    }
    const deepseekBalance = await repository.getCache<ModelBalance>("balance:deepseek");
    const qwenBalance = await repository.getCache<ModelBalance>("balance:qwen");
    const deepseekUsage = await repository.getCache<UsageConsoleSnapshot>("usage:deepseek");
    const qwenUsage = await repository.getCache<UsageConsoleSnapshot>("usage:qwen");
    setSnapshots(cachedSnapshots);
    setBalances({ deepseek: deepseekBalance?.value, qwen: qwenBalance?.value });
    setUsage({ deepseek: deepseekUsage?.value, qwen: qwenUsage?.value });
  }, [repository]);

  useEffect(() => { void load().catch((error) => setNotice(describeError(error))); }, [load]);

  async function refreshRepository(config: GitHubRepositoryConfig) {
    setBusyKey(`github:${config.id}`);
    setNotice("");
    setRepositoryErrors((value) => {
      const next = { ...value };
      delete next[config.id];
      return next;
    });
    try {
      const snapshot = await desktopApi.github.fetch(config.owner, config.name);
      await repository.saveCache(`github:${config.id}`, snapshot, snapshot.fetchedAt);
      setSnapshots((value) => ({ ...value, [config.id]: snapshot }));
    } catch (error) {
      const message = describeError(error);
      setRepositoryErrors((value) => ({ ...value, [config.id]: message }));
      setNotice(`${config.owner}/${config.name} 读取失败，具体原因已显示在仓库卡片中。`);
    } finally {
      setBusyKey("");
    }
  }

  async function refreshBalance(provider: "deepseek" | "qwen") {
    setBusyKey(`balance:${provider}`);
    setNotice("");
    try {
      const balance = provider === "deepseek" ? await desktopApi.balances.deepseek() : await desktopApi.balances.qwen();
      await repository.saveCache(`balance:${provider}`, balance, balance.fetchedAt);
      setBalances((value) => ({ ...value, [provider]: balance }));
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      setBusyKey("");
    }
  }

  async function readUsage(provider: "deepseek" | "qwen") {
    setBusyKey(`usage:${provider}`);
    setNotice("");
    try {
      const snapshot = await desktopApi.usage.read(provider);
      await repository.saveCache(`usage:${provider}`, snapshot, snapshot.fetchedAt);
      setUsage((value) => ({ ...value, [provider]: snapshot }));
      if (snapshot.message) setNotice(snapshot.message);
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      setBusyKey("");
    }
  }

  async function readQwenMonitor(start: string, end: string) {
    setBusyKey("usage:qwen-monitor");
    setNotice("");
    try {
      const snapshot = await desktopApi.usage.qwenMonitor(`${start}T00:00:00.000Z`, `${end}T23:59:59.000Z`);
      await repository.saveCache("usage:qwen", snapshot, snapshot.fetchedAt);
      setUsage((value) => ({ ...value, qwen: snapshot }));
      if (snapshot.message) setNotice(snapshot.message);
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      setBusyKey("");
    }
  }

  return (
    <div className="tools-center workspace-scroll">
      <header className="tools-heading"><div><span>工具中心</span><h1>网页只是能力的载体</h1><p>高频信息留在工作台，偶尔使用的网站按需打开。</p></div></header>
      <div className="tools-layout">
        <nav className="tools-tabs" aria-label="工具分类">{tabs.map((item) => <button className={tab === item.id ? "active" : ""} key={item.id} onClick={() => setTab(item.id)}><strong>{item.label}</strong></button>)}</nav>
        <main className="tools-content">
          {notice && <div className="tools-notice" role="alert"><span>{notice}</span><button onClick={() => setNotice("")}>×</button></div>}
          {tab === "ai" && <AiTools links={quickLinks} onSave={onSaveQuickLinks} onOpenAi={onOpenAi} onNotice={setNotice} />}
          {tab === "development" && <DevelopmentTools
            repository={repository}
            repositories={repositories}
            snapshots={snapshots}
            errors={repositoryErrors}
            busyKey={busyKey}
            onReload={load}
            onRefresh={refreshRepository}
            onNotice={setNotice}
          />}
          {tab === "accounts" && <AccountTools balances={balances} usage={usage} busyKey={busyKey} onRefreshBalance={refreshBalance} onReadUsage={readUsage} onReadQwenMonitor={readQwenMonitor} onNotice={setNotice} />}
          {tab === "entertainment" && <EntertainmentTools links={quickLinks} onSave={onSaveQuickLinks} onNotice={setNotice} />}
          {tab === "web" && <LinkLibrary area="web" links={quickLinks} onSave={onSaveQuickLinks} onNotice={setNotice} />}
        </main>
      </div>
    </div>
  );
}

function AiTools({ links, onSave, onOpenAi, onNotice }: { links: QuickLink[]; onSave: (links: QuickLink[]) => Promise<void>; onOpenAi: () => void; onNotice: (message: string) => void }) {
  const visible = useMemo(() => links.filter((link) => link.area === "ai" && link.id !== "deepseek"), [links]);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  async function add(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !url.trim()) return;
    const normalized = /^https?:\/\//i.test(url) ? url.trim() : `https://${url.trim()}`;
    const next: QuickLink = { id: `ai-link-${Date.now()}`, title: title.trim(), url: normalized, category: "general", area: "ai", openMode: "external", allowInsecureHttp: false, pinned: false, order: links.length };
    try {
      await onSave([...links, next]);
      setTitle("");
      setUrl("");
      setAdding(false);
    } catch (error) { onNotice(describeError(error)); }
  }
  async function remove(link: QuickLink) {
    try { await onSave(links.filter((item) => item.id !== link.id)); }
    catch (error) { onNotice(describeError(error)); }
  }
  async function open(link: QuickLink) {
    try { await openQuickLink(link); }
    catch (error) { onNotice(describeError(error)); }
  }
  return <section className="tool-section ai-tools"><header><div><span>原生对话</span><h2>DeepSeek AI 助手</h2><p>使用官网会话完成简单问答，当前运行期间支持多轮上下文。</p></div><div className="tool-section-header-actions"><button onClick={() => setAdding((value) => !value)}>{adding ? "取消" : "＋ 添加链接"}</button><button className="primary" onClick={onOpenAi}>打开对话</button></div></header>{adding && <form className="link-add-form" onSubmit={add}><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="名称" /><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." /><button>保存</button></form>}<div className="tool-link-grid">{visible.map((link) => <article key={link.id}><button className="ai-link-main" onClick={() => void open(link)}><BrandMark link={link} /><span><strong>{link.title}</strong><small>{hostOf(link.url)}</small></span><em>↗</em></button><button className="ai-link-delete danger" onClick={() => void remove(link)} aria-label={`删除 ${link.title}`}>删除</button></article>)}</div>{!visible.length && <p className="tool-placeholder">还没有 AI 模型链接，可以点击“添加链接”创建入口。</p>}</section>;
}

function EntertainmentTools({ links, onSave, onNotice }: { links: QuickLink[]; onSave: (links: QuickLink[]) => Promise<void>; onNotice: (message: string) => void }) {
  return <LinkLibrary area="entertainment" links={links} onSave={onSave} onNotice={onNotice} />;
}

function DevelopmentTools({ repository, repositories, snapshots, errors, busyKey, onReload, onRefresh, onNotice }: {
  repository: IntegrationRepository;
  repositories: GitHubRepositoryConfig[];
  snapshots: Record<string, GitHubRepositorySnapshot>;
  errors: Record<string, string>;
  busyKey: string;
  onReload: () => Promise<void>;
  onRefresh: (config: GitHubRepositoryConfig) => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [owner, setOwner] = useState("");
  const [name, setName] = useState("");
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const configurationRef = useRef<HTMLDetailsElement>(null);

  function showConfiguration() {
    setConfigurationOpen(true);
    window.requestAnimationFrame(() => configurationRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!owner.trim() || !name.trim()) return;
    const config: GitHubRepositoryConfig = {
      id: `github-${owner.trim()}-${name.trim()}`.toLocaleLowerCase(),
      owner: owner.trim(),
      name: name.trim(),
      displayName: "",
      enabled: true,
      homePinned: repositories.filter((item) => item.homePinned).length < 3,
      order: repositories.length,
    };
    try {
      await repository.saveGitHubRepository(config);
      setOwner(""); setName("");
      await onReload();
      setConfigurationOpen(false);
    } catch (error) { onNotice(describeError(error)); }
  }

  async function togglePinned(config: GitHubRepositoryConfig) {
    if (!config.homePinned && repositories.filter((item) => item.homePinned).length >= 3) {
      onNotice("首页最多展示三个 GitHub 仓库，请先取消一个首页展示。");
      return;
    }
    await repository.saveGitHubRepository({ ...config, homePinned: !config.homePinned });
    await onReload();
  }

  return <section className="tool-section github-tools">
    <header><div><span>GitHub</span><h2>私有仓库动态</h2><p>进入页面先看最近提交和 Release，需要变更连接时再打开设置。</p></div><div className="tool-section-header-actions"><button onClick={() => void openInternalUrl("https://github.com").catch((error) => onNotice(describeError(error)))}>打开 GitHub</button><button className={configurationOpen ? "active" : ""} onClick={() => configurationOpen ? setConfigurationOpen(false) : showConfiguration()}>{configurationOpen ? "收起设置" : "管理仓库"}</button></div></header>
    {repositories.length ? <div className="github-repository-list">{repositories.map((config) => {
      const snapshot = snapshots[config.id];
      const error = errors[config.id];
      return <article key={config.id} className={`github-repository-card${error ? " has-error" : ""}`}>
        <header>
          <div className="github-repository-identity">
            <i><BrandLogo brand="github" /></i>
            <div><small>仓库</small><strong>{config.displayName || `${config.owner}/${config.name}`}</strong><span>{error ? "本次刷新失败" : snapshot ? `更新于 ${relativeTime(snapshot.fetchedAt)}` : "尚未读取"}</span></div>
          </div>
          <div className="github-repository-actions">
            <button className={config.homePinned ? "github-home-toggle active" : "github-home-toggle"} onClick={() => void togglePinned(config)}>{config.homePinned ? "首页展示中" : "设为首页"}</button>
            <button className="github-refresh-button" onClick={() => void onRefresh(config)} disabled={busyKey === `github:${config.id}`} title="刷新仓库动态">{busyKey === `github:${config.id}` ? "刷新中…" : "↻ 刷新"}</button>
            <details className="github-repository-menu">
              <summary aria-label="更多仓库操作" title="更多仓库操作">•••</summary>
              <div><button className="danger" onClick={() => void repository.deleteGitHubRepository(config.id).then(onReload)}>删除仓库</button></div>
            </details>
          </div>
        </header>
        {error && <GitHubRepositoryError config={config} message={error} onNotice={onNotice} />}
        {snapshot ? <div className="github-activity-grid"><GitHubCommitItems commits={snapshot.commits} /><GitHubReleaseItems releases={snapshot.releases} /></div> : !error && <p className="tool-placeholder">保存只读 PAT 后刷新，即可读取公开或私有仓库信息。</p>}
      </article>;
    })}</div> : <div className="tool-empty-state"><div><strong>还没有仓库动态</strong><p>添加常用仓库后，这里会直接显示最近提交和 Release。</p></div><button className="primary" onClick={showConfiguration}>添加第一个仓库</button></div>}
    <details ref={configurationRef} className="tool-settings-panel" open={configurationOpen} onToggle={(event) => setConfigurationOpen(event.currentTarget.open)}>
      <summary><span><strong>仓库与访问设置</strong><small>PAT、仓库列表和首页展示均在这里管理</small></span></summary>
      <div className="tool-settings-content">
        <SecretEditor
          kind="github_pat"
          label="Fine-grained PAT"
          hint="建议仅授予所选仓库 Contents: read 权限"
          placeholder="github_pat_..."
          onNotice={onNotice}
          help={<>
            <ol>
              <li><strong>创建只读凭据</strong><p>打开 GitHub 的 Fine-grained token 页面，Resource owner 选择你的账号；Repository access 选择“Only select repositories”并勾选要展示的仓库。</p></li>
              <li><strong>只给读取权限</strong><p>在 Repository permissions 中把 Contents 设为 Read-only。生成后复制以 <code>github_pat_</code> 开头的完整内容，粘贴到下方 Fine-grained PAT。</p></li>
              <li><strong>填写仓库地址</strong><p>如果仓库网址是 <code>github.com/muyuxiaoluo/my-project</code>，仓库所有者填 <code>muyuxiaoluo</code>，仓库名称填 <code>my-project</code>，不要粘贴整段网址。</p></li>
            </ol>
            <div className="configuration-guide-actions"><button type="button" onClick={() => void openInternalUrl("https://github.com/settings/personal-access-tokens/new").catch((error) => onNotice(describeError(error)))}>去 GitHub 创建凭据</button><button type="button" onClick={() => void openInternalUrl("https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens").catch((error) => onNotice(describeError(error)))}>查看官方说明</button></div>
            <p className="configuration-safety">凭据只保存在 Windows 系统凭据管理器中，保存后本项目不会把完整内容重新显示出来。</p>
          </>}
        />
        <form className="github-add-form" onSubmit={add}><label><span>仓库所有者</span><input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="例如：muyuxiaoluo" /></label><label><span>仓库名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：life-strategy-library" /></label><button>添加仓库</button></form>
      </div>
    </details>
  </section>;
}

function GitHubCommitItems({ commits }: { commits: GitHubCommit[] }) {
  const recent = commits.slice(0, 2);
  const earlier = commits.slice(2);
  const renderCommit = (commit: GitHubCommit) => <button className="github-activity-row" key={commit.sha} onClick={() => void openInternalUrl(commit.url)}><i aria-hidden="true">●</i><span><strong>{commit.message}</strong><small>{commit.author} · {relativeTime(commit.committedAt)}</small></span></button>;
  return <section className="github-activity-group commits"><header><div><span>代码动态</span><h3>最近提交</h3></div><b>{commits.length}</b></header>{recent.map(renderCommit)}{earlier.length > 0 && <details className="github-more-items"><summary>更早的 {earlier.length} 次提交</summary><div>{earlier.map(renderCommit)}</div></details>}</section>;
}

function GitHubReleaseItems({ releases }: { releases: GitHubRelease[] }) {
  if (!releases.length) return <section className="github-activity-group releases empty"><header><div><span>版本动态</span><h3>Release</h3></div><b>0</b></header><p>暂无 Release</p></section>;
  const recent = releases.slice(0, 2);
  const earlier = releases.slice(2);
  const renderRelease = (release: GitHubRelease) => <button className="github-activity-row" key={release.id} onClick={() => void openInternalUrl(release.url)}><i aria-hidden="true">◇</i><span><strong>{release.name}</strong><small>{release.tagName} · {relativeTime(release.publishedAt)}</small></span></button>;
  return <section className="github-activity-group releases"><header><div><span>版本动态</span><h3>Release</h3></div><b>{releases.length}</b></header>{recent.map(renderRelease)}{earlier.length > 0 && <details className="github-more-items"><summary>更早的 {earlier.length} 个 Release</summary><div>{earlier.map(renderRelease)}</div></details>}</section>;
}

function GitHubRepositoryError({ config, message, onNotice }: {
  config: GitHubRepositoryConfig;
  message: string;
  onNotice: (message: string) => void;
}) {
  const privateAccessHidden = /404|没有找到仓库|看不到这个私有仓库/.test(message);
  return <section className="github-repository-error" role="alert">
    <strong>{privateAccessHidden ? "这个私有仓库存在，但当前保存的 PAT 看不到它" : "GitHub 没有完成这次读取"}</strong>
    <p>{message}</p>
    {privateAccessHidden && <ol>
      <li>打开当前 Fine-grained PAT，确认 <b>Resource owner</b> 是 <code>{config.owner}</code>。</li>
      <li>在 <b>Repository access</b> 中确认已选中 <code>{config.name}</code>。</li>
      <li>在 <b>Repository permissions</b> 中把 <b>Contents</b> 设为 <b>Read-only</b>。</li>
      <li>如果你生成的是另一枚新 PAT，请把新值粘贴到上方并点击“保存”替换旧值。</li>
    </ol>}
    <div><button onClick={() => void openInternalUrl("https://github.com/settings/personal-access-tokens").catch((error) => onNotice(describeError(error)))}>检查 PAT 仓库范围</button><button onClick={() => void openInternalUrl(`https://github.com/${config.owner}/${config.name}`).catch((error) => onNotice(describeError(error)))}>打开仓库确认地址</button></div>
  </section>;
}

function AccountTools({ balances, usage, busyKey, onRefreshBalance, onReadUsage, onReadQwenMonitor, onNotice }: {
  balances: Partial<Record<"deepseek" | "qwen", ModelBalance>>;
  usage: Partial<Record<"deepseek" | "qwen", UsageConsoleSnapshot>>;
  busyKey: string;
  onRefreshBalance: (provider: "deepseek" | "qwen") => Promise<void>;
  onReadUsage: (provider: "deepseek" | "qwen") => Promise<void>;
  onReadQwenMonitor: (start: string, end: string) => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const initialStart = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [rangeStart, setRangeStart] = useState(initialStart);
  const [rangeEnd, setRangeEnd] = useState(today);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const configurationRef = useRef<HTMLDetailsElement>(null);

  function showConfiguration() {
    setConfigurationOpen(true);
    window.requestAnimationFrame(() => configurationRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }

  return <section className="tool-section account-tools"><header><div><span>模型账户</span><h2>余额与 Token 用量</h2><p>余额、用量和更新时间优先展示；凭据只在需要维护时展开。</p></div><div className="tool-section-header-actions"><button className={configurationOpen ? "active" : ""} onClick={() => configurationOpen ? setConfigurationOpen(false) : showConfiguration()}>{configurationOpen ? "收起设置" : "账户设置"}</button></div></header>
    <div className="account-provider-grid">{(["deepseek", "qwen"] as const).map((provider) => {
      const balance = balances[provider];
      const modelUsage = usage[provider];
      const rows = modelUsage?.rows ?? [];
      const totalTokens = rows.reduce((total, row) => total + row.totalTokens, 0);
      const label = provider === "deepseek" ? "DeepSeek" : "Qwen / 阿里云";
      const brand = provider === "deepseek" ? "deepseek" : "alibaba-cloud";
      const refreshing = busyKey === `balance:${provider}`;
      return <article className={`account-provider-card ${provider}`} key={provider}>
        <header className="account-provider-header">
          <div className="account-provider-identity"><i><BrandLogo brand={brand} /></i><div><span>{label}</span><small>{balance?.message || (balance ? `更新于 ${relativeTime(balance.fetchedAt)}` : "尚未连接余额数据")}</small></div></div>
          <button className="account-refresh-button" onClick={() => void onRefreshBalance(provider)} disabled={refreshing}>{refreshing ? "读取中…" : "↻ 更新"}</button>
        </header>
        <div className="account-balance-block"><small>API 账户余额</small><strong>{balance ? `${balance.currency} ${balance.amount || "0"}` : "—"}</strong></div>
        <section className="account-usage-panel">
          <header><div><span>Token 用量</span><small>{modelUsage ? `更新于 ${relativeTime(modelUsage.fetchedAt)}` : "最近一次读取"}</small></div><strong>{rows.length ? formatNumber(totalTokens) : "暂无数据"}</strong></header>
          {rows.length ? <ul>{rows.map((row, index) => <li key={`${row.model}-${index}`}><span>{row.model}</span><strong>{formatNumber(row.totalTokens)}</strong><small>输入 {formatNumber(row.inputTokens)} · 输出 {formatNumber(row.outputTokens)}</small></li>)}</ul> : <div className="account-usage-empty"><i>—</i><span>尚未读取 Token 明细</span></div>}
        </section>
        <details className="account-provider-more">
          <summary><span>更多操作</span><small>网页读取{provider === "qwen" ? "与高级监控" : ""}</small></summary>
          <div className="account-provider-more-content">
            <div className="account-provider-quick-actions"><button onClick={() => void desktopApi.usage.open(provider).catch((error) => onNotice(describeError(error)))}>打开官方用量页 ↗</button><button onClick={() => void onReadUsage(provider)} disabled={busyKey === `usage:${provider}`}>{busyKey === `usage:${provider}` ? "读取中…" : "读取已打开页面"}</button></div>
            {provider === "qwen" && <div className="qwen-monitor-range"><label><span>开始</span><input type="date" value={rangeStart} max={rangeEnd} onChange={(event) => setRangeStart(event.target.value)} /></label><label><span>结束</span><input type="date" value={rangeEnd} min={rangeStart} max={today} onChange={(event) => setRangeEnd(event.target.value)} /></label><button onClick={() => void onReadQwenMonitor(rangeStart, rangeEnd)} disabled={busyKey === "usage:qwen-monitor" || !rangeStart || !rangeEnd}>{busyKey === "usage:qwen-monitor" ? "查询中…" : "读取高级监控"}</button></div>}
            <p>先在官方控制台登录并进入用量明细，再读取当前页面。高级监控只在你主动操作时查询。</p>
          </div>
        </details>
      </article>;
    })}</div><p className="monitoring-note">数据仅在你主动刷新时读取；Qwen 高级监控默认关闭。</p>
    <details ref={configurationRef} className="tool-settings-panel" open={configurationOpen} onToggle={(event) => setConfigurationOpen(event.currentTarget.open)}>
      <summary><span><strong>凭据与高级统计设置</strong><small>日常查看无需展开，所有凭据仍只保存在本机</small></span></summary>
      <div className="tool-settings-content">
        <p className="account-configuration-summary">以下配置均为可选项，只使用网页 AI 对话时无需填写。点击字段旁的 <b>?</b> 查看来源和填写步骤。</p>
        <div className="credential-grid">
          <SecretEditor kind="deepseek_api_key" label="DeepSeek API Key" hint="仅用于查询 API 余额，不会用于模型推理" placeholder="sk-..." onNotice={onNotice} help={<><ol><li><strong>打开 DeepSeek 开放平台</strong><p>登录后进入“API Keys / API 密钥”，创建一个新 Key。</p></li><li><strong>复制并粘贴</strong><p>把以 <code>sk-</code> 开头的完整 Key 粘贴到此处。它不会用于网页问答，也不会产生推理调用。</p></li></ol><div className="configuration-guide-actions"><button type="button" onClick={() => void openInternalUrl("https://platform.deepseek.com/api_keys").catch((error) => onNotice(describeError(error)))}>打开 API Key 页面</button><button type="button" onClick={() => void openInternalUrl("https://api-docs.deepseek.com/zh-cn/api/get-user-balance/").catch((error) => onNotice(describeError(error)))}>余额接口说明</button></div></>} />
          <SecretEditor kind="aliyun_access_key_id" label="阿里云 AccessKey ID" hint="建议使用只读 RAM 用户" placeholder="通常以 LTAI 开头" onNotice={onNotice} help={<AliyunAccessKeyHelp onNotice={onNotice} />} />
          <SecretEditor kind="aliyun_access_key_secret" label="阿里云 AccessKey Secret" hint="保存在 Windows 系统凭据管理器" placeholder="粘贴只显示一次的 Secret" onNotice={onNotice} help={<AliyunAccessKeyHelp onNotice={onNotice} />} />
          <SecretEditor kind="qwen_monitor_credential" label="Qwen 监控 HTTP API 地址" hint="仅在手动开启高级监控后填写" placeholder="https://..." inputType="url" onNotice={onNotice} help={<><ol><li><strong>普通查看不需要填写</strong><p>可直接使用上方“打开官方用量页”和“读取当前页面”。</p></li><li><strong>需要自动统计时再开启</strong><p>在阿里云百炼“模型监控”中手动开启高级监控，然后进入云监控 Prometheus 实例详情。</p></li><li><strong>复制完整 HTTP API 地址</strong><p>复制公网访问地址中以 <code>https://</code> 开头的完整 HTTP API 地址；不要填写控制台网页地址。</p></li></ol><div className="configuration-guide-actions"><button type="button" onClick={() => void openInternalUrl("https://help.aliyun.com/zh/model-studio/model-telemetry").catch((error) => onNotice(describeError(error)))}>查看阿里云图文步骤</button><button type="button" onClick={() => void desktopApi.usage.open("qwen").catch((error) => onNotice(describeError(error)))}>打开百炼控制台</button></div><p className="configuration-warning">高级监控可能产生费用，本项目不会代你开通。</p></>} />
        </div>
      </div>
    </details>
  </section>;
}

function AliyunAccessKeyHelp({ onNotice }: { onNotice: (message: string) => void }) {
  return <><ol><li><strong>建议新建只读 RAM 用户</strong><p>不要使用主账号 AccessKey。为 RAM 用户授予 <code>AliyunBSSReadOnlyAccess</code>，只读取费用与账户余额。</p></li><li><strong>创建 AccessKey</strong><p>在 RAM 用户的认证管理中创建 AccessKey。把通常以 <code>LTAI</code> 开头的 ID 和只显示一次的 Secret 分别粘贴到对应字段。</p></li></ol><div className="configuration-guide-actions"><button type="button" onClick={() => void openInternalUrl("https://ram.console.aliyun.com/manage/ak").catch((error) => onNotice(describeError(error)))}>打开 AccessKey 管理</button><button type="button" onClick={() => void openInternalUrl("https://help.aliyun.com/en/user-center/developer-reference/api-calling-authorization").catch((error) => onNotice(describeError(error)))}>查看只读权限说明</button></div></>;
}

function ConfigurationHelp({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="configuration-help-trigger" aria-label={`查看${title}`} title={title} onClick={() => setOpen(true)}>?</button>
    {open && <div className="configuration-help-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section className="configuration-help-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header><div><span>配置帮助</span><h2>{title}</h2></div><button type="button" aria-label="关闭配置帮助" onClick={() => setOpen(false)}>×</button></header>
        <div className="configuration-guide-body">{children}</div>
      </section>
    </div>}
  </>;
}

function SecretEditor({ kind, label, hint, placeholder = "粘贴凭据", inputType = "password", onNotice, help }: { kind: SecretKind; label: string; hint: string; placeholder?: string; inputType?: "password" | "url"; onNotice: (message: string) => void; help?: ReactNode }) {
  const [configured, setConfigured] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (isTauri()) void desktopApi.secrets.status(kind).then(setConfigured).catch(() => setConfigured(false)); }, [kind]);
  async function save(event: FormEvent) { event.preventDefault(); if (!value.trim()) return; setBusy(true); try { await desktopApi.secrets.set(kind, value); setValue(""); setConfigured(true); onNotice(`${label} 已安全保存。`); } catch (error) { onNotice(describeError(error)); } finally { setBusy(false); } }
  async function remove() { setBusy(true); try { await desktopApi.secrets.delete(kind); setConfigured(false); onNotice(`${label} 已从系统凭据管理器删除。`); } catch (error) { onNotice(describeError(error)); } finally { setBusy(false); } }
  return <form className="secret-editor" onSubmit={save}><header><div><div className="secret-editor-title"><strong>{label}</strong>{help && <ConfigurationHelp title={`${label} 怎么配置？`}>{help}</ConfigurationHelp>}</div><small>{hint}</small></div><span className={configured ? "configured" : ""}>{configured ? "已配置" : "未配置"}</span></header><div><input type={inputType} autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} placeholder={configured ? "输入新值以替换" : placeholder} /><button disabled={busy || !value.trim()}>{busy ? "保存中…" : "保存"}</button>{configured && <button type="button" className="danger" onClick={() => void remove()} disabled={busy}>删除</button>}</div></form>;
}

function LinkLibrary({ area, links, onSave, onNotice }: { area: "entertainment" | "web"; links: QuickLink[]; onSave: (links: QuickLink[]) => Promise<void>; onNotice: (message: string) => void }) {
  const visible = useMemo(() => links.filter((link) => link.area === area), [area, links]);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState(""); const [url, setUrl] = useState("");
  async function add(event: FormEvent) { event.preventDefault(); if (!title.trim() || !url.trim()) return; const normalized = /^https?:\/\//i.test(url) ? url.trim() : `https://${url.trim()}`; const next: QuickLink = { id: `link-${Date.now()}`, title: title.trim(), url: normalized, category: area === "entertainment" ? "content" : "general", area, openMode: area === "entertainment" ? "internal" : "external", allowInsecureHttp: false, pinned: false, order: links.length }; await onSave([...links, next]); setTitle(""); setUrl(""); setAdding(false); }
  async function update(link: QuickLink, patch: Partial<QuickLink>) { await onSave(links.map((item) => item.id === link.id ? { ...item, ...patch } : item)); }
  async function open(link: QuickLink) { try { await openQuickLink(link); } catch (error) { onNotice(describeError(error)); } }
  return <section className="tool-section link-library"><header><div><span>{area === "entertainment" ? "娱乐" : "常用网站"}</span><h2>{area === "entertainment" ? "娱乐平台" : "你的网页工具箱"}</h2><p>{area === "entertainment" ? "所有入口统一放在这里；内置打开时复用同一个娱乐窗口，关闭即释放。" : "每个入口可以独立选择内置或系统浏览器。"}</p></div><button onClick={() => setAdding((value) => !value)}>{adding ? "取消" : "＋ 添加入口"}</button></header>{adding && <form className="link-add-form" onSubmit={add}><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="名称" /><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." /><button>保存</button></form>}<div className="link-library-list">{visible.map((link) => <article key={link.id}><button className="link-main" onClick={() => void open(link)}><BrandMark link={link} /><span><strong>{link.title}</strong><small>{link.url}</small></span><em>打开 ↗</em></button><div><select value={link.openMode} onChange={(event) => void update(link, { openMode: event.target.value as LinkOpenMode })}><option value="internal">项目内打开</option><option value="external">系统浏览器</option></select>{link.url.startsWith("http://") && link.openMode === "internal" && <label><input type="checkbox" checked={link.allowInsecureHttp} onChange={(event) => void update(link, { allowInsecureHttp: event.target.checked })} />允许局域网 HTTP</label>}<button className="danger" onClick={() => void onSave(links.filter((item) => item.id !== link.id))}>删除</button></div></article>)}</div>{!visible.length && <p className="tool-placeholder">这个分类还没有入口。</p>}</section>;
}

export function HomeIntegrationCards({ repository, onOpenTools }: { repository: IntegrationRepository; onOpenTools: () => void }) {
  const [repositories, setRepositories] = useState<GitHubRepositoryConfig[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, GitHubRepositorySnapshot>>({});
  const [balances, setBalances] = useState<Partial<Record<"deepseek" | "qwen", ModelBalance>>>({});
  const [usage, setUsage] = useState<Partial<Record<"deepseek" | "qwen", UsageConsoleSnapshot>>>({});

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const configs = (await repository.listGitHubRepositories()).filter((item) => item.enabled && item.homePinned).slice(0, 3);
      const nextSnapshots: Record<string, GitHubRepositorySnapshot> = {};
      for (const config of configs) {
        const cached = await repository.getCache<GitHubRepositorySnapshot>(`github:${config.id}`);
        if (cached) nextSnapshots[config.id] = cached.value;
        if (isTauri() && (!cached || isStale(cached.fetchedAt))) {
          try { const snapshot = await desktopApi.github.fetch(config.owner, config.name); await repository.saveCache(`github:${config.id}`, snapshot, snapshot.fetchedAt); nextSnapshots[config.id] = snapshot; } catch { /* keep stale data */ }
        }
      }
      const nextBalances: Partial<Record<"deepseek" | "qwen", ModelBalance>> = {};
      const nextUsage: Partial<Record<"deepseek" | "qwen", UsageConsoleSnapshot>> = {};
      for (const provider of ["deepseek", "qwen"] as const) {
        const cached = await repository.getCache<ModelBalance>(`balance:${provider}`);
        if (cached) nextBalances[provider] = cached.value;
        const cachedUsage = await repository.getCache<UsageConsoleSnapshot>(`usage:${provider}`);
        if (cachedUsage) nextUsage[provider] = cachedUsage.value;
        if (isTauri() && (!cached || isStale(cached.fetchedAt))) {
          const configured = provider === "deepseek"
            ? await desktopApi.secrets.status("deepseek_api_key").catch(() => false)
            : await Promise.all([
                desktopApi.secrets.status("aliyun_access_key_id").catch(() => false),
                desktopApi.secrets.status("aliyun_access_key_secret").catch(() => false),
              ]).then((values) => values.every(Boolean));
          if (configured) {
            try {
              const balance = provider === "deepseek" ? await desktopApi.balances.deepseek() : await desktopApi.balances.qwen();
              await repository.saveCache(`balance:${provider}`, balance, balance.fetchedAt);
              nextBalances[provider] = balance;
            } catch { /* keep stale balance */ }
          }
        }
      }
      if (!disposed) { setRepositories(configs); setSnapshots(nextSnapshots); setBalances(nextBalances); setUsage(nextUsage); }
    })();
    return () => { disposed = true; };
  }, [repository]);

  const topUsage = (["deepseek", "qwen"] as const).flatMap((provider) => (usage[provider]?.rows ?? []).map((row) => ({ ...row, provider }))).sort((left, right) => right.totalTokens - left.totalTokens).slice(0, 3);
  return <div className="home-integration-grid"><section className="workspace-card home-developer-card"><header><div><span>开发动态</span><strong>GitHub 仓库</strong></div><button onClick={onOpenTools}>查看全部 →</button></header>{repositories.length ? <div>{repositories.map((config) => { const snapshot = snapshots[config.id]; const commit = snapshot?.commits[0]; const release = snapshot?.releases[0]; return <button key={config.id} onClick={() => snapshot && void openInternalUrl(snapshot.url)}><i><BrandLogo brand="github" /></i><span><strong>{config.displayName || `${config.owner}/${config.name}`}</strong><small>{commit?.message || "等待首次刷新"}</small></span><em>{release?.tagName || (commit ? relativeTime(commit.committedAt) : "未连接")}</em></button>; })}</div> : <p>还没有首页仓库。到工具中心添加私有仓库并配置只读 PAT。</p>}</section><section className="workspace-card home-account-card"><header><div><span>模型账户</span><strong>余额摘要</strong></div><button onClick={onOpenTools}>管理账户 →</button></header><div>{(["deepseek", "qwen"] as const).map((provider) => { const balance = balances[provider]; return <article key={provider}><i><BrandLogo brand={provider} /></i><span><strong>{provider === "deepseek" ? "DeepSeek" : "Qwen / 阿里云"}</strong><small>{balance ? `更新于 ${relativeTime(balance.fetchedAt)}` : "尚未配置或刷新"}</small></span><em>{balance ? `${balance.currency} ${balance.amount || "0"}` : "—"}</em></article>; })}</div>{topUsage.length ? <ul className="home-token-summary">{topUsage.map((row, index) => <li key={`${row.provider}-${row.model}-${index}`}><span>{row.model}</span><strong>{formatNumber(row.totalTokens)} tokens</strong></li>)}</ul> : <p>Token 用量按需从官方控制台读取，不会在后台持续监控。</p>}</section></div>;
}

function BrandMark({ link }: { link: Pick<QuickLink, "title" | "url"> }) {
  const brand = brandForLink(link.url, link.title);
  return <i>{brand ? <BrandLogo brand={brand} /> : <span className="brand-logo-fallback">{link.title.slice(0, 1).toUpperCase()}</span>}</i>;
}

function isStale(value: string) { return Date.now() - new Date(value).getTime() > 30 * 60 * 1000; }
function formatNumber(value: number) { return new Intl.NumberFormat("zh-CN").format(value); }
function hostOf(url: string) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } }
function relativeTime(value: string) { if (!value) return "未知时间"; const difference = Math.max(0, Date.now() - new Date(value).getTime()); const minutes = Math.floor(difference / 60_000); if (minutes < 1) return "刚刚"; if (minutes < 60) return `${minutes} 分钟前`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours} 小时前`; return `${Math.floor(hours / 24)} 天前`; }
function describeError(error: unknown) { return error instanceof Error ? error.message : String(error || "操作没有完成"); }
