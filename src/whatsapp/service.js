const fs = require('fs');
const path = require('path');
const os = require('os');
const { install, detectBrowserPlatform, Browser } = require('@puppeteer/browsers');
const {
  Client,
  LocalAuth,
  MessageTypes,
  MessageAck
} = require('whatsapp-web.js');
const EventEmitter = require('events');
const { formatPeerLabel, truncate } = require('../utils/format');
const { displayBodyForParts } = require('../utils/messageFormat');

/**
 * Check if Puppeteer's Chrome is already installed.
 */
function isBrowserInstalled() {
  try {
    const puppeteer = require('puppeteer');
    return fs.existsSync(puppeteer.executablePath());
  } catch (_) {
    return false;
  }
}

/**
 * Remove stale/corrupt chrome cache folders that lack the actual executable.
 * Puppeteer refuses to re-download if the folder exists, even if incomplete.
 */
function cleanStaleChromeCache() {
  try {
    const cacheDir = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
    if (!fs.existsSync(cacheDir)) return;
    for (const entry of fs.readdirSync(cacheDir)) {
      const entryPath = path.join(cacheDir, entry);
      if (!fs.statSync(entryPath).isDirectory()) continue;
      // Check if any executable exists inside — if not, it's stale
      const hasExe = fs.readdirSync(entryPath, { recursive: true }).some(
        (f) => String(f).includes('chrome') || String(f).includes('Chrome')
      );
      // If the folder is nearly empty (no chrome binary), remove it
      if (!hasExe) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
    }
  } catch (_) {
    // Non-critical — install may still work or produce a clear error
  }
}

/**
 * Install Puppeteer's Chrome, emitting progress via the provided callback.
 * Uses @puppeteer/browsers Node API for reliable progress reporting.
 * @param {(percent: number) => void} onProgress
 */
async function installBrowser(onProgress) {
  cleanStaleChromeCache();
  const { PUPPETEER_REVISIONS } = require('puppeteer-core/lib/cjs/puppeteer/revisions.js');
  const cacheDir = path.join(os.homedir(), '.cache', 'puppeteer');
  await install({
    browser: Browser.CHROME,
    buildId: PUPPETEER_REVISIONS.chrome,
    platform: detectBrowserPlatform(),
    cacheDir,
    downloadProgressCallback: (downloadedBytes, totalBytes) => {
      if (totalBytes > 0) {
        onProgress(Math.round((downloadedBytes / totalBytes) * 100));
      }
    }
  });
}

async function resolveIncomingAuthor(msg, chat) {
  const isGroup = Boolean(chat && chat.isGroup);
  const peerTitle = (chat && (chat.name || chat.formattedTitle || '').trim()) || '';
  if (!isGroup) {
    if (peerTitle) return peerTitle;
    return formatPeerLabel(msg.author || msg.from);
  }
  try {
    const c = await msg.getContact();
    const n = (c.pushname || c.name || c.shortName || '').trim();
    if (n) return n;
  } catch (_) {}
  return formatPeerLabel(msg.author || msg.from);
}

const SUPPRESSED_MESSAGE_TYPES = new Set([
  MessageTypes.E2E_NOTIFICATION,
  MessageTypes.PROTOCOL,
  MessageTypes.GP2,
  MessageTypes.CIPHERTEXT,
  MessageTypes.REACTION,
  MessageTypes.DEBUG,
  MessageTypes.BROADCAST_NOTIFICATION,
  MessageTypes.REVOKED
]);

function shouldEmitUserMessage(msg) {
  if (!msg || msg.isStatus || !msg.id?._serialized) return false;
  if (msg.broadcast) return false;
  if (SUPPRESSED_MESSAGE_TYPES.has(msg.type)) return false;
  const body = msg.body != null ? String(msg.body).trim() : '';
  if (!body && !msg.hasMedia) return false;
  return true;
}

async function quotedSnippetFrom(msg) {
  if (!msg.hasQuotedMsg) return '';
  try {
    const q = await msg.getQuotedMessage();
    if (!q) return '';
    const qb =
      q.body != null && String(q.body).trim()
        ? String(q.body).trim()
        : displayBodyForParts(q.type, Boolean(q.hasMedia), q.body);
    return truncate(qb, 40);
  } catch (_) {
    return '';
  }
}

