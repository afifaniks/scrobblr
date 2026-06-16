<div align="center">

<img src="icons/icon128.png" width="96" height="96" alt="Scrobblr icon" />

# Scrobblr

**Automatically scrobble the music videos you watch on YouTube to your [Last.fm](https://www.last.fm) profile.**

A lightweight, privacy-respecting Chrome extension (Manifest V3). No tracking, no servers, no remote code — your data goes only to Last.fm.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-green)
![No dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)

</div>

## What it does

When you watch a music video on YouTube or YouTube Music, this extension detects the track, cleans up the title into an artist/song pair, and scrobbles it to Last.fm — automatically, once you've watched **more than one minute** or the video **finishes**. Only videos in your allowed YouTube categories are scrobbled (Music and Entertainment by default), so vlogs and tutorials don't pollute your library.

## Features

- **Automatic scrobbling** once a track has been *actively* played for 60 seconds or plays to the end. Pauses and seeks don't inflate the counter — only real watch time counts.
- **Live "Scrobbling now" indicator** with an animated equalizer in the popup, which clears the moment you pause the video or pause scrobbling, and flips to "Scrobbled ✓" when submitted.
- **Toolbar icon as a play indicator** — coloured while a music video is playing, muted grey when idle. No numeric badge.
- **Recent scrobbles** showing the latest 5, expandable to the full list (up to 50). Click any entry to reopen it on YouTube.
- **Smart artist/title parsing** that handles `Artist - Title`, strips noise like `(Official Video)` / `[Lyrics]`, and understands VEVO channels and YouTube Music "Topic" art-tracks.
- **Customizable title cleanup** — add your own words/phrases to strip (e.g. `Sped Up`, `8D Audio`, `Nightcore`) on top of the built-in list.
- **Category allow-list** built on YouTube's own category metadata. Add any category you like (Gaming, Comedy, …) from the settings page.
- **Configurable scrobble delay** — choose how many seconds of active play trigger a scrobble (default 60, or on completion).
- **Pause/resume** scrobbling instantly from the popup (On / Paused).
- **Unscrobble** any recent track with one click.
- **One-click Last.fm sign-in** via Chrome's identity flow — connect once and stay signed in.
- **Elegant dark UI** for both the popup and the settings page.

## How it works

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest: permissions, content-script + service-worker registration, CSP. |
| `background.js` | Service worker — Last.fm API calls, MD5 request signing, auth, scrobble recording, badge, unscrobble. |
| `md5.js` | Dependency-free, UTF-8-correct MD5 used to sign Last.fm requests. |
| `inject.js` | Runs in the YouTube **page context** to read the player's internal data (video id, title, author, length, **category**). |
| `content.js` | Injects the probe, tracks real playback time with event-driven play/pause/ended handlers, parses the track, applies the category filter, and drives now-playing/scrobble. |
| `noise.js` | Shared built-in title-cleanup word list, used by both the parser and the settings page. |
| `popup/` | Toolbar popup: status, On/Paused toggle, live track, recent scrobbles with unscrobble. |
| `options/` | Settings: API credentials, connect/disconnect, category manager. |

## Install

This extension isn't on the Chrome Web Store yet, so load it unpacked:

1. Download or clone this repository.
2. Open `chrome://extensions` and enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the project folder.
4. The equalizer icon appears in your toolbar.

Works in any Chromium browser (Chrome, Edge, Brave, Arc, …).

## Setup

Last.fm's API requires an application key. This is a one-time, ~60-second step:

