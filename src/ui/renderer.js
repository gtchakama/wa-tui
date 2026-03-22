const blessed = require('neo-blessed');
const qrcode = require('qrcode-terminal');
const { exec } = require('child_process');
const { MessageAck } = require('whatsapp-web.js');

// Monkey-patch blessed's charWidth to handle emoji as double-wide.
// Without this, blessed thinks emoji are 1-cell wide but terminals render
// them as 2 cells, causing scattered/garbled text rendering.
const _origCharWidth = blessed.unicode.charWidth;
blessed.unicode.charWidth = function (str, i) {
  const point = typeof str !== 'number'
    ? blessed.unicode.codePointAt(str, i || 0)
    : str;
  // Emoji & symbol ranges that terminals render as 2 cells wide
  if ((point >= 0x1F300 && point <= 0x1FAFF)   // Misc Symbols, Emoticons, etc.
    || (point >= 0x2600 && point <= 0x27BF)     // Misc Symbols, Dingbats
    || (point >= 0x2300 && point <= 0x23FF)     // Misc Technical
    || (point >= 0x2B05 && point <= 0x2B55)     // Arrows, geometric
    || (point >= 0xFE00 && point <= 0xFE0F)     // Variation selectors (invisible, width 0)
    || point === 0x200D) {                       // ZWJ (invisible, width 0)
    // Variation selectors and ZWJ are zero-width joiners
    if ((point >= 0xFE00 && point <= 0xFE0F) || point === 0x200D) return 0;
    return 2;
  }
  // Regional indicator symbols (flags) — each pair = 1 flag glyph = 2 cells
  if (point >= 0x1F1E6 && point <= 0x1F1FF) return 1; // each half = 1, pair = 2 cells
  return _origCharWidth(str, i);
};
const state = require('./state');
const waService = require('../whatsapp/service');
const { formatTimestamp, truncate, chatIdsMatch, sanitizeForBlessed } = require('../utils/format');
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
  searchRoot: null,
  searchPrompt: null,
  searchInput: null,
  searchMeta: null,
  searchResults: null,
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
let currentSearchEntries = [];
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

function safeTagText(value) {
  return sanitizeForBlessed(
    String(value == null ? '' : value).replace(/\}/g, ')')
  );
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
    const h = Math.max(15, Math.min(20, Math.floor(inner * 0.55)));
    layout.main.height = h;
  }
}

function stopBootLoader() {
  if (bootLoaderInterval) {
    clearInterval(bootLoaderInterval);
    bootLoaderInterval = null;
  }
}

const BOOT_PHASES = {
  init:             { step: 0, label: 'Initializing',               detail: 'Setting up wa-tui' },
  browser_download: { step: 0, label: 'Setting up WhatsApp',        detail: 'Downloading browser' },
  launching:        { step: 1, label: 'Launching browser',          detail: 'Starting headless Chrome' },
  waiting_auth:  { step: 2, label: 'Connecting',                    detail: 'Opening WhatsApp Web' },
  qr:            { step: 3, label: 'Waiting for QR scan',           detail: 'Scan QR code with your phone' },
  authenticated: { step: 4, label: 'Authenticated',                 detail: 'Session established' },
  syncing:       { step: 5, label: 'Syncing',                       detail: 'Loading WhatsApp data' },
  loading_chats: { step: 6, label: 'Loading chats',                 detail: 'Fetching conversations' },
  ready:         { step: 7, label: 'Ready',                         detail: '' },
};
const BOOT_TOTAL_STEPS = 7;

