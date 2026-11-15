import { useState } from "react";
import type { AsabaObservation, CompanionStatus } from "../app/companion-types";
import { companionProjectName, companionTodayRecords } from "../app/companion-types";
import { Button } from "./DesktopControls";

type Props = {
  observation: AsabaObservation | null;
  status: CompanionStatus | null;
  idleMotion: boolean;
  smalltalk: boolean;
  focusSuggestions: boolean;
  attentionDot: boolean;
  busy: boolean;
  onIdleMotion: (value: boolean) => void;
  onSmalltalk: (value: boolean) => void;
  onFocusSuggestions: (value: boolean) => void;
  onAttentionDot: (value: boolean) => void;
  onObservation: (operation: string, executable?: string) => void;
  onCodex: (enabled: boolean) => void;
  onReadCodex: () => void;
  onPauseAll: () => void;
  onPreviewVoice: () => void;
  onHide: () => void;
};

function SettingSwitch({ title, description, checked, disabled, onChange }: {
  title: string; description: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void;
}) {
  return <div className="asaba-setting-row">
    <div><strong>{title}</strong><small>{description}</small></div>
    <Button className="asaba-setting-switch" variant="ghost" role="switch" aria-label={title} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></Button>
  </div>;
}

function GroupIcon({ kind }: { kind: "companion" | "record" | "code" }) {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "companion" && <><path d="M5 19c1-8 2-13 12-15 2 7-2 12-9 13M6 18l9-10M8 13l5 1" /></>}
    {kind === "record" && <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M6 11h3l2-3 3 6 2-3h2" /></>}
    {kind === "code" && <><path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16" /></>}
  </svg>;
}

export function AsabaSettings(props: Props) {
  const [tab, setTab] = useState<"companion" | "records">("companion");
  const { observation, status, busy } = props;
  const records = companionTodayRecords(status?.records ?? []);
  const allowed = (observation?.games.length ?? 0) + (observation?.browser ? 1 : 0);
  const source = observation?.sourceApplication;
  return <div className="asaba-settings">
    <div className="asaba-settings-tabs" role="tablist" aria-label="设置分类">
      <Button size="small" variant="ghost" role="tab" aria-selected={tab === "companion"} aria-controls="asaba-companion-settings" id="asaba-companion-tab" onClick={() => setTab("companion")}>陪伴与声音</Button>
      <Button size="small" variant="ghost" role="tab" aria-selected={tab === "records"} aria-controls="asaba-record-settings" id="asaba-record-tab" onClick={() => setTab("records")}>了解今天</Button>
    </div>
    {tab === "companion" ? <div role="tabpanel" id="asaba-companion-settings" aria-labelledby="asaba-companion-tab">
      <section className="asaba-setting-group">
        <header><GroupIcon kind="companion" /><h3>相处方式</h3></header>
        <SettingSwitch title="自然待机" description="偶尔思考、伸懒腰、跳一小段舞" checked={props.idleMotion} onChange={props.onIdleMotion} />
        <SettingSwitch title="心情小气泡" description="偶尔说句俏皮话，投入和朗读时安静陪伴" checked={props.smalltalk} onChange={props.onSmalltalk} />
        <SettingSwitch title="投入提醒" description="持续工作后，提醒你记下这次投入" checked={props.focusSuggestions} onChange={props.onFocusSuggestions} />
        <SettingSwitch title="待关注未读点" description="收起气泡时提示新事项，记录投入时隐藏" checked={props.attentionDot} disabled={busy} onChange={props.onAttentionDot} />
        <details className="asaba-setting-help"><summary>什么时候会提醒？</summary><p>需要开启「桌面活动记录」。在编辑器或文档应用持续使用 10 分钟后，浅羽会提示开始投入。计时从你确认时开始，空闲 5 分钟再提醒你是否结束。</p></details>
      </section>
      <section className="asaba-setting-group">
        <header><span className="asaba-settings-note" aria-hidden="true">♪</span><h3>浅羽的声音</h3><span className="asaba-setting-tag">本机音色</span></header>
        <div className="asaba-setting-voice"><p>听听她的声音</p><Button size="small" onClick={props.onPreviewVoice}>试听</Button></div>
      </section>
      <p className="asaba-settings-footnote">右键点她可以逗逗浅羽，试试抱兔、小舞步和犯困的动作。鼠标移上去会轻轻跟随，摸摸头也有回应。停留不动 4 秒后淡出一些，拖动可以换位置。</p>
    </div> : <div role="tabpanel" id="asaba-record-settings" aria-labelledby="asaba-record-tab">
      <section className="asaba-setting-group">
        <header><GroupIcon kind="record" /><h3>桌面活动</h3><span className="asaba-setting-tag" data-enabled={Boolean(observation?.enabled)}>{observation?.enabled ? "记录中" : "已暂停"}</span></header>
        <SettingSwitch title="桌面活动记录" description="记下用过的应用和时段，供「听今天」回顾" checked={Boolean(observation?.enabled)} disabled={busy || !observation} onChange={enabled => props.onObservation(enabled ? "enable" : "pause")} />
        <details className="asaba-setting-help">
          <summary>允许截图的窗口 <span>{allowed ? allowed + " 项" : "未设置"}</span></summary>
          <p>游戏和浏览器里的事情，有时需要画面才能理解。你允许的窗口才会留少量截图，画面保存在本机。</p>
          {source ? <div className="asaba-setting-source">
            <small>刚才使用的应用</small><strong>{companionProjectName(source)}</strong>
            {observation?.sourceIsBrowser ? <><small>同一窗口的标签页都在范围内，关窗后失效。</small><Button size="small" disabled={busy || !observation.enabled} onClick={() => props.onObservation("browser")}>允许截图这个窗口</Button></>
              : <Button size="small" disabled={busy || !observation?.enabled} onClick={() => props.onObservation("game")}>允许截图这个应用</Button>}
          </div> : <p className="asaba-setting-hint">先切到想记录的游戏或浏览器，再点浅羽打开这里。</p>}
          {!observation?.enabled && <small className="asaba-setting-hint">开启桌面活动记录后可添加窗口。</small>}
          {observation?.browser && <div className="asaba-setting-permission"><span><strong>{companionProjectName(observation.browser)}</strong><small>本次浏览器窗口</small></span><Button variant="ghost" size="small" disabled={busy} onClick={() => props.onObservation("forget_browser")}>移除</Button></div>}
          {observation?.games.map(path => <div className="asaba-setting-permission" key={path}><span><strong>{companionProjectName(path)}</strong><small>已允许的应用</small></span><Button variant="ghost" size="small" disabled={busy} onClick={() => props.onObservation("forget_game", path)}>移除</Button></div>)}
          <p className="asaba-setting-hint">画面变化时才留图，同一窗口至少间隔 90 秒，每天最多 30 张，7 天后清理。</p>
        </details>
      </section>
      <section className="asaba-setting-group">
        <header><GroupIcon kind="code" /><h3>Codex 工作记录</h3><span className="asaba-setting-tag">{records.length} 条今日线索</span></header>
        <SettingSwitch title="读取 Codex 工作记录" description="从本机已有会话中，补充今天的代码进展" checked={Boolean(status?.enabled)} disabled={busy || !status} onChange={props.onCodex} />
        <details className="asaba-setting-help"><summary>会读取什么？</summary>
          <p>读取你在 Codex 中已有的会话内容、执行结果和改动线索，每 5 分钟检查一次。已有记录会用于「听今天」的回顾。</p>
          <p>要让 Codex 帮忙修改 Bug，可以在便签里选择「交给 Codex」，再确认仓库和说明。</p>
          <div className="asaba-actions"><Button size="small" disabled={busy || status?.collecting} onClick={props.onReadCodex}>{status?.collecting ? "正在读取…" : "现在读取一次"}</Button></div>
          {!!records.length && <details className="asaba-record-excerpts"><summary>查看已有线索 · {records.length}</summary>
            {records.map(record => <details key={record.id}><summary>{record.title}</summary><pre>{record.text}</pre></details>)}
          </details>}
        </details>
      </section>
      {(observation?.enabled || status?.enabled) && <Button variant="ghost" size="small" className="asaba-settings-pause" disabled={busy} onClick={props.onPauseAll}>暂停全部记录</Button>}
    </div>}
    <div className="asaba-settings-bottom"><Button variant="ghost" size="small" onClick={props.onHide}>暂时隐藏浅羽</Button></div>
  </div>;
}