function chatIdFromClientMessage(msg) {
  if (!msg) return '';
  const to =
    typeof msg.to === 'string'
      ? msg.to
      : msg.to && msg.to._serialized
        ? msg.to._serialized
        : '';
  const from =
    typeof msg.from === 'string'
      ? msg.from
      : msg.from && msg.from._serialized
        ? msg.from._serialized
        : '';
  if (msg.fromMe) return to || from;
  return from || to;
}

function ackFromMessage(msg) {
  if (!msg || !msg.fromMe) return undefined;
  return typeof msg.ack === 'number' ? msg.ack : MessageAck.ACK_PENDING;
}

async function rowFromClientMessage(msg, chat) {
  const author = msg.fromMe ? 'You' : await resolveIncomingAuthor(msg, chat);
  const quotedSnippet = await quotedSnippetFrom(msg);
  return {
    id: msg.id._serialized,
    body: msg.body,
    displayBody: displayBodyForParts(msg.type, msg.hasMedia, msg.body),
    fromMe: msg.fromMe,
    author,
    timestamp: msg.timestamp,
    type: msg.type,
    hasMedia: Boolean(msg.hasMedia),
    hasQuotedMsg: Boolean(msg.hasQuotedMsg),
    quotedSnippet,
    ack: ackFromMessage(msg)
  };
}

