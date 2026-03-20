const { spawn } = require('child_process');
const fs = require('fs');

function trySpawn(cmd, args, extra = {}) {
  try {
    const child = spawn(cmd, args, {
      stdio: 'ignore',
      detached: true,
      ...extra
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Short notification when an incoming message arrives elsewhere in the UI.
 * Set WA_TUI_NO_SOUND=1 to disable.
 */
function playIncomingMessageSound() {
  if (process.env.WA_TUI_NO_SOUND === '1') return;

  const platform = process.platform;

  if (platform === 'darwin') {
    const custom = process.env.WA_TUI_SOUND && String(process.env.WA_TUI_SOUND).trim();
    if (custom && fs.existsSync(custom) && trySpawn('afplay', [custom])) return;
    const ping = '/System/Library/Sounds/Ping.aiff';
    if (fs.existsSync(ping) && trySpawn('afplay', [ping])) return;
  }

  if (platform === 'win32') {
    if (
      trySpawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[console]::Beep(1050, 45); [console]::Beep(1400, 65)'
        ],
        { windowsHide: true }
      )
    ) {
      return;
    }
  }

  if (platform === 'linux') {
    const custom = process.env.WA_TUI_SOUND && String(process.env.WA_TUI_SOUND).trim();
    if (custom && fs.existsSync(custom)) {
      if (trySpawn('paplay', [custom])) return;
      if (trySpawn('aplay', ['-q', custom])) return;
    }
    const complete = '/usr/share/sounds/freedesktop/stereo/complete.oga';
    if (fs.existsSync(complete) && trySpawn('paplay', [complete])) return;
    const oga = '/usr/share/sounds/freedesktop/stereo/message.oga';
    if (fs.existsSync(oga) && trySpawn('paplay', [oga])) return;
    const wav = '/usr/share/sounds/sound-icons/echocancel.wav';
    if (fs.existsSync(wav) && trySpawn('aplay', ['-q', wav])) return;
  }

  try {
    process.stdout.write('\x07');
  } catch {
    // ignore
  }
}

module.exports = { playIncomingMessageSound };
