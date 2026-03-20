const blessed = require('neo-blessed');
const qrcode = require('qrcode-terminal');
const state = require('./state');
const waService = require('../whatsapp/service');
const { formatTimestamp, truncate, chatIdsMatch } = require('../utils/format');
const { augmentDisplayPlain } = require('../utils/messageFormat');
const { paginate } = require('../utils/pager');

/**
 * Palette: Prussian Blue base, Dodger / Pacific / Sky accents, Classic Crimson alerts.
 * (Terminal cannot change font from Node — set it in your terminal emulator preferences.)
 */
const theme = {
  bg: '#02182B',
  fg: '#68C5DB',
  fgDim: '#448FA3',
  accent: '#0197F6',
  selfMsg: '#68C5DB',
  peerMsg: '#448FA3',
  error: '#D7263D',
  unread: '#D7263D',
  selectedBg: '#0197F6',
  selectedFg: '#02182B',
  scrollbar: '#448FA3'
};

const screen = blessed.screen({
  smartCSR: true,
  title: 'wa-tui',
  // neo-blessed only applies cursor styling if `shape` is set (see screen.enter).
  cursor: {
    shape: 'block',
    blink: true,
    color: theme.accent
  },
  style: {
    bg: theme.bg,
    fg: theme.fg
  }
});

const layout = {
  header: null,
  main: null,
  footer: null,
  chatList: null,
  chatDetail: null,
  replyBar: null,
  qrBox: null
};

let bootLoaderInterval = null;

/** xterm-style window resize CSI (opt-in: WA_TUI_RESIZE=1). */
function tryResizeTerminal(rows, cols) {
  if (process.env.WA_TUI_RESIZE !== '1' || !process.stdout.isTTY) return;
  process.stdout.write(`\x1b[8;${rows};${cols}t`);
}

/** Usable rows between 1-line header (top 0) and 1-line footer. */
function innerRows() {
  return Math.max(6, (screen.height || 24) - 2);
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
  layout.msgList.add(`[${time}] ${name}: ${text}`);
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
      fg: theme.accent,
      bg: theme.bg
    },
    padding: { left: 0 }
  });
  screen.append(layout.header);
}

function createFooter() {
  layout.footer = blessed.box({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: '',
    style: {
      fg: theme.fgDim,
      bg: theme.bg
    }
  });
  screen.append(layout.footer);
  updateFooter();
}

function updateFooter() {
  if (!layout.footer) return;
  let line;
  if (state.screen === 'chatDetail') {
    line =
      ' [Esc]: clr quote / back · [B]: Back · [Ctrl+↑↓]: Quote msg · [Ctrl+D]: DL media · [Ctrl+L]: Logout · [Q]: Quit';
  } else if (state.screen === 'chats') {
    line =
      ' [Q]: Quit · ctrl+L Logout · [R]efresh · [U]nread · [N]/[P] · [1-3] filter · [O] sort';
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
  const inner = innerRows();
  if (layout.chatList) {
    layout.chatList.top = 1;
    layout.chatList.height = inner;
  }
  applyChatDetailLayout();
}

function applyChatDetailLayout() {
  const inner = innerRows();
  if (!layout.chatDetail || !layout.msgList || !layout.input) return;
  const inputH = layout.input.height || 3;
  const replyH = state.replyTo ? 1 : 0;
  layout.chatDetail.top = 1;
  layout.chatDetail.height = inner;
  if (layout.replyBar) {
    layout.replyBar.hidden = !state.replyTo;
    layout.replyBar.bottom = inputH;
    layout.replyBar.left = 0;
    layout.replyBar.width = '100%';
    layout.replyBar.height = 1;
  }
  layout.input.bottom = 0;
  layout.msgList.top = 0;
  layout.msgList.height = Math.max(4, inner - inputH - replyH);
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
      return `[${time}] ${mark}${name}: ${plain}`;
    })
    .join('\n');
  layout.msgList.setContent(content);
}

function finishReplyUi() {
  updateReplyBarContent();
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
  if (state.chatSort === 'unread') {
    out.sort((a, b) => {
      const du = (b.unreadCount || 0) - (a.unreadCount || 0);
      if (du !== 0) return du;
      return (b.timestamp || 0) - (a.timestamp || 0);
    });
  } else if (state.chatSort === 'alpha') {
    out.sort((a, b) =>
      (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
    );
  }
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
    style: {
      fg: theme.fg,
      bg: theme.bg
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
    else if (state.screen === 'qr') layoutMainPanel('qr');
    syncListAndDetailHeights();
    screen.render();
  });

  screen.render();
}

function showQr(qr) {
  stopBootLoader();
  state.screen = 'qr';
  state.qr = qr;
  tryResizeTerminal(42, 110);
  layout.main.show();
  layoutMainPanel('qr');
  layout.main.setContent('{#448FA3-fg}Scan this QR with WhatsApp →{/}\n\n{#68C5DB-fg}Refreshing…{/}');
  screen.render();

  qrcode.generate(qr, { small: true }, (code) => {
    layout.main.setContent(
      `{#448FA3-fg}Scan this QR with WhatsApp →{/}\n\n{#68C5DB-fg}${code}{/}`
    );
    screen.render();
  });
  updateTitle();
}

