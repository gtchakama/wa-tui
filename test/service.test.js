const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageAck, MessageTypes } = require('whatsapp-web.js');

const service = require('../src/whatsapp/service');

test('service exposes private helpers for unit testing message transformation', () => {
  assert.ok(service.__private);
});

test('shouldEmitUserMessage rejects empty non-media and suppressed protocol messages', () => {
  const { shouldEmitUserMessage } = service.__private;

  assert.equal(
    shouldEmitUserMessage({
      id: { _serialized: 'm1' },
      type: MessageTypes.TEXT,
      body: '   ',
      hasMedia: false
    }),
    false
  );

  assert.equal(
    shouldEmitUserMessage({
      id: { _serialized: 'm2' },
      type: MessageTypes.PROTOCOL,
      body: 'hello',
      hasMedia: false
    }),
    false
  );
});

test('shouldEmitUserMessage keeps media-only rows that a user can act on', () => {
  const { shouldEmitUserMessage } = service.__private;

  assert.equal(
    shouldEmitUserMessage({
      id: { _serialized: 'm3' },
      type: MessageTypes.IMAGE,
      body: '',
      hasMedia: true
    }),
    true
  );
});

test('chatIdFromClientMessage prefers the destination for sent messages', () => {
  const { chatIdFromClientMessage } = service.__private;

  assert.equal(
    chatIdFromClientMessage({
      fromMe: true,
      to: { _serialized: '123@c.us' },
      from: { _serialized: 'me@c.us' }
    }),
    '123@c.us'
  );
});

test('ackFromMessage uses pending as the fallback for sent messages without an ack yet', () => {
  const { ackFromMessage } = service.__private;

  assert.equal(ackFromMessage({ fromMe: true }), MessageAck.ACK_PENDING);
  assert.equal(ackFromMessage({ fromMe: false, ack: MessageAck.ACK_READ }), undefined);
});

test('rowFromClientMessage builds a renderable row with author, quote and ack data', async () => {
  const { rowFromClientMessage } = service.__private;
  const chat = { isGroup: true };
  const msg = {
    id: { _serialized: 'abc' },
    body: '',
    fromMe: false,
    timestamp: 1710000000,
    type: MessageTypes.IMAGE,
    hasMedia: true,
    hasQuotedMsg: true,
    author: '263123456789@c.us',
    from: '120363@g.us',
    getContact: async () => ({ pushname: 'Tariro' }),
    getQuotedMessage: async () => ({
      body: 'This quoted message is long enough to be truncated after forty characters',
      type: MessageTypes.TEXT,
      hasMedia: false
    })
  };

  const row = await rowFromClientMessage(msg, chat);

  assert.deepEqual(row, {
    id: 'abc',
    body: '',
    displayBody: '[image]',
    fromMe: false,
    author: 'Tariro',
    timestamp: 1710000000,
    type: MessageTypes.IMAGE,
    hasMedia: true,
    hasQuotedMsg: true,
    quotedSnippet: 'This quoted message is long enough to be...',
    ack: undefined
  });
});
