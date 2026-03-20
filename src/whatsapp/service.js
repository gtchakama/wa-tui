const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  Client,
  LocalAuth,
  MessageTypes
} = require('whatsapp-web.js');
const EventEmitter = require('events');
const { formatPeerLabel, truncate } = require('../utils/format');
const { displayBodyForParts } = require('../utils/messageFormat');

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
    quotedSnippet
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
  }

  initialize(onQr, onReady, onAuth) {
    this.client.on('qr', (qr) => {
      onQr(qr);
    });

    this.client.on('ready', () => {
      this.ready = true;
      onReady();
    });

    this.client.on('authenticated', () => {
      if (onAuth) onAuth();
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

        let author = 'You';
        if (!msg.fromMe) {
          try {
            const chat = await msg.getChat();
            author = await resolveIncomingAuthor(msg, chat);
          } catch (_) {
            author = formatPeerLabel(msg.author || msg.from);
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
          fromMe: msg.fromMe,
          type: msg.type,
          hasMedia: Boolean(msg.hasMedia),
          hasQuotedMsg: Boolean(msg.hasQuotedMsg),
          quotedSnippet
        });
      })();
    });

    this.client.on('auth_failure', (msg) => {
      console.error('Authentication failure:', msg);
    });

    return this.client.initialize();
  }

  async getChats() {
    const chats = await this.client.getChats();
    const sorted = chats.sort((a, b) => b.timestamp - a.timestamp);

    return sorted.map((chat) => {
      const title =
        chat.name || chat.formattedTitle || (chat.id && chat.id.user) || 'Unknown';

      return {
        id: chat.id._serialized,
        name: title,
        isGroup: chat.isGroup,
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
