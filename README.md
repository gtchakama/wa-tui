# wa-tui

Terminal UI for WhatsApp Web, built with [neo-blessed](https://www.npmjs.com/package/neo-blessed) and [whatsapp-web.js](https://wwebjs.dev/). Scan a QR code in the terminal, then browse chats, read messages, reply, and download media without leaving your shell.

## Requirements

- **Node.js** 18 or newer  
- **Google Chrome** or **Chromium** installed locally — `whatsapp-web.js` drives a headless browser session; if startup fails, install Chrome or point Puppeteer at your binary (see [whatsapp-web.js docs](https://docs.wwebjs.dev/)).

Session data and cache are stored under `.wwebjs_auth` and `.wwebjs_cache` in the current working directory (and settings under `~/.wa-tui/`).

## Install

### Homebrew (macOS / Linux)

Uses [Homebrew](https://brew.sh/) so `wa-tui` is on your PATH like any other CLI. This repository contains [`Formula/wa-tui.rb`](Formula/wa-tui.rb), which installs the published npm tarball and pulls in **Node** as a dependency. Because the GitHub repository is named `wa-tui` rather than `homebrew-wa-tui`, tap it with an explicit URL:

```bash
brew tap gtchakama/wa-tui https://github.com/gtchakama/wa-tui
brew install gtchakama/wa-tui/wa-tui
```

Upgrade later with `brew upgrade wa-tui`. You still need **Chrome** or **Chromium** locally (see Requirements).

### npm

```bash
npm install -g @gtchakama/wa-tui
```

Or run without a global install:

```bash
npx @gtchakama/wa-tui
```

From a git checkout:

```bash
npm install
npm start
```

## Usage

```bash
wa-tui
```

Run the command from whatever directory you want to use for WhatsApp session files (`.wwebjs_auth`, `.wwebjs_cache` are created in the **current working directory**). Per-user settings live under `~/.wa-tui/`.

### First run (QR)

1. Start `wa-tui` and wait for the QR block to appear in the terminal.
2. On your phone open **WhatsApp → Settings → Linked devices → Link a device** and scan the code.
3. After login, the **chat list** loads. The **footer** at the bottom shows shortcuts for the screen you’re on.

### Chat list

- **Move** through chats with **↑↓** (or **j / k**).
- **Enter** opens the highlighted chat.
- **Mouse**: you can click a row if your terminal supports it.
- **1** All chats · **2** Direct messages only · **3** Groups only.
- **U** Toggle **unread-only** list.
- **O** Cycle sort: **recent** → **unread first** → **A–Z**.
- **N** / **P** Next / previous **page** of chats (see header `P1`, `P2`, …).
- **R** Reload the chat list.
- **F2** Open **colour settings** (palette applies after **Enter**; **Esc** / **F2** closes).
- **Ctrl+L** **Log out** (ends the session and exits).
- **Q** or **Ctrl+C** **Quit** without logging out (session may remain linked).

### Inside a conversation

- Focus is on the **message box** at the bottom. Type text and press **Enter** to **send**.
- **Esc** If you’re quoting a message, clears the quote; if not, **returns to the chat list** (draft for that chat is kept).
- **B** **Back** to the chat list (same as Esc when not quoting).
- **Ctrl+↑** / **Ctrl+↓** Move the **quote/reply** target to a **newer or older** message (▶ marks the selected line). Then send as usual to reply quoting that message.
- **Ctrl+D** **Download** media from the quoted message if it has an attachment; otherwise tries the latest message with media. Saved under **`~/Downloads/wa-tui/`** (path is echoed in the log).
- Scroll the transcript with the mouse wheel or your terminal’s scroll keys if supported (**PgUp** / **PgDn** often work on focused log widgets).

### Colour settings (F2)

- Choose a palette and press **Enter** to apply. Settings are written to **`~/.wa-tui/settings.json`**.
- **Esc** or **F2** closes settings. **Q** still quits the app.

### Environment variables

| Variable | Description |
| -------- | ----------- |
| `WA_TUI_RESIZE` | Set to `1` to enable resize-related behavior used during development (`npm run start:resize`). |
| `WA_TUI_NO_SOUND` | Set to `1` to disable the incoming-message notification sound. |
| `WA_TUI_SOUND` | Optional path to an audio file (macOS: `afplay`; Linux: `paplay` / `aplay`). Overrides the default tone. |

Incoming messages play a short sound when you are **not** viewing that chat. Defaults: **macOS** — `Ping.aiff` via `afplay`; **Windows** — short two-tone console beep; **Linux** — freedesktop `complete.oga` or `message.oga`, then WAV fallback; otherwise the terminal bell. There is no sound for your own messages or for messages in the chat you currently have open.

## Scripts (development)

| Command | Description |
| ------- | ----------- |
| `npm start` | Run the TUI |
| `npm run start:resize` | Run with `WA_TUI_RESIZE=1` |

## Maintainers: bump the Homebrew formula

After publishing a new version to npm, update **`url`**, **`sha256`**, and the version segment in the tarball path inside [`Formula/wa-tui.rb`](Formula/wa-tui.rb) to match `package.json`. Get `sha256`:

```bash
V=$(npm view @gtchakama/wa-tui version)
curl -sL "https://registry.npmjs.org/@gtchakama/wa-tui/-/wa-tui-${V}.tgz" | shasum -a 256
```

Commit the formula change on the default branch so `brew upgrade` sees it.

## Disclaimer

WhatsApp’s terms of service apply to any client you use. This project is an unofficial interface; use it at your own risk.

## License

ISC
