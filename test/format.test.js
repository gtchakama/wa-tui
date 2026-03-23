const test = require('node:test');
const assert = require('node:assert/strict');

const {
  truncate,
  chatIdsMatch,
  formatPeerLabel,
  sanitizeForBlessed
} = require('../src/utils/format');

test('truncate returns the original string when it already fits', () => {
  assert.equal(truncate('hello', 10), 'hello');
});

test('truncate appends ellipsis after cutting at the requested length', () => {
  assert.equal(truncate('abcdefghijklmnopqrstuvwxyz', 5), 'abcde...');
});

test('chatIdsMatch normalizes direct-message hostnames and casing', () => {
  assert.equal(chatIdsMatch('263123456789@C.US', '263123456789@s.whatsapp.net'), true);
});

test('chatIdsMatch keeps group ids distinct from direct-message ids', () => {
  assert.equal(chatIdsMatch('1203630@g.us', '1203630@c.us'), false);
});

test('formatPeerLabel formats numeric WhatsApp ids as phone numbers', () => {
  assert.equal(formatPeerLabel('263123456789@c.us'), '+263123456789');
});

test('sanitizeForBlessed removes zero-width characters and curly braces', () => {
  assert.equal(sanitizeForBlessed('hi{there}\u200B'), 'hi(there}');
});