class WhatsAppService extends EventEmitter {
  constructor() {
    super();
    this.client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    });
    this.ready = false;
    this._remoteTypingBridgeInstalled = false;
  }

  /**
   * Mark chat as read in WhatsApp (blue ticks for the other party when applicable).
   */
  async markChatSeen(chatId, rawChat = null) {
    if (!chatId) return;
    try {
      let chat = rawChat;
      if (!chat || typeof chat.sendSeen !== 'function') {
        chat = await this.client.getChatById(chatId);
      }
      if (chat && typeof chat.sendSeen === 'function') await chat.sendSeen();
    } catch (_) {}
  }

  /** Notify the peer that we are composing (WhatsApp refreshes ~25s). */
  async pulseOutgoingTyping(chatId, rawChat = null) {
    if (!chatId) return;
    try {
      let chat = rawChat;
      if (!chat || typeof chat.sendStateTyping !== 'function') {
        chat = await this.client.getChatById(chatId);
      }
      if (chat && typeof chat.sendStateTyping === 'function') {
        await chat.sendStateTyping();
      }
    } catch (_) {}
  }

  /** Stop composing/recording indicator for this chat. */
  async clearOutgoingTyping(chatId, rawChat = null) {
    if (!chatId) return;
    try {
      let chat = rawChat;
      if (!chat || typeof chat.clearState !== 'function') {
        chat = await this.client.getChatById(chatId);
      }
      if (chat && typeof chat.clearState === 'function') await chat.clearState();
    } catch (_) {}
  }

  /**
   * Best-effort: listen to WhatsApp Web chat models for remote typing/recording.
   * Emits `remote_typing` with `{ chatId, state: 'typing'|'recording'|null }`.
   */
  async installRemoteTypingBridge() {
    if (this._remoteTypingBridgeInstalled) return;
    const page = this.client && this.client.pupPage;
    if (!page) return;

    try {
      await page.exposeFunction('waTuiRemoteTyping', (json) => {
        let payload;
        try {
          payload = JSON.parse(json);
        } catch (_) {
          return;
        }
        this.emit('remote_typing', payload);
      });
    } catch (err) {
      const m = String(err && err.message ? err.message : err);
      if (!m.includes('already been registered')) {
        return;
      }
    }

    try {
      await page.evaluate(() => {
        if (window.__waTuiTypingHook) return;
        window.__waTuiTypingHook = true;

        const notify = (chatId, state) => {
          try {
            window.waTuiRemoteTyping(
              JSON.stringify({ chatId, state: state || null })
            );
          } catch (_) {}
        };

        const mapState = (v) => {
          if (v == null) return null;
          if (typeof v === 'string') {
            const s = v.toLowerCase();
            if (s.includes('typing') || s === 'composing') return 'typing';
            if (s.includes('record')) return 'recording';
            return null;
          }
          if (typeof v === 'number') {
            if (v === 1) return 'typing';
            if (v === 2) return 'recording';
            if (v === 0) return null;
          }
          if (typeof v === 'object') {
            const t = v.type || v.chatstate || v.state;
            if (t) return mapState(t);
          }
          return null;
        };

        const hookChat = (chat) => {
          if (!chat || !chat.id || chat.__waTuiTypingHook) return;
          if (typeof chat.on !== 'function') return;
          chat.__waTuiTypingHook = true;

          const fire = (raw) => {
            const st = mapState(raw);
            notify(chat.id._serialized, st);
          };

          try {
            chat.on('change:chatState', (_m, v) => fire(v));
          } catch (_) {}
          try {
            chat.on('change:chatstate', (_m, v) => fire(v));
          } catch (_) {}
          try {
            chat.on('change:presence', (_m, v) => fire(v));
          } catch (_) {}
        };

        const store = window.Store;
        if (!store || !store.Chat) return;

        try {
          store.Chat.on('add', hookChat);
        } catch (_) {}
        try {
          if (typeof store.Chat.getModelsArray === 'function') {
            store.Chat.getModelsArray().forEach(hookChat);
          }
        } catch (_) {}
      });
    } catch (_) {}

    this._remoteTypingBridgeInstalled = true;
  }

  async initialize(onQr, onReady, onAuth) {
    if (!isBrowserInstalled()) {
      this.emit('lifecycle', { phase: 'browser_download', percent: 0 });
      await installBrowser((percent) => {
        this.emit('lifecycle', { phase: 'browser_download', percent });
      });
    }
    this.emit('lifecycle', { phase: 'launching' });

    this.client.on('loading_screen', (percent, message) => {
      this.emit('lifecycle', { phase: 'syncing', percent, message });
    });

    this.client.on('qr', (qr) => {
      this.emit('lifecycle', { phase: 'qr' });
      onQr(qr);
    });

    this.client.on('ready', () => {
      this.ready = true;
      this.emit('lifecycle', { phase: 'ready' });
      onReady();
    });

    this.client.on('authenticated', () => {
      this.emit('lifecycle', { phase: 'authenticated' });
      if (onAuth) onAuth();
    });

    this.client.on('auth_failure', (msg) => {
      this.emit('lifecycle', { phase: 'auth_failure', message: msg });
    });

    this.client.on('disconnected', (reason) => {
      this.ready = false;
      this.emit('lifecycle', { phase: 'disconnected', reason });
    });

    this.client.on('message_ack', (msg, ack) => {
      if (!msg || !msg.id?._serialized) return;
      this.emit('message_ack', {
        messageId: msg.id._serialized,
        chatId: chatIdFromClientMessage(msg),
        ack
      });
    });

    this.client.on('message_create', (msg) => {
      void (async () => {
        if (!shouldEmitUserMessage(msg)) return;

        const remote =
          msg.id &&
          msg.id.remote &&
          msg.id.remote !== 'status@broadcast'
            ? String(msg.id.remote)
            : '';
        const chatId = remote || (msg.fromMe ? msg.to : msg.from);
        let chat = null;
        let chatName = '';
        let isGroup = false;

        let author = 'You';
        if (!msg.fromMe) {
          try {
            chat = await msg.getChat();
            chatName =
              (chat && (chat.name || chat.formattedTitle || '').trim()) || '';
            isGroup = Boolean(chat && chat.isGroup);
            author = await resolveIncomingAuthor(msg, chat);
          } catch (_) {
            author = formatPeerLabel(msg.author || msg.from);
            chatName = author;
          }
        }

        const quotedSnippet = await quotedSnippetFrom(msg);

        this.emit('message', {
          id: msg.id._serialized,
          chatId,
          body: msg.body,
          displayBody: displayBodyForParts(msg.type, msg.hasMedia, msg.body),
          timestamp: msg.timestamp,
          author,
          chatName,
          isGroup,
          fromMe: msg.fromMe,
          type: msg.type,
          hasMedia: Boolean(msg.hasMedia),
          hasQuotedMsg: Boolean(msg.hasQuotedMsg),
          quotedSnippet,
          ack: ackFromMessage(msg)
        });
      })();
    });

    this.emit('lifecycle', { phase: 'waiting_auth' });
    return this.client.initialize();
  }

  async getChats() {
    const chats = await this.client.getChats();

    return chats.map((chat, listIndex) => {
      const title =
        chat.name || chat.formattedTitle || (chat.id && chat.id.user) || 'Unknown';

      return {
        id: chat.id._serialized,
        name: title,
        isGroup: chat.isGroup,
        pinned: Boolean(chat.pinned),
        listIndex,
        unreadCount: chat.unreadCount || 0,
        timestamp: chat.timestamp || 0,
        lastMessage: chat.lastMessage ? chat.lastMessage.body : '',
        raw: chat
      };
    });
  }

  async getMessages(chatId, limit = 40, rawChat = null) {
    try {
      let chat = rawChat;

      if (!chat) {
        const chats = await this.getChats();
        const found = chats.find((c) => c.id === chatId);
        if (found) chat = found.raw;
      }

      if (!chat) {
        chat = await this.client.getChatById(chatId).catch(() => null);
      }

      if (!chat || !chat.fetchMessages) return [];

      const messages = await chat.fetchMessages({ limit });
      const filtered = messages.filter((msg) => shouldEmitUserMessage(msg));
      return Promise.all(filtered.map((msg) => rowFromClientMessage(msg, chat)));
    } catch (err) {
      console.error('Error in getMessages:', err);
      return [];
    }
  }

  async sendMessage(chatId, text, rawChat = null, sendOptions = {}) {
    try {
      const hasQuote = Boolean(sendOptions && sendOptions.quotedMessageId);
      if (hasQuote) {
        return this.client.sendMessage(chatId, text, sendOptions);
      }
      if (rawChat && rawChat.sendMessage) {
        return rawChat.sendMessage(text);
      }
      if (chatId == null || chatId === '') {
        throw new Error('No chat selected');
      }
      return this.client.sendMessage(chatId, text);
    } catch (err) {
      console.error('Error in sendMessage:', err);
      throw err;
    }
  }

  /** Saves media to ~/Downloads/wa-tui/, returns absolute file path. */
  async downloadMessageMedia(messageId, chatId, rawChat = null) {
    let chat = rawChat;
    if (!chat) {
      const chats = await this.getChats();
      const found = chats.find((c) => c.id === chatId);
      if (found) chat = found.raw;
    }
    if (!chat) {
      chat = await this.client.getChatById(chatId).catch(() => null);
    }
    if (!chat || !chat.fetchMessages) {
      throw new Error('Chat not available');
    }
    const messages = await chat.fetchMessages({ limit: 80 });
    const msg = messages.find((m) => m.id._serialized === messageId);
    if (!msg) throw new Error('Message not found');
    if (!msg.hasMedia) throw new Error('This message has no media to download');
    const media = await msg.downloadMedia();
    if (!media || !media.data) throw new Error('Download failed');

    const dir = path.join(os.homedir(), 'Downloads', 'wa-tui');
    fs.mkdirSync(dir, { recursive: true });
    const ext =
      (media.mimetype && media.mimetype.split('/')[1] && media.mimetype.split('/')[1].split(';')[0]) ||
      'bin';
    const safe = String(messageId).replace(/[^a-z0-9]+/gi, '_').slice(-24);
    const fname = `${Date.now()}_${safe}.${ext}`;
    const fpath = path.join(dir, fname);
    fs.writeFileSync(fpath, media.data, 'base64');
    return fpath;
  }

  async logoutSession() {
    this.ready = false;
    try {
      await this.client.logout();
    } catch (err) {
      console.error('Logout:', err.message || err);
      try {
        await this.client.destroy();
      } catch (_) {}
    }
  }
}

module.exports = new WhatsAppService();
