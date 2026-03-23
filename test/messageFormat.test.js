const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageTypes } = require('whatsapp-web.js');

const {
  mediaBracketLabel,
  displayBodyForParts,
  augmentDisplayPlain
} = require('../src/utils/messageFormat');

test('mediaBracketLabel maps known WhatsApp media types to short labels', () => {
  assert.equal(mediaBracketLabel(MessageTypes.IMAGE, true), 'image');
  assert.equal(mediaBracketLabel(MessageTypes.DOCUMENT, true), 'doc');
  assert.equal(mediaBracketLabel(MessageTypes.TEXT, true), 'media');
});

test('displayBodyForParts prefers trimmed text over media fallback labels', () => {
  assert.equal(displayBodyForParts(MessageTypes.IMAGE, true, '  caption  '), 'caption');
});

test('displayBodyForParts returns a bracket label for media-only messages', () => {
  assert.equal(displayBodyForParts(MessageTypes.VOICE, true, ''), '[voice]');
});

test('augmentDisplayPlain appends quote and open hints for media rows', () => {
  const text = augmentDisplayPlain({
    type: MessageTypes.IMAGE,
    hasMedia: true,
    body: '',
    hasQuotedMsg: true,
    quotedSnippet: 'earlier',
    localPath: '/tmp/file.jpg'
  });

  assert.equal(text, '[image] (re: earlier) [click or Ctrl+O to open]');
});

test('augmentDisplayPlain falls back to an em dash for empty non-media rows', () => {
  const text = augmentDisplayPlain({
    type: MessageTypes.TEXT,
    hasMedia: false,
    body: '   ',
    hasQuotedMsg: false
  });

  assert.equal(text, '—');
});
