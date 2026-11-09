/*
 * dsh-rewind Client half.
 *
 * Registers one action under a completed Turn's action row and, when a rewind
 * has already cut this Session, hides the withdrawn Turns from the rendered
 * transcript. The Host owns every decision: this module only asks
 * `/api/dsh-rewind/*`, shows the confirmation dialog, and writes the returned
 * prompt back into the composer.
 */
window.__ModuleLoader__.load({
  id: '@netcatty/dsh-rewind',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // `react-dom` is not a guaranteed module-table entry; a missing portal only
    // costs positioning (the dock's transformed ancestor moves a fixed layer).
    const ReactDOM = (() => {
      try { return require('react-dom'); } catch { return null; }
    })();
    const { useState, useEffect, useRef, useCallback } = React;

    const NS = 'dsh-rewind';
    const API = '/api/dsh-rewind';
    const SLOT = 'conversation.composer.dock';
    const HIDDEN_ATTR = 'data-dsh-rewind-hidden';
    const STYLE_ID = 'dsh-rewind-style';
    const MARKER_TEXT = '(dsh-rewind)';
    const REQUEST_TIMEOUT_MS = 30000;

    const zh = {
      'meta.title': '回退对话',
      'meta.description': '把对话回退到更早的一条消息，可连文件一起还原，原文自动放回输入框。',
      'action.rewind': '回退',
      'action.rewindTitle': '回退到本轮提问之前',
      'action.editTitle': '停止并编辑这条消息',
      'dialog.editSubtitle': '会先停止当前生成，再撤回这条消息并把原文放回输入框。',
      'dialog.stopAndEdit': '停止并编辑',
      'dialog.title': '回退到这条消息',
      'dialog.subtitle': '这条消息及其之后的内容会从模型上下文中撤回，日志本身保留。',
      'dialog.preview': '原消息',
      'dialog.files': '受影响文件',
      'dialog.filesCount': '{count} 个文件',
      'dialog.noFiles': '这次回退没有记录到文件改动。',
      'dialog.added': '将删除',
      'dialog.modified': '将还原',
      'dialog.chatOnly': '只回退对话',
      'dialog.filesOnly': '只还原文件',
      'dialog.filesOnlyDone': '已还原文件：还原 {restored}，删除 {deleted}，未变 {unchanged}，跳过 {skipped}，失败 {failed}。对话未改动。',
      'dialog.diff': '差异',
      'dialog.diffHide': '收起',
      'dialog.diffSame': '内容一致',
      'dialog.diffTruncated': '差异过长，已截断',
      'dialog.both': '对话和文件',
      'dialog.confirm': '确认回退',
      'dialog.cancel': '取消',
      'dialog.running': '正在回退…',
      'dialog.done': '已回退，原文已放回输入框。',
      'dialog.doneNoDraft': '已回退，但没能写入输入框。',
      'dialog.filesDone': '文件：还原 {restored}，删除 {deleted}，未变 {unchanged}，跳过 {skipped}，失败 {failed}。',
      'dialog.changedSince': '之后被改动',
      'panel.open': '回退历史',
      'panel.title': '选择要回退的消息',
      'panel.running': '生成中',
      'panel.hint': '↑↓ 选择 · Enter 确认 · Esc 关闭',
      'panel.rewoundCount': '已回退 {count} 次',
      'panel.restoreDraft': '恢复上次草稿（{count} 字）',
      'dialog.attachments': '这条消息含 {count} 个附件；回退只回填文字，附件需重新添加。',
      'dialog.backup': '输入框原有内容已备份，可在「回退历史」里恢复。',
      'settings.intro': '回退对话会就地撤回模型上下文；这里的快照记录每个轮次改动过的文件，用于「对话和文件」一键还原。',
      'settings.snapshots': '文件快照',
      'settings.turns': '轮次',
      'settings.files': '文件',
      'settings.size': '占用',
      'settings.directory': '数据目录',
      'settings.integrityOk': '快照自检正常',
      'settings.integrityIssues': '自检发现 {count} 个问题（缺失或孤儿文件）',
      'settings.refresh': '刷新',
      'settings.clear': '清空快照',
      'settings.clearConfirm': '清空所有文件快照？已完成的回退不受影响，但之后无法再还原这些文件。',
      'settings.limits': '单文件上限 {file}，每轮最多 {files} 个文件，全局保留 {turns} 轮；.git 目录永不记录。bash 与外部工具的写入不在捕获范围内。',
      'settings.limitsSource': '上限来自 cordis.patch.yml 的插件行，改完重启生效。',
      'settings.quarantine': '隔离区',
      'settings.clearQuarantine': '清空隔离区',
      'settings.clearQuarantineConfirm': '清空隔离区？被还原覆盖或删除的内容将无法取回。',
      'settings.quarantineHint': '还原时被覆盖或删除的原始内容保存在这里，误回退可以从隔离区取回；最多 200 份、128 MiB。',
      'settings.quarantineEmpty': '隔离区是空的。',
      'settings.quarantineSession': '会话',
      'settings.quarantineMore': '还有 {count} 条未显示',
      'settings.discard': '删除',
      'settings.restore': '恢复',
      'settings.restoreConfirm': '把隔离区的内容写回该文件？当前内容会被覆盖，旧内容仍会留在隔离区。',
      'dialog.notLive': '会话未打开，无法就地回退。',
      'dialog.failed': '回退失败',
      'dialog.close': '关闭',
      'dialog.fileTooLarge': '超过快照上限',
      'dialog.fileUnavailable': '内容已不可用',
    };

    const en = {
      'meta.title': 'Rewind conversation',
      'meta.description': 'Cut the conversation back to an earlier message, optionally restore the files that turn changed, and put the original text back in the composer.',
      'action.rewind': 'Rewind',
      'action.rewindTitle': 'Rewind to before this turn’s prompt',
      'action.editTitle': 'Stop and edit this message',
      'dialog.editSubtitle': 'The running reply stops, this message is withdrawn, and its text goes back to the composer.',
      'dialog.stopAndEdit': 'Stop and edit',
      'dialog.title': 'Rewind to this message',
      'dialog.subtitle': 'This message and everything after it leave the model context. The log itself is kept.',
      'dialog.preview': 'Message',
      'dialog.files': 'Affected files',
      'dialog.filesCount': '{count} files',
      'dialog.noFiles': 'No file change was recorded for this rewind.',
      'dialog.added': 'will be removed',
      'dialog.modified': 'will be restored',
      'dialog.chatOnly': 'Conversation only',
      'dialog.filesOnly': 'Files only',
      'dialog.filesOnlyDone': 'Files restored: {restored} restored, {deleted} removed, {unchanged} unchanged, {skipped} skipped, {failed} failed. The conversation is untouched.',
      'dialog.diff': 'Diff',
      'dialog.diffHide': 'Hide',
      'dialog.diffSame': 'identical',
      'dialog.diffTruncated': 'diff truncated',
      'dialog.both': 'Conversation and files',
      'dialog.confirm': 'Rewind',
      'dialog.cancel': 'Cancel',
      'dialog.running': 'Rewinding…',
      'dialog.done': 'Rewound. The original text is back in the composer.',
      'dialog.doneNoDraft': 'Rewound, but the composer could not be filled.',
      'dialog.filesDone': 'Files: {restored} restored, {deleted} removed, {unchanged} unchanged, {skipped} skipped, {failed} failed.',
      'dialog.changedSince': 'edited since',
      'panel.open': 'Rewind history',
      'panel.title': 'Choose a message to rewind to',
      'panel.running': 'running',
      'panel.hint': '↑↓ select · Enter confirm · Esc close',
      'panel.rewoundCount': 'rewound {count}×',
      'panel.restoreDraft': 'Restore the saved draft ({count} chars)',
      'dialog.attachments': 'This message has {count} attachments; a rewind refills text only, add them again.',
      'dialog.backup': 'The previous composer text was saved and can be restored from Rewind history.',
      'settings.intro': 'A rewind withdraws the model context in place. These snapshots hold the files each Turn changed, so “Conversation and files” can put them back.',
      'settings.snapshots': 'File snapshots',
      'settings.turns': 'Turns',
      'settings.files': 'Files',
      'settings.size': 'On disk',
      'settings.directory': 'Data directory',
      'settings.integrityOk': 'Snapshot check passed',
      'settings.integrityIssues': 'Snapshot check found {count} issue(s): missing or orphan files',
      'settings.refresh': 'Refresh',
      'settings.clear': 'Clear snapshots',
      'settings.clearConfirm': 'Clear every file snapshot? Finished rewinds stay, but those files can no longer be restored.',
      'settings.limits': 'Up to {file} per file, {files} files per Turn, {turns} Turns total; .git is never recorded. Writes made through bash or external tools are out of scope.',
      'settings.limitsSource': 'Limits come from the plugin row in cordis.patch.yml; restart after editing.',
      'settings.quarantine': 'Quarantine',
      'settings.clearQuarantine': 'Clear quarantine',
      'settings.clearQuarantineConfirm': 'Clear the quarantine? Content displaced by a restore can no longer be recovered.',
      'settings.quarantineHint': 'Bytes overwritten or deleted by a restore are kept here, so a mistaken rewind is recoverable; up to 200 entries and 128 MiB.',
      'settings.quarantineEmpty': 'The quarantine is empty.',
      'settings.quarantineSession': 'Session',
      'settings.quarantineMore': '{count} more not shown',
      'settings.discard': 'Delete',
      'settings.restore': 'Restore',
      'settings.restoreConfirm': 'Write the quarantined bytes back to this file? The current content is overwritten, and the old content stays in the quarantine.',
      'dialog.notLive': 'This session is not open, so it cannot be rewound in place.',
      'dialog.failed': 'Rewind failed',
      'dialog.close': 'Close',
      'dialog.fileTooLarge': 'over the snapshot cap',
      'dialog.fileUnavailable': 'content unavailable',
    };

    const fill = (template, params) => String(template ?? '').replace(/\{(\w+)\}/g, (match, name) => {
      const value = params?.[name];
      return value === undefined || value === null ? match : String(value);
    });

    const prefersChinese = typeof navigator !== 'undefined'
      && typeof navigator.language === 'string'
      && navigator.language.toLowerCase().startsWith('zh');
    const fallback = prefersChinese ? zh : en;

    function localMessage(key, params) {
      return fill(fallback[key] ?? en[key] ?? key, params);
    }

    // ---------------------------------------------------------------------
    // Shared per-Session state cache: one request serves every Turn row.
    // ---------------------------------------------------------------------

    const states = new Map();
    /** Refill tokens already written into a composer, so a poll cannot repeat one. */
    const handledRefills = new Set();

    function entryOf(sessionId) {
      let entry = states.get(sessionId);
      if (entry === undefined) {
        entry = { data: undefined, error: undefined, promise: undefined, listeners: new Set() };
        states.set(sessionId, entry);
      }
      return entry;
    }

    function publish(sessionId, patch) {
      const entry = entryOf(sessionId);
      Object.assign(entry, patch);
      for (const listener of [...entry.listeners]) {
        try { listener(entry); } catch { /* a broken listener must not stop the rest */ }
      }
    }

    /** A cheap identity for the parts of the state a row renders from. */
    function signatureOf(value) {
      try {
        return JSON.stringify({
          c: (value.candidates ?? []).map((row) => `${row.seq}:${row.turn ?? ''}:${row.running === true ? 1 : 0}`),
          h: value.hiddenTurns ?? [],
          r: value.rewound === true,
        });
      } catch {
        return '';
      }
    }

    async function loadState(sessionId, force) {
      const entry = entryOf(sessionId);
      // One in-flight request per Session serves every Turn row mounted at the
      // same time; a forced call only skips the cached value.
      if (entry.promise !== undefined) return entry.promise;
      if (entry.data !== undefined) {
        const age = Date.now() - (entry.loadedAt ?? 0);
        if (force !== true || age < 400) return entry.data;
      }
      const run = (async () => {
        try {
          const response = await fetch(`${API}/state?sessionId=${encodeURIComponent(sessionId)}`, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          });
          const value = await response.json().catch(() => null);
          if (!response.ok || value?.ok !== true) {
            throw new Error(value?.error ?? `HTTP ${response.status}`);
          }
          const signature = signatureOf(value);
          if (entry.data !== undefined && entry.signature === signature) {
            // A poll that learned nothing new must not re-render every row.
            entry.loadedAt = Date.now();
            return value;
          }
          publish(sessionId, { data: value, error: undefined, loadedAt: Date.now(), signature });
          return value;
        } catch (error) {
          publish(sessionId, { error: error instanceof Error ? error.message : String(error) });
          return undefined;
        } finally {
          const current = entryOf(sessionId);
          if (current.promise === run) current.promise = undefined;
        }
      })();
      entryOf(sessionId).promise = run;
      return run;
    }

    function readEntry(sessionId) {
      return entryOf(sessionId);
    }

    // A Host-side change such as `/undo` appends its marker without any Client
    // action, so a low-frequency poll refreshes the rows that are on screen.
    // The signature comparison in `loadState` keeps an unchanged poll free.
    const polling = { timer: 0 };

    function ensurePolling() {
      if (polling.timer !== 0 || typeof window === 'undefined') return;
      polling.timer = window.setInterval(() => {
        try {
          if (document.visibilityState !== 'visible') return;
          for (const [sessionId, entry] of states) {
            if (entry.listeners.size === 0) continue;
            void loadState(sessionId, true);
          }
        } catch { /* polling must never break the page */ }
      }, 4000);
    }

    function disposePolling() {
      if (polling.timer !== 0) {
        window.clearInterval(polling.timer);
        polling.timer = 0;
      }
    }

    // ---------------------------------------------------------------------
    // Hiding withdrawn Turns.
    //
    // Chat renders append-origin rows, so a declared rewind does not remove the
    // old rows by itself. This marks the Turns the Host reports as withdrawn,
    // plus the marker row, with an attribute a single stylesheet rule hides.
    // Unknown attributes survive a re-render; inline styles do not.
    // ---------------------------------------------------------------------

    const hiding = { turns: new Set(), scheduled: 0, observer: null, installed: false };

    /**
     * One action per rendered user row, keyed `<sessionId>:<turn>`. The row is
     * built by the official renderer, so the action is injected beside its Copy
     * button and re-created whenever React rebuilds the row.
     */
    const actions = new Map();

    const ACTION_ATTR = 'data-dsh-rewind-action';

    const EDIT_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
      + '<path d="M10.4 2.9l2.7 2.7-7.2 7.2-3.4.7.7-3.4 7.2-7.2z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>'
      + '</svg>';

    const ACTION_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
      + '<path d="M6.5 2.5 2.5 6.5l4 4" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M2.5 6.5h7a4 4 0 0 1 4 4v1.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>'
      + '</svg>';

    function ensureStyle() {
      if (typeof document === 'undefined') return;
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `[${HIDDEN_ATTR}]{display:none!important}`
        + `[${ACTION_ATTR}]{display:inline-flex;align-items:center;justify-content:center}`;
      (document.head ?? document.documentElement).appendChild(style);
    }

    function applyHiding() {
      hiding.scheduled = 0;
      if (typeof document === 'undefined') return;
      let rows;
      try { rows = document.querySelectorAll('[data-chat-turn]'); } catch { return; }
      for (const row of rows) {
        const turn = Number(row.getAttribute('data-chat-turn'));
        const isMarker = (row.textContent ?? '').trim() === MARKER_TEXT;
        const hide = isMarker || (Number.isInteger(turn) && hiding.turns.has(turn));
        if (hide) {
          if (!row.hasAttribute(HIDDEN_ATTR)) row.setAttribute(HIDDEN_ATTR, 'true');
        } else if (row.hasAttribute(HIDDEN_ATTR)) {
          row.removeAttribute(HIDDEN_ATTR);
        }
      }
      syncActions();
    }

    /** Re-create every registered action whose row lost it to a React rebuild. */
    function syncActions() {
      if (typeof document === 'undefined') return;
      for (const [key, entry] of actions) {
        try { mountAction(key, entry); } catch { /* a row shape we do not recognize */ }
      }
    }

    function mountAction(key, entry) {
      const selector = `[data-chat-flow-kind="user"][data-chat-turn="${entry.turn}"]`;
      const row = document.querySelector(selector);
      if (row === null) return;
      const kind = entry.icon === EDIT_ICON ? 'edit' : 'rewind';
      const existing = row.querySelector(`[${ACTION_ATTR}="${key}"]`);
      if (existing !== null) {
        if (existing.getAttribute('data-dsh-rewind-kind') !== kind) {
          existing.setAttribute('data-dsh-rewind-kind', kind);
          existing.innerHTML = entry.icon ?? ACTION_ICON;
          existing.title = entry.title;
          existing.setAttribute('aria-label', entry.title);
        }
        return;
      }
      const copy = row.querySelector('button');
      if (copy === null || copy.parentElement === null) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute(ACTION_ATTR, key);
      button.setAttribute('data-dsh-rewind-kind', kind);
      button.setAttribute('aria-label', entry.title);
      button.setAttribute('aria-haspopup', 'dialog');
      button.title = entry.title;
      button.innerHTML = entry.icon ?? ACTION_ICON;
      // Reuse the sibling Copy button's chrome so the action matches the row.
      if (typeof copy.className === 'string' && copy.className !== '') button.className = copy.className;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        entry.open(button);
      });
      copy.after(button);
    }

    function removeAction(key) {
      if (typeof document === 'undefined') return;
      let escaped = key;
      try { escaped = CSS.escape(key); } catch { /* fall back to the raw key */ }
      for (const element of document.querySelectorAll(`[${ACTION_ATTR}="${escaped}"]`)) {
        try { element.remove(); } catch { /* already gone */ }
      }
    }

    function scheduleHiding() {
      if (typeof document === 'undefined') return;
      if (hiding.scheduled !== 0) return;
      hiding.scheduled = window.setTimeout(applyHiding, 120);
    }

    function setHiddenTurns(turns) {
      const next = new Set(Array.isArray(turns) ? turns.filter((turn) => Number.isInteger(turn)) : []);
      if (next.size === hiding.turns.size && [...next].every((turn) => hiding.turns.has(turn))) return;
      hiding.turns = next;
      scheduleHiding();
    }

    function ensureObserver() {
      if (hiding.installed || typeof document === 'undefined' || typeof MutationObserver !== 'function') return;
      hiding.installed = true;
      ensureStyle();
      try {
        hiding.observer = new MutationObserver(() => scheduleHiding());
        hiding.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-chat-turn'] });
      } catch {
        hiding.observer = null;
      }
      if (hiding.turns.size > 0) scheduleHiding();
    }

    function disposeObserver() {
      try { hiding.observer?.disconnect(); } catch { /* already gone */ }
      hiding.observer = null;
      hiding.installed = false;
      if (hiding.scheduled !== 0) {
        window.clearTimeout(hiding.scheduled);
        hiding.scheduled = 0;
      }
      hiding.turns = new Set();
    }

    // ---------------------------------------------------------------------
    // Host calls.
    // ---------------------------------------------------------------------

    async function postJson(route, body) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller === null ? 0 : window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(route, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          ...(controller === null ? {} : { signal: controller.signal }),
        });
      } finally {
        if (timer !== 0) window.clearTimeout(timer);
      }
      const value = await response.json().catch(() => null);
      if (!response.ok || value?.ok !== true) {
        const error = new Error(value?.error ?? `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return value;
    }

    // ---------------------------------------------------------------------
    // The action + dialog.
    // ---------------------------------------------------------------------

    function RewindController(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined;
      const inputActions = props.inputActions;
      const tr = typeof props.tr === 'function' ? props.tr : localMessage;

      const [state, setState] = useState(() => (sessionId === undefined ? undefined : readEntry(sessionId).data));
      const [active, setActive] = useState(null);
      const [panel, setPanel] = useState(false);
      const [cursor, setCursor] = useState(0);
      const [backup, setBackup] = useState('');
      const [open, setOpen] = useState(false);
      const [anchor, setAnchor] = useState(null);
      const [plan, setPlan] = useState(null);
      const [phase, setPhase] = useState('idle');
      const [message, setMessage] = useState('');
      const [selected, setSelected] = useState(() => new Set());
      const [planToken, setPlanToken] = useState(null);
      const [expanded, setExpanded] = useState(() => new Set());
      const openRef = useRef(null);
      const dialogRef = useRef(null);
      const panelRef = useRef(null);
      const dockRef = useRef(null);

      useEffect(() => {
        if (sessionId === undefined) return undefined;
        const entry = readEntry(sessionId);
        const listener = (next) => { setState(next.data); };
        entry.listeners.add(listener);
        // Refresh on every mount: a new Turn appears after the previous state
        // snapshot, and a shared in-flight request keeps that cheap.
        void loadState(sessionId, true);
        if (entry.data !== undefined) setState(entry.data);
        return () => { entry.listeners.delete(listener); };
      }, [sessionId]);

      useEffect(() => {
        if (state === undefined) return;
        setHiddenTurns(state.hiddenTurns);
      }, [state]);

      // A Host-side rewind (`/undo`, `/rewind <n>`) cannot reach the composer
      // itself; the next state read hands the text over once.
      useEffect(() => {
        const refill = state?.refill;
        if (refill === null || refill === undefined) return;
        if (sessionId === undefined || typeof refill.token !== 'string') return;
        if (handledRefills.has(refill.token)) return;
        handledRefills.add(refill.token);
        const text = typeof refill.text === 'string' ? refill.text : '';
        if (text === '') return;
        let current = '';
        try {
          current = String(document.querySelector('[data-composer-input]')?.textContent ?? '').trim();
        } catch { current = ''; }
        if (current !== '' && current !== text.trim() && draftKey !== '') {
          try {
            window.localStorage.setItem(draftKey, JSON.stringify({ text: current, at: Date.now() }));
          } catch { /* the refill still wins */ }
        }
        try {
          if (inputActions !== undefined && typeof inputActions.setDraft === 'function') {
            inputActions.setDraft(text);
            if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft();
          }
        } catch { /* a refused composer keeps the receipt text */ }
        void fetch(`${API}/refill-consumed`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, token: refill.token }),
        }).catch(() => undefined);
      }, [state?.refill, sessionId]);

      const choices = Array.isArray(state?.candidates) ? state.candidates : [];

      const draftKey = sessionId === undefined ? '' : `dsh-rewind:draft:${sessionId}`;
      const readBackup = () => {
        if (draftKey === '') return '';
        try {
          const raw = window.localStorage.getItem(draftKey);
          const text = raw === null ? '' : (JSON.parse(raw)?.text ?? '');
          return typeof text === 'string' ? text : '';
        } catch {
          return '';
        }
      };

      const choose = (item, element) => {
        if (item === undefined || item === null) return;
        setPanel(false);
        setActive(item);
        openRef.current?.(element ?? panelRef.current ?? null, item);
      };

      // Double Esc is the keyboard shortcut for the panel. A single Esc keeps the
      // host's own meaning (stop generation, close a popover).
      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        let last = 0;
        const onKey = (event) => {
          if (event.key !== 'Escape' || panel || open) return;
          if (state?.running === true) return;
          const now = Date.now();
          if (now - last < 400) {
            last = 0;
            setPanel(true);
            setCursor(0);
          } else {
            last = now;
          }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
      }, [panel, open, state?.running]);

      // Candidate panel: ↑/↓ move, Enter opens the confirmation, Esc closes.
      useEffect(() => {
        if (!panel) return undefined;
        setBackup(readBackup());
        const onKey = (event) => {
          if (event.key === 'Escape') { event.stopPropagation(); setPanel(false); return; }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setCursor((value) => Math.min(value + 1, Math.max(0, Math.min(choices.length, 50) - 1)));
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setCursor((value) => Math.max(0, value - 1));
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            choose(choices[cursor], panelRef.current);
          }
        };
        const onDown = (event) => {
          if (panelRef.current !== null && panelRef.current.contains(event.target)) return;
          if (dockRef.current !== null && dockRef.current.contains(event.target)) return;
          setPanel(false);
        };
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('mousedown', onDown, true);
        return () => {
          document.removeEventListener('keydown', onKey, true);
          document.removeEventListener('mousedown', onDown, true);
        };
      }, [panel, cursor, choices]);

      // Place one action beside every user message on the surface, including
      // the Turn that is still streaming: the state carries `running` for that
      // one and the action becomes "stop and edit". The row is host-owned DOM,
      // so the button is re-created by the shared sync pass on every rebuild.
      useEffect(() => {
        if (sessionId === undefined) return undefined;
        const registered = new Set();
        if (state?.isSubagent === true) {
          scheduleHiding();
          return () => undefined;
        }
        for (const item of state?.candidates ?? []) {
          if (!Number.isInteger(item.turn) || !Number.isInteger(item.seq)) continue;
          const key = `${sessionId}:${item.turn}`;
          registered.add(key);
          actions.set(key, {
            turn: item.turn,
            title: item.running === true ? tr('action.editTitle') : tr('action.rewindTitle'),
            icon: item.running === true ? EDIT_ICON : ACTION_ICON,
            open: (element) => {
              setActive(item);
              openRef.current?.(element, item);
            },
          });
        }
        scheduleHiding();
        return () => {
          for (const key of registered) {
            actions.delete(key);
            removeAction(key);
          }
        };
      }, [sessionId, state?.candidates]);

      const close = useCallback(() => {
        setOpen(false);
        setActive(null);
        setPlan(null);
        setPlanToken(null);
        setPhase('idle');
        setMessage('');
      }, []);

      useEffect(() => {
        if (!open || dialogRef.current === null) return;
        // Keep the dialog inside the viewport: flipping upward when the anchor
        // sits near the bottom is cheaper than estimating the rendered height.
        const element = dialogRef.current;
        const rect = element.getBoundingClientRect();
        const overflow = rect.bottom - (window.innerHeight - 12);
        if (overflow > 0) {
          const nextTop = Math.max(12, rect.top - overflow);
          element.style.top = `${nextTop}px`;
        }
      }, [open, plan, phase, message]);

      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') { event.stopPropagation(); close(); }
        };
        const onDown = (event) => {
          if (dialogRef.current !== null && dialogRef.current.contains(event.target)) return;
          if (event.target instanceof Element && event.target.closest(`[${ACTION_ATTR}]`) !== null) return;
          close();
        };
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('mousedown', onDown, true);
        return () => {
          document.removeEventListener('keydown', onKey, true);
          document.removeEventListener('mousedown', onDown, true);
        };
      }, [open, close]);

      const openDialog = async (anchorElement, item) => {
        if (item !== null && item !== undefined) setActive(item);
        const element = anchorElement instanceof Element ? anchorElement : null;
        if (element !== null) {
          const rect = element.getBoundingClientRect();
          const offscreen = rect.bottom < 0 || rect.top > window.innerHeight;
          setAnchor(offscreen
            ? { left: Math.max(12, (window.innerWidth - 368) / 2), top: 96 }
            : { left: Math.min(rect.left, Math.max(12, window.innerWidth - 380)), top: rect.bottom + 8 });
        }
        setOpen(true);
        setPhase('preview');
        setMessage('');
        try {
          const value = await postJson(`${API}/preview`, { sessionId, seq: item.seq });
          setPlan(value);
          setPlanToken(typeof value.planToken === 'string' ? value.planToken : null);
          setExpanded(new Set());
          setSelected(new Set((value.files ?? []).map((file) => file.absolute)));
          setPhase('ready');
        } catch (error) {
          setPhase('error');
          setMessage(error instanceof Error ? error.message : String(error));
        }
      };

      const run = async (mode, chosen) => {
        setPhase('running');
        setMessage('');
        try {
          const result = await postJson(`${API}/execute`, {
            sessionId,
            seq: active.seq,
            mode,
            ...(Array.isArray(chosen) ? { paths: chosen } : {}),
            ...(typeof planToken === 'string' ? { planToken } : {}),
          });
          if (mode === 'files') {
            const files = result.files ?? {};
            setPhase('done');
            setMessage(tr('dialog.filesOnlyDone', {
              restored: files.restored ?? 0,
              deleted: files.deleted ?? 0,
              unchanged: files.unchanged ?? 0,
              skipped: files.skipped ?? 0,
              failed: files.failed ?? 0,
            }));
            void loadState(sessionId, true);
            window.setTimeout(() => { close(); }, 2200);
            return;
          }
          const prompt = typeof result.prompt === 'string' ? result.prompt : '';
          let filled = false;
          let backedUp = false;
          if (prompt !== '' && inputActions !== undefined && typeof inputActions.setDraft === 'function') {
            // Never trade one draft for another silently: keep what the composer
            // already held and offer it back from Rewind history.
            let current = '';
            try {
              current = String(document.querySelector('[data-composer-input]')?.textContent ?? '').trim();
            } catch { current = ''; }
            if (current !== '' && current !== prompt.trim() && draftKey !== '') {
              try {
                window.localStorage.setItem(draftKey, JSON.stringify({ text: current, at: Date.now() }));
                backedUp = true;
              } catch { backedUp = false; }
            }
            try {
              inputActions.setDraft(prompt);
              if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft();
              filled = true;
            } catch { filled = false; }
          }
          if (Array.isArray(result.hiddenTurns)) setHiddenTurns(result.hiddenTurns);
          setPhase('done');
          const lines = [filled ? tr('dialog.done') : (prompt === '' ? tr('dialog.doneNoDraft') : tr('dialog.doneNoDraft'))];
          if (result.files !== undefined) {
            lines.push(tr('dialog.filesDone', {
              restored: result.files.restored,
              deleted: result.files.deleted,
              unchanged: result.files.unchanged ?? 0,
              skipped: result.files.skipped,
              failed: result.files.failed,
            }));
          }
          if (backedUp === true) lines.push(tr('dialog.backup'));
          if ((result.attachments ?? 0) > 0) {
            lines.push(tr('dialog.attachments', { count: result.attachments }));
          }
          setMessage(lines.join('\n'));
          void loadState(sessionId, true);
          window.setTimeout(() => { close(); }, 2200);
        } catch (error) {
          setPhase('error');
          setMessage(error instanceof Error ? error.message : String(error));
        }
      };

      openRef.current = openDialog;

      // The dialog follows the latest state: a candidate that finished streaming
      // while the dialog was open must stop reading "stop and edit".
      const current = active === null
        ? null
        : (choices.find((item) => item.seq === active.seq) ?? active);

      // A saved draft keeps the entry reachable even when nothing is left to
      // rewind (the common state right after a rewind).
      let backupExists = false;
      try { backupExists = draftKey !== '' && window.localStorage.getItem(draftKey) !== null; } catch { backupExists = false; }

      const dockButton = state?.isSubagent === true
        || (choices.length === 0 && backupExists !== true && state?.rewound !== true)
        ? null
        : h('button', {
        ref: dockRef,
        type: 'button',
        title: tr('panel.open'),
        'aria-label': tr('panel.open'),
        'aria-expanded': panel ? 'true' : 'false',
        onClick: () => { setPanel((value) => !value); setCursor(0); },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          height: 24,
          padding: '0 8px',
          border: 'none',
          borderRadius: 6,
          background: panel ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: 12,
          cursor: 'pointer',
          fontFamily: 'inherit',
        },
      },
      h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
        h('path', {
          d: 'M3 4.5h10M3 8h10M3 11.5h6',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        })),
      h('span', null, tr('panel.open')));

      const panelNode = panel ? h('div', {
        ref: panelRef,
        role: 'dialog',
        'aria-label': tr('panel.title'),
        style: {
          position: 'fixed',
          zIndex: 60,
          left: 24,
          bottom: 96,
          width: 420,
          maxWidth: 'calc(100vw - 24px)',
          maxHeight: '60vh',
          overflow: 'auto',
          boxSizing: 'border-box',
          padding: 10,
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 10,
          background: 'var(--dsw-alias-bg-overlay)',
          boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
          color: 'var(--dsw-alias-label-primary)',
          fontSize: 13,
        },
      },
      h('div', {
        style: {
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
          padding: '2px 6px 8px',
        },
      },
      h('div', { style: { fontWeight: 600, fontSize: 13 } }, tr('panel.title')),
      (state?.markerSeqs?.length ?? 0) > 0
        ? h('div', {
          style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
        }, tr('panel.rewoundCount', { count: state.markerSeqs.length }))
        : null),
      backup !== '' ? h('button', {
        type: 'button',
        onClick: () => {
          try {
            if (inputActions !== undefined && typeof inputActions.setDraft === 'function') {
              inputActions.setDraft(backup);
              if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft();
            }
            if (draftKey !== '') window.localStorage.removeItem(draftKey);
            setBackup('');
          } catch { /* keep the backup when the composer refuses */ }
          setPanel(false);
        },
        style: {
          display: 'block',
          width: '100%',
          margin: '0 0 6px',
          padding: '6px 8px',
          border: '1px dashed var(--dsw-alias-border-l2)',
          borderRadius: 6,
          background: 'transparent',
          color: 'var(--dsw-alias-brand-primary)',
          fontSize: 12,
          textAlign: 'left',
          cursor: 'pointer',
          fontFamily: 'inherit',
        },
      }, tr('panel.restoreDraft', { count: backup.length })) : null,
      choices.slice(0, 50).map((item, index) => h('button', {
        key: `${item.seq}`,
        type: 'button',
        onClick: (event) => { choose(item, event.currentTarget); },
        onMouseEnter: () => { setCursor(index); },
        style: {
          display: 'flex',
          width: '100%',
          gap: 8,
          alignItems: 'baseline',
          padding: '6px 8px',
          border: 'none',
          borderRadius: 6,
          textAlign: 'left',
          background: index === cursor ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 12,
        },
      },
      h('span', {
        style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary)', minWidth: 22 },
      }, `${item.index}.`),
      h('span', {
        style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, item.preview || '(空消息)'),
      item.running === true
        ? h('span', { style: { flex: '0 0 auto', color: 'var(--dsw-alias-state-warn-primary)' } }, tr('panel.running'))
        : null)),
      h('div', {
        style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, padding: '6px 8px 0' },
      }, tr('panel.hint'))) : null;

      const files = Array.isArray(plan?.files) ? plan.files : [];
      const showFiles = files.length > 0;

      const chosen = files.filter((file) => selected.has(file.absolute)).map((file) => file.absolute);

      const fileRows = files.slice(0, 50).map((file, index) => {
        const isOpen = expanded.has(file.absolute);
        const diff = file.diff ?? null;
        return h('div', {
          key: `${file.path}-${index}`,
          style: { display: 'flex', flexDirection: 'column', gap: 2 },
        },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 12 } },
          h('input', {
            type: 'checkbox',
            checked: selected.has(file.absolute),
            'aria-label': file.path,
            onChange: () => {
              setSelected((previous) => {
                const next = new Set(previous);
                if (next.has(file.absolute)) next.delete(file.absolute);
                else next.add(file.absolute);
                return next;
              });
            },
            style: { margin: 0, flex: '0 0 auto' },
          }),
          h('span', {
            style: {
              flex: '0 0 auto',
              color: file.existed ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-error-primary)',
            },
          }, file.existed ? tr('dialog.modified') : tr('dialog.added')),
          h('span', {
            title: file.absolute,
            style: {
              flex: '1 1 auto',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              direction: 'rtl',
              textAlign: 'left',
            },
          }, file.path),
          file.changedSince === true
            ? h('span', {
              style: { flex: '0 0 auto', color: 'var(--dsw-alias-state-warn-primary)' },
            }, tr('dialog.changedSince'))
            : null,
          diff === null ? null : h('button', {
            type: 'button',
            onClick: () => {
              setExpanded((previous) => {
                const next = new Set(previous);
                if (next.has(file.absolute)) next.delete(file.absolute);
                else next.add(file.absolute);
                return next;
              });
            },
            style: {
              flex: '0 0 auto',
              border: 'none',
              background: 'transparent',
              color: 'var(--dsw-alias-brand-primary)',
              fontSize: 11,
              padding: 0,
              cursor: 'pointer',
              fontFamily: 'inherit',
            },
          }, isOpen ? tr('dialog.diffHide') : tr('dialog.diff'))),
        isOpen && diff !== null
          ? h('div', {
            style: {
              fontFamily: 'ui-monospace, SFMono-Regular, monospace',
              fontSize: 11,
              lineHeight: 1.45,
              whiteSpace: 'pre',
              overflow: 'auto',
              maxHeight: 160,
              padding: '4px 6px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-base)',
            },
          },
          diff.rows.length === 0
            ? h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, tr('dialog.diffSame'))
            : diff.rows.map((row, rowIndex) => h('div', {
              key: rowIndex,
              style: {
                color: row.type === 'del'
                  ? 'var(--dsw-alias-state-error-primary)'
                  : (row.type === 'add'
                    ? 'var(--dsw-alias-state-success-primary)'
                    : 'var(--dsw-alias-label-secondary)'),
              },
            }, `${row.type === 'del' ? '-' : (row.type === 'add' ? '+' : ' ')} ${row.text}`)),
          diff.truncated
            ? h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, tr('dialog.diffTruncated'))
            : null)
          : null);
      });

      const filesBlock = showFiles
        ? h('div', { style: { marginBottom: 10 } },
          h('div', {
            style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginBottom: 4 },
          }, `${tr('dialog.files')} · ${tr('dialog.filesCount', { count: files.length })}`),
          h('div', {
            style: { maxHeight: 132, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 },
          }, fileRows))
        : null;

      const dialog = open && active !== null ? h('div', {
          ref: dialogRef,
          role: 'dialog',
          'aria-modal': 'false',
          'aria-label': tr('dialog.title'),
          style: {
            position: 'fixed',
            zIndex: 60,
            left: anchor === null ? 24 : anchor.left,
            top: anchor === null ? 120 : anchor.top,
            width: 368,
            maxWidth: 'calc(100vw - 24px)',
            maxHeight: '70vh',
            overflow: 'auto',
            boxSizing: 'border-box',
            padding: 14,
            borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-overlay)',
            boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: 13,
            lineHeight: 1.5,
          },
        },
        h('div', { style: { fontWeight: 600, fontSize: 14, marginBottom: 2 } },
          current?.running === true ? tr('action.editTitle') : tr('dialog.title')),
        h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginBottom: 10 } },
          current?.running === true ? tr('dialog.editSubtitle') : tr('dialog.subtitle')),

        phase === 'preview' ? h('div', { style: { color: 'var(--dsw-alias-label-secondary)', padding: '12px 0' } }, tr('dialog.running')) : null,

        phase !== 'preview' ? h('div', {
          style: {
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 8,
            padding: '8px 10px',
            marginBottom: 10,
            maxHeight: 120,
            overflow: 'auto',
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        }, (plan?.target?.preview ?? current.preview) || '(空消息)') : null,

        phase !== 'preview' && (plan?.attachments ?? current.attachments ?? 0) > 0 ? h('div', {
          style: {
            color: 'var(--dsw-alias-state-warn-primary)',
            fontSize: 12,
            marginBottom: 8,
          },
        }, tr('dialog.attachments', { count: plan?.attachments ?? current.attachments })) : null,

        phase !== 'preview' ? filesBlock : null,
        phase !== 'preview' && !showFiles && plan !== null ? h('div', {
          style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginBottom: 10 },
        }, tr('dialog.noFiles')) : null,

        message !== '' ? h('div', {
          style: {
            marginBottom: 10,
            whiteSpace: 'pre-wrap',
            fontSize: 12,
            color: phase === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
          },
        }, message) : null,

        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          h('button', {
            type: 'button',
            onClick: close,
            style: buttonStyle(false),
          }, phase === 'done' ? tr('dialog.close') : tr('dialog.cancel')),
          phase === 'ready' ? h('button', {
            type: 'button',
            onClick: () => { void run('chat'); },
            style: buttonStyle(showFiles !== true),
          }, showFiles
            ? tr('dialog.chatOnly')
            : (current?.running === true ? tr('dialog.stopAndEdit') : tr('dialog.confirm'))) : null,
          phase === 'ready' && showFiles ? h('button', {
            type: 'button',
            onClick: () => { void run('files', chosen); },
            disabled: chosen.length === 0,
            style: {
              ...buttonStyle(false),
              ...(chosen.length === 0 ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
            },
          }, tr('dialog.filesOnly')) : null,
          phase === 'ready' && showFiles ? h('button', {
            type: 'button',
            onClick: () => { void run('both', chosen); },
            style: {
              ...buttonStyle(false),
              ...(chosen.length === 0 || plan?.live !== true ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
            },
            disabled: chosen.length === 0 || plan?.live !== true,
            title: plan?.live === true ? '' : tr('dialog.notLive'),
          }, chosen.length === files.length
            ? tr('dialog.both')
            : `${tr('dialog.both')} (${chosen.length}/${files.length})`) : null,
          phase === 'running' ? h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, tr('dialog.running')) : null,
          phase === 'error' ? h('button', {
            type: 'button',
            onClick: () => { void run('chat'); },
            style: buttonStyle(false),
          }, tr('dialog.confirm')) : null)) : null;

      const overlay = h(React.Fragment, null, panelNode, dialog);
      const floating = (open || panel) && ReactDOM !== null && typeof ReactDOM.createPortal === 'function'
        ? ReactDOM.createPortal(overlay, document.body)
        : overlay;
      return h(React.Fragment, null, dockButton, floating);
    }

    function buttonStyle(primary) {
      return {
        height: 28,
        padding: '0 12px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: primary ? 'var(--dsw-alias-brand-primary)' : 'transparent',
        color: primary ? '#fff' : 'var(--dsw-alias-label-primary)',
        fontSize: 12,
        cursor: 'pointer',
        fontFamily: 'inherit',
      };
    }

    /** Settings → 回退对话: snapshots an operator can inspect and clear. */
    function SettingsSection(props) {
      const tr = typeof props.tr === 'function' ? props.tr : localMessage;
      const [stats, setStats] = useState(null);
      const [entries, setEntries] = useState([]);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);

      const load = useCallback(async () => {
        try {
          const [statsResponse, listResponse] = await Promise.all([
            fetch(`${API}/stats`, { credentials: 'same-origin', headers: { accept: 'application/json' } }),
            fetch(`${API}/quarantine`, { credentials: 'same-origin', headers: { accept: 'application/json' } }),
          ]);
          const value = await statsResponse.json().catch(() => null);
          if (!statsResponse.ok || value?.ok !== true) throw new Error(value?.error ?? `HTTP ${statsResponse.status}`);
          const list = await listResponse.json().catch(() => null);
          setStats(value);
          setEntries(Array.isArray(list?.entries) ? list.entries : []);
          setError('');
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }, []);

      useEffect(() => { void load(); }, [load]);

      const restoreQuarantine = async (row) => {
        if (busy || typeof row?.blob !== 'string') return;
        if (typeof window.confirm === 'function' && window.confirm(tr('settings.restoreConfirm')) !== true) return;
        setBusy(true);
        try {
          await postJson(`${API}/quarantine-restore`, { blob: row.blob, overwrite: true });
          await load();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          setBusy(false);
        }
      };

      const discardOne = async (blob) => {
        if (busy || typeof blob !== 'string') return;
        setBusy(true);
        try {
          await postJson(`${API}/quarantine-discard`, { blob });
          await load();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          setBusy(false);
        }
      };

      const clearQuarantine = async () => {
        if (busy) return;
        if (typeof window.confirm === 'function' && window.confirm(tr('settings.clearQuarantineConfirm')) !== true) return;
        setBusy(true);
        try {
          await postJson(`${API}/clear-quarantine`, { confirm: true });
          await load();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          setBusy(false);
        }
      };

      const clear = async () => {
        if (busy) return;
        if (typeof window.confirm === 'function' && window.confirm(tr('settings.clearConfirm')) !== true) return;
        setBusy(true);
        try {
          await postJson(`${API}/clear`, { confirm: true });
          await load();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          setBusy(false);
        }
      };

      const fileSize = (bytes) => {
        const value = Number(bytes) || 0;
        if (value < 1024) return `${value} B`;
        if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
        return `${(value / 1024 / 1024).toFixed(1)} MB`;
      };

      const archive = stats?.archive ?? null;

      const quarantineNodes = (() => {
        const groups = new Map();
        for (const row of entries) {
          const key = typeof row.sessionId === 'string' && row.sessionId !== '' ? row.sessionId : '—';
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(row);
        }
        const nodes = [];
        let shown = 0;
        for (const [key, rows] of groups) {
          if (shown >= 12) break;
          nodes.push(h('div', {
            key: `session-${key}`,
            style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', margin: '4px 0 1px' },
          }, `${tr('settings.quarantineSession')} ${String(key).slice(0, 12)} · ${rows.length}`));
          for (const row of rows) {
            if (shown >= 12) break;
            shown += 1;
            const full = String(row.displayPath || row.path || '—');
            const cut = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'));
            const base = full.slice(cut + 1) || full;
            nodes.push(h('div', {
              key: `${row.blob}-${shown}`,
              style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 },
            },
            h('span', {
              title: full,
              style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, base),
            h('span', {
              style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary)' },
            }, fileSize(row.size)),
            h('button', {
              type: 'button',
              onClick: () => { void restoreQuarantine(row); },
              disabled: busy,
              style: {
                flex: '0 0 auto',
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--dsw-alias-brand-primary)',
                fontSize: 11,
                padding: '1px 8px',
                cursor: 'pointer',
                fontFamily: 'inherit',
              },
            }, tr('settings.restore')),
            h('button', {
              type: 'button',
              onClick: () => { void discardOne(row.blob); },
              disabled: busy,
              style: {
                flex: '0 0 auto',
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                fontSize: 11,
                padding: '1px 8px',
                cursor: 'pointer',
                fontFamily: 'inherit',
              },
            }, tr('settings.discard'))));
          }
        }
        if (shown < entries.length) {
          nodes.push(h('div', {
            key: 'more',
            style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
          }, tr('settings.quarantineMore', { count: entries.length - shown })));
        }
        return nodes;
      })();
      const cell = (label, value) => h('div', {
        style: {
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 8,
          padding: '10px 12px',
          background: 'var(--dsw-alias-bg-layer-1)',
        },
      },
      h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, label),
      h('div', { style: { fontSize: 18, fontWeight: 600, marginTop: 2 } }, String(value)));

      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720, padding: '4px 0' },
      },
      h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 } }, tr('settings.intro')),
      h('div', {
        style: {
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 10,
          padding: 14,
          background: 'var(--dsw-alias-bg-layer-1)',
        },
      },
      h('div', { style: { fontWeight: 600, marginBottom: 10 } }, tr('settings.snapshots')),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 } },
        cell(tr('settings.turns'), archive?.turns ?? 0),
        cell(tr('settings.files'), archive?.files ?? 0),
        cell(tr('settings.size'), fileSize(archive?.bytes)),
        cell(tr('settings.quarantine'), archive?.quarantine?.entries ?? 0)),
      h('div', {
        style: {
          marginTop: 10,
          fontSize: 12,
          color: 'var(--dsw-alias-label-secondary)',
          wordBreak: 'break-all',
        },
      }, `${tr('settings.directory')}：${stats?.dataDir ?? '—'}`),
      stats?.archive?.integrity === undefined ? null : h('div', {
        style: {
          marginTop: 6,
          fontSize: 12,
          color: stats.archive.integrity.ok === true
            ? 'var(--dsw-alias-label-secondary)'
            : 'var(--dsw-alias-state-warn-primary)',
        },
      }, stats.archive.integrity.ok === true
        ? tr('settings.integrityOk')
        : tr('settings.integrityIssues', {
          count: (stats.archive.integrity.missingBlobs ?? 0)
            + (stats.archive.integrity.orphanBlobs ?? 0)
            + (stats.archive.integrity.quarantineMissing ?? 0)
            + (stats.archive.integrity.corruptManifestLines ?? 0),
        })),
      h('div', { style: { marginTop: 12, display: 'flex', gap: 8 } },
        h('button', { type: 'button', onClick: () => { void load(); }, style: buttonStyle(false) }, tr('settings.refresh')),
        h('button', {
          type: 'button',
          onClick: () => { void clear(); },
          disabled: busy || (archive?.turns ?? 0) === 0,
          style: { ...buttonStyle(false), ...(busy || (archive?.turns ?? 0) === 0 ? { opacity: 0.5 } : {}) },
        }, tr('settings.clear')),
        h('button', {
          type: 'button',
          onClick: () => { void clearQuarantine(); },
          disabled: busy || (archive?.quarantine?.entries ?? 0) === 0,
          style: { ...buttonStyle(false), ...(busy || (archive?.quarantine?.entries ?? 0) === 0 ? { opacity: 0.5 } : {}) },
        }, tr('settings.clearQuarantine')))),
      h('div', {
        style: {
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 10,
          padding: 14,
          background: 'var(--dsw-alias-bg-layer-1)',
        },
      },
      h('div', { style: { fontWeight: 600, marginBottom: 8 } }, tr('settings.quarantine')),
      entries.length === 0
        ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, tr('settings.quarantineEmpty'))
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, quarantineNodes)),
      error !== ''
        ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } }, error)
        : null,
      h('div', {
        style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.7 },
      }, tr('settings.quarantineHint')),
      h('div', {
        style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.7 },
      }, tr('settings.limits', {
        file: stats?.limits === undefined ? '2 MiB' : fileSize(stats.limits.maxFileBytes),
        files: stats?.limits?.maxFilesPerTurn ?? 200,
        turns: stats?.limits?.maxTurns ?? 500,
      })),
      h('div', {
        style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.7 },
      }, tr('settings.limitsSource')));
    }

    let translate = localMessage;

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.inject(['locale'], (scope) => {
            scope.effect(() => scope.locale.register(NS, { zh, en }), 'dsh-rewind: dictionaries');
            const bound = scope.locale.bind(NS);
            if (typeof bound === 'function') translate = bound;
          });
        } catch { /* bundled dictionaries remain in charge */ }

        ensureObserver();
        ensurePolling();
        try {
          ctx.effect(() => () => { disposeObserver(); disposePolling(); }, 'dsh-rewind: transcript hider');
        } catch { /* no effect scope */ }

        const component = (props) => h(RewindController, { ...props, ctx, tr: translate });
        try {
          ctx.slots.inject(SLOT, () => ctx.slots.register({
            name: SLOT,
            id: 'dsh-rewind',
            order: 40,
            label: translate('action.rewind'),
            inject: () => ({ tr: translate }),
          }, component));
        } catch (error) {
          try { console.warn('[dsh-rewind] slot registration failed', error); } catch { /* console unavailable */ }
        }

        try {
          const settings = (props) => h(SettingsSection, { ...props, tr: translate });
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-rewind',
            order: 80,
            label: () => translate('meta.title'),
            inject: () => ({ tr: translate }),
          }, settings));
        } catch (error) {
          try { console.warn('[dsh-rewind] settings registration failed', error); } catch { /* console unavailable */ }
        }
      },
    };
  },
});
