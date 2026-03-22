const { MessageTypes } = require('whatsapp-web.js');
const { truncate, sanitizeForBlessed } = require('./format');

function mediaBracketLabel(type, hasMedia) {
  if (!hasMedia) return null;
  switch (type) {
    case MessageTypes.IMAGE:
    case MessageTypes.ALBUM:
      return 'image';
    case MessageTypes.VIDEO:
      return 'video';
    case MessageTypes.VOICE:
      return 'voice';
    case MessageTypes.AUDIO:
      return 'audio';
    case MessageTypes.DOCUMENT:
      return 'doc';
    case MessageTypes.STICKER:
      return 'sticker';
    case MessageTypes.LOCATION:
      return 'location';
    default:
      return 'media';
  }
}

/** Primary line body: caption/text or [kind] for media-only. */
function displayBodyForParts(type, hasMedia, body) {
  const text = body != null ? String(body).trim() : '';
  if (text) return text;
  const kind = mediaBracketLabel(type, hasMedia);
  return kind ? `[${kind}]` : '';
}

/** Plain text augmentation (renderer applies colors). */
function augmentDisplayPlain(row) {
  const base =
    displayBodyForParts(row.type, row.hasMedia, row.body) || '—';
  let out = base;
  if (row.hasQuotedMsg && row.quotedSnippet) {
    out += ` (re: ${row.quotedSnippet})`;
  }
  if (row.localPath) {
    out += ` @ ${truncate(row.localPath, 56)}`;
  }
  return sanitizeForBlessed(out);
}

module.exports = {
  mediaBracketLabel,
  displayBodyForParts,
  augmentDisplayPlain
};
