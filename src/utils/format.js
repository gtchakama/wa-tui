function formatTimestamp(timestamp) {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function truncate(str, len = 40) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.substring(0, len) + '...';
}

/** Compare chat JIDs when WA uses @c.us vs @s.whatsapp.net (or casing differs). */
function canonicalChatIdForCompare(id) {
  if (!id || typeof id !== 'string') return '';
  const lower = id.toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at === -1) return lower;
  const user = lower.slice(0, at);
  const host = lower.slice(at + 1);
  if (host === 'g.us') return `${user}@g.us`;
  if (host === 'c.us' || host === 's.whatsapp.net') return `${user}@c.us`;
  return lower;
}

function chatIdsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return canonicalChatIdForCompare(a) === canonicalChatIdForCompare(b);
}

/** Readable fallback when pushname is missing (e.g. +263… instead of raw JID). */
/**
 * Sanitize text for blessed rendering.
 * Escapes blessed tag syntax and strips invisible zero-width characters
 * that cause rendering artifacts, while preserving visible emoji.
 */
function sanitizeForBlessed(text) {
  if (!text) return text;
  return String(text)
    .replace(/\{/g, '(')
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD]/g, '');
}

function formatPeerLabel(jidOrName) {
  if (jidOrName == null || jidOrName === '') return '';
  const s = String(jidOrName);
  if (!s.includes('@')) return s;
  const at = s.lastIndexOf('@');
  const user = s.slice(0, at);
  const host = s.slice(at + 1).toLowerCase();
  if (host === 'g.us') return s;
  if (/^\d+$/.test(user)) return `+${user}`;
  return user;
}

module.exports = {
  formatTimestamp,
  truncate,
  chatIdsMatch,
  formatPeerLabel,
  sanitizeForBlessed
};
