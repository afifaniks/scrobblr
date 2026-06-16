# Security

This document describes the security posture, threat model, and the results of an internal
security review of the Scrobblr extension (YouTube → Last.fm scrobbling).

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, report privately via the
repository's security advisories (GitHub → *Security* → *Report a vulnerability*) or by email to
the maintainer. You'll get an acknowledgement, and fixes for confirmed issues will be released as
promptly as possible.

## Design principles

- **No backend.** The extension talks only to Last.fm. There is no analytics, telemetry, or any
  third-party endpoint.
- **No remote code.** Everything executes from the packaged files. MD5 signing is implemented
  locally rather than loaded from a CDN.
- **Least privilege.** Only the permissions strictly required are requested.
- **Secrets stay on device.** Credentials and the session key are stored in `chrome.storage.local`
  and never leave the browser, except as the MD5 signature the Last.fm protocol requires.

## Trust boundaries

| Boundary | Notes |
|----------|-------|
| Web page → content script | The content script reads YouTube player data via a page-context probe and `window.postMessage`. Messages are checked for `source`, same-origin, and the video id is cross-checked against the page URL. |
| Content script / pages → background worker | `chrome.runtime.onMessage` accepts messages **only** from the extension's own contexts (`sender.id === chrome.runtime.id`). No `externally_connectable` is declared, so external sites cannot message the worker. |
| Extension → Last.fm API | All requests are HTTPS. Authenticated calls are signed (MD5 of sorted params + shared secret). Session key is sent in POST bodies, never in URLs. |
| Extension → last.fm website (unscrobble) | Deletion runs as a first-party request injected into a logged-in `last.fm` tab, scoped to the `www.last.fm` host permission. |

## Content-Security-Policy

Extension pages run under:

```
script-src 'self'; object-src 'self'; base-uri 'none'
```

No inline scripts, no remote scripts, no `eval`.

## Handling of untrusted input

- **Video titles/metadata** are treated as untrusted. They are rendered in the popup using
  `textContent` / escaped helpers — never `innerHTML` of raw values — preventing HTML/script
  injection from a crafted video title.
- **Injected delete arguments** (artist, title, timestamp, username) are passed to the injected
  function as **arguments**, not concatenated into code, and are URL-encoded in the request body,
  so they cannot break out into executable code.

## Security review summary

An internal review of all source files (`manifest.json`, `background.js`, `content.js`,
`inject.js`, `md5.js`, `popup/*`, `options/*`) found **no critical or high-severity issues**:
no XSS, no secret leakage, no remote code, no code injection, and no over-broad permissions.

The following defense-in-depth hardening was applied as a result of the review:

1. **Sender validation** — the background message router rejects any message whose
   `sender.id` is not this extension.
2. **Input validation** — credentials and category lists received over messages are coerced to
   strings, trimmed, de-duplicated, and length-capped before storage.
3. **Anti-spoofing** — on a `/watch` page the content script discards reported metadata whose
   video id doesn't match the URL's `v` parameter, limiting same-origin metadata spoofing.
4. **Reduced fingerprinting** — `inject.js` is exposed with `use_dynamic_url: true` so its URL
   isn't a stable installation fingerprint.
5. **Origin-restricted `postMessage`** — the page-context probe and content script exchange
   messages using `window.location.origin` as the target and verify `event.origin`.

### Known, accepted residual risks

- **Same-origin metadata spoofing.** Reading YouTube's player globals inherently trusts code
  running in the `youtube.com` origin. A successful XSS *on YouTube itself* could feed false
  track metadata and cause spurious scrobbles. Impact is limited to incorrect scrobbles (no
  credential or account compromise), and the anti-spoofing URL check raises the bar. This is
  inherent to any scrobbler that reads page data and is accepted.
- **Unscrobble via the website endpoint.** Last.fm provides no official delete API; the
  first-party injection approach is the supported community method and may break if Last.fm
  changes its site. Failure is non-destructive (the local removal still succeeds).
- **Shared secret visibility.** The shared secret is entered by the user and stored locally; any
  software with access to the user's profile could read `chrome.storage.local`. This matches the
  trust model of every installed Last.fm client.

## Dependencies

None. The extension has zero third-party runtime dependencies, which eliminates supply-chain risk
from npm packages.
