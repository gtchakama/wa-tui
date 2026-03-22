const blessed = require('neo-blessed');
const qrcode = require('qrcode-terminal');
const { MessageAck } = require('whatsapp-web.js');
const state = require('./state');
const waService = require('../whatsapp/service');
const { formatTimestamp, truncate, chatIdsMatch } = require('../utils/format');
const { augmentDisplayPlain } = require('../utils/messageFormat');
const { paginate } = require('../utils/pager');
const { playIncomingMessageSound } = require('../utils/notifySound');
const { notifyDesktop } = require('../utils/notifyDesktop');
const { loadSettings, saveSettings } = require('../config/userSettings');
const {
  PALETTES,
  PALETTE_ORDER,
  buildTheme,
  normalizePaletteId
} = require('../config/palettes');

/**
 * Theme colours (mutable). Loaded from ~/.wa-tui/settings.json — change via F2 Settings.
 * Terminal font is still chosen in the emulator, not here.
 */
const theme = Object.assign(
  {},
  buildTheme(normalizePaletteId(loadSettings().palette))
);

const screen = blessed.screen({
  smartCSR: true,
  fullUnicode: true,
  forceUnicode: true,
  title: 'wa-tui',
  // neo-blessed only applies cursor styling if `shape` is set (see screen.enter).
  cursor: {
    shape: 'block',
    blink: true,
    color: theme.accent
  },
  style: {
    fg: theme.fg
  }
});

const layout = {
  header: null,
  main: null,
  footer: null,
  chatBrowser: null,
  chatListPane: null,
  chatListMeta: null,
  chatList: null,
  chatPreviewPane: null,
  chatPreviewMeta: null,
  chatPreviewBody: null,
  chatMetaPane: null,
  chatMetaBody: null,
  chatDetail: null,
  chatDetailMain: null,
  chatDetailSide: null,
  chatDetailSideBody: null,
  replyBar: null,
  typingBar: null,
  settingsList: null,
  settingsRoot: null,
  settingsListPane: null,
  settingsPreviewPane: null,
  settingsPreviewBody: null,
  qrRoot: null,
  qrStepsPane: null,
  qrStepsBody: null,
  qrPane: null,
  qrPaneBody: null,
  qrBox: null
};

let bootLoaderInterval = null;
let currentChatPageItems = [];
let chatPreviewToken = 0;
let settingsPreviewPaletteId = normalizePaletteId(loadSettings().palette);
const CHAT_LIST_ITEM_LINES = 2;

/** xterm-style window resize CSI (opt-in: WA_TUI_RESIZE=1). */
function tryResizeTerminal(rows, cols) {
  if (process.env.WA_TUI_RESIZE !== '1' || !process.stdout.isTTY) return;
  process.stdout.write(`\x1b[8;${rows};${cols}t`);
}

/** Usable rows between 1-line header (top 0) and 1-line footer. */
function innerRows() {
  return Math.max(6, (screen.height || 24) - 2);
}

function makePane(parent, label, options = {}) {
  const transparent = options.transparent !== false;
  const pane = blessed.box({
    parent,
    top: 0,
    left: 0,
    width: 10,
    height: 10,
    border: 'line',
    label: ` ${label} `,
    tags: true,
    transparent,
    style: {
      fg: theme.fg,
      border: { fg: theme.fgDim },
      label: { fg: theme.fgDim }
    }
  });

  const inner = blessed.box({
    parent: pane,
    top: 1,
    left: 1,
    width: Math.max(2, pane.width - 2),
    height: Math.max(2, pane.height - 2),
    tags: true,
    transparent,
    style: { fg: theme.fg }
  });

  pane._inner = inner;
  return pane;
}

function setPaneActive(pane, active) {
  if (!pane || !pane.style) return;
  if (!pane.style.border) pane.style.border = {};
  if (!pane.style.label) pane.style.label = {};
  pane.style.border.fg = active ? theme.accent : theme.fgDim;
  pane.style.label.fg = active ? theme.accent : theme.fgDim;
}

function resizePaneInner(pane) {
  if (!pane || !pane._inner) return;
  pane._inner.top = 1;
  pane._inner.left = 1;
  pane._inner.width = Math.max(2, pane.width - 2);
  pane._inner.height = Math.max(2, pane.height - 2);
}

function layoutMainPanel(phase) {
  if (!layout.main) return;
  const inner = innerRows();
  layout.main.top = 1;
  layout.main.left = phase === 'loading' ? 'center' : 'center';
  if (phase === 'qr') {
    layout.main.width = '96%';
    layout.main.height = inner;
  } else if (phase === 'loading') {
    layout.main.width = '74%';
    const h = Math.max(12, Math.min(17, Math.floor(inner * 0.48)));
    layout.main.height = h;
  }
}

function stopBootLoader() {
  if (bootLoaderInterval) {
    clearInterval(bootLoaderInterval);
    bootLoaderInterval = null;
  }
}

function bootLoaderFrame(n) {
  const spin = [' ◐ ', ' ◓ ', ' ◑ ', ' ◒ '];
  const s = spin[n % spin.length];
  const A = theme.accent.slice(1);
  const D = theme.fgDim.slice(1);
  const L = theme.fg.slice(1);
  return (
    `{#${A}-fg}    ╭──────────────────────────╮{/}\n` +
    `{#${A}-fg}    │{/}    {#${L}-fg}╦ ╦┌─┐┬┌┬┐┬ ┬{/}       {#${A}-fg}│{/}\n` +
    `{#${A}-fg}    │{/}    {#${L}-fg}║║║├─┤│ │ ├─┤{/}       {#${A}-fg}│{/}\n` +
    `{#${A}-fg}    │{/}    {#${L}-fg}╚╩╝┴ ┴┴ ┴ ┴ ┴{/}       {#${A}-fg}│{/}\n` +
    `{#${A}-fg}    ╰──────────────────────────╯{/}\n` +
    `\n` +
    `      {#${A}-fg}${s}{/}{#${D}-fg} session handshake  ${s}{/}\n` +
    `      {#${D}-fg}· · ·  connecting to WhatsApp Web  · · ·{/}`
  );
}

function startBootLoader() {
  stopBootLoader();
  let n = 0;
  bootLoaderInterval = setInterval(() => {
    if (!layout.main || state.screen === 'qr' || state.screen === 'chats') return;
    layout.main.setContent(bootLoaderFrame(n));
    n++;
    screen.render();
  }, 160);
}

const LIVE_MSG_ID_CAP = 2000;
const seenLiveMessageIds = new Set();

/** Debounced outgoing typing indicator to WhatsApp peers */
let outgoingTypingTimer = null;
let peerTypingHideTimer = null;

const OUTGOING_TYPING_DEBOUNCE_MS = 480;

const liveLineDedupTtlMs = 6000;
const liveLineFingerprints = new Map();

function rememberLiveMessageId(id) {
  if (!id) return;
  if (seenLiveMessageIds.size >= LIVE_MSG_ID_CAP) {
    const oldest = seenLiveMessageIds.values().next().value;
    seenLiveMessageIds.delete(oldest);
  }
  seenLiveMessageIds.add(id);
}

function clearLiveDedup() {
  seenLiveMessageIds.clear();
  liveLineFingerprints.clear();
}

function isDuplicateLiveLine(payload) {
  const body =
    (payload.displayBody != null && String(payload.displayBody).trim()) ||
    (payload.body != null ? String(payload.body).trim() : '');
  const ts = Number(payload.timestamp) || 0;
  const fp = `${payload.fromMe ? '1' : '0'}|${ts}|${body}`;
  const now = Date.now();
  for (const [key, exp] of liveLineFingerprints) {
    if (exp < now) liveLineFingerprints.delete(key);
  }
  if (liveLineFingerprints.has(fp)) return true;
  liveLineFingerprints.set(fp, now + liveLineDedupTtlMs);
  if (liveLineFingerprints.size > 120) {
    const first = liveLineFingerprints.keys().next().value;
    liveLineFingerprints.delete(first);
  }
  return false;
}

function scheduleOutgoingTypingPulse() {
  if (state.screen !== 'chatDetail' || !state.currentChatId) return;
  clearTimeout(outgoingTypingTimer);
  outgoingTypingTimer = setTimeout(() => {
    outgoingTypingTimer = null;
    void waService.pulseOutgoingTyping(state.currentChatId, state.currentRawChat);
  }, OUTGOING_TYPING_DEBOUNCE_MS);
}