function showChats(chats) {
  stopBootLoader();
  tryResizeTerminal(30, 100);
  state.screen = 'chats';
  state.loading = false;
  state.chats = chats;
  state.unreadCount = chats.reduce((acc, c) => acc + c.unreadCount, 0);

  if (layout.main) layout.main.hide();
  if (layout.chatDetail) layout.chatDetail.hide();

  if (!layout.chatList) {
    layout.chatList = blessed.list({
      top: 1,
      left: 0,
      width: '100%',
      height: innerRows(),
      keys: true,
      vi: true,
      mouse: true,
      tags: true,
      scrollbar: {
        ch: ' ',
        track: {
          bg: theme.scrollbar
        },
        style: {
          fg: theme.fgDim,
          bg: theme.bg
        }
      },
      style: {
        fg: theme.fg,
        bg: theme.bg,
        selected: {
          bg: theme.selectedBg,
          fg: theme.selectedFg
        }
      }
    });

    screen.append(layout.chatList);
  }

  const result = paginate(chats, state.page, state.pageSize);
  state.page = result.page;
  const pageItems = result.items;

  syncListAndDetailHeights();
  layout.chatList.show();

  const items = pageItems.map((c) => {
    const unread =
      c.unreadCount > 0
        ? ` {${theme.unread}-fg}[${c.unreadCount}]{/${theme.unread}-fg}`
        : '';
    const type = c.isGroup ? ` {${theme.fgDim}-fg}[Grp]{/${theme.fgDim}-fg}` : '';
    const time = formatTimestamp(c.timestamp);
    const lastMsg = truncate(c.lastMessage);

    return `{${theme.accent}-fg}{bold}${c.name}{/bold}{/${theme.accent}-fg}${unread}${type} {${theme.fgDim}-fg}- ${time}{/${theme.fgDim}-fg}\n   {${theme.fgDim}-fg}${lastMsg}{/${theme.fgDim}-fg}`;
  });

  layout.chatList.setItems(items);

  layout.chatList.removeAllListeners('select');
  layout.chatList.on('select', async (item, index) => {
    const chat = pageItems[index];
    if (chat) {
      await openChat(chat);
    }
  });

  layout.chatList.focus();
  updateTitle();
  screen.render();
}

async function openChat(chatOrId) {
  if (state.screen === 'chatDetail' && layout.input) {
    persistCurrentDraft();
  }

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

  if (layout.chatList) layout.chatList.hide();

  if (!layout.chatDetail) {
    layout.chatDetail = blessed.box({
      top: 1,
      left: 0,
      width: '100%',
      height: innerRows(),
      style: {
        fg: theme.fg,
        bg: theme.bg
      }
    });

    layout.msgList = blessed.log({
      top: 0,
      left: 0,
      width: '100%',
      height: innerRows() - 3,
      scrollable: true,
      alwaysScroll: true,
      tags: true,
      padding: { left: 0, right: 0 },
      style: {
        fg: theme.fg,
        bg: theme.bg
      }
    });

    layout.replyBar = blessed.box({
      bottom: 3,
      left: 0,
      width: '100%',
      height: 1,
      hidden: true,
      tags: true,
      style: {
        fg: theme.fgDim,
        bg: theme.bg
      }
    });

    layout.input = blessed.textbox({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      keys: true,
      inputOnFocus: true,
      style: {
        fg: theme.fg,
        bg: theme.bg
      }
    });

    layout.input.on('submit', async (text) => {
      if (text.trim()) {
        try {
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
          layout.input.focus();
          screen.render();
        } catch (e) {
          const er = theme.error.slice(1);
          layout.msgList.add(`{#${er}-fg}Failed to send: ${e.message}{/#${er}-fg}`);
          screen.render();
        }
      }
    });

    layout.chatDetail.append(layout.msgList);
    layout.chatDetail.append(layout.replyBar);
    layout.chatDetail.append(layout.input);
    screen.append(layout.chatDetail);
  }

  syncListAndDetailHeights();
  layout.chatDetail.show();
  layout.msgList.setContent(`{${theme.fgDim}-fg}Loading messages…{/${theme.fgDim}-fg}`);
  updateTitle();
  screen.render();

  let messages = [];
  try {
    messages = await waService.getMessages(chat.id, 40, chat.raw);
  } catch (e) {
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

  const draft = state.chatDrafts[chat.id];
  if (draft) layout.input.setValue(draft);
  else layout.input.clearValue();

  layout.input.focus();
  screen.render();
}

function handleReady() {
  stopBootLoader();
  layout.main.setContent(
    `{${theme.fgDim}-fg}WhatsApp ready — loading chats…{/${theme.fgDim}-fg}`
  );
  screen.render();
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
  if (state.screen !== 'chatDetail') return;
  if (state.replyTo) {
    clearReplyTarget();
    updateReplyBarContent();
    applyChatDetailLayout();
    redrawChatMessages();
    screen.render();
    return;
  }
  persistCurrentDraft();
  refreshChats();
});

screen.key(['b'], () => {
  if (state.screen !== 'chatDetail') return;
  persistCurrentDraft();
  clearReplyTarget();
  refreshChats();
});

screen.key(['C-l'], () => {
  void performLogout();
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
  if (state.screen === 'chats') {
    refreshChats();
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
    quotedSnippet: msg.quotedSnippet || ''
  };
  state.currentMessages.push(row);
  if (state.currentMessages.length > 200) {
    state.currentMessages.splice(0, state.currentMessages.length - 200);
  }
  appendMsgListLine(row);
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
  handleReady
};
