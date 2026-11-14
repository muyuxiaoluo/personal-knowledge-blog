use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;
use url::Url;

const WINDOW_LABEL: &str = "deepseek-bridge";
const ADAPTER_VERSION: u8 = 12;
const IDLE_SECONDS: u64 = 3 * 60;

pub struct DeepSeekBridgeState {
    lifecycle_generation: AtomicU64,
}

impl Default for DeepSeekBridgeState {
    fn default() -> Self {
        Self {
            lifecycle_generation: AtomicU64::new(0),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekSnapshot {
    status: String,
    ready: bool,
    generating: bool,
    #[serde(default)]
    text: String,
    #[serde(default)]
    reasoning_text: String,
    #[serde(default)]
    legacy_text: String,
    #[serde(default)]
    conversation_ref: String,
    #[serde(default)]
    error: String,
    #[serde(default)]
    deep_thinking_available: bool,
    #[serde(default)]
    deep_thinking_enabled: bool,
    #[serde(default)]
    smart_search_available: bool,
    #[serde(default)]
    smart_search_enabled: bool,
    #[serde(default)]
    vision_available: bool,
    #[serde(default)]
    attachment_name: String,
    adapter_version: u8,
}

impl DeepSeekSnapshot {
    fn preparing() -> Self {
        Self {
            status: "preparing".into(),
            ready: false,
            generating: false,
            text: String::new(),
            reasoning_text: String::new(),
            legacy_text: String::new(),
            conversation_ref: String::new(),
            error: String::new(),
            deep_thinking_available: false,
            deep_thinking_enabled: false,
            smart_search_available: false,
            smart_search_enabled: false,
            vision_available: false,
            attachment_name: String::new(),
            adapter_version: ADAPTER_VERSION,
        }
    }
}

const ADAPTER_SCRIPT: &str = r#"
(() => {
  if (!/(^|\.)deepseek\.com$/i.test(location.hostname)) return;
  const VERSION = 12;
  const text = (node) => (node?.innerText || node?.textContent || '').trim();
  const markdownText = (node, preserveMath = true) => {
    const renderChildren = (parent, context = {}) => Array.from(parent?.childNodes || []).map((child) => render(child, context)).join('');
    const compactInline = (value) => value.replace(/[\t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').trim();
    const renderList = (list, ordered, depth) => {
      const items = Array.from(list.children).filter((child) => child.tagName === 'LI');
      const result = items.map((item, index) => {
        const parts = Array.from(item.childNodes).map((child) => {
          if (child.nodeType === Node.ELEMENT_NODE && /^(UL|OL)$/.test(child.tagName)) {
            return `\n${renderList(child, child.tagName === 'OL', depth + 1).trimEnd()}`;
          }
          return render(child, { listDepth: depth });
        }).join('').trim().replace(/\n{3,}/g, '\n\n');
        const prefix = ordered ? `${index + 1}. ` : '- ';
        const indent = '  '.repeat(depth);
        return parts.split('\n').map((line, lineIndex) => `${indent}${lineIndex === 0 ? prefix : '  '}${line}`).join('\n');
      }).join('\n');
      return `${result}\n\n`;
    };
    const renderTable = (table) => {
      const rows = Array.from(table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tr'));
      if (!rows.length) return '';
      const cells = rows.map((row) => Array.from(row.children).filter((cell) => /^(TH|TD)$/.test(cell.tagName)).map((cell) => compactInline(renderChildren(cell)).replace(/\|/g, '\\|')));
      const width = Math.max(...cells.map((row) => row.length));
      const header = cells[0];
      while (header.length < width) header.push('');
      const separator = Array.from({ length: width }, () => '---');
      return `${[header, separator, ...cells.slice(1)].map((row) => `| ${[...row, ...Array(Math.max(0, width - row.length)).fill('')].join(' | ')} |`).join('\n')}\n\n`;
    };
    const render = (current, context = {}) => {
      if (!current) return '';
      if (current.nodeType === Node.TEXT_NODE) return current.nodeValue || '';
      if (current.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = current.tagName;
      // Read the TeX source once, before traversing KaTeX's MathML and visual copies.
      if (preserveMath && current.matches('.katex-display, .katex, mjx-container, math')) {
        const source = current.querySelector('annotation[encoding="application/x-tex"]')?.textContent
          || current.getAttribute('data-latex');
        if (source?.trim()) {
          const display = current.matches('.katex-display, [display="block"], [display="true"]')
            || Boolean(current.querySelector('math[display="block"]'));
          return display ? `\n\n$$\n${source.trim()}\n$$\n\n` : `$${source.trim()}$`;
        }
      }
      if (/^(BUTTON|SVG|PATH|SCRIPT|STYLE|NOSCRIPT)$/.test(tag) || current.getAttribute('aria-hidden') === 'true') return '';
      if (tag === 'BR') return '\n';
      if (/^H[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${compactInline(renderChildren(current))}\n\n`;
      if (tag === 'P') return `${renderChildren(current).trim()}\n\n`;
      if (tag === 'STRONG' || tag === 'B') return `&#8203;**${renderChildren(current).trim()}**&#8203;`;
      if (tag === 'EM' || tag === 'I') return `*${renderChildren(current).trim()}*`;
      if (tag === 'DEL' || tag === 'S') return `~~${renderChildren(current).trim()}~~`;
      if (tag === 'A') {
        const label = renderChildren(current).trim();
        const href = current.getAttribute('href') || '';
        return href && label ? `[${label}](${href})` : label;
      }
      if (tag === 'IMG') {
        const alt = current.getAttribute('alt') || '';
        const src = current.getAttribute('src') || '';
        return src ? `![${alt}](${src})` : alt;
      }
      if (tag === 'CODE' && current.parentElement?.tagName !== 'PRE') {
        const value = current.textContent || '';
        const fence = value.includes('`') ? '``' : '`';
        return `${fence}${value}${fence}`;
      }
      if (tag === 'PRE') {
        const code = current.querySelector('code') || current;
        const language = Array.from(code.classList || []).map((name) => name.match(/(?:language-|lang-)([\w+-]+)/)?.[1]).find(Boolean) || '';
        return `\`\`\`${language}\n${(code.textContent || '').replace(/\n$/, '')}\n\`\`\`\n\n`;
      }
      if (tag === 'UL' || tag === 'OL') return renderList(current, tag === 'OL', Number(context.listDepth || 0));
      if (tag === 'BLOCKQUOTE') return `${renderChildren(current).trim().split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
      if (tag === 'HR') return '---\n\n';
      if (tag === 'TABLE') return renderTable(current);
      const content = renderChildren(current, context);
      return /^(DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER)$/.test(tag) ? `${content}\n` : content;
    };
    return render(node)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };
  const visible = (node) => !!node && node.getClientRects().length > 0;
  const buttons = () => Array.from(document.querySelectorAll('button')).filter(visible);
  const findButton = (patterns) => buttons().find((button) => {
    const label = `${text(button)} ${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`;
    return patterns.some((pattern) => pattern.test(label));
  });
  const labeledElement = (patterns) => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], [tabindex], span, p, div'))
      .filter(visible)
      .map((node) => ({ node, label: `${text(node)} ${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('title') || ''}`.trim() }))
      .filter(({ label }) => label && label.length < 80 && patterns.some((pattern) => pattern.test(label)))
      .sort((left, right) => left.label.length - right.label.length);
    return candidates[0]?.node || null;
  };
  const controlForLabel = (patterns) => {
    const label = labeledElement(patterns);
    if (!label) return null;
    let node = label;
    for (let depth = 0; depth < 6 && node; depth += 1, node = node.parentElement) {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (node.matches?.('button, [role="button"], [role="menuitem"], [role="option"], [tabindex]')) return node;
      if (style.cursor === 'pointer' && rect.width < 300 && rect.height < 80) return node;
    }
    return label;
  };
  const controlState = (control) => {
    if (!control) return false;
    let node = control;
    for (let depth = 0; depth < 5 && node; depth += 1, node = node.parentElement) {
      const pressed = node.getAttribute?.('aria-pressed');
      const checked = node.getAttribute?.('aria-checked');
      const selected = node.getAttribute?.('aria-selected');
      const state = node.getAttribute?.('data-state') || '';
      const classes = typeof node.className === 'string' ? node.className : '';
      if (pressed === 'true' || checked === 'true' || selected === 'true' || /^(checked|on|active|selected)$/i.test(state) || /(^|[-_ ])(active|selected|checked)([-_ ]|$)/i.test(classes)) return true;
      const rect = node.getBoundingClientRect?.();
      if (rect && rect.width < 260 && rect.height < 70) {
        const style = getComputedStyle(node);
        const tintedBlue = [style.backgroundColor, style.borderColor, style.color].some((value) => {
          const channels = value.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
          const [red = 0, green = 0, blue = 0, alpha = 1] = channels;
          return alpha > 0.1 && (blue - red > 8 || blue - green > 6);
        });
        if (tintedBlue) return true;
      }
    }
    return false;
  };
  const editor = () => Array.from(document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"][data-lexical-editor], [contenteditable="true"]'))
    .filter((node) => visible(node) && !node.disabled && !node.readOnly && node.getAttribute('aria-disabled') !== 'true')
    .filter((node) => !node.closest('pre, code'))
    .map((node) => {
      const rect = node.getBoundingClientRect();
      const label = `${node.getAttribute('placeholder') || ''} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('data-placeholder') || ''}`;
      let score = Math.min(rect.width / 100, 8) + Math.min(rect.bottom / Math.max(window.innerHeight, 1), 1) * 5;
      if (/发送消息|输入消息|message|ask|提问/i.test(label)) score += 12;
      if (node.matches('[role="textbox"]')) score += 4;
      if (node.closest('form')) score += 4;
      return { node, score };
    })
    .sort((left, right) => right.score - left.score)[0]?.node || null;
  const deepThinkingControl = () => controlForLabel([/^(深度思考|思考|推理|DeepThink|Deep Think|Thinking|Reasoning)(?:\s|$)/i]);
  const smartSearchControl = () => controlForLabel([/^(智能搜索|联网搜索|搜索|Web Search|Search)(?:\s|$)/i]);
  const fileInput = () => Array.from(document.querySelectorAll('input[type="file"]')).find((input) => /image|\*/i.test(input.accept || '')) || document.querySelector('input[type="file"]');
  const attachmentControl = () => controlForLabel([/^(添加附件|添加图片|添加文件|附件|上传文件|上传图片|Attach|Upload|Add (?:file|image)s?)(?:\s|$)/i]) || findButton([/附件|上传|attach|upload|add (?:file|image)/i]);
  const composerRoot = () => {
    const input = editor();
    if (!input) return document;
    return input.closest('form') || input.parentElement?.parentElement?.parentElement || document;
  };
  const buttonInComposer = (patterns) => Array.from(composerRoot().querySelectorAll('button, [role="button"]')).filter(visible).find((button) => {
    const label = `${text(button)} ${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${button.getAttribute('data-testid') || ''}`;
    return patterns.some((pattern) => pattern.test(label));
  });
  const stopButton = () => buttonInComposer([/停止|终止|stop generating|stop response|stop$/i]) || findButton([/停止|终止|stop generating|stop response|stop$/i]);
  const sendButton = () => buttonInComposer([/发送|send|提交|submit/i]) || Array.from(composerRoot().querySelectorAll('button[type="submit"]')).filter(visible).find((button) => !button.disabled) || findButton([/发送|send|提交/i]);
  const newButton = () => controlForLabel([/^(开启新对话|新建对话|新对话|New Chat|New Conversation)(?:\s|$)/i]) || findButton([/新建对话|新对话|开启新对话|new chat|new conversation/i]);
  const assistantContainers = () => {
    const selectors = [
      '[data-message-role="assistant"]', '[data-role="assistant"]', '[data-author-role="assistant"]',
      '[data-message-author-role="assistant"]', '[data-testid*="assistant-message"]',
      '[class*="assistant-message"]', '[class*="assistantMessage"]'
    ];
    return [...new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(visible))];
  };
  const markdownCandidates = () => {
    const nestedSelectors = ['.ds-assistant-message-main-content', '.ds-markdown', '.markdown-body', '[class*="markdown"]', '[class*="message-content"]', '[class*="messageContent"]'];
    const scoped = assistantContainers().flatMap((container) => {
      const nested = nestedSelectors.flatMap((selector) => Array.from(container.querySelectorAll(selector))).filter(visible);
      return nested.length ? nested : [container];
    });
    const legacy = ['.ds-assistant-message-main-content', '[class*="assistant"] [class*="markdown"]']
      .flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(visible);
    return [...new Set([...scoped, ...legacy])];
  };
  const reasoningNode = () => {
    const directSelectors = [
      '[class*="think"] .ds-markdown', '[class*="reason"] .ds-markdown',
      '[class*="think-content"]', '[class*="reasoning-content"]',
      '[data-testid*="think"] .ds-markdown', '[data-testid*="reason"] .ds-markdown',
      '[data-testid*="think"] [class*="markdown"]', '[data-testid*="reason"] [class*="markdown"]'
    ];
    const direct = [...new Set(directSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(visible))]
      .filter((node) => text(node) && text(node).length > 1);
    if (direct.length) return direct.at(-1);
    const labels = Array.from(document.querySelectorAll('span, div, button'))
      .filter(visible)
      .filter((node) => {
        const label = text(node).replace(/\s+/g, ' ');
        return label.length > 0 && label.length < 60 && /^(?:已)?深度思考(?:完成)?(?:\s*[（(].*?[）)])?|^(?:thought process|reasoning|thinking)(?:\s|$)/i.test(label);
      });
    for (const label of labels.reverse()) {
      let container = label.parentElement;
      for (let depth = 0; depth < 5 && container; depth += 1, container = container.parentElement) {
        const contents = Array.from(container.querySelectorAll('.ds-markdown, .markdown-body, [class*="markdown"]')).filter(visible);
        if (contents.length >= 2) return contents[0];
        if (contents.length === 1 && !contents[0].contains(label)) return contents[0];
      }
    }
    return null;
  };
  const reasoningText = () => {
    const node = reasoningNode();
    if (!node) return '';
    return markdownText(node)
      .replace(/^(?:已)?深度思考(?:完成)?(?:\s*[（(].*?[）)])?\s*/i, '')
      .trim();
  };
  const assistantText = (preserveMath = true) => {
    const reasoning = reasoningNode();
    const candidates = markdownCandidates().filter((candidate) => !reasoning || (candidate !== reasoning && !reasoning.contains(candidate) && !candidate.contains(reasoning)));
    const outermost = candidates.filter((candidate) => !candidates.some((other) => other !== candidate && other.contains(candidate)));
    const values = (outermost.length ? outermost : candidates).map((node) => ({ node, value: markdownText(node, preserveMath) })).filter((item) => item.value);
    if (values.length) {
      values.sort((left, right) => {
        const position = left.node.compareDocumentPosition(right.node);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
      return values.at(-1)?.value || '';
    }
    const messageContainers = assistantContainers()
      .filter((candidate) => !reasoning || (candidate !== reasoning && !candidate.contains(reasoning)));
    return messageContainers.length ? markdownText(messageContainers.at(-1), preserveMath) : '';
  };
  const normalizePath = (value) => {
    try { return new URL(value, location.href).pathname.replace(/\/$/, ''); }
    catch { return String(value || '').split(/[?#]/, 1)[0].replace(/\/$/, ''); }
  };
  const conversationRowFrom = (origin) => {
    const sidebarRight = Math.min(430, window.innerWidth * 0.42);
    let node = origin;
    let fallback = null;
    for (let depth = 0; depth < 9 && node && node !== document.body; depth += 1, node = node.parentElement) {
      const rect = node.getBoundingClientRect?.();
      if (!rect || rect.left >= sidebarRight || rect.width < 120 || rect.width > 420 || rect.height < 26 || rect.height > 96) continue;
      fallback = node;
      const interactive = node.querySelector?.('button, [role="button"], [role="menuitem"], [tabindex]');
      const menuLabel = Array.from(node.querySelectorAll?.('span, div') || []).find((child) => {
        const label = `${text(child)} ${child.getAttribute?.('aria-label') || ''} ${child.getAttribute?.('title') || ''}`.trim();
        return /^(?:\.\.\.|…|⋯)$|更多|more|操作/i.test(label) && visible(child);
      });
      if (interactive || menuLabel) return node;
    }
    return fallback;
  };
  const rowSelectionScore = (row) => {
    if (!row) return -1;
    let score = 0;
    const state = `${row.getAttribute?.('aria-current') || ''} ${row.getAttribute?.('aria-selected') || ''} ${row.getAttribute?.('data-state') || ''} ${row.getAttribute?.('data-active') || ''}`;
    const classes = typeof row.className === 'string' ? row.className : '';
    if (/page|true|active|selected/i.test(state)) score += 8;
    if (/(^|[-_ ])(active|selected)([-_ ]|$)/i.test(classes)) score += 5;
    const background = getComputedStyle(row).backgroundColor.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
    if (background.length >= 3) {
      const [red, green, blue, alpha = 1] = background;
      if (alpha > 0.08 && blue > red + 5 && blue >= green) score += 3;
    }
    const rect = row.getBoundingClientRect();
    if (rect.top < window.innerHeight - 110) score += 1;
    return score;
  };
  const currentConversationRow = () => {
    const currentPath = normalizePath(location.href);
    const conversationId = currentPath.split('/').filter(Boolean).at(-1) || '';
    const referenceNodes = Array.from(document.querySelectorAll('a[href], [data-href], [data-url], [data-path], [data-id]')).filter(visible);
    const referenced = referenceNodes.find((node) => {
      const values = ['href', 'data-href', 'data-url', 'data-path'].map((name) => node.getAttribute(name)).filter(Boolean);
      if (values.some((value) => normalizePath(value) === currentPath)) return true;
      const dataId = node.getAttribute('data-id') || '';
      return conversationId.length >= 8 && dataId === conversationId;
    });
    const referencedRow = conversationRowFrom(referenced);
    if (referencedRow) return referencedRow;

    const activeSelectors = [
      '[aria-current="page"]', '[aria-selected="true"]', '[data-state="active"]',
      '[data-state="selected"]', '[data-active="true"]',
      '[class*="active"][class*="chat"]', '[class*="selected"][class*="chat"]',
      '[class*="active"][class*="conversation"]', '[class*="selected"][class*="conversation"]'
    ];
    const activeRows = [...new Set(activeSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(visible).map(conversationRowFrom).filter(Boolean))];
    if (activeRows.length) return activeRows.sort((left, right) => rowSelectionScore(right) - rowSelectionScore(left))[0];

    const sidebarRight = Math.min(430, window.innerWidth * 0.42);
    const menuLabels = Array.from(document.querySelectorAll('button, [role="button"], [tabindex], span, div'))
      .filter(visible)
      .filter((node) => node.getBoundingClientRect().left < sidebarRight)
      .filter((node) => {
        const label = `${text(node)} ${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('title') || ''}`.trim();
        return label.length < 40 && (/^(?:\.\.\.|…|⋯)$/.test(label) || /更多|more|操作/i.test(label));
      });
    const menuRows = [...new Set(menuLabels.map(conversationRowFrom).filter(Boolean))];
    return menuRows.sort((left, right) => rowSelectionScore(right) - rowSelectionScore(left))[0] || null;
  };
  const actionForLabel = (patterns, stage) => {
    const dialog = stage === 'confirm'
      ? Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="dialog"], [class*="modal"]')).filter(visible).at(-1)
      : null;
    const root = dialog || document;
    const candidates = Array.from(root.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], [tabindex], li, span, p, div'))
      .filter(visible)
      .map((node) => ({
        node,
        label: `${text(node)} ${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('title') || ''}`.replace(/\s+/g, ' ').trim()
      }))
      .filter(({ label }) => label && label.length < 80 && patterns.some((pattern) => pattern.test(label)))
      .sort((left, right) => {
        const leftExact = /^(?:删除|确认删除|删除(?:此|该)?(?:对话|会话)|Delete|Delete (?:chat|conversation)|Confirm delete)$/i.test(left.label) ? 1 : 0;
        const rightExact = /^(?:删除|确认删除|删除(?:此|该)?(?:对话|会话)|Delete|Delete (?:chat|conversation)|Confirm delete)$/i.test(right.label) ? 1 : 0;
        if (leftExact !== rightExact) return rightExact - leftExact;
        const leftSemantic = left.node.matches?.('button, [role="button"], [role="menuitem"], [role="option"]') ? 1 : 0;
        const rightSemantic = right.node.matches?.('button, [role="button"], [role="menuitem"], [role="option"]') ? 1 : 0;
        if (leftSemantic !== rightSemantic) return rightSemantic - leftSemantic;
        return left.label.length - right.label.length;
      });
    for (const candidate of candidates) {
      let control = candidate.node;
      for (let depth = 0; depth < 6 && control && control !== root; depth += 1, control = control.parentElement) {
        const rect = control.getBoundingClientRect?.();
        const style = getComputedStyle(control);
        if (control.matches?.('button, [role="button"], [role="menuitem"], [role="option"], [tabindex]')) return control;
        if (style.cursor === 'pointer' && rect && rect.width < 420 && rect.height < 120) return control;
      }
      return candidate.node;
    }
    return null;
  };
  const visibleActionLabels = () => [...new Set(Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], [tabindex], li'))
    .filter(visible)
    .map((node) => `${text(node)} ${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('title') || ''}`.replace(/\s+/g, ' ').trim())
    .filter((label) => label && label.length < 40))].slice(-12);
  const loginRequired = () => {
    const body = text(document.body).slice(0, 4000);
    const hasLoginCopy = /扫码登录|密码登录|手机号登录|登录 DeepSeek|sign in|log in/i.test(body);
    return !editor() && hasLoginCopy;
  };
  const withFeatures = (value) => {
    const deepThinking = deepThinkingControl();
    const smartSearch = smartSearchControl();
    return {
      ...value,
      reasoningText: reasoningText(),
      deepThinkingAvailable: !!deepThinking,
      deepThinkingEnabled: controlState(deepThinking),
      smartSearchAvailable: !!smartSearch,
      smartSearchEnabled: controlState(smartSearch),
      visionAvailable: !!fileInput() || !!attachmentControl(),
      attachmentName: window.__personalDeepSeekAttachmentName || ''
    };
  };
  const snapshot = () => {
    if (document.readyState !== 'complete' && document.readyState !== 'interactive') {
      return withFeatures({ status: 'preparing', ready: false, generating: false, text: '', conversationRef: '', error: '', adapterVersion: VERSION });
    }
    if (loginRequired()) {
      return withFeatures({ status: 'login_required', ready: false, generating: false, text: assistantText(), conversationRef: location.href, error: '', adapterVersion: VERSION });
    }
    const input = editor();
    if (!input) {
      return withFeatures({ status: 'adapter_error', ready: false, generating: false, text: assistantText(), conversationRef: location.href, error: '没有识别到 DeepSeek 输入框，网页结构可能已经变化。', adapterVersion: VERSION });
    }
    const generating = !!stopButton();
    return withFeatures({ status: generating ? 'generating' : 'ready', ready: true, generating, text: assistantText(), legacyText: generating ? '' : assistantText(false), conversationRef: location.href, error: '', adapterVersion: VERSION });
  };
  const setInput = (input, prompt) => {
    input.focus();
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
      descriptor?.set?.call(input, prompt);
    } else {
      input.textContent = '';
      document.execCommand('insertText', false, prompt);
      if (!text(input)) input.textContent = prompt;
    }
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  window.__personalDeepSeekBridge = {
    version: VERSION,
    snapshot,
    send(prompt) {
      try {
        const input = editor();
        if (!input) return { ...snapshot(), status: 'adapter_error', error: '没有识别到输入框。' };
        setInput(input, String(prompt || ''));
        const button = sendButton();
        if (button && !button.disabled) button.click();
        else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        window.__personalDeepSeekAttachmentName = '';
        return snapshot();
      } catch (error) {
        return { ...snapshot(), status: 'adapter_error', error: String(error?.message || error) };
      }
    },
    setToggle(kind, enabled) {
      const control = kind === 'deepThinking' ? deepThinkingControl() : kind === 'smartSearch' ? smartSearchControl() : null;
      if (!control) return { ...snapshot(), status: 'adapter_error', error: kind === 'deepThinking' ? '官网当前没有可用的“深度思考”开关。' : '官网当前没有可用的“智能搜索”开关。' };
      if (controlState(control) !== !!enabled) control.click();
      return snapshot();
    },
    attachImage(name, mime, dataUrl) {
      try {
        const input = fileInput();
        if (!input) return { ...snapshot(), status: 'adapter_error', error: '官网当前没有识别到图片附件输入。' };
        const parts = String(dataUrl || '').split(',', 2);
        if (parts.length !== 2 || !/^data:image\//i.test(parts[0])) return { ...snapshot(), status: 'adapter_error', error: '图片数据格式无法识别。' };
        const binary = atob(parts[1]);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const file = new File([bytes], String(name || 'image'), { type: String(mime || 'image/png') });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        window.__personalDeepSeekAttachmentName = file.name;
        return snapshot();
      } catch (error) {
        return { ...snapshot(), status: 'adapter_error', error: String(error?.message || error) };
      }
    },
    removeAttachment() {
      const remove = findButton([/移除附件|删除附件|remove attachment|remove file/i]);
      if (!remove) return { ...snapshot(), status: 'adapter_error', error: '没有识别到官网的“移除附件”按钮，可以在官网窗口中检查附件状态。' };
      remove.click();
      window.__personalDeepSeekAttachmentName = '';
      return snapshot();
    },
    stop() { stopButton()?.click(); return snapshot(); },
    newConversation() {
      const button = newButton();
      if (!button) return { ...snapshot(), status: 'adapter_error', error: '没有识别到“新对话”按钮。' };
      button.click();
      window.__personalDeepSeekAttachmentName = '';
      return snapshot();
    },
    openDeleteMenu() {
      const row = currentConversationRow();
      if (!row) return { ok: false, error: '没有在官网侧栏中识别到当前会话。' };
      row.scrollIntoView?.({ block: 'nearest' });
      if (typeof PointerEvent === 'function') row.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      const rowControls = Array.from(row.querySelectorAll('button, [role="button"], [tabindex], span, div')).filter(visible);
      const more = rowControls.find((control) => {
        const label = `${text(control)} ${control.getAttribute?.('aria-label') || ''} ${control.getAttribute?.('title') || ''}`.trim();
        return label.length < 40 && (/^(?:\.\.\.|…|⋯)$/.test(label) || /更多|more|操作/i.test(label));
      }) || rowControls.filter((control) => {
        const rect = control.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        return rect.width <= 56 && rect.height <= 56 && rect.right > rowRect.right - 72;
      }).at(-1);
      if (!more) return { ok: false, error: '已定位官网当前会话，但会话菜单尚未显示。' };
      more.click();
      return { ok: true, error: '' };
    },
    clickDeleteAction(stage = 'menu') {
      const patterns = [
        /^(?:删除|确认删除|删除(?:此|该)?(?:对话|会话)|Delete|Delete (?:chat|conversation)|Confirm delete)$/i,
        /(?:^|\s)(?:删除|确认删除|删除(?:此|该)?(?:对话|会话)|Delete|Delete (?:chat|conversation)|Confirm delete)(?:\s|$)/i
      ];
      const action = actionForLabel(patterns, stage);
      if (!action) {
        const labels = visibleActionLabels();
        return { ok: false, error: `没有识别到官网的${stage === 'confirm' ? '确认删除按钮' : '删除操作'}。${labels.length ? `当前可见操作：${labels.join('、')}` : ''}` };
      }
      action.scrollIntoView?.({ block: 'nearest' });
      if (typeof PointerEvent === 'function') action.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      action.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      action.click();
      return { ok: true, error: '' };
    }
  };
})();
"#;

fn deepseek_url() -> Result<Url, String> {
    "https://chat.deepseek.com"
        .parse()
        .map_err(|error| format!("DeepSeek 地址无效：{error}"))
}

fn allowed_deepseek_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host == "deepseek.com" || host.ends_with(".deepseek.com"))
}

fn same_deepseek_conversation(left: &Url, right: &Url) -> bool {
    left.host_str() == right.host_str()
        && left.path().trim_end_matches('/') == right.path().trim_end_matches('/')
}

fn ensure_window(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        return Ok(window);
    }
    let data_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法准备 DeepSeek 登录目录：{error}"))?
        .join("webview-profiles")
        .join("deepseek");
    let mut builder =
        WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(deepseek_url()?))
            .title("DeepSeek · AI 助手连接")
            .inner_size(1080.0, 760.0)
            .min_inner_size(760.0, 560.0)
            .center()
            .visible(false)
            .skip_taskbar(true)
            .resizable(true)
            .data_directory(data_directory)
            .initialization_script(ADAPTER_SCRIPT)
            .on_navigation(allowed_deepseek_url)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    if let Some(main) = app.get_webview_window("main") {
        builder = builder
            .owner(&main)
            .map_err(|error| format!("无法关联 DeepSeek 窗口：{error}"))?;
    }
    builder
        .build()
        .map_err(|error| format!("无法打开 DeepSeek 页面：{error}"))
}

async fn eval_json<T: DeserializeOwned>(
    window: &WebviewWindow,
    script: String,
) -> Result<T, String> {
    let (sender, receiver) = oneshot::channel::<String>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    window
        .eval_with_callback(script, move |result| {
            if let Some(sender) = sender.lock().ok().and_then(|mut value| value.take()) {
                let _ = sender.send(result);
            }
        })
        .map_err(|error| format!("无法读取 DeepSeek 页面：{error}"))?;
    let raw = tokio::time::timeout(Duration::from_secs(5), receiver)
        .await
        .map_err(|_| "等待 DeepSeek 页面响应超时".to_string())?
        .map_err(|_| "DeepSeek 页面响应已中断".to_string())?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("DeepSeek 页面返回了无法识别的数据：{error}"))
}

async fn snapshot(window: &WebviewWindow) -> Result<DeepSeekSnapshot, String> {
    eval_json(
        window,
        format!(
            "window.__personalDeepSeekBridge?.snapshot?.() ?? {{status:'preparing',ready:false,generating:false,text:'',conversationRef:location.href,error:'',adapterVersion:{ADAPTER_VERSION}}}"
        ),
    )
    .await
}

#[tauri::command]
pub async fn deepseek_prepare(
    app: tauri::AppHandle,
    state: State<'_, DeepSeekBridgeState>,
) -> Result<DeepSeekSnapshot, String> {
    state.lifecycle_generation.fetch_add(1, Ordering::SeqCst);
    let window = ensure_window(&app)?;
    snapshot(&window)
        .await
        .or_else(|_| Ok(DeepSeekSnapshot::preparing()))
}

#[tauri::command]
pub async fn deepseek_get_status(app: tauri::AppHandle) -> Result<DeepSeekSnapshot, String> {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return Ok(DeepSeekSnapshot::preparing());
    };
    snapshot(&window).await
}

#[tauri::command]
pub async fn deepseek_configure_modes(
    app: tauri::AppHandle,
    deep_thinking: bool,
    smart_search: bool,
) -> Result<DeepSeekSnapshot, String> {
    let window = ensure_window(&app)?;
    let mut current = snapshot(&window).await?;
    if current.deep_thinking_available && current.deep_thinking_enabled != deep_thinking {
        let _: DeepSeekSnapshot = eval_json(
            &window,
            format!(
                "window.__personalDeepSeekBridge?.setToggle?.('deepThinking', {deep_thinking}) ?? {{status:'adapter_error',ready:false,generating:false,text:'',conversationRef:location.href,error:'页面尚未准备完成',adapterVersion:{ADAPTER_VERSION}}}"
            ),
        )
        .await?;
        tokio::time::sleep(Duration::from_millis(120)).await;
        current = snapshot(&window).await?;
    }
    if current.smart_search_available && current.smart_search_enabled != smart_search {
        let _: DeepSeekSnapshot = eval_json(
            &window,
            format!(
                "window.__personalDeepSeekBridge?.setToggle?.('smartSearch', {smart_search}) ?? {{status:'adapter_error',ready:false,generating:false,text:'',conversationRef:location.href,error:'页面尚未准备完成',adapterVersion:{ADAPTER_VERSION}}}"
            ),
        )
        .await?;
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
    snapshot(&window).await
}

#[tauri::command]
pub async fn deepseek_attach_image(
    app: tauri::AppHandle,
    name: String,
    mime: String,
    data_url: String,
) -> Result<DeepSeekSnapshot, String> {
    if !mime.starts_with("image/") || !data_url.starts_with("data:image/") {
        return Err("只能添加图片文件".into());
    }
    if data_url.len() > 14_000_000 {
        return Err("图片过大，请选择 10 MB 以内的图片".into());
    }
    let window = ensure_window(&app)?;
    let name =
        serde_json::to_string(name.trim()).map_err(|error| format!("无法准备图片名称：{error}"))?;
    let mime =
        serde_json::to_string(&mime).map_err(|error| format!("无法准备图片类型：{error}"))?;
    let data_url =
        serde_json::to_string(&data_url).map_err(|error| format!("无法准备图片：{error}"))?;
    eval_json(
        &window,
        format!(
            "window.__personalDeepSeekBridge?.attachImage?.({name}, {mime}, {data_url}) ?? {{status:'adapter_error',ready:false,generating:false,text:'',conversationRef:location.href,error:'页面尚未准备完成',adapterVersion:{ADAPTER_VERSION}}}"
        ),
    )
    .await
}

#[tauri::command]
pub async fn deepseek_remove_attachment(app: tauri::AppHandle) -> Result<DeepSeekSnapshot, String> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "DeepSeek 页面尚未打开".to_string())?;
    eval_json(
        &window,
        format!(
            "window.__personalDeepSeekBridge?.removeAttachment?.() ?? {{status:'adapter_error',ready:false,generating:false,text:'',conversationRef:location.href,error:'页面尚未准备完成',adapterVersion:{ADAPTER_VERSION}}}"
        ),
    )
    .await
}

#[tauri::command]
pub async fn deepseek_send_message(
    app: tauri::AppHandle,
    prompt: String,
    state: State<'_, DeepSeekBridgeState>,
) -> Result<DeepSeekSnapshot, String> {
    if prompt.trim().is_empty() {
        return Err("问题不能为空".into());
    }
    state.lifecycle_generation.fetch_add(1, Ordering::SeqCst);
    let window = ensure_window(&app)?;
    let prompt =
        serde_json::to_string(prompt.trim()).map_err(|error| format!("无法准备问题：{error}"))?;
    eval_json(
        &window,
        format!("window.__personalDeepSeekBridge?.send?.({prompt}) ?? {{status:'preparing',ready:false,generating:false,text:'',conversationRef:location.href,error:'页面尚未准备完成',adapterVersion:{ADAPTER_VERSION}}}"),
    )
    .await
}

#[tauri::command]
pub async fn deepseek_stop_generation(app: tauri::AppHandle) -> Result<DeepSeekSnapshot, String> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "DeepSeek 页面尚未打开".to_string())?;
    eval_json(
        &window,
        format!("window.__personalDeepSeekBridge?.stop?.() ?? {{status:'preparing',ready:false,generating:false,text:'',conversationRef:location.href,error:'页面尚未准备完成',adapterVersion:{ADAPTER_VERSION}}}"),
    )
    .await
}

#[tauri::command]
pub async fn deepseek_new_conversation(app: tauri::AppHandle) -> Result<DeepSeekSnapshot, String> {
    let window = ensure_window(&app)?;
    eval_json(
        &window,
        format!("window.__personalDeepSeekBridge?.newConversation?.() ?? {{status:'preparing',ready:false,generating:false,text:'',conversationRef:location.href,error:'页面尚未准备完成',adapterVersion:{ADAPTER_VERSION}}}"),
    )
    .await
}

#[tauri::command]
pub async fn deepseek_restore_conversation(
    app: tauri::AppHandle,
    conversation_ref: String,
) -> Result<DeepSeekSnapshot, String> {
    let url = conversation_ref
        .parse::<Url>()
        .map_err(|_| "保存的 DeepSeek 会话地址无效".to_string())?;
    if !allowed_deepseek_url(&url) {
        return Err("只能恢复 DeepSeek 官方会话".into());
    }
    let window = ensure_window(&app)?;
    window
        .navigate(url)
        .map_err(|error| format!("无法恢复 DeepSeek 会话：{error}"))?;
    Ok(DeepSeekSnapshot::preparing())
}

#[derive(Deserialize)]
struct DeepSeekActionResult {
    ok: bool,
    #[serde(default)]
    error: String,
}

async fn bridge_action(
    window: &WebviewWindow,
    action: &str,
) -> Result<DeepSeekActionResult, String> {
    eval_json(
        window,
        format!(
            "window.__personalDeepSeekBridge?.{action}?.() ?? {{ok:false,error:'DeepSeek 页面尚未准备完成'}}"
        ),
    )
    .await
}

async fn bridge_delete_action(
    window: &WebviewWindow,
    stage: &str,
) -> Result<DeepSeekActionResult, String> {
    eval_json(
        window,
        format!(
            "window.__personalDeepSeekBridge?.clickDeleteAction?.('{stage}') ?? {{ok:false,error:'DeepSeek 页面尚未准备完成'}}"
        ),
    )
    .await
}

#[tauri::command]
pub async fn deepseek_delete_conversation(
    app: tauri::AppHandle,
    conversation_ref: String,
) -> Result<(), String> {
    let url = conversation_ref
        .parse::<Url>()
        .map_err(|_| "保存的 DeepSeek 会话地址无效".to_string())?;
    if !allowed_deepseek_url(&url) || url.path() == "/" {
        return Err("这个本地记录还没有可同步删除的官网会话".into());
    }
    let window = ensure_window(&app)?;
    let current_url = window
        .url()
        .map_err(|error| format!("无法读取 DeepSeek 当前地址：{error}"))?;
    if !same_deepseek_conversation(&current_url, &url) {
        window
            .navigate(url.clone())
            .map_err(|error| format!("无法打开要删除的 DeepSeek 会话：{error}"))?;
        tokio::time::sleep(Duration::from_millis(900)).await;
    }
    let mut menu_result = None;
    for _ in 0..12 {
        if let Ok(result) = bridge_action(&window, "openDeleteMenu").await {
            if result.ok {
                menu_result = Some(result);
                break;
            }
            menu_result = Some(result);
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
    let menu = menu_result.ok_or_else(|| "官网会话尚未加载完成".to_string())?;
    if !menu.ok {
        let current = window
            .url()
            .map_err(|error| format!("无法确认官网会话状态：{error}"))?;
        if !same_deepseek_conversation(&current, &url) {
            return Ok(());
        }
        return Err(if menu.error.is_empty() {
            "没有识别到官网会话菜单".into()
        } else {
            menu.error
        });
    }
    let mut delete = DeepSeekActionResult {
        ok: false,
        error: "官网删除菜单尚未出现".into(),
    };
    for _ in 0..8 {
        tokio::time::sleep(Duration::from_millis(160)).await;
        delete = bridge_delete_action(&window, "menu").await?;
        if delete.ok {
            break;
        }
    }
    if !delete.ok {
        return Err(if delete.error.is_empty() {
            "没有识别到官网删除操作".into()
        } else {
            delete.error
        });
    }
    let mut confirm_result = DeepSeekActionResult {
        ok: false,
        error: "官网确认删除弹窗尚未出现".into(),
    };
    for _ in 0..8 {
        tokio::time::sleep(Duration::from_millis(160)).await;
        let current = window
            .url()
            .map_err(|error| format!("无法确认官网删除结果：{error}"))?;
        if !same_deepseek_conversation(&current, &url) {
            return Ok(());
        }
        confirm_result = bridge_delete_action(&window, "confirm").await?;
        if confirm_result.ok {
            tokio::time::sleep(Duration::from_millis(500)).await;
            break;
        }
    }
    if !confirm_result.ok {
        return Err(if confirm_result.error.is_empty() {
            "没有识别到官网确认删除按钮".into()
        } else {
            confirm_result.error
        });
    }
    for _ in 0..20 {
        let current = window
            .url()
            .map_err(|error| format!("无法确认官网删除结果：{error}"))?;
        if !same_deepseek_conversation(&current, &url) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(
        "未能确认官网会话已经删除；为避免数据不一致，本地记录已保留。请打开官网检查页面结构。"
            .into(),
    )
}

#[tauri::command]
pub async fn deepseek_show_official(
    app: tauri::AppHandle,
    state: State<'_, DeepSeekBridgeState>,
) -> Result<(), String> {
    state.lifecycle_generation.fetch_add(1, Ordering::SeqCst);
    let window = ensure_window(&app)?;
    window
        .set_skip_taskbar(false)
        .map_err(|error| format!("无法显示 DeepSeek 窗口：{error}"))?;
    window
        .show()
        .map_err(|error| format!("无法显示 DeepSeek 窗口：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("无法聚焦 DeepSeek 窗口：{error}"))
}

#[tauri::command]
pub async fn deepseek_release(
    app: tauri::AppHandle,
    state: State<'_, DeepSeekBridgeState>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
        let _ = window.set_skip_taskbar(true);
    }
    let generation = state.lifecycle_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let state_generation = generation;
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(IDLE_SECONDS)).await;
        let current = app_handle.state::<DeepSeekBridgeState>();
        if current.lifecycle_generation.load(Ordering::SeqCst) == state_generation {
            if let Some(window) = app_handle.get_webview_window(WINDOW_LABEL) {
                #[cfg(windows)]
                crate::developer_mode::record("deepseek_window_destroy");
                let _ = window.destroy();
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{allowed_deepseek_url, same_deepseek_conversation, ADAPTER_SCRIPT};
    use url::Url;

    #[test]
    fn limits_bridge_navigation_to_deepseek_https() {
        assert!(allowed_deepseek_url(
            &"https://chat.deepseek.com/a/chat/s/1".parse().unwrap()
        ));
        assert!(allowed_deepseek_url(
            &"https://platform.deepseek.com".parse().unwrap()
        ));
        assert!(!allowed_deepseek_url(
            &"http://chat.deepseek.com".parse().unwrap()
        ));
        assert!(!allowed_deepseek_url(
            &"https://deepseek.com.example.org".parse().unwrap()
        ));
    }

    #[test]
    fn compares_conversations_by_host_and_normalized_path() {
        let saved: Url = "https://chat.deepseek.com/a/chat/s/conversation-1"
            .parse()
            .unwrap();
        let current: Url = "https://chat.deepseek.com/a/chat/s/conversation-1/?from=sidebar"
            .parse()
            .unwrap();
        let other: Url = "https://chat.deepseek.com/a/chat/s/conversation-2"
            .parse()
            .unwrap();

        assert!(same_deepseek_conversation(&saved, &current));
        assert!(!same_deepseek_conversation(&saved, &other));
    }

    #[test]
    fn delete_adapter_supports_non_semantic_menu_items_and_confirmation_stage() {
        assert!(ADAPTER_SCRIPT.contains("[tabindex], li, span, p, div"));
        assert!(ADAPTER_SCRIPT.contains("clickDeleteAction(stage = 'menu')"));
        assert!(ADAPTER_SCRIPT.contains("stage === 'confirm'"));
        assert!(ADAPTER_SCRIPT.contains("删除(?:此|该)?(?:对话|会话)"));
    }

    #[test]
    fn unified_chat_adapter_does_not_depend_on_retired_primary_modes() {
        assert!(!ADAPTER_SCRIPT.contains("quickModePatterns"));
        assert!(!ADAPTER_SCRIPT.contains("expertModePatterns"));
        assert!(!ADAPTER_SCRIPT.contains("selectMode(mode)"));
        assert!(ADAPTER_SCRIPT.contains("[contenteditable=\"true\"][data-lexical-editor]"));
        assert!(ADAPTER_SCRIPT.contains("data-message-author-role=\"assistant\""));
    }
}