function clearOutgoingTypingSchedule() {
  clearTimeout(outgoingTypingTimer);
  outgoingTypingTimer = null;
}

async function stopOutgoingTypingOnLeave() {
  clearOutgoingTypingSchedule();
  const id = state.currentChatId;
  const raw = state.currentRawChat;
  if (id) await waService.clearOutgoingTyping(id, raw);
}

function peerTypingLabel() {
  if (state.peerTypingState === 'recording') return 'recording audio…';
  if (state.peerTypingState === 'typing') return 'typing…';
  return '';
}

function updatePeerTypingBar() {
  if (!layout.typingBar) return;
  const label = peerTypingLabel();
  if (!label) {
    layout.typingBar.setContent('');
  } else {
    const D = theme.fgDim.slice(1);
    layout.typingBar.setContent(`{#${D}-fg}● ${label}{/#${D}-fg}`);
  }
  applyChatDetailLayout();
  renderChatDetailMeta();
  screen.render();
}

function refreshPeerTypingTimeout() {
  clearTimeout(peerTypingHideTimer);
  if (!state.peerTypingState) return;
  peerTypingHideTimer = setTimeout(() => {
    peerTypingHideTimer = null;
    state.peerTypingState = null;
    updatePeerTypingBar();
  }, 6500);
}

function clearPeerTypingState() {
  clearTimeout(peerTypingHideTimer);
  peerTypingHideTimer = null;
  state.peerTypingState = null;
  if (layout.typingBar) layout.typingBar.setContent('');
  applyChatDetailLayout();
  renderChatDetailMeta();
  screen.render();
}

function ackSuffix(ack) {
  if (ack === undefined || ack === null) return '';
  if (ack === MessageAck.ACK_ERROR) {
    const er = theme.error.slice(1);
    return ` {#${er}-fg}⚠{/}`;
  }
  if (ack === MessageAck.ACK_READ || ack === MessageAck.ACK_PLAYED) {
    const a = theme.accent.slice(1);
    return ` {#${a}-fg}✓✓{/}`;
  }
  if (ack === MessageAck.ACK_DEVICE) {
    const d = theme.fgDim.slice(1);
    return ` {#${d}-fg}✓✓{/}`;
  }
  if (ack === MessageAck.ACK_SERVER) {
    const d = theme.fgDim.slice(1);
    return ` {#${d}-fg}✓{/}`;
  }
  const d = theme.fgDim.slice(1);
  return ` {#${d}-fg}…{/}`;
}

function appendMsgListLine(payload) {
  const { fromMe, author, timestamp, id } = payload;
  if (!layout.msgList) return;
  const row = {
    type: payload.type || 'chat',
    hasMedia: Boolean(payload.hasMedia),
    hasQuotedMsg: Boolean(payload.hasQuotedMsg),
    quotedSnippet: payload.quotedSnippet || '',
    body: payload.body,
    localPath: (id && state.mediaPaths[id]) || payload.localPath
  };
  const nameColor = fromMe ? theme.selfMsg : theme.peerMsg;
  const name = fromMe
    ? `{bold}{${nameColor}-fg}You{/${nameColor}-fg}{/bold}`
    : `{bold}{${nameColor}-fg}${author}{/${nameColor}-fg}{/bold}`;
  const time = formatTimestamp(timestamp);
  const text = augmentDisplayPlain(row).replace(/\{/g, '(');
  const ack = fromMe ? ackSuffix(payload.ack) : '';
  layout.msgList.add(`[${time}] ${name}: ${text}${ack}`);
  try {
    layout.msgList.scrollTo(layout.msgList.getScrollHeight());
  } catch (_) {}
  screen.render();
}

function createHeader() {
  layout.header = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: '{bold} wa-tui {/bold}',
    tags: true,
    transparent: true,
    style: {
      fg: theme.accent
    },
    padding: { left: 0 }
  });
  screen.append(layout.header);
}

function syncScreenTheme() {
  // Screen is a Node, not an Element — neo-blessed may not define `style` until we set it.
  if (!screen.style) screen.style = {};
  delete screen.style.bg;
  screen.style.fg = theme.fg;
  if (screen.cursor) screen.cursor.color = theme.accent;
  if (typeof screen.cursorColor === 'function') {
    try {
      screen.cursorColor(theme.accent);
    } catch (_) {}
  }
  if (typeof screen.cursorShape === 'function') {
    try {
      screen.cursorShape('block', true);
    } catch (_) {}
  }
}

function refreshWidgetStyles() {
  if (layout.header) {
    layout.header.style.fg = theme.accent;
    delete layout.header.style.bg;
  }
  if (layout.footer) {
    layout.footer.style.fg = theme.fgDim;
    delete layout.footer.style.bg;
  }
  if (layout.main) {
    layout.main.style.fg = theme.fg;
    delete layout.main.style.bg;
  }
  if (layout.chatList) {
    layout.chatList.style.fg = theme.fg;
    delete layout.chatList.style.bg;
    if (layout.chatList.style.selected) {
      layout.chatList.style.selected.fg = theme.accent;
      layout.chatList.style.selected.bold = true;
      layout.chatList.style.selected.underline = true;
      delete layout.chatList.style.selected.bg;
    }
    if (layout.chatList.style.scrollbar) {
      layout.chatList.style.scrollbar.fg = theme.fgDim;
      delete layout.chatList.style.scrollbar.bg;
    }
    if (layout.chatList.style.track) delete layout.chatList.style.track.bg;
  }
  if (layout.chatDetail) {
    layout.chatDetail.style.fg = theme.fg;
    delete layout.chatDetail.style.bg;
  }
  if (layout.msgList) {
    layout.msgList.style.fg = theme.fg;
    delete layout.msgList.style.bg;
  }
  if (layout.input) {
    layout.input.style.fg = theme.fg;
    delete layout.input.style.bg;
  }
  if (layout.replyBar) {
    layout.replyBar.style.fg = theme.fgDim;
    delete layout.replyBar.style.bg;
  }
  if (layout.typingBar) {
    layout.typingBar.style.fg = theme.fgDim;
    delete layout.typingBar.style.bg;
  }
  if (layout.settingsList) {
    layout.settingsList.style.fg = theme.fg;
    delete layout.settingsList.style.bg;
    if (layout.settingsList.style.selected) {
      layout.settingsList.style.selected.fg = theme.accent;
      layout.settingsList.style.selected.bold = true;
      layout.settingsList.style.selected.underline = true;
      delete layout.settingsList.style.selected.bg;
    }
    if (layout.settingsList.style.scrollbar) {
      layout.settingsList.style.scrollbar.fg = theme.fgDim;
      delete layout.settingsList.style.scrollbar.bg;
    }
    if (layout.settingsList.style.track) delete layout.settingsList.style.track.bg;
  }

  [
    layout.chatListPane,
    layout.chatPreviewPane,
    layout.chatMetaPane,
    layout.chatDetailMain,
    layout.chatDetailSide,
    layout.settingsListPane,
    layout.settingsPreviewPane,
    layout.qrStepsPane,
    layout.qrPane
  ].forEach((pane) => {
    if (!pane) return;
    pane.style.fg = theme.fg;
    if (!pane.style.border) pane.style.border = {};
    if (!pane.style.label) pane.style.label = {};
  });

  if (layout.chatListMeta) {
    layout.chatListMeta.style.fg = theme.fgDim;
    delete layout.chatListMeta.style.bg;
  }
  if (layout.chatPreviewMeta) {
    layout.chatPreviewMeta.style.fg = theme.fgDim;
    delete layout.chatPreviewMeta.style.bg;
  }
  if (layout.chatPreviewBody) {
    layout.chatPreviewBody.style.fg = theme.fg;
    delete layout.chatPreviewBody.style.bg;
  }
  if (layout.chatMetaBody) {
    layout.chatMetaBody.style.fg = theme.fg;
    delete layout.chatMetaBody.style.bg;
  }
  if (layout.chatDetailSideBody) {
    layout.chatDetailSideBody.style.fg = theme.fg;
    delete layout.chatDetailSideBody.style.bg;
  }
  if (layout.settingsPreviewBody) {
    layout.settingsPreviewBody.style.fg = theme.fg;
    delete layout.settingsPreviewBody.style.bg;
  }
  if (layout.qrStepsBody) {
    layout.qrStepsBody.style.fg = theme.fg;
    delete layout.qrStepsBody.style.bg;
  }
  if (layout.qrPaneBody) {
    layout.qrPaneBody.style.fg = theme.fg;
    delete layout.qrPaneBody.style.bg;
  }
}