1. **Register an API account** at <https://www.last.fm/api/account/create>. Give it any name and description; the Callback URL can be anything. Submit, then copy the **API key** and **Shared secret** (two distinct values).
2. Open the extension's **Settings** (right-click the icon → Options, or the link in the popup). Paste the **API key** and **Shared secret** into step 1.
3. Click **Connect Last.fm**. A Last.fm window opens — click **Yes, allow access** and it connects automatically. (If Last.fm rejects the callback, copy the redirect URL shown under the button into your API app's **Callback URL** field and retry.)
4. Adjust your **categories** in step 3 if you wish.

Done. Play a music video and watch it scrobble.

> **Why do I need a key?** Every Last.fm API call must be signed with an application key + shared secret. Apps that seem "keyless" simply ship the developer's key baked in. This extension keeps the key on your machine instead, so nothing is shared and the project contains no secrets.

## Usage notes

- **Pause scrobbling** anytime with the On/Paused switch in the popup. While paused, nothing is sent and the live card is hidden.
- **Unscrobble** by hovering a recent entry and clicking ✕. This always removes it from the extension's history. Because Last.fm has **no official delete API**, removing it from Last.fm itself is done by replaying the site's own delete request inside an open, signed-in `last.fm` tab — so keep a Last.fm tab open if you want the deletion to propagate there.
- The **scrobble delay is configurable** in Settings → Behaviour (default 60 seconds of active play, or video end — whichever comes first). Set it anywhere from 10 seconds to 60 minutes.

## Privacy & security

This extension is built to be minimal and trustworthy:

- **No servers, no analytics, no third parties.** The only network requests go to `ws.audioscrobbler.com` (the Last.fm API) and `www.last.fm` (sign-in and unscrobble). Nothing else.
- **No remote code.** All logic ships in the package, including the MD5 implementation. A strict Content-Security-Policy (`script-src 'self'`) forbids inline or remote scripts and `eval`.
- **Least-privilege permissions** (see below). No `tabs`, no broad host access.
- **Your secrets stay local.** The API key, shared secret, and Last.fm session key live in `chrome.storage.local` on your device. The shared secret is never transmitted — only an MD5 signature derived from it is sent, exactly as the Last.fm protocol requires.
- **Hardened messaging.** Background messages are accepted only from the extension's own contexts; page↔content messaging is origin-checked; the reported video id is cross-checked against the page URL; and all UI is rendered with safe DOM APIs (no `innerHTML` of untrusted text), so a malicious video title can't inject markup.

See [SECURITY.md](SECURITY.md) for the full threat model, the security review, and how to report a vulnerability.

### Permissions

| Permission | Why |
|------------|-----|
| `storage` | Save your settings, credentials, session, and recent scrobbles locally. |
| `identity` | Open the Last.fm sign-in window and detect when it completes. |
| `scripting` | Run the unscrobble delete request inside a logged-in `last.fm` tab (the only way Last.fm accepts it). Used on `last.fm` only. |
| `host: ws.audioscrobbler.com` | Call the Last.fm API. |
| `host: www.last.fm` | Sign in and unscrobble. |
| content script on `youtube.com` / `music.youtube.com` | Detect what's playing. |

## Limitations

- **Artist/title parsing is heuristic.** Oddly titled uploads may scrobble imperfectly; Music-category and YouTube Music "Topic" tracks are the most reliable.
- **Unscrobble's remote deletion** depends on an open, signed-in Last.fm tab, because there is no official delete API.
- **Category filtering** uses YouTube's own categories; since "Entertainment" is allowed by default, some non-music entertainment videos can scrobble. Narrow the list to just **Music** for music-only behavior.

## Development

No build step and no dependencies — it's plain JavaScript. Edit the files and hit the reload button on the extension card at `chrome://extensions`.

```
.
├── manifest.json
├── background.js        # service worker
├── md5.js               # request signing
├── noise.js             # shared built-in cleanup words
├── content.js           # YouTube playback tracking
├── inject.js            # page-context metadata probe
├── popup/               # toolbar popup
├── options/             # settings page
└── icons/
```

Quick sanity check before committing:

```bash
for f in background.js content.js inject.js md5.js popup/popup.js options/options.js; do node --check "$f"; done
```

## Contributing

Issues and pull requests are welcome. Please keep the project dependency-free and within the existing least-privilege/security posture described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) — not affiliated with or endorsed by Last.fm or YouTube. "Last.fm" and "YouTube" are trademarks of their respective owners.

## Disclaimer

Full transparency: I vibe-coded this with Claude Opus 4.8. It works for me, but I'm not making any promises — there's no warranty here, so use it at your own risk and you're responsible for whatever it does on your account. It signs into Last.fm with *your own* API key and only ever talks to Last.fm (nothing else, no servers of mine), and I did my best to keep it safe and minimal — the whole thing is in [SECURITY.md](SECURITY.md) and the code is right here, so please read it before you trust it. The artist/title parsing is just heuristics, so it'll occasionally scrobble something wrong; if that bugs you, fix it and send a PR. Not affiliated with Last.fm or YouTube in any way.