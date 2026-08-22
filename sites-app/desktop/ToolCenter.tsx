import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { IntegrationRepository } from "../app/data/integration-repository";
import type {
  GitHubRepositoryConfig,
  GitHubRepositorySnapshot,
  ModelBalance,
  SecretKind,
  UsageConsoleSnapshot,
} from "../app/integration-types";
import type { LinkOpenMode, QuickLink, ToolArea } from "../app/workspace-preferences";
import { BrandLogo, brandForLink } from "./BrandLogo";
import { desktopApi, openInternalUrl, openQuickLink } from "./integrationApi";

type ToolTab = "ai" | "development" | "accounts" | "entertainment" | "web";

const tabs: Array<{ id: ToolTab; label: string; note: string }> = [
  { id: "ai", label: "AI 与模型", note: "对话与模型入口" },
  { id: "development", label: "开发与 GitHub", note: "私有仓库动态" },
  { id: "accounts", label: "用量与账户", note: "余额与 Token" },
  { id: "entertainment", label: "娱乐", note: "按需打开" },
  { id: "web", label: "常用网站", note: "你的工具入口" },
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
        <nav className="tools-tabs" aria-label="工具分类">{tabs.map((item) => <button className={tab === item.id ? "active" : ""} key={item.id} onClick={() => setTab(item.id)}><strong>{item.label}</strong><small>{item.note}</small></button>)}</nav>
        <main className="tools-content">
          {notice && <div className="tools-notice" role="alert"><span>{notice}</span><button onClick={() => setNotice("")}>×</button></div>}
          {tab === "ai" && <AiTools links={quickLinks.filter((link) => link.area === "ai")} onOpenAi={onOpenAi} />}
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

function AiTools({ links, onOpenAi }: { links: QuickLink[]; onOpenAi: () => void }) {
  const presets: QuickLink[] = [
    { id: "qwen-preset", title: "Qwen", url: "https://chat.qwen.ai", category: "general", area: "ai", openMode: "external", allowInsecureHttp: false, pinned: false, order: 0 },
    { id: "gemini-preset", title: "Gemini", url: "https://gemini.google.com", category: "general", area: "ai", openMode: "external", allowInsecureHttp: false, pinned: false, order: 1 },
    { id: "grok-preset", title: "Grok", url: "https://grok.com", category: "general", area: "ai", openMode: "external", allowInsecureHttp: false, pinned: false, order: 2 },
  ];
  const visible = [...presets.filter((preset) => !links.some((link) => hostOf(link.url) === hostOf(preset.url))), ...links.filter((link) => link.id !== "deepseek")];
  return <section className="tool-section"><header><div><span>原生对话</span><h2>DeepSeek AI 助手</h2><p>使用官网会话完成简单问答，当前运行期间支持多轮上下文。</p></div><button className="primary" onClick={onOpenAi}>打开对话</button></header><div className="tool-link-grid">{visible.map((link) => <button key={link.id} onClick={() => void openQuickLink(link)}><BrandMark link={link} /><span><strong>{link.title}</strong><small>{hostOf(link.url)}</small></span><em>↗</em></button>)}</div></section>;
}

function EntertainmentTools({ links, onSave, onNotice }: { links: QuickLink[]; onSave: (links: QuickLink[]) => Promise<void>; onNotice: (message: string) => void }) {
  const presets: QuickLink[] = [
    { id: "bilibili-preset", title: "哔哩哔哩", url: "https://www.bilibili.com", category: "content", area: "entertainment", openMode: "internal", allowInsecureHttp: false, pinned: false, order: 0 },
    { id: "douyin-preset", title: "抖音", url: "https://www.douyin.com", category: "content", area: "entertainment", openMode: "internal", allowInsecureHttp: false, pinned: false, order: 1 },
  ];
  return <><section className="tool-section entertainment-presets"><header><div><span>娱乐窗口</span><h2>常用平台</h2><p>使用独立单例窗口，关闭后释放页面资源。</p></div></header><div className="tool-link-grid">{presets.map((link) => <button key={link.id} onClick={() => void openQuickLink(link).catch((error) => onNotice(describeError(error)))}><BrandMark link={link} /><span><strong>{link.title}</strong><small>{hostOf(link.url)}</small></span><em>项目内打开</em></button>)}</div></section><div className="tool-section-spacer" /><LinkLibrary area="entertainment" links={links} onSave={onSave} onNotice={onNotice} /></>;
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
    <header><div><span>GitHub</span><h2>私有仓库动态</h2><p>只读取你配置的仓库提交和 Release，不统计 Star 或 Fork。</p></div><button onClick={() => void openInternalUrl("https://github.com").catch((error) => onNotice(describeError(error)))}>打开 GitHub</button></header>
    <details className="configuration-guide" open>
      <summary><span>第一次使用：这三项分别填什么？</span><small>展开查看完整步骤</small></summary>
      <div className="configuration-guide-body">
        <ol>
          <li><strong>创建只读凭据</strong><p>打开 GitHub 的 Fine-grained token 页面，Resource owner 选择你的账号；Repository access 选择“Only select repositories”并勾选要展示的仓库。</p></li>
          <li><strong>只给读取权限</strong><p>在 Repository permissions 中把 Contents 设为 Read-only。生成后复制以 <code>github_pat_</code> 开头的完整内容，粘贴到下方 Fine-grained PAT。</p></li>
          <li><strong>填写仓库地址</strong><p>如果仓库网址是 <code>github.com/muyuxiaoluo/my-project</code>，仓库所有者填 <code>muyuxiaoluo</code>，仓库名称填 <code>my-project</code>，不要粘贴整段网址。</p></li>
        </ol>
        <div className="configuration-guide-actions"><button onClick={() => void openInternalUrl("https://github.com/settings/personal-access-tokens/new").catch((error) => onNotice(describeError(error)))}>去 GitHub 创建凭据</button><button onClick={() => void openInternalUrl("https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens").catch((error) => onNotice(describeError(error)))}>查看官方说明</button></div>
        <p className="configuration-safety">凭据只保存在 Windows 系统凭据管理器中，保存后本项目不会把完整内容重新显示出来。</p>
      </div>
    </details>
    <SecretEditor kind="github_pat" label="Fine-grained PAT" hint="建议仅授予所选仓库 Contents: read 权限" placeholder="github_pat_..." onNotice={onNotice} />
    <form className="github-add-form" onSubmit={add}><label><span>仓库所有者</span><input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="例如：muyuxiaoluo" /></label><label><span>仓库名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：life-strategy-library" /></label><button>添加仓库</button></form>
    <div className="github-repository-list">{repositories.map((config) => {
      const snapshot = snapshots[config.id];
      const error = errors[config.id];
      return <article key={config.id} className={`github-repository-card${error ? " has-error" : ""}`}><header><div><strong>{config.displayName || `${config.owner}/${config.name}`}</strong><span>{error ? "本次刷新失败" : snapshot ? `更新于 ${relativeTime(snapshot.fetchedAt)}` : "尚未读取"}</span></div><div><button onClick={() => void togglePinned(config)}>{config.homePinned ? "取消首页" : "放到首页"}</button><button onClick={() => void onRefresh(config)} disabled={busyKey === `github:${config.id}`}>{busyKey === `github:${config.id}` ? "刷新中…" : "刷新"}</button><button className="danger" onClick={() => void repository.deleteGitHubRepository(config.id).then(onReload)}>删除</button></div></header>{error && <GitHubRepositoryError config={config} message={error} onNotice={onNotice} />}{snapshot ? <><section><h3>最近提交</h3>{snapshot.commits.map((commit) => <button key={commit.sha} onClick={() => void openInternalUrl(commit.url)}><strong>{commit.message}</strong><small>{commit.author} · {relativeTime(commit.committedAt)}</small></button>)}</section><section><h3>Release</h3>{snapshot.releases.length ? snapshot.releases.map((release) => <button key={release.id} onClick={() => void openInternalUrl(release.url)}><strong>{release.name}</strong><small>{release.tagName} · {relativeTime(release.publishedAt)}</small></button>) : <p>暂无 Release</p>}</section></> : !error && <p className="tool-placeholder">保存只读 PAT 后刷新，即可读取公开或私有仓库信息。</p>}</article>;
    })}</div>
  </section>;
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
  return <section className="tool-section account-tools"><header><div><span>模型账户</span><h2>余额与 Token 用量</h2><p>这些配置只服务于余额与用量卡片，不影响 AI 助手对话。</p></div></header>
    <div className="optional-configuration-note"><strong>如果你只想使用 AI 对话，这一页可以完全不配置。</strong><p>DeepSeek 网页对话依赖官网登录状态，不需要 API Key。下面四项都是可选的账户统计能力。</p></div>
    <div className="configuration-guide-grid">
      <details className="configuration-guide" open>
        <summary><span>DeepSeek API Key 怎么填？</span><small>可选 · 只查询 API 余额</small></summary>
        <div className="configuration-guide-body"><ol><li><strong>打开 DeepSeek 开放平台</strong><p>登录后进入“API Keys / API 密钥”，创建一个新 Key。</p></li><li><strong>复制并粘贴</strong><p>把以 <code>sk-</code> 开头的完整 Key 粘贴到“DeepSeek API Key”。它不会用于本项目中的网页问答，也不会产生推理调用。</p></li></ol><div className="configuration-guide-actions"><button onClick={() => void openInternalUrl("https://platform.deepseek.com/api_keys").catch((error) => onNotice(describeError(error)))}>打开 API Key 页面</button><button onClick={() => void openInternalUrl("https://api-docs.deepseek.com/zh-cn/api/get-user-balance/").catch((error) => onNotice(describeError(error)))}>余额接口说明</button></div></div>
      </details>
      <details className="configuration-guide">
        <summary><span>阿里云 AccessKey 怎么填？</span><small>可选 · 查询阿里云账户余额</small></summary>
        <div className="configuration-guide-body"><ol><li><strong>建议新建只读 RAM 用户</strong><p>不要使用主账号 AccessKey。为 RAM 用户授予 <code>AliyunBSSReadOnlyAccess</code>，用于只读查询费用与账户余额。</p></li><li><strong>创建 AccessKey</strong><p>在 RAM 用户的认证管理中创建 AccessKey。把 AccessKey ID（通常以 <code>LTAI</code> 开头）和只显示一次的 AccessKey Secret 分别粘贴到对应输入框。</p></li></ol><div className="configuration-guide-actions"><button onClick={() => void openInternalUrl("https://ram.console.aliyun.com/manage/ak").catch((error) => onNotice(describeError(error)))}>打开 AccessKey 管理</button><button onClick={() => void openInternalUrl("https://help.aliyun.com/en/user-center/developer-reference/api-calling-authorization").catch((error) => onNotice(describeError(error)))}>查看只读权限说明</button></div></div>
      </details>
      <details className="configuration-guide">
        <summary><span>Qwen 监控 HTTP API 地址在哪？</span><small>高级功能 · 可能收费</small></summary>
        <div className="configuration-guide-body"><ol><li><strong>先决定是否真的需要</strong><p>普通用量查看不需要这一项。你可以直接点击下方“打开官方用量页”，登录后再读取当前页面。</p></li><li><strong>需要自动统计时再开启</strong><p>进入阿里云百炼“模型监控”，在右上角“模型监控配置”中手动开启高级监控；然后进入云监控 Prometheus 实例详情。</p></li><li><strong>复制完整 HTTP API 地址</strong><p>选择公网访问地址，复制整段以 <code>https://</code> 开头的 HTTP API 地址粘贴到下方。不要填百炼控制台网页地址，也不要自己拼接接口路径。</p></li></ol><div className="configuration-guide-actions"><button onClick={() => void openInternalUrl("https://help.aliyun.com/zh/model-studio/model-telemetry").catch((error) => onNotice(describeError(error)))}>查看阿里云图文步骤</button><button onClick={() => void desktopApi.usage.open("qwen").catch((error) => onNotice(describeError(error)))}>打开百炼控制台</button></div><p className="configuration-warning">高级监控由你在阿里云侧手动开通并可能产生费用，本项目不会代你开通。HTTP API 使用与 Prometheus 实例同一账号的 AccessKey ID 和 Secret。</p></div>
      </details>
    </div>
    <div className="credential-grid"><SecretEditor kind="deepseek_api_key" label="DeepSeek API Key" hint="仅用于查询 API 余额，不会用于模型推理" placeholder="sk-..." onNotice={onNotice} /><SecretEditor kind="aliyun_access_key_id" label="阿里云 AccessKey ID" hint="建议使用只读 RAM 用户" placeholder="通常以 LTAI 开头" onNotice={onNotice} /><SecretEditor kind="aliyun_access_key_secret" label="阿里云 AccessKey Secret" hint="保存在 Windows 系统凭据管理器" placeholder="粘贴只显示一次的 Secret" onNotice={onNotice} /><SecretEditor kind="qwen_monitor_credential" label="Qwen 监控 HTTP API 地址" hint="仅在你手动开启百炼高级监控后，从实例详情复制" placeholder="https://..." inputType="url" onNotice={onNotice} /></div>
    <div className="account-provider-grid">{(["deepseek", "qwen"] as const).map((provider) => {
      const balance = balances[provider]; const modelUsage = usage[provider]; const label = provider === "deepseek" ? "DeepSeek" : "Qwen / 阿里云";
      return <article key={provider}><header><div><span>{label}</span><strong>{balance ? `${balance.currency} ${balance.amount || "0"}` : "尚未读取余额"}</strong><small>{balance?.message || (balance ? `更新于 ${relativeTime(balance.fetchedAt)}` : "配置凭据后手动刷新")}</small></div><button onClick={() => void onRefreshBalance(provider)} disabled={busyKey === `balance:${provider}`}>{busyKey === `balance:${provider}` ? "读取中…" : "刷新余额"}</button></header><section><div><h3>最近读取的 Token</h3><button onClick={() => void desktopApi.usage.open(provider).catch((error) => onNotice(describeError(error)))}>打开官方用量页</button><button onClick={() => void onReadUsage(provider)} disabled={busyKey === `usage:${provider}`}>读取当前页面</button></div>{provider === "qwen" && <div className="qwen-monitor-range"><label><span>开始</span><input type="date" value={rangeStart} max={rangeEnd} onChange={(event) => setRangeStart(event.target.value)} /></label><label><span>结束</span><input type="date" value={rangeEnd} min={rangeStart} max={today} onChange={(event) => setRangeEnd(event.target.value)} /></label><button onClick={() => void onReadQwenMonitor(rangeStart, rangeEnd)} disabled={busyKey === "usage:qwen-monitor" || !rangeStart || !rangeEnd}>{busyKey === "usage:qwen-monitor" ? "查询中…" : "从高级监控读取"}</button></div>}{modelUsage?.rows.length ? <ul>{modelUsage.rows.map((row, index) => <li key={`${row.model}-${index}`}><span>{row.model}</span><strong>{formatNumber(row.totalTokens)}</strong><small>输入 {formatNumber(row.inputTokens)} · 输出 {formatNumber(row.outputTokens)}</small></li>)}</ul> : <p>打开官方控制台、完成登录并进入用量明细后，再读取当前页面。</p>}</section></article>;
    })}</div><p className="monitoring-note">Qwen 高级监控可能产生额外监控费用，本项目不会自动开启。</p>
  </section>;
}

function SecretEditor({ kind, label, hint, placeholder = "粘贴凭据", inputType = "password", onNotice }: { kind: SecretKind; label: string; hint: string; placeholder?: string; inputType?: "password" | "url"; onNotice: (message: string) => void }) {
  const [configured, setConfigured] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (isTauri()) void desktopApi.secrets.status(kind).then(setConfigured).catch(() => setConfigured(false)); }, [kind]);
  async function save(event: FormEvent) { event.preventDefault(); if (!value.trim()) return; setBusy(true); try { await desktopApi.secrets.set(kind, value); setValue(""); setConfigured(true); onNotice(`${label} 已安全保存。`); } catch (error) { onNotice(describeError(error)); } finally { setBusy(false); } }
  async function remove() { setBusy(true); try { await desktopApi.secrets.delete(kind); setConfigured(false); onNotice(`${label} 已从系统凭据管理器删除。`); } catch (error) { onNotice(describeError(error)); } finally { setBusy(false); } }
  return <form className="secret-editor" onSubmit={save}><header><div><strong>{label}</strong><small>{hint}</small></div><span className={configured ? "configured" : ""}>{configured ? "已配置" : "未配置"}</span></header><div><input type={inputType} autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} placeholder={configured ? "输入新值以替换" : placeholder} /><button disabled={busy || !value.trim()}>{busy ? "保存中…" : "保存"}</button>{configured && <button type="button" className="danger" onClick={() => void remove()} disabled={busy}>删除</button>}</div></form>;
}