function applyPalette(paletteId) {
  const id = normalizePaletteId(paletteId);
  Object.assign(theme, buildTheme(id));
  saveSettings({ palette: id });
  syncScreenTheme();
  refreshWidgetStyles();
  if (state.screen === 'chats') {
    setPaneActive(layout.chatListPane, true);
    setPaneActive(layout.chatPreviewPane, false);
    setPaneActive(layout.chatMetaPane, false);
  } else if (state.screen === 'chatDetail') {
    setPaneActive(layout.chatDetailMain, true);
    setPaneActive(layout.chatDetailSide, false);
    redrawChatMessages();
    updatePeerTypingBar();
  } else if (state.screen === 'settings') {
    setPaneActive(layout.settingsListPane, true);
    setPaneActive(layout.settingsPreviewPane, false);
    renderSettingsPreview(id);
    syncSettingsItems();
  }
}

function createFooter() {
  layout.footer = blessed.box({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: '',
    transparent: true,
    style: {
      fg: theme.fgDim
    }
  });
  screen.append(layout.footer);
  updateFooter();
}

function updateFooter() {
  if (!layout.footer) return;
  let line;
  if (state.screen === 'settings') {
    line =
      ' [Enter]: apply palette · [Esc]/[F2]: back · Saved: ~/.wa-tui/settings.json · [Q]: Quit';
  } else if (state.screen === 'chatDetail') {
    line =
      ' [Esc]: clr quote / back · [B]: Back · [Ctrl+↑↓]: Quote · [Ctrl+D]: DL · typing + receipts · [F2]: Colours · [Ctrl+L]: Logout · [Q]: Quit';
  } else if (state.screen === 'chats') {
    line =
      ' [Q]: Quit · [F2]: Colours · ctrl+L Logout · [R]efresh · [U]nread · [N]/[P] · [1-3] filter · [O] sort';
  } else {
    line = ' [Q]: Quit · [Ctrl+L]: Logout';
  }
  layout.footer.setContent(line);
}

async function performLogout() {
  stopBootLoader();
  if (layout.main && !layout.main.hidden) {
    layout.main.setContent(
      `{${theme.fgDim}-fg}Logging out…{/${theme.fgDim}-fg}`
    );
  }
  if (layout.footer) layout.footer.setContent(' Closing session…');
  screen.render();
  await waService.logoutSession();
  process.exit(0);
}

function updateTitle() {
  let modeText = state.screen.toUpperCase();
  if (state.screen === 'chats') {
    const u = state.unreadOnly ? ' · unread' : '';
    const sortLabel =
      state.chatSort === 'unread'
        ? 'unread⬆'
        : state.chatSort === 'alpha'
          ? 'A-Z'
          : 'recent';
    modeText = `CHATS (${state.filter}${u} · ${sortLabel}) - P${state.page}`;
  } else if (state.screen === 'settings') {
    modeText = 'SETTINGS · Colour palette';
  } else if (state.screen === 'chatDetail') {
    modeText = `CHAT: ${state.currentChatName || 'Unknown'}`;
  }
  layout.header.setContent(
    `{bold}{${theme.accent}-fg}wa-tui{/${theme.accent}-fg}{/bold} | ${modeText} | Unread: ${state.unreadCount}`
  );
  updateFooter();
  screen.render();
}

function syncListAndDetailHeights() {
  syncChatBrowserLayout();
  syncChatDetailShell();
  applyChatDetailLayout();
}

function hidePrimaryViews() {
  layout.main?.hide();
  layout.chatBrowser?.hide();
  layout.chatDetail?.hide();
  layout.settingsRoot?.hide();
  layout.qrRoot?.hide();
}

function applyChatDetailLayout() {
  if (!layout.chatDetailMain || !layout.chatDetailMain._inner || !layout.msgList || !layout.input) return;
  const inner = layout.chatDetailMain._inner.height;
  const width = layout.chatDetailMain._inner.width;
  const inputH = layout.input.height || 3;
  const replyH = state.replyTo ? 1 : 0;
  const typingH = state.peerTypingState ? 1 : 0;
  if (layout.typingBar) {
    layout.typingBar.hidden = !state.peerTypingState;
    layout.typingBar.bottom = inputH;
    layout.typingBar.left = 0;
    layout.typingBar.width = width;
    layout.typingBar.height = 1;
  }
  if (layout.replyBar) {
    layout.replyBar.hidden = !state.replyTo;
    layout.replyBar.bottom = inputH + typingH;
    layout.replyBar.left = 0;
    layout.replyBar.width = width;
    layout.replyBar.height = 1;
  }
  layout.input.bottom = 0;
  layout.input.left = 0;
  layout.input.width = width;
  layout.msgList.top = 0;
  layout.msgList.left = 0;
  layout.msgList.width = width;
  layout.msgList.height = Math.max(4, inner - inputH - replyH - typingH);
}

function persistCurrentDraft() {
  if (state.screen !== 'chatDetail' || !state.currentChatId || !layout.input) {
    return;
  }
  const v = layout.input.getValue();
  if (v && String(v).trim()) state.chatDrafts[state.currentChatId] = v;
  else delete state.chatDrafts[state.currentChatId];
}

function clearReplyTarget() {
  state.replyTo = null;
  state.replyPickIndex = null;
}

function updateReplyBarContent() {
  if (!layout.replyBar) return;
  if (!state.replyTo) {
    layout.replyBar.setContent('');
    return;
  }
  const sn = state.replyTo.snippet || '';
  const A = theme.accent.slice(1);
  const D = theme.fgDim.slice(1);
  layout.replyBar.setContent(
    `{#${A}-fg}↪{/} ${state.replyTo.author}: ${sn.replace(/\{/g, '(')}  {#${D}-fg}Esc clear · Ctrl+↑↓{/}`
  );
}

function rowsWithPaths() {
  return state.currentMessages.map((m) => ({
    ...m,
    localPath: state.mediaPaths[m.id] || m.localPath
  }));
}

function redrawChatMessages() {
  if (!layout.msgList) return;
  if (!state.currentMessages.length) return;
  const A = theme.accent.slice(1);
  const rows = rowsWithPaths();
  const content = rows
    .map((m) => {
      const nc = (m.fromMe ? theme.selfMsg : theme.peerMsg).slice(1);
      const name = m.fromMe
        ? `{bold}{#${nc}-fg}You{/#${nc}-fg}{/bold}`
        : `{bold}{#${nc}-fg}${m.author}{/#${nc}-fg}{/bold}`;
      const time = formatTimestamp(m.timestamp);
      const mark =
        state.replyTo && m.id === state.replyTo.id
          ? `{#${A}-fg}▶ {/#${A}-fg}`
          : '';
      const plain = augmentDisplayPlain(m).replace(/\{/g, '(');
      const ack = m.fromMe ? ackSuffix(m.ack) : '';
      return `[${time}] ${mark}${name}: ${plain}${ack}`;
    })
    .join('\n');
  layout.msgList.setContent(content);
}

function finishReplyUi() {
  updateReplyBarContent();
  renderChatDetailMeta();
  applyChatDetailLayout();
  redrawChatMessages();
  screen.render();
}

/** newer = +1 (Ctrl+↑), older = -1 (Ctrl+↓) */
function adjustReplyPick(delta) {
  if (state.screen !== 'chatDetail') return;
  const msgs = state.currentMessages;
  if (!msgs.length) return;
  let idx = state.replyPickIndex;

  if (idx == null) {
    if (delta > 0) return;
    idx = msgs.length - 1;
  } else {
    idx += delta;
    if (idx >= msgs.length) {
      clearReplyTarget();
      updateReplyBarContent();
      applyChatDetailLayout();
      redrawChatMessages();
      screen.render();
      return;
    }
    if (idx < 0) idx = 0;
  }

  state.replyPickIndex = idx;
  const m = msgs[idx];
  state.replyTo = {
    id: m.id,
    author: m.author,
    snippet: String(m.displayBody || m.body || '')
      .replace(/\{/g, '(')
      .slice(0, 48)
  };
  finishReplyUi();
}

function applyChatSort(chats) {
  const out = [...chats];
  const byListIndex = (a, b) => (a.listIndex || 0) - (b.listIndex || 0);

  out.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) return byListIndex(a, b);

    if (state.chatSort === 'unread') {
      const du = (b.unreadCount || 0) - (a.unreadCount || 0);
      if (du !== 0) return du;
      const dt = (b.timestamp || 0) - (a.timestamp || 0);
      if (dt !== 0) return dt;
      return byListIndex(a, b);
    }

    if (state.chatSort === 'alpha') {
      const dn = (a.name || '').localeCompare(b.name || '', undefined, {
        sensitivity: 'base'
      });
      if (dn !== 0) return dn;
    }

    return byListIndex(a, b);
  });
  return out;
}