function bootLoaderFrame(n) {
  const spin = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const s = spin[n % spin.length];
  const A = theme.accent.slice(1);
  const D = theme.fgDim.slice(1);
  const L = theme.fg.slice(1);
  const E = theme.error.slice(1);
  const logoLines = [
    ' ██╗    ██╗ █████╗     ████████╗██╗   ██╗██╗',
    ' ██║    ██║██╔══██╗    ╚══██╔══╝██║   ██║██║',
    ' ██║ █╗ ██║███████║       ██║   ██║   ██║██║',
    ' ██║███╗██║██╔══██║       ██║   ██║   ██║██║',
    ' ╚███╔███╔╝██║  ██║       ██║   ╚██████╔╝██║',
    '  ╚══╝╚══╝ ╚═╝  ╚═╝       ╚═╝    ╚═════╝ ╚═╝',
  ];
  const innerWidth = logoLines.reduce((max, line) => Math.max(max, line.length), 0) + 6;
  const center = (text) => {
    const gap = Math.max(0, innerWidth - text.length);
    const left = Math.floor(gap / 2);
    const right = gap - left;
    return `${' '.repeat(left)}${text}${' '.repeat(right)}`;
  };
  const logoBody = logoLines
    .map((line) => `{#${L}-fg}${center(line)}{/}`)
    .join('\n');
  const byline = `{#${D}-fg}${center('by gtchakama')}{/}`;

  // Phase info
  const phase = BOOT_PHASES[state.loadingPhase] || BOOT_PHASES.init;
  const isError = state.loadingPhase === 'auth_failure' || state.loadingPhase === 'disconnected';

  // Progress bar
  const barWidth = innerWidth - 8;
  const filled = Math.round((phase.step / BOOT_TOTAL_STEPS) * barWidth);
  const empty = barWidth - filled;
  const bar = `{#${A}-fg}${'█'.repeat(filled)}{/}{#${D}-fg}${'░'.repeat(empty)}{/}`;

  // Status line
  let statusLine;
  if (isError) {
    const errMsg = state.loadingPhase === 'auth_failure'
      ? 'Authentication failed — check session or restart'
      : `Disconnected: ${state.error || 'connection lost'}`;
    statusLine = `    {#${E}-fg}✖ ${errMsg}{/}`;
  } else {
    // Percent suffix for download / sync phases
    let pctSuffix = '';
    if (state.loadingPhase === 'browser_download' && state._browserDlPercent != null) {
      pctSuffix = ` (${state._browserDlPercent}%)`;
    } else if (state.loadingPhase === 'syncing' && state._syncPercent != null) {
      pctSuffix = ` (${state._syncPercent}%)`;
    }
    statusLine = `    {#${A}-fg}${s}{/} {#${L}-fg}${phase.label}${pctSuffix}{/}  {#${D}-fg}${phase.detail}{/}`;
  }

  // Step indicators
  const steps = ['init', 'launching', 'waiting_auth', 'authenticated', 'syncing', 'loading_chats'];
  const stepDots = steps.map((key) => {
    const p = BOOT_PHASES[key];
    if (p.step < phase.step) return `{#${A}-fg}●{/}`;
    if (p.step === phase.step && !isError) return `{#${L}-fg}○{/}`;
    return `{#${D}-fg}·{/}`;
  }).join(' ');

  return (
    `${logoBody}\n` +
    `\n` +
    `${byline}\n` +
    `\n` +
    `    ${bar}\n` +
    `${statusLine}\n` +
    `    ${stepDots}`
  );
}

