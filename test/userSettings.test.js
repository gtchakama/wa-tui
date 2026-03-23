const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const modulePath = require.resolve('../src/config/userSettings');

function loadFreshUserSettings(fakeHome) {
  const originalHomedir = os.homedir;
  os.homedir = () => fakeHome;
  delete require.cache[modulePath];
  try {
    return require('../src/config/userSettings');
  } finally {
    os.homedir = originalHomedir;
  }
}

test('loadSettings returns an empty object when the file is missing', async (t) => {
  const fakeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-tui-settings-'));
  t.after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

  const settings = loadFreshUserSettings(fakeHome);
  assert.deepEqual(settings.loadSettings(), {});
});

test('saveSettings merges new values with previously saved settings', async (t) => {
  const fakeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-tui-settings-'));
  t.after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

  const settings = loadFreshUserSettings(fakeHome);
  assert.deepEqual(settings.saveSettings({ palette: 'amber' }), { palette: 'amber' });
  assert.deepEqual(
    settings.saveSettings({ unreadOnly: true }),
    { palette: 'amber', unreadOnly: true }
  );

  const raw = fs.readFileSync(settings.SETTINGS_PATH, 'utf8');
  assert.deepEqual(JSON.parse(raw), { palette: 'amber', unreadOnly: true });
});