async function downloadHighlightedMedia() {
  if (state.screen !== 'chatDetail') return;
  let targetId = state.replyTo?.id;
  if (targetId) {
    const sel = state.currentMessages.find((m) => m.id === targetId);
    if (sel && !sel.hasMedia) targetId = null;
  }
  if (!targetId) {
    const withMedia = [...state.currentMessages].reverse().find((m) => m.hasMedia);
    targetId = withMedia?.id;
  }
  if (!targetId) {
    const er = theme.error.slice(1);
    layout.msgList.add(
      `{#${er}-fg}No media to download — Ctrl+↓ to pick a message.{/#${er}-fg}`
    );
    screen.render();
    return;
  }
  try {
    const fpath = await waService.downloadMessageMedia(
      targetId,
      state.currentChatId,
      state.currentRawChat
    );
    state.mediaPaths[targetId] = fpath;
    redrawChatMessages();
    const d = theme.fgDim.slice(1);
    layout.msgList.add(`{#${d}-fg}Saved: ${fpath.replace(/\{/g, '(')}{/#${d}-fg}`);
  } catch (e) {
    const er = theme.error.slice(1);
    layout.msgList.add(`{#${er}-fg}Download failed: ${e.message}{/#${er}-fg}`);
  }
  screen.render();
}

function init() {
  state.screen = 'loading';
  tryResizeTerminal(22, 100);

  createHeader();
  createFooter();

  layout.main = blessed.box({
    top: 1,
    left: 'center',
    width: '74%',
    height: 12,
    content: bootLoaderFrame(0),
    align: 'center',
    valign: 'middle',
    scrollable: true,
    alwaysScroll: true,
    tags: true,
    transparent: true,
    style: {
      fg: theme.fg
    }
  });
  screen.append(layout.main);
  layoutMainPanel('loading');
  startBootLoader();

  screen.key(['q', 'C-c'], () => {
    return process.exit(0);
  });

  screen.on('resize', () => {
    if (state.screen === 'loading') layoutMainPanel('loading');
    if (state.screen === 'chats') {
      showChats(state.chats);
      return;
    }
    syncListAndDetailHeights();
    syncSettingsListGeometry();
    syncQrLayout();
    screen.render();
  });

  syncScreenTheme();
  refreshWidgetStyles();
  screen.render();
}

function chatBrowserGeometry() {
  const totalWidth = screen.width || 100;
  const totalHeight = innerRows();
  const rightWidth = Math.max(28, Math.floor(totalWidth * 0.24));
  const leftWidth = Math.max(30, Math.floor(totalWidth * 0.31));
  const gap = 1;
  const centerWidth = Math.max(
    32,
    totalWidth - leftWidth - rightWidth - gap * 2
  );
  return {
    top: 1,
    leftWidth,
    centerWidth,
    rightWidth,
    gap,
    height: totalHeight
  };
}

function detailGeometry() {
  const {
    top,
    leftWidth,
    centerWidth,
    rightWidth,
    gap,
    height
  } = chatBrowserGeometry();
  return {
    top,
    left: leftWidth + gap,
    mainWidth: centerWidth,
    sideWidth: rightWidth,
    gap,
    height
  };
}

function showChatBrowserColumns(mode = 'browser') {
  if (!layout.chatBrowser) return;
  layout.chatBrowser.show();
  layout.chatListPane?.show();
  if (mode === 'detail') {
    layout.chatPreviewPane?.hide();
    layout.chatMetaPane?.hide();
    return;
  }
  layout.chatPreviewPane?.show();
  layout.chatMetaPane?.show();
}

function formatChatListItems(pageItems) {
  return pageItems.map((c) => {
    const pin = c.pinned
      ? ` {${theme.accent}-fg}[pin]{/${theme.accent}-fg}`
      : '';
    const unread =
      c.unreadCount > 0
        ? ` {${theme.unread}-fg}[${c.unreadCount}]{/${theme.unread}-fg}`
        : '';
    const type = c.isGroup
      ? ` {${theme.fgDim}-fg}[grp]{/${theme.fgDim}-fg}`
      : ` {${theme.fgDim}-fg}[dm]{/${theme.fgDim}-fg}`;
    const time = formatTimestamp(c.timestamp);
    const lastMsg = truncate(c.lastMessage || '—', 56);
    const name = String(c.name || '').replace(/\{/g, '(').replace(/\}/g, ')');
    const displayName = c.unreadCount > 0 ? `{bold}${name}{/bold}` : name;

    return `${displayName}${pin}${unread}${type} {${theme.fgDim}-fg}${time}{/${theme.fgDim}-fg}\n` +
      `  {${theme.fgDim}-fg}${lastMsg.replace(/\{/g, '(').replace(/\}/g, ')')}{/${theme.fgDim}-fg}`;
  });
}

function currentChatPageSize() {
  const visibleRows = Number(layout.chatList?.height) || state.pageSize * CHAT_LIST_ITEM_LINES;
  return Math.max(1, Math.floor(visibleRows / CHAT_LIST_ITEM_LINES));
}