function updateBootPhase(ev) {
  if (state.screen !== 'loading') return;
  if (ev.phase === 'browser_download') {
    state.loadingPhase = 'browser_download';
    state._browserDlPercent = ev.percent != null ? ev.percent : state._browserDlPercent;
  } else if (ev.phase === 'syncing') {
    state.loadingPhase = 'syncing';
    state._syncPercent = ev.percent != null ? ev.percent : state._syncPercent;
  } else if (ev.phase === 'auth_failure') {
    state.loadingPhase = 'auth_failure';
    state.error = ev.message || 'Authentication failed';
  } else if (ev.phase === 'disconnected') {
    state.loadingPhase = 'disconnected';
    state.error = ev.reason || 'Connection lost';
  } else if (BOOT_PHASES[ev.phase]) {
    state.loadingPhase = ev.phase;
  }
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
    : `{bold}{${nameColor}-fg}${sanitizeForBlessed(author)}{/${nameColor}-fg}{/bold}`;
  const time = formatTimestamp(timestamp);
  const text = augmentDisplayPlain(row);
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
  if (layout.searchRoot) {
    layout.searchRoot.style.fg = theme.fg;
    delete layout.searchRoot.style.bg;
  }
  if (layout.searchInput) {
    layout.searchInput.style.fg = theme.fg;
    delete layout.searchInput.style.bg;
  }
  if (layout.searchMeta) {
    layout.searchMeta.style.fg = theme.fgDim;
    delete layout.searchMeta.style.bg;
  }
  if (layout.searchPrompt) {
    layout.searchPrompt.style.fg = theme.fgDim;
    delete layout.searchPrompt.style.bg;
  }
  if (layout.searchResults) {
    layout.searchResults.style.fg = theme.fg;
    delete layout.searchResults.style.bg;
    if (layout.searchResults.style.selected) {
      layout.searchResults.style.selected.fg = theme.accent;
      layout.searchResults.style.selected.bold = true;
      layout.searchResults.style.selected.underline = true;
      delete layout.searchResults.style.selected.bg;
    }
    if (layout.searchResults.style.scrollbar) {
      layout.searchResults.style.scrollbar.fg = theme.fgDim;
      delete layout.searchResults.style.scrollbar.bg;
    }
    if (layout.searchResults.style.track) delete layout.searchResults.style.track.bg;
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
    layout.searchRoot,
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
  if (state.searchOpen) {
    setPaneActive(layout.searchRoot, true);
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
  if (state.searchOpen) {
    line =
      ' [Enter]: open · [↑↓]: move · [Esc]: close · [Ctrl+K]: toggle finder';
  } else if (state.screen === 'settings') {
    line =
      ' [Enter]: apply palette · [Esc]/[F2]: back · Saved: ~/.wa-tui/settings.json · [Q]: Quit';
  } else if (state.screen === 'chatDetail') {
    line =
      ' [Esc]: clr quote / back · [B]: Back · [Ctrl+K]: Search · [Ctrl+↑↓]: Quote · [Ctrl+D]: DL+Open · [Ctrl+O]: Open · [F2]: Colours · [Ctrl+L]: Logout · [Q]: Quit';
  } else if (state.screen === 'chats') {
    line =
      ' [Q]: Quit · [Ctrl+K] or [/]: Search · [F2]: Colours · [Ctrl+L]: Logout · [R]efresh · [U]nread · [N]/[P] · [1-3] filter · [O] sort';
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
  if (state.screen === 'loading') {
    const phase = BOOT_PHASES[state.loadingPhase] || BOOT_PHASES.init;
    modeText = phase.label.toUpperCase();
  } else if (state.searchOpen) {
    modeText = 'SEARCH · Fuzzy finder';
  } else if (state.screen === 'chats') {
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
  layout.searchRoot?.hide();
  layout.searchBackdrop?.hide();
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
    `{#${A}-fg}↪{/} ${sanitizeForBlessed(state.replyTo.author)}: ${sanitizeForBlessed(sn)}  {#${D}-fg}Esc clear · Ctrl+↑↓{/}`
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
        : `{bold}{#${nc}-fg}${sanitizeForBlessed(m.author)}{/#${nc}-fg}{/bold}`;
      const time = formatTimestamp(m.timestamp);
      const mark =
        state.replyTo && m.id === state.replyTo.id
          ? `{#${A}-fg}▶ {/#${A}-fg}`
          : state.searchHitMessageId && m.id === state.searchHitMessageId
            ? `{#${A}-fg}◆ {/#${A}-fg}`
          : '';
      const plain = augmentDisplayPlain(m);
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

function openMediaFile(fpath) {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${cmd} ${JSON.stringify(fpath)}`, (err) => {
    if (err) {
      const er = theme.error.slice(1);
      layout.msgList.add(`{#${er}-fg}Could not open file: ${err.message}{/#${er}-fg}`);
      screen.render();
    }
  });
}

async function openHighlightedMedia() {
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
    layout.msgList.add(`{#${er}-fg}No media message found — Ctrl+↓ to pick a message.{/#${er}-fg}`);
    screen.render();
    return;
  }
  const fpath = state.mediaPaths[targetId];
  if (!fpath) {
    const d = theme.fgDim.slice(1);
    layout.msgList.add(`{#${d}-fg}Media not downloaded yet — press Ctrl+D first.{/#${d}-fg}`);
    screen.render();
    return;
  }
  openMediaFile(fpath);
  const d = theme.fgDim.slice(1);
  layout.msgList.add(`{#${d}-fg}Opening: ${fpath.replace(/\{/g, '(')}{/#${d}-fg}`);
  screen.render();
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
    openMediaFile(fpath);
    const d = theme.fgDim.slice(1);
    layout.msgList.add(`{#${d}-fg}Saved & opening: ${fpath.replace(/\{/g, '(')}{/#${d}-fg}`);
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
    if (state.searchOpen) {
      if (state.screen === 'chats') showChats(state.chats);
      else syncListAndDetailHeights();
      syncSearchLayout();
      layout.searchBackdrop?.show();
      layout.searchBackdrop?.setFront?.();
      layout.searchRoot?.show();
      layout.searchRoot?.setFront?.();
      updateSearchMeta();
      screen.render();
      return;
    }
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
    const name = sanitizeForBlessed(String(c.name || '').replace(/\}/g, ')'));
    const displayName = c.unreadCount > 0 ? `{bold}${name}{/bold}` : name;

    return `${displayName}${pin}${unread}${type} {${theme.fgDim}-fg}${time}{/${theme.fgDim}-fg}\n` +
      `  {${theme.fgDim}-fg}${sanitizeForBlessed(lastMsg.replace(/\}/g, ')'))}{/${theme.fgDim}-fg}`;
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
      const who = m.fromMe ? 'You' : sanitizeForBlessed(m.author);
      const body = augmentDisplayPlain(m);
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
    `✓ sent · ✓✓ delivered · {${theme.accent}-fg}✓✓{/${theme.accent}-fg} read`,
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
    'Ctrl+K search',
    'Ctrl+up/down move quote',
    'Ctrl+D download & open media',
    'Ctrl+O or click: open media',
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

  layout.msgList.on('mouse', (data) => {
    if (data.action !== 'mousedown' || data.button !== 'left') return;
    if (state.screen !== 'chatDetail') return;
    const rows = rowsWithPaths();
    if (!rows.length) return;
    // Map click y to visual line index (accounting for scroll)
    const scrollTop = layout.msgList.childBase || 0;
    const absTop = layout.msgList.atop != null ? layout.msgList.atop : 0;
    const visualLine = scrollTop + (data.y - absTop);
    // rtof maps visual (wrapped) line index → original content line index
    const clines = layout.msgList._clines;
    let msgIdx;
    if (clines && clines.rtof && clines.rtof[visualLine] != null) {
      msgIdx = clines.rtof[visualLine];
    } else {
      msgIdx = visualLine;
    }
    if (msgIdx < 0 || msgIdx >= rows.length) return;
    const msg = rows[msgIdx];
    if (!msg || !msg.hasMedia) return;
    if (msg.localPath) {
      openMediaFile(msg.localPath);
      const d = theme.fgDim.slice(1);
      layout.msgList.add(`{#${d}-fg}Opening: ${msg.localPath.replace(/\{/g, '(')}{/#${d}-fg}`);
      screen.render();
    } else {
      // Not yet downloaded — download + open
      const d = theme.fgDim.slice(1);
      layout.msgList.add(`{#${d}-fg}Downloading…{/#${d}-fg}`);
      screen.render();
      void (async () => {
        try {
          const fpath = await waService.downloadMessageMedia(
            msg.id, state.currentChatId, state.currentRawChat
          );
          state.mediaPaths[msg.id] = fpath;
          redrawChatMessages();
          openMediaFile(fpath);
          layout.msgList.add(`{#${d}-fg}Saved & opening: ${fpath.replace(/\{/g, '(')}{/#${d}-fg}`);
        } catch (e) {
          const er = theme.error.slice(1);
          layout.msgList.add(`{#${er}-fg}Download failed: ${e.message}{/#${er}-fg}`);
        }
        screen.render();
      })();
    }
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

  layout.qrPane = makePane(layout.qrRoot, ' wa-tui by gtchakama ');
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

function searchGeometry() {
  const totalWidth = screen.width || 100;
  const totalHeight = innerRows();
  const width = Math.max(50, Math.min(72, Math.floor(totalWidth * 0.55)));
  const height = Math.max(14, Math.min(totalHeight - 4, Math.floor(totalHeight * 0.65)));
  return {
    top: 1 + Math.max(1, Math.floor((totalHeight - height) / 2)),
    left: Math.max(2, Math.floor((totalWidth - width) / 2)),
    width,
    height
  };
}

function syncSearchLayout() {
  if (!layout.searchRoot) return;
  const { top, left, width, height } = searchGeometry();
  layout.searchRoot.top = top;
  layout.searchRoot.left = left;
  layout.searchRoot.width = width;
  layout.searchRoot.height = height;

  // Inner content area: border takes 1 col each side, plus 1 col padding each side
  const contentW = width - 4;
  const contentLeft = 2; // 1 border + 1 padding

  layout.searchPrompt.top = 1;
  layout.searchPrompt.left = contentLeft;
  layout.searchPrompt.width = 2;
  layout.searchPrompt.height = 1;

  layout.searchInput.top = 1;
  layout.searchInput.left = contentLeft + 2;
  layout.searchInput.width = contentW - 2;
  layout.searchInput.height = 1;

  layout.searchSep.top = 2;
  layout.searchSep.left = contentLeft;
  layout.searchSep.width = contentW;
  layout.searchSep.height = 1;
  layout.searchSep.setContent(`{${theme.fgDim}-fg}${'─'.repeat(Math.max(1, contentW))}{/${theme.fgDim}-fg}`);

  layout.searchResults.top = 3;
  layout.searchResults.left = contentLeft;
  layout.searchResults.width = contentW;
  layout.searchResults.height = Math.max(4, height - 5);

  layout.searchMeta.top = height - 2;
  layout.searchMeta.left = contentLeft;
  layout.searchMeta.width = contentW;
  layout.searchMeta.height = 1;
}

function searchQueryParts(query) {
  return String(query || '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function fuzzyMatchScore(query, text) {
  const parts = searchQueryParts(query);
  if (!parts.length) return 0;
  const haystack = String(text || '').toLowerCase();
  let score = 0;
  for (const part of parts) {
    const idx = haystack.indexOf(part);
    if (idx === -1) return -1; // all parts must be substrings
    // Prefer matches at the start or at word boundaries
    if (idx === 0) score += 20;
    else if (' -_./:@'.includes(haystack[idx - 1] || '')) score += 10;
    score += Math.max(0, 10 - idx); // earlier matches score higher
    score += part.length; // longer matching parts score higher
  }
  return score;
}

function searchMessageRows() {
  if (state.screen !== 'chatDetail' || !state.currentMessages.length) return [];
  return rowsWithPaths();
}

function buildChatSearchEntries(query) {
  const chats = state.allChats?.length ? state.allChats : state.chats;
  if (!chats || !chats.length) return [];
  if (!searchQueryParts(query).length) {
    return chats.slice(0, 10).map((chat) => ({ kind: 'chat', chat }));
  }
  return chats
    .map((chat) => {
      const text = `${chat.name || ''} ${chat.lastMessage || ''} ${chat.id || ''}`;
      const score = fuzzyMatchScore(query, text);
      return score < 0 ? null : { kind: 'chat', chat, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || (a.chat.listIndex || 0) - (b.chat.listIndex || 0))
    .slice(0, 12);
}

function buildMessageSearchEntries(query) {
  const rows = searchMessageRows();
  if (!rows.length) return [];
  const ordered = [...rows].reverse();
  if (!searchQueryParts(query).length) {
    return ordered.slice(0, 8).map((message) => ({ kind: 'message', message }));
  }
  return ordered
    .map((message) => {
      const author = message.fromMe ? 'You' : message.author || '';
      const text = `${author} ${augmentDisplayPlain(message)}`;
      const score = fuzzyMatchScore(query, text);
      return score < 0 ? null : { kind: 'message', message, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || (b.message.timestamp || 0) - (a.message.timestamp || 0))
    .slice(0, 10);
}

function isSearchSelectableEntry(entry) {
  return entry?.kind === 'chat' || entry?.kind === 'message';
}

function buildSearchEntries(query) {
  const entries = [];
  const chats = buildChatSearchEntries(query);
  const messages = buildMessageSearchEntries(query);

  if (chats.length) {
    entries.push({ kind: 'section', label: 'Chats' });
    entries.push(...chats);
  }
  if (messages.length) {
    entries.push({ kind: 'section', label: 'Messages' });
    entries.push(...messages);
  }
  if (!entries.some(isSearchSelectableEntry)) {
    entries.push({
      kind: 'empty',
      label: searchQueryParts(query).length
        ? 'No matches.'
        : 'Type to search chats. Current-thread messages appear below when available.'
    });
  }
  return entries;
}

function formatSearchEntry(entry) {
  if (entry.kind === 'section') {
    return `{${theme.fgDim}-fg}── ${entry.label} ──{/${theme.fgDim}-fg}`;
  }
  if (entry.kind === 'empty') {
    return `  {${theme.fgDim}-fg}${safeTagText(entry.label)}{/${theme.fgDim}-fg}`;
  }
  if (entry.kind === 'chat') {
    const { chat } = entry;
    const name = safeTagText(chat.name || 'Unknown');
    const type = chat.isGroup
      ? `{${theme.fgDim}-fg}grp{/${theme.fgDim}-fg}`
      : `{${theme.fgDim}-fg}dm{/${theme.fgDim}-fg}`;
    const unread =
      chat.unreadCount > 0
        ? ` {${theme.unread}-fg}${chat.unreadCount}{/${theme.unread}-fg}`
        : '';
    const time = `{${theme.fgDim}-fg}${formatTimestamp(chat.timestamp || 0)}{/${theme.fgDim}-fg}`;
    return `  ${name} ${type}${unread} ${time}`;
  }
  const { message } = entry;
  const nc = (message.fromMe ? theme.selfMsg : theme.peerMsg).slice(1);
  const author = `{#${nc}-fg}${safeTagText(message.fromMe ? 'You' : message.author || 'Unknown')}{/#${nc}-fg}`;
  const time = `{${theme.fgDim}-fg}${formatTimestamp(message.timestamp || 0)}{/${theme.fgDim}-fg}`;
  const preview = truncate(safeTagText(augmentDisplayPlain(message)), 42);
  return `  ${author} ${time} ${preview}`;
}

function findSearchSelectableIndex(start = 0, step = 1) {
  if (!currentSearchEntries.length) return -1;
  for (
    let i = Math.max(0, Math.min(start, currentSearchEntries.length - 1));
    i >= 0 && i < currentSearchEntries.length;
    i += step
  ) {
    if (isSearchSelectableEntry(currentSearchEntries[i])) return i;
  }
  return -1;
}

function updateSearchMeta() {
  if (!layout.searchMeta) return;
  const chatCount = currentSearchEntries.filter((entry) => entry.kind === 'chat').length;
  const messageCount = currentSearchEntries.filter((entry) => entry.kind === 'message').length;
  const selected = currentSearchEntries[layout.searchResults?.selected || 0];

  const counts = [];
  if (chatCount) counts.push(`${chatCount} chats`);
  if (messageCount) counts.push(`${messageCount} msgs`);
  const countStr = counts.length ? counts.join(' · ') : 'no results';

  let hint = '';
  if (selected?.kind === 'chat') {
    hint = `Enter: open chat`;
  } else if (selected?.kind === 'message') {
    hint = `Enter: jump to message`;
  }

  layout.searchMeta.setContent(
    `{${theme.fgDim}-fg}${countStr}${hint ? '  ·  ' + hint : ''}  ·  Esc: close{/${theme.fgDim}-fg}`
  );
}

function syncSearchResults() {
  if (!layout.searchInput || !layout.searchResults) return;
  const previous = layout.searchResults.selected || 0;
  currentSearchEntries = buildSearchEntries(layout.searchInput.getValue());
  layout.searchResults.setItems(currentSearchEntries.map(formatSearchEntry));

  let next = isSearchSelectableEntry(currentSearchEntries[previous])
    ? previous
    : findSearchSelectableIndex(0, 1);
  if (next < 0) next = 0;
  layout.searchResults.select(next);
  updateSearchMeta();
  screen.render();
}

function moveSearchSelection(delta) {
  if (!state.searchOpen || !layout.searchResults || !currentSearchEntries.length) return;
  const step = delta < 0 ? -1 : 1;
  let moves = Math.max(1, Math.abs(delta));
  let index = layout.searchResults.selected || 0;

  while (moves > 0) {
    const next = findSearchSelectableIndex(index + step, step);
    if (next < 0) break;
    index = next;
    moves -= 1;
  }

  layout.searchResults.select(index);
  updateSearchMeta();
  screen.render();
}

function revealSearchMessage(messageId) {
  if (!layout.msgList || !messageId) return;
  const idx = state.currentMessages.findIndex((message) => message.id === messageId);
  if (idx < 0) return;
  try {
    layout.msgList.scrollTo(Math.max(0, idx - 3));
  } catch (_) {}
}

async function activateSearchSelection() {
  const entry = currentSearchEntries[layout.searchResults?.selected || 0];
  if (!isSearchSelectableEntry(entry)) return;

  if (entry.kind === 'chat') {
    state.searchHitMessageId = null;
    closeSearch();
    if (state.screen === 'chatDetail' && chatIdsMatch(state.currentChatId, entry.chat.id)) {
      layout.input?.focus();
      screen.render();
      return;
    }
    await openChat(entry.chat);
    return;
  }

  state.searchHitMessageId = entry.message.id;
  closeSearch();
  redrawChatMessages();
  revealSearchMessage(entry.message.id);
  layout.input?.focus();
  screen.render();
}

function ensureSearchLayout() {
  if (layout.searchRoot) return;

  // Semi-transparent backdrop to dim the underlying UI
  layout.searchBackdrop = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    transparent: true,
    ch: ' ',
    style: {}
  });
  layout.searchBackdrop.hide();

  layout.searchRoot = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: 10,
    height: 10,
    border: { type: 'line' },
    label: ` {bold}Search{/bold} `,
    tags: true,
    transparent: false,
    style: {
      fg: theme.fg,
      border: { fg: theme.accent },
      label: { fg: theme.accent }
    }
  });
  layout.searchRoot.hide();

  layout.searchPrompt = blessed.box({
    parent: layout.searchRoot,
    top: 1,
    left: 2,
    width: 10,
    height: 1,
    tags: true,
    content: `{${theme.accent}-fg}>{/${theme.accent}-fg} `,
    transparent: false,
    style: { fg: theme.fgDim }
  });

  layout.searchInput = blessed.textbox({
    parent: layout.searchRoot,
    top: 1,
    left: 4,
    width: 10,
    height: 1,
    keys: true,
    mouse: true,
    inputOnFocus: true,
    transparent: false,
    style: { fg: theme.fg }
  });

  // Separator line below input
  layout.searchSep = blessed.box({
    parent: layout.searchRoot,
    top: 2,
    left: 1,
    width: 10,
    height: 1,
    tags: true,
    transparent: false,
    style: { fg: theme.fgDim }
  });

  layout.searchResults = blessed.list({
    parent: layout.searchRoot,
    top: 3,
    left: 1,
    width: 10,
    height: 10,
    keys: true,
    vi: true,
    mouse: true,
    tags: true,
    invertSelected: false,
    transparent: false,
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

  layout.searchMeta = blessed.box({
    parent: layout.searchRoot,
    top: 10,
    left: 1,
    width: 10,
    height: 1,
    tags: true,
    transparent: false,
    style: { fg: theme.fgDim }
  });

  layout.searchInput.on('keypress', (ch, key = {}) => {
    if (!state.searchOpen) return;
    if (key.name === 'down') {
      moveSearchSelection(1);
      return;
    }
    if (key.name === 'up') {
      moveSearchSelection(-1);
      return;
    }
    if (key.name === 'pagedown') {
      moveSearchSelection(5);
      return;
    }
    if (key.name === 'pageup') {
      moveSearchSelection(-5);
      return;
    }
    if (['enter', 'return', 'escape'].includes(key.name)) return;
    setImmediate(syncSearchResults);
  });

  layout.searchInput.on('submit', () => {
    void activateSearchSelection();
  });

  layout.searchInput.on('cancel', () => {
    closeSearch();
  });

  layout.searchResults.on('select item', () => {
    updateSearchMeta();
    screen.render();
  });

  layout.searchResults.on('action', () => {
    void activateSearchSelection();
  });

  syncSearchLayout();
}

function openSearch() {
  if (state.screen !== 'chats' && state.screen !== 'chatDetail') return;
  state.searchOpen = true;
  state.searchReturnScreen = state.screen;
  ensureSearchLayout();
  syncSearchLayout();
  refreshWidgetStyles();
  layout.searchBackdrop.show();
  layout.searchBackdrop.setFront?.();
  layout.searchRoot.show();
  layout.searchRoot.setFront?.();
  layout.searchInput.setValue('');
  currentSearchEntries = [];
  syncSearchResults();
  layout.searchInput.focus();
  updateTitle();
  screen.render();
}

function closeSearch() {
  if (!state.searchOpen) return;
  const back = state.searchReturnScreen || state.screen;
  state.searchOpen = false;
  state.searchReturnScreen = null;
  currentSearchEntries = [];
  layout.searchInput?.clearValue();
  layout.searchRoot?.hide();
  layout.searchBackdrop?.hide();

  if (back === 'chatDetail') {
    layout.input?.focus();
    redrawChatMessages();
  } else if (back === 'chats') {
    layout.chatList?.focus();
  }

  updateTitle();
  screen.render();
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
  const accent = theme.accent.slice(1);
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
  layout.qrBox.setContent(
    `{#${accent}-fg}{bold}wa-tui{/bold}{/#${accent}-fg}\n` +
      `{#${dim}-fg}by gtchakama{/}\n\n` +
      `{#${fg}-fg}Refreshing QR…{/}`
  );
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
      `${sanitizeForBlessed(chat.name)}\n` +
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
      `${sanitizeForBlessed(chat.name)}\n` +
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
  state.searchHitMessageId = null;
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
  state.loadingPhase = 'loading_chats';
  // Keep boot loader running for the last phase — it will show the progress bar at ~85%
  screen.render();
  void waService.installRemoteTypingBridge();
  refreshChats();
}

async function refreshChats() {
  let chats = await waService.getChats();
  state.allChats = chats;

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
  if (state.searchOpen) {
    layout.searchBackdrop?.show();
    layout.searchBackdrop?.setFront?.();
    layout.searchRoot?.show();
    layout.searchRoot?.setFront?.();
    syncSearchResults();
    layout.searchInput?.focus();
  }
}

screen.key(['escape'], () => {
  if (state.searchOpen) {
    closeSearch();
    return;
  }
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
  if (state.searchOpen) return;
  if (state.screen !== 'chatDetail') return;
  void waService.clearOutgoingTyping(state.currentChatId, state.currentRawChat);
  clearOutgoingTypingSchedule();
  clearPeerTypingState();
  persistCurrentDraft();
  clearReplyTarget();
  refreshChats();
});

screen.key(['C-l'], () => {
  if (state.searchOpen) return;
  void performLogout();
});

screen.key(['C-k'], () => {
  if (state.screen !== 'chats' && state.screen !== 'chatDetail' && !state.searchOpen) return;
  if (state.searchOpen) {
    closeSearch();
    return;
  }
  openSearch();
});

screen.key(['/'], () => {
  if (state.searchOpen) return;
  if (state.screen !== 'chats') return;
  openSearch();
});

screen.key(['f2'], () => {
  if (state.searchOpen) return;
  if (state.screen === 'settings') {
    closeSettings();
    return;
  }
  openSettings();
});

screen.key(['r'], () => {
  if (state.searchOpen) return;
  if (state.screen === 'chats') {
    refreshChats();
  }
});

screen.key(['1'], () => {
  if (state.searchOpen) return;
  state.filter = 'all';
  state.page = 1;
  refreshChats();
});

screen.key(['2'], () => {
  if (state.searchOpen) return;
  state.filter = 'direct';
  state.page = 1;
  refreshChats();
});

screen.key(['3'], () => {
  if (state.searchOpen) return;
  state.filter = 'groups';
  state.page = 1;
  refreshChats();
});

screen.key(['u', 'U'], () => {
  if (state.searchOpen) return;
  if (state.screen !== 'chats') return;
  state.unreadOnly = !state.unreadOnly;
  state.page = 1;
  refreshChats();
});

const CHAT_SORT_CYCLE = ['recent', 'unread', 'alpha'];

screen.key(['o', 'O'], () => {
  if (state.searchOpen) return;
  if (state.screen !== 'chats') return;
  const i = CHAT_SORT_CYCLE.indexOf(state.chatSort);
  state.chatSort = CHAT_SORT_CYCLE[(i + 1) % CHAT_SORT_CYCLE.length];
  state.page = 1;
  refreshChats();
});

screen.key(['C-up'], () => {
  if (state.searchOpen) return;
  adjustReplyPick(1);
});

screen.key(['C-down'], () => {
  if (state.searchOpen) return;
  adjustReplyPick(-1);
});

screen.key(['C-d'], () => {
  if (state.searchOpen) return;
  void downloadHighlightedMedia();
});

screen.key(['C-o'], () => {
  if (state.searchOpen) return;
  void openHighlightedMedia();
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
  if (state.searchOpen) syncSearchResults();
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
  if (state.searchOpen) return;
  if (state.screen === 'chats') {
    state.page++;
    refreshChats();
  }
});

screen.key(['p'], () => {
  if (state.searchOpen) return;
  if (state.screen === 'chats' && state.page > 1) {
    state.page--;
    refreshChats();
  }
});

module.exports = {
  init,
  showQr,
  handleReady,
  updateBootPhase,
  applyPalette
};