function LinkLibrary({ area, links, onSave, onNotice }: { area: "entertainment" | "web"; links: QuickLink[]; onSave: (links: QuickLink[]) => Promise<void>; onNotice: (message: string) => void }) {
  const visible = useMemo(() => links.filter((link) => link.area === area), [area, links]);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState(""); const [url, setUrl] = useState("");
  async function add(event: FormEvent) { event.preventDefault(); if (!title.trim() || !url.trim()) return; const normalized = /^https?:\/\//i.test(url) ? url.trim() : `https://${url.trim()}`; const next: QuickLink = { id: `link-${Date.now()}`, title: title.trim(), url: normalized, category: area === "entertainment" ? "content" : "general", area, openMode: area === "entertainment" ? "internal" : "external", allowInsecureHttp: false, pinned: false, order: links.length }; await onSave([...links, next]); setTitle(""); setUrl(""); setAdding(false); }
  async function update(link: QuickLink, patch: Partial<QuickLink>) { await onSave(links.map((item) => item.id === link.id ? { ...item, ...patch } : item)); }
  async function open(link: QuickLink) { try { await openQuickLink(link); } catch (error) { onNotice(describeError(error)); } }
  return <section className="tool-section link-library"><header><div><span>{area === "entertainment" ? "娱乐窗口" : "常用网站"}</span><h2>{area === "entertainment" ? "用完即关闭" : "你的网页工具箱"}</h2><p>{area === "entertainment" ? "只保留一个娱乐 WebView，关闭窗口后立即释放。" : "每个入口可以独立选择内置或系统浏览器。"}</p></div><button onClick={() => setAdding((value) => !value)}>{adding ? "取消" : "＋ 添加入口"}</button></header>{adding && <form className="link-add-form" onSubmit={add}><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="名称" /><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." /><button>保存</button></form>}<div className="link-library-list">{visible.map((link) => <article key={link.id}><button className="link-main" onClick={() => void open(link)}><BrandMark link={link} /><span><strong>{link.title}</strong><small>{link.url}</small></span><em>打开 ↗</em></button><div><select value={link.openMode} onChange={(event) => void update(link, { openMode: event.target.value as LinkOpenMode })}><option value="internal">项目内打开</option><option value="external">系统浏览器</option></select>{link.url.startsWith("http://") && link.openMode === "internal" && <label><input type="checkbox" checked={link.allowInsecureHttp} onChange={(event) => void update(link, { allowInsecureHttp: event.target.checked })} />允许局域网 HTTP</label>}<button className="danger" onClick={() => void onSave(links.filter((item) => item.id !== link.id))}>删除</button></div></article>)}</div>{!visible.length && <p className="tool-placeholder">这个分类还没有入口。</p>}</section>;
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