function renderChatPreviewBody(chat, rows, error) {
  if (!layout.chatPreviewBody) return;
  if (!chat) {
    layout.chatPreviewBody.setContent(
      `{${theme.fgDim}-fg}Move through chats to preview the latest messages.{/${theme.fgDim}-fg}`
    );
    return;
  }
  if (error) {
    layout.chatPreviewBody.setContent(
      `{${theme.error}-fg}Preview failed: ${String(error).replace(/\{/g, '(')}{/${theme.error}-fg}`
    );
    return;
  }
  if (!rows) {
    layout.chatPreviewBody.setContent(
      `{${theme.fgDim}-fg}Loading preview…{/${theme.fgDim}-fg}`
    );
    return;
  }
  if (!rows.length) {
    layout.chatPreviewBody.setContent(
      `{${theme.fgDim}-fg}No preview messages available.{/${theme.fgDim}-fg}`
    );
    return;
  }

  const content = rows
    .map((m) => {
      const nameColor = (m.fromMe ? theme.selfMsg : theme.peerMsg).slice(1);
      const who = m.fromMe ? 'You' : m.author;
      const body = augmentDisplayPlain(m).replace(/\{/g, '(');
      return `[${formatTimestamp(m.timestamp)}] {bold}{#${nameColor}-fg}${who}{/#${nameColor}-fg}{/bold}\n` +
        `  ${body}`;
    })
    .join('\n');
  layout.chatPreviewBody.setContent(content);
}

function renderChatMeta(chat) {
  if (!layout.chatMetaBody) return;
  if (!chat) {
    layout.chatMetaBody.setContent(
      `{${theme.fgDim}-fg}No chat selected.{/${theme.fgDim}-fg}`
    );
    return;
  }
  const lines = [
    `{bold}type{/bold}`,
    chat.isGroup ? 'group' : 'direct message',
    '',
    `{bold}pinned{/bold}`,
    chat.pinned ? 'yes' : 'no',
    '',
    `{bold}unread{/bold}`,
    String(chat.unreadCount || 0),
    '',
    `{bold}last activity{/bold}`,
    formatTimestamp(chat.timestamp || 0),
    '',
    `{bold}actions{/bold}`,
    'Enter open chat',
    'click row select/open',
    'R reload list',
    'N/P page',
    '',
    `{${theme.accent}-fg}filters: 1 all · 2 direct · 3 groups · U unread{/}`
  ];
  layout.chatMetaBody.setContent(lines.join('\n'));
}

async function loadChatPreview(chat) {
  const token = ++chatPreviewToken;
  renderChatPreviewBody(chat, null, null);
  try {
    const rows = await waService.getMessages(chat.id, 8, chat.raw);
    if (token !== chatPreviewToken) return;
    renderChatPreviewBody(chat, rows, null);
    screen.render();
  } catch (err) {
    if (token !== chatPreviewToken) return;
    renderChatPreviewBody(chat, null, err.message || String(err));
    screen.render();
  }
}

function syncChatBrowserLayout() {
  if (!layout.chatBrowser) return;
  const { top, leftWidth, centerWidth, rightWidth, gap, height } =
    chatBrowserGeometry();

  layout.chatBrowser.top = top;
  layout.chatBrowser.left = 0;
  layout.chatBrowser.width = screen.width || 100;
  layout.chatBrowser.height = height;

  layout.chatListPane.top = 0;
  layout.chatListPane.left = 0;
  layout.chatListPane.width = leftWidth;
  layout.chatListPane.height = height;
  resizePaneInner(layout.chatListPane);
  layout.chatListMeta.top = 0;
  layout.chatListMeta.left = 0;
  layout.chatListMeta.width = layout.chatListPane._inner.width;
  layout.chatListMeta.height = 2;
  layout.chatList.top = 2;
  layout.chatList.left = 0;
  layout.chatList.width = layout.chatListPane._inner.width;
  layout.chatList.height = Math.max(1, layout.chatListPane._inner.height - 2);

  layout.chatPreviewPane.top = 0;
  layout.chatPreviewPane.left = leftWidth + gap;
  layout.chatPreviewPane.width = centerWidth;
  layout.chatPreviewPane.height = height;
  resizePaneInner(layout.chatPreviewPane);
  layout.chatPreviewMeta.top = 0;
  layout.chatPreviewMeta.left = 0;
  layout.chatPreviewMeta.width = layout.chatPreviewPane._inner.width;
  layout.chatPreviewMeta.height = 2;
  layout.chatPreviewBody.top = 2;
  layout.chatPreviewBody.left = 0;
  layout.chatPreviewBody.width = layout.chatPreviewPane._inner.width;
  layout.chatPreviewBody.height = Math.max(1, layout.chatPreviewPane._inner.height - 2);

  layout.chatMetaPane.top = 0;
  layout.chatMetaPane.left = leftWidth + gap + centerWidth + gap;
  layout.chatMetaPane.width = rightWidth;
  layout.chatMetaPane.height = height;
  resizePaneInner(layout.chatMetaPane);
  layout.chatMetaBody.top = 0;
  layout.chatMetaBody.left = 0;
  layout.chatMetaBody.width = layout.chatMetaPane._inner.width;
  layout.chatMetaBody.height = layout.chatMetaPane._inner.height;
}

function ensureChatBrowserLayout() {
  if (layout.chatBrowser) return;

  layout.chatBrowser = blessed.box({
    top: 1,
    left: 0,
    width: '100%',
    height: innerRows(),
    transparent: true
  });
  screen.append(layout.chatBrowser);

  layout.chatListPane = makePane(layout.chatBrowser, ' chats ');
  layout.chatListMeta = blessed.box({
    parent: layout.chatListPane._inner,
    top: 0,
    left: 0,
    width: 10,
    height: 2,
    tags: true,
    transparent: true,
    style: { fg: theme.fgDim }
  });
  layout.chatList = blessed.list({
    parent: layout.chatListPane._inner,
    top: 2,
    left: 0,
    width: 10,
    height: 10,
    keys: true,
    vi: true,
    mouse: true,
    tags: true,
    invertSelected: false,
    transparent: true,
    scrollbar: {
      ch: '│',
      style: { fg: theme.fgDim }
    },
    style: {
      fg: theme.fg,
      selected: {
        fg: theme.accent,
        bold: true,
        underline: true
      }
    }
  });

  layout.chatPreviewPane = makePane(layout.chatBrowser, ' preview ');
  layout.chatPreviewMeta = blessed.box({
    parent: layout.chatPreviewPane._inner,
    top: 0,
    left: 0,
    width: 10,
    height: 2,
    tags: true,
    transparent: true,
    style: { fg: theme.fgDim }
  });
  layout.chatPreviewBody = blessed.box({
    parent: layout.chatPreviewPane._inner,
    top: 2,
    left: 0,
    width: 10,
    height: 10,
    tags: true,
    mouse: true,
    scrollable: true,
    alwaysScroll: true,
    transparent: true,
    style: { fg: theme.fg }
  });

  layout.chatMetaPane = makePane(layout.chatBrowser, ' meta ');
  layout.chatMetaBody = blessed.box({
    parent: layout.chatMetaPane._inner,
    top: 0,
    left: 0,
    width: 10,
    height: 10,
    tags: true,
    transparent: true,
    style: { fg: theme.fg }
  });

  syncChatBrowserLayout();
}

function renderChatDetailMeta() {
  if (!layout.chatDetailSideBody) return;
  const chat = state.currentRawChat;
  const lines = [
    `{bold}type{/bold}`,
    chat && chat.isGroup ? 'group' : 'direct message',
    '',
    `{bold}chat{/bold}`,
    (state.currentChatName || 'Unknown').replace(/\{/g, '('),
    '',
    `{bold}reply target{/bold}`,
    state.replyTo
      ? `${state.replyTo.author}: ${state.replyTo.snippet}`.replace(/\{/g, '(')
      : 'none',
    '',
    `{bold}your messages{/bold}`,
    '✓ sent · ✓✓ delivered · accent ✓✓ read',
    '',
    `{bold}peer activity{/bold}`,
    state.peerTypingState === 'recording'
      ? 'recording audio…'
      : state.peerTypingState === 'typing'
        ? 'typing…'
        : '—',
    '',
    `{bold}actions{/bold}`,
    'Esc clear quote / back',
    'B back to chats',
    'Ctrl+up/down move quote',
    'Ctrl+D download media',
    '',
    `{${theme.accent}-fg}mouse: click prompt, wheel transcript, click lines{/}`
  ];
  layout.chatDetailSideBody.setContent(lines.join('\n'));
}

function syncChatDetailShell() {
  if (!layout.chatDetail) return;
  const { top, left, mainWidth, sideWidth, gap, height } = detailGeometry();
  layout.chatDetail.top = top;
  layout.chatDetail.left = left;
  layout.chatDetail.width = mainWidth + gap + sideWidth;
  layout.chatDetail.height = height;

  layout.chatDetailMain.top = 0;
  layout.chatDetailMain.left = 0;
  layout.chatDetailMain.width = mainWidth;
  layout.chatDetailMain.height = height;
  resizePaneInner(layout.chatDetailMain);

  layout.chatDetailSide.top = 0;
  layout.chatDetailSide.left = mainWidth + gap;
  layout.chatDetailSide.width = sideWidth;
  layout.chatDetailSide.height = height;
  resizePaneInner(layout.chatDetailSide);
  layout.chatDetailSideBody.top = 0;
  layout.chatDetailSideBody.left = 0;
  layout.chatDetailSideBody.width = layout.chatDetailSide._inner.width;
  layout.chatDetailSideBody.height = layout.chatDetailSide._inner.height;

  applyChatDetailLayout();
}

function ensureChatDetailLayout() {
  if (layout.chatDetail) return;

  layout.chatDetail = blessed.box({
    top: 1,
    left: 0,
    width: '100%',
    height: innerRows(),
    transparent: false,
    style: { fg: theme.fg }
  });

  layout.chatDetailMain = makePane(layout.chatDetail, ' thread ', {
    transparent: false
  });
  layout.chatDetailSide = makePane(layout.chatDetail, ' chat info ', {
    transparent: false
  });
  layout.chatDetailSideBody = blessed.box({
    parent: layout.chatDetailSide._inner,
    top: 0,
    left: 0,
    width: 10,
    height: 10,
    tags: true,
    transparent: false,
    style: { fg: theme.fg }
  });

  layout.msgList = blessed.log({
    parent: layout.chatDetailMain._inner,
    top: 0,
    left: 0,
    width: 10,
    height: 10,
    mouse: true,
    scrollable: true,
    alwaysScroll: true,
    tags: true,
    padding: { left: 0, right: 0 },
    transparent: false,
    style: { fg: theme.fg }
  });

  layout.replyBar = blessed.box({
    parent: layout.chatDetailMain._inner,
    bottom: 3,
    left: 0,
    width: 10,
    height: 1,
    hidden: true,
    tags: true,
    transparent: false,
    style: { fg: theme.fgDim }
  });

  layout.typingBar = blessed.box({
    parent: layout.chatDetailMain._inner,
    bottom: 3,
    left: 0,
    width: 10,
    height: 1,
    hidden: true,
    tags: true,
    transparent: false,
    style: { fg: theme.fgDim }
  });

  layout.input = blessed.textbox({
    parent: layout.chatDetailMain._inner,
    bottom: 0,
    left: 0,
    width: 10,
    height: 3,
    keys: true,
    mouse: true,
    inputOnFocus: true,
    transparent: false,
    style: { fg: theme.fg }
  });

  layout.input.on('keypress', () => scheduleOutgoingTypingPulse());

  layout.input.on('submit', async (text) => {
    if (!text.trim()) return;
    try {
      clearOutgoingTypingSchedule();
      await waService.clearOutgoingTyping(state.currentChatId, state.currentRawChat);
      const sendOpts = state.replyTo
        ? { quotedMessageId: state.replyTo.id }
        : {};
      await waService.sendMessage(
        state.currentChatId,
        text.trim(),
        state.currentRawChat,
        sendOpts
      );
      layout.input.clearValue();
      delete state.chatDrafts[state.currentChatId];
      clearReplyTarget();
      updateReplyBarContent();
      renderChatDetailMeta();
      layout.input.focus();
      screen.render();
    } catch (e) {
      const er = theme.error.slice(1);
      layout.msgList.add(`{#${er}-fg}Failed to send: ${e.message}{/#${er}-fg}`);
      screen.render();
    }
  });

  screen.append(layout.chatDetail);
  syncChatDetailShell();
}

function qrGeometry() {
  const totalWidth = screen.width || 100;
  const totalHeight = innerRows();
  const leftWidth = Math.max(30, Math.floor(totalWidth * 0.30));
  const gap = 1;
  const rightWidth = Math.max(40, totalWidth - leftWidth - gap);
  return { top: 1, height: totalHeight, leftWidth, rightWidth, gap };
}

function syncQrLayout() {
  if (!layout.qrRoot) return;
  const { top, height, leftWidth, rightWidth, gap } = qrGeometry();
  layout.qrRoot.top = top;
  layout.qrRoot.left = 0;
  layout.qrRoot.width = screen.width || 100;
  layout.qrRoot.height = height;

  layout.qrStepsPane.top = 0;
  layout.qrStepsPane.left = 0;
  layout.qrStepsPane.width = leftWidth;
  layout.qrStepsPane.height = height;
  resizePaneInner(layout.qrStepsPane);
  layout.qrStepsBody.top = 0;
  layout.qrStepsBody.left = 0;
  layout.qrStepsBody.width = layout.qrStepsPane._inner.width;
  layout.qrStepsBody.height = layout.qrStepsPane._inner.height;

  layout.qrPane.top = 0;
  layout.qrPane.left = leftWidth + gap;
  layout.qrPane.width = rightWidth;
  layout.qrPane.height = height;
  resizePaneInner(layout.qrPane);
  layout.qrPaneBody.top = 0;
  layout.qrPaneBody.left = 0;
  layout.qrPaneBody.width = layout.qrPane._inner.width;
  layout.qrPaneBody.height = layout.qrPane._inner.height;
  if (layout.qrBox) {
    layout.qrBox.top = Math.max(1, Math.floor((layout.qrPaneBody.height - layout.qrBox.height) / 2));
    layout.qrBox.left = Math.max(1, Math.floor((layout.qrPaneBody.width - layout.qrBox.width) / 2));
  }
}

function ensureQrLayout() {
  if (layout.qrRoot) return;
  layout.qrRoot = blessed.box({
    top: 1,
    left: 0,
    width: '100%',
    height: innerRows(),
    transparent: true
  });
  screen.append(layout.qrRoot);

  layout.qrStepsPane = makePane(layout.qrRoot, ' link_steps ');
  layout.qrStepsBody = blessed.box({
    parent: layout.qrStepsPane._inner,
    top: 0,
    left: 0,
    width: 10,
    height: 10,
    tags: true,
    transparent: true,
    style: { fg: theme.fg }
  });

  layout.qrPane = makePane(layout.qrRoot, ' scan_with_whatsapp ');
  layout.qrPaneBody = blessed.box({
    parent: layout.qrPane._inner,
    top: 0,
    left: 0,
    width: 10,
    height: 10,
    tags: true,
    transparent: true,
    align: 'center',
    valign: 'middle',
    style: { fg: theme.fg }
  });

  layout.qrBox = blessed.box({
    parent: layout.qrPaneBody,
    top: 0,
    left: 0,
    width: 42,
    height: 18,
    border: 'line',
    tags: true,
    align: 'center',
    valign: 'middle',
    transparent: true,
    style: {
      fg: theme.fg,
      border: { fg: theme.fgDim }
    }
  });

  syncQrLayout();
}

function settingsGeometry() {
  const totalWidth = screen.width || 100;
  const totalHeight = innerRows();
  const leftWidth = Math.max(34, Math.floor(totalWidth * 0.32));
  const gap = 1;
  const rightWidth = Math.max(40, totalWidth - leftWidth - gap);
  return { top: 1, height: totalHeight, leftWidth, rightWidth, gap };
}

function renderSettingsPreview(paletteId) {
  if (!layout.settingsPreviewBody) return;
  const p = buildTheme(normalizePaletteId(paletteId));
  layout.settingsPreviewBody.setContent(
    `{#${p.accent.slice(1)}-fg}{bold}wa-tui{/bold}{/#${p.accent.slice(1)}-fg} | settings preview\n` +
      `{#${p.fgDim.slice(1)}-fg}Unread badge: {/#${p.fgDim.slice(1)}-fg}{#${p.unread.slice(1)}-fg}[4]{/#${p.unread.slice(1)}-fg}\n\n` +
      `[00:17] {#${p.peerMsg.slice(1)}-fg}{bold}Titus{/#${p.peerMsg.slice(1)}-fg}{/bold}: image attached\n` +
      `[00:19] {#${p.selfMsg.slice(1)}-fg}{bold}You{/#${p.selfMsg.slice(1)}-fg}{/bold}: opening thread now\n\n` +
      `{#${p.accent.slice(1)}-fg}> {/#${p.accent.slice(1)}-fg}reply_to_titus_vetech\n` +
      `{#${p.fgDim.slice(1)}-fg}Enter apply palette · Esc back{/}`
  );
}

function syncSettingsItems() {
  if (!layout.settingsList) return;
  layout.settingsList.setItems(
    PALETTE_ORDER.map((id) => {
      const p = PALETTES[id];
      const current =
        theme.paletteId === id
          ? ` {${theme.accent}-fg}* active{/${theme.accent}-fg}`
          : '';
      const preview =
        settingsPreviewPaletteId === id && theme.paletteId !== id
          ? ` {${theme.fgDim}-fg}(preview){/${theme.fgDim}-fg}`
          : '';
      const label = p.label.replace(/\{/g, '(').replace(/\}/g, ')');
      return `${label} {${theme.fgDim}-fg}· ${id}{/${theme.fgDim}-fg}${current}${preview}`;
    })
  );
}

function syncSettingsListGeometry() {
  if (!layout.settingsRoot) return;
  const { top, height, leftWidth, rightWidth, gap } = settingsGeometry();
  layout.settingsRoot.top = top;
  layout.settingsRoot.left = 0;
  layout.settingsRoot.width = screen.width || 100;
  layout.settingsRoot.height = height;

  layout.settingsListPane.top = 0;
  layout.settingsListPane.left = 0;
  layout.settingsListPane.width = leftWidth;
  layout.settingsListPane.height = height;
  resizePaneInner(layout.settingsListPane);
  layout.settingsList.top = 0;
  layout.settingsList.left = 0;
  layout.settingsList.width = layout.settingsListPane._inner.width;
  layout.settingsList.height = layout.settingsListPane._inner.height;

  layout.settingsPreviewPane.top = 0;
  layout.settingsPreviewPane.left = leftWidth + gap;
  layout.settingsPreviewPane.width = rightWidth;
  layout.settingsPreviewPane.height = height;
  resizePaneInner(layout.settingsPreviewPane);
  layout.settingsPreviewBody.top = 0;
  layout.settingsPreviewBody.left = 0;
  layout.settingsPreviewBody.width = layout.settingsPreviewPane._inner.width;
  layout.settingsPreviewBody.height = layout.settingsPreviewPane._inner.height;
}

function ensureSettingsLayout() {
  if (layout.settingsRoot) return;

  layout.settingsRoot = blessed.box({
    top: 1,
    left: 0,
    width: '100%',
    height: innerRows(),
    transparent: true
  });
  screen.append(layout.settingsRoot);

  layout.settingsListPane = makePane(layout.settingsRoot, ' palettes ');
  layout.settingsList = blessed.list({
    parent: layout.settingsListPane._inner,
    top: 0,
    left: 0,
    width: 10,
    height: 10,
    keys: true,
    vi: true,
    mouse: true,
    tags: true,
    invertSelected: false,
    transparent: true,
    scrollbar: {
      ch: '│',
      style: { fg: theme.fgDim }
    },
    style: {
      fg: theme.fg,
      selected: {
        fg: theme.accent,
        bold: true,
        underline: true
      }
    }
  });

  layout.settingsPreviewPane = makePane(layout.settingsRoot, ' preview ');
  layout.settingsPreviewBody = blessed.box({
    parent: layout.settingsPreviewPane._inner,
    top: 0,
    left: 0,
    width: 10,
    height: 10,
    tags: true,
    transparent: true,
    style: { fg: theme.fg }
  });

  layout.settingsList.on('select item', (item, index) => {
    const id = PALETTE_ORDER[index];
    if (!id) return;
    settingsPreviewPaletteId = id;
    renderSettingsPreview(id);
    syncSettingsItems();
    screen.render();
  });

  layout.settingsList.on('action', (item, index) => {
    const id = PALETTES[PALETTE_ORDER[index]] ? PALETTE_ORDER[index] : null;
    if (!id) return;
    applyPalette(id);
    closeSettings();
  });

  syncSettingsListGeometry();
}

function openSettings() {
  if (state.screen !== 'chats' && state.screen !== 'chatDetail') return;
  state.settingsReturnScreen = state.screen;
  state.screen = 'settings';
  settingsPreviewPaletteId = normalizePaletteId(theme.paletteId);
  hidePrimaryViews();
  ensureSettingsLayout();
  syncSettingsListGeometry();
  syncSettingsItems();
  renderSettingsPreview(settingsPreviewPaletteId);
  setPaneActive(layout.settingsListPane, true);
  setPaneActive(layout.settingsPreviewPane, false);
  refreshWidgetStyles();
  layout.settingsRoot.show();
  layout.settingsList.focus();
  const selectedIndex = Math.max(0, PALETTE_ORDER.indexOf(settingsPreviewPaletteId));
  layout.settingsList.select(selectedIndex);
  updateTitle();
  updateFooter();
  screen.render();
}

function closeSettings() {
  if (state.screen !== 'settings') return;
  layout.settingsRoot?.hide();
  const back = state.settingsReturnScreen || 'chats';
  state.screen = back;
  state.settingsReturnScreen = null;

  if (back === 'chatDetail') {
    showChatBrowserColumns('detail');
    layout.chatDetail?.show();
    refreshWidgetStyles();
    redrawChatMessages();
    updateReplyBarContent();
    renderChatDetailMeta();
    layout.input?.focus();
    updateTitle();
    updateFooter();
    screen.render();
    return;
  }

  if (back === 'chats' && state.chats && state.chats.length) {
    showChats(state.chats);
    return;
  }

  void refreshChats();
}

function showQr(qr) {
  stopBootLoader();
  state.screen = 'qr';
  state.qr = qr;
  tryResizeTerminal(42, 110);
  hidePrimaryViews();
  ensureQrLayout();
  syncQrLayout();
  setPaneActive(layout.qrStepsPane, true);
  setPaneActive(layout.qrPane, false);
  const dim = theme.fgDim.slice(1);
  const fg = theme.fg.slice(1);
  layout.qrStepsBody.setContent(
    `{bold}Link steps{/bold}\n` +
      `1. Open WhatsApp on your phone.\n` +
      `2. Go to Settings -> Linked devices.\n` +
      `3. Tap {#${theme.accent.slice(1)}-fg}Link a device{/}.\n` +
      `4. Scan the code in the right pane.\n\n` +
      `{bold}Session files{/bold}\n` +
      `.wwebjs_auth/\n` +
      `.wwebjs_cache/\n\n` +
      `{#${dim}-fg}If the code expires, wa-tui refreshes it automatically.{/}`
  );
  layout.qrBox.setContent(`{#${fg}-fg}Refreshing QR…{/}`);
  layout.qrRoot.show();
  screen.render();

  qrcode.generate(qr, { small: true }, (code) => {
    layout.qrBox.setContent(`{#${fg}-fg}${code}{/}`);
    screen.render();
  });
  updateTitle();
}

function showChats(chats) {
  stopBootLoader();
  tryResizeTerminal(32, 118);
  state.screen = 'chats';
  state.loading = false;
  state.chats = chats;
  state.unreadCount = chats.reduce((acc, c) => acc + c.unreadCount, 0);
  chatPreviewToken++;

  hidePrimaryViews();
  ensureChatBrowserLayout();
  showChatBrowserColumns('browser');
  syncChatBrowserLayout();
  setPaneActive(layout.chatListPane, true);
  setPaneActive(layout.chatPreviewPane, false);
  setPaneActive(layout.chatMetaPane, false);

  const pageSize = currentChatPageSize();
  state.pageSize = pageSize;
  const result = paginate(chats, state.page, pageSize);
  state.page = result.page;
  currentChatPageItems = result.items;

  refreshWidgetStyles();
  layout.chatListMeta.setContent(
    `filter: ${state.filter}   sort: ${state.chatSort}   page: ${state.page}/${result.totalPages}\n` +
      `${state.unreadOnly ? 'unread_only on' : 'unread_only off'}   mouse: click or wheel`
  );
  layout.chatList.show();
  layout.chatList.setItems(formatChatListItems(currentChatPageItems));
  layout.chatList.removeAllListeners('select item');
  layout.chatList.removeAllListeners('action');
  layout.chatList.on('select item', (item, index) => {
    const chat = currentChatPageItems[index];
    if (!chat) return;
    layout.chatPreviewMeta.setContent(
      `${chat.name.replace(/\{/g, '(')}\n` +
        `${chat.isGroup ? 'group' : 'direct'} · ${formatTimestamp(chat.timestamp)}`
    );
    renderChatMeta(chat);
    void loadChatPreview(chat);
    screen.render();
  });
  layout.chatList.on('action', (item, index) => {
    const chat = currentChatPageItems[index];
    if (chat) void openChat(chat);
  });

  const selectedIndex = Math.max(
    0,
    currentChatPageItems.findIndex((chat) => chat.id === state.currentChatId)
  );
  if (currentChatPageItems.length) {
    layout.chatList.select(selectedIndex);
    const chat = currentChatPageItems[selectedIndex];
    layout.chatPreviewMeta.setContent(
      `${chat.name.replace(/\{/g, '(')}\n` +
        `${chat.isGroup ? 'group' : 'direct'} · ${formatTimestamp(chat.timestamp)}`
    );
    renderChatMeta(chat);
    void loadChatPreview(chat);
  } else {
    layout.chatPreviewMeta.setContent('no chats\ntry changing filters or reload');
    renderChatPreviewBody(null, [], null);
    renderChatMeta(null);
  }
  layout.chatList.focus();
  updateTitle();
  screen.render();
}

async function openChat(chatOrId) {
  if (state.screen === 'chatDetail' && layout.input) {
    persistCurrentDraft();
  }
  if (state.screen === 'chatDetail' && state.currentChatId) {
    void waService.clearOutgoingTyping(state.currentChatId, state.currentRawChat);
  }
  clearOutgoingTypingSchedule();
  clearTimeout(peerTypingHideTimer);
  peerTypingHideTimer = null;
  state.peerTypingState = null;

  const chat =
    typeof chatOrId === 'string'
      ? state.chats?.find((c) => c.id === chatOrId)
      : chatOrId;
  if (!chat?.id) {
    console.error('wa-tui: openChat missing chat id', chatOrId);
    return;
  }

  state.screen = 'chatDetail';
  state.currentChatId = chat.id;
  state.currentChatName = chat.name;
  state.currentRawChat = chat.raw;
  state.loading = true;
  clearLiveDedup();
  clearReplyTarget();

  layout.main?.hide();
  layout.settingsRoot?.hide();
  layout.qrRoot?.hide();
  ensureChatBrowserLayout();
  showChatBrowserColumns('detail');
  ensureChatDetailLayout();
  syncChatDetailShell();
  layout.chatDetail.show();
  if (layout.typingBar) layout.typingBar.setContent('');
  setPaneActive(layout.chatListPane, false);
  setPaneActive(layout.chatDetailMain, true);
  setPaneActive(layout.chatDetailSide, false);
  layout.msgList.setContent(`{${theme.fgDim}-fg}Loading messages…{/${theme.fgDim}-fg}`);
  renderChatDetailMeta();
  updateTitle();
  screen.render();

  let messages = [];
  try {
    messages = await waService.getMessages(chat.id, 40, chat.raw);
  } catch (e) {
    state.loading = false;
    const er = theme.error.slice(1);
    layout.msgList.setContent(`{#${er}-fg}Error loading messages: ${e.message}{/#${er}-fg}`);
    screen.render();
    return;
  }

  for (const m of messages) rememberLiveMessageId(m.id);

  state.currentMessages = messages;

  if (!messages || messages.length === 0) {
    layout.msgList.setContent(
      `{${theme.fgDim}-fg}No messages found.{/${theme.fgDim}-fg}`
    );
  } else {
    redrawChatMessages();
    layout.msgList.scrollTo(layout.msgList.getScrollHeight());
  }

  updateReplyBarContent();
  applyChatDetailLayout();
  renderChatDetailMeta();
  state.loading = false;

  const draft = state.chatDrafts[chat.id];
  if (draft) layout.input.setValue(draft);
  else layout.input.clearValue();

  void waService.markChatSeen(chat.id, chat.raw);

  layout.input.focus();
  screen.render();
}

function handleReady() {
  stopBootLoader();
  layout.main.setContent(
    `{${theme.fgDim}-fg}WhatsApp ready — loading chats…{/${theme.fgDim}-fg}`
  );
  screen.render();
  void waService.installRemoteTypingBridge();
  refreshChats();
}

async function refreshChats() {
  let chats = await waService.getChats();

  if (state.filter === 'direct') {
    chats = chats.filter((c) => !c.isGroup);
  } else if (state.filter === 'groups') {
    chats = chats.filter((c) => c.isGroup);
  }
  if (state.unreadOnly) {
    chats = chats.filter((c) => (c.unreadCount || 0) > 0);
  }

  chats = applyChatSort(chats);

  showChats(chats);
}

screen.key(['escape'], () => {
  if (state.screen === 'settings') {
    closeSettings();
    return;
  }
  if (state.screen !== 'chatDetail') return;
  if (state.replyTo) {
    clearReplyTarget();
    updateReplyBarContent();
    applyChatDetailLayout();
    redrawChatMessages();
    screen.render();
    return;
  }
  void waService.clearOutgoingTyping(state.currentChatId, state.currentRawChat);
  clearOutgoingTypingSchedule();
  clearPeerTypingState();
  persistCurrentDraft();
  refreshChats();
});

screen.key(['b'], () => {
  if (state.screen !== 'chatDetail') return;
  void waService.clearOutgoingTyping(state.currentChatId, state.currentRawChat);
  clearOutgoingTypingSchedule();
  clearPeerTypingState();
  persistCurrentDraft();
  clearReplyTarget();
  refreshChats();
});

screen.key(['C-l'], () => {
  void performLogout();
});

screen.key(['f2'], () => {
  if (state.screen === 'settings') {
    closeSettings();
    return;
  }
  openSettings();
});

screen.key(['r'], () => {
  if (state.screen === 'chats') {
    refreshChats();
  }
});

screen.key(['1'], () => {
  state.filter = 'all';
  state.page = 1;
  refreshChats();
});

screen.key(['2'], () => {
  state.filter = 'direct';
  state.page = 1;
  refreshChats();
});

screen.key(['3'], () => {
  state.filter = 'groups';
  state.page = 1;
  refreshChats();
});

screen.key(['u', 'U'], () => {
  if (state.screen !== 'chats') return;
  state.unreadOnly = !state.unreadOnly;
  state.page = 1;
  refreshChats();
});

const CHAT_SORT_CYCLE = ['recent', 'unread', 'alpha'];

screen.key(['o', 'O'], () => {
  if (state.screen !== 'chats') return;
  const i = CHAT_SORT_CYCLE.indexOf(state.chatSort);
  state.chatSort = CHAT_SORT_CYCLE[(i + 1) % CHAT_SORT_CYCLE.length];
  state.page = 1;
  refreshChats();
});

screen.key(['C-up'], () => adjustReplyPick(1));
screen.key(['C-down'], () => adjustReplyPick(-1));

screen.key(['C-d'], () => {
  void downloadHighlightedMedia();
});

waService.on('message', (msg) => {
  const viewingThisChat =
    state.screen === 'chatDetail' && chatIdsMatch(state.currentChatId, msg.chatId);
  if (viewingThisChat && !msg.fromMe) {
    void waService.markChatSeen(state.currentChatId, state.currentRawChat);
  }
  if (!msg.fromMe && !viewingThisChat) {
    playIncomingMessageSound();
    const title = msg.isGroup
      ? (msg.chatName || 'WhatsApp')
      : (msg.author || msg.chatName || 'WhatsApp');
    const subtitle =
      msg.isGroup && msg.author ? `from ${msg.author}` : 'new message';
    notifyDesktop({
      title: `wa-tui · ${title}`,
      subtitle,
      body: msg.displayBody || msg.body || '[media]'
    });
  }

  if (state.screen === 'chats') {
    void refreshChats();
  }

  if (
    state.screen !== 'chatDetail' ||
    !layout.msgList ||
    !chatIdsMatch(state.currentChatId, msg.chatId)
  ) {
    return;
  }

  if (seenLiveMessageIds.has(msg.id)) return;
  if (isDuplicateLiveLine(msg)) return;

  rememberLiveMessageId(msg.id);
  const row = {
    id: msg.id,
    body: msg.body,
    displayBody: msg.displayBody,
    fromMe: msg.fromMe,
    author: msg.author,
    timestamp: msg.timestamp,
    type: msg.type,
    hasMedia: msg.hasMedia,
    hasQuotedMsg: msg.hasQuotedMsg,
    quotedSnippet: msg.quotedSnippet || '',
    ack:
      msg.fromMe && msg.ack !== undefined && msg.ack !== null
        ? msg.ack
        : msg.fromMe
          ? MessageAck.ACK_PENDING
          : undefined
  };
  state.currentMessages.push(row);
  if (state.currentMessages.length > 200) {
    state.currentMessages.splice(0, state.currentMessages.length - 200);
  }
  appendMsgListLine(row);
});

waService.on('message_ack', ({ messageId, chatId, ack }) => {
  if (
    state.screen !== 'chatDetail' ||
    !chatIdsMatch(state.currentChatId, chatId)
  ) {
    return;
  }
  const row = state.currentMessages.find((m) => m.id === messageId);
  if (!row || !row.fromMe) return;
  row.ack = ack;
  redrawChatMessages();
  screen.render();
});

waService.on('remote_typing', (payload) => {
  const { chatId, state: remoteState } = payload || {};
  if (!chatId || state.screen !== 'chatDetail') return;
  if (!chatIdsMatch(state.currentChatId, chatId)) return;
  if (!remoteState) {
    state.peerTypingState = null;
  } else if (remoteState === 'recording') {
    state.peerTypingState = 'recording';
  } else {
    state.peerTypingState = 'typing';
  }
  updatePeerTypingBar();
  refreshPeerTypingTimeout();
});

screen.key(['n'], () => {
  if (state.screen === 'chats') {
    state.page++;
    refreshChats();
  }
});

screen.key(['p'], () => {
  if (state.screen === 'chats' && state.page > 1) {
    state.page--;
    refreshChats();
  }
});

module.exports = {
  init,
  showQr,
  handleReady,
  applyPalette
};
