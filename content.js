// Content script (isolated world). Injects the page-context probe, receives
// video metadata, tracks real playback time, applies the category filter,
// and tells the background worker when to update "now playing" / scrobble.

const TAG = "YTSCROBBLER";
const DEFAULT_SCROBBLE_AFTER = 60; // seconds of active play (user-configurable) OR completion
const NOW_PLAYING_AFTER_SECONDS = 5;

// After the extension is reloaded/updated, a content script left running on an
// already-open tab will throw "Extension context invalidated" on every chrome.*
// call. Guard all messaging: detect that once and quietly shut this instance down.
let contextDead = false;
function contextAlive() {
  try { return !contextDead && chrome.runtime && !!chrome.runtime.id; }
  catch (e) { return false; }
}
function safeSend(message) {
  if (!contextAlive()) { shutDown(); return; }
  try {
    chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
  } catch (e) {
    shutDown();
  }
}
function shutDown() {
  contextDead = true;
  try { stopTicker(); } catch (e) { /* ignore */ }
}

// ---- inject the page-context probe ----
(function injectProbe() {
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("inject.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { /* ignore */ }
})();

// =================== smart artist/title parser ===================
// Built-in cleanup words come from the shared noise.js (loaded before this file).
const NOISE = (typeof YTS_BUILTIN_NOISE !== "undefined") ? YTS_BUILTIN_NOISE : [];

// User-added noise phrases (lowercased), e.g. "sped up", "8d audio". Updated from storage.
let userNoise = [];
function escapeRegex(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function matchesNoise(low, n) {
  return low === n || low.startsWith(n + " ") || low.endsWith(" " + n) || low.includes(n);
}

function stripBrackets(str) {
  // remove (...) and [...] chunks that are pure noise, keep meaningful ones (e.g. feat., remix)
  return str.replace(/[\(\[\{]([^\)\]\}]*)[\)\]\}]/g, (m, inner) => {
    const low = inner.trim().toLowerCase();
    if (/feat\.?|ft\.?|featuring|remix|mix|version|acoustic|cover|prod\.?/.test(low)) return m;
    for (const n of NOISE) if (matchesNoise(low, n)) return "";
    for (const n of userNoise) if (matchesNoise(low, n)) return "";
    return m;
  });
}

function cleanField(str) {
  if (!str) return "";
  let s = stripBrackets(str);
  // trailing " - Official Video" style suffixes after a dash
  s = s.replace(/[\-–—−]\s*(official\s+)?(music\s+)?(video|audio|lyric[s]?( video)?|visualizer|mv)\s*$/i, "");
  // strip user-added noise phrases wherever they appear as whole words
  for (const n of userNoise) {
    if (!n) continue;
    s = s.replace(new RegExp("(^|[\\s\\-–—|])" + escapeRegex(n) + "($|[\\s\\-–—|])", "gi"), " ");
  }
  s = s.replace(/\s{2,}/g, " ").replace(/^[\-–—−"'\s|]+|[\-–—−"'\s|]+$/g, "").trim();
  return s;
}

function cleanArtist(a) {
  if (!a) return "";
  let s = a.replace(/\s*-\s*Topic$/i, "");           // YouTube Music auto channels
  s = s.replace(/VEVO$/i, "").replace(/Official$/i, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

// Returns {artist, title} or null if we can't confidently parse.
function parseTrack(meta) {
  const rawTitle = (meta.title || "").trim();
  const author = (meta.author || "").trim();
  if (!rawTitle) return null;

  // YouTube Music "Art Track": author is "<Artist> - Topic", title is the song
  if (/-\s*Topic$/i.test(author)) {
    return { artist: cleanArtist(author), title: cleanField(rawTitle) };
  }

  // Title with an artist/title separator
  const sep = rawTitle.split(/\s+[\-–—−]\s+/);
  if (sep.length >= 2) {
    const artist = cleanArtist(cleanField(sep[0]));
    const title = cleanField(sep.slice(1).join(" - "));
    if (artist && title) return { artist, title };
  }

  // Fallback: channel as artist, cleaned title as track
  const artist = cleanArtist(author);
  const title = cleanField(rawTitle);
  if (artist && title) return { artist, title };
  return null;
}

// =================== playback session tracking ===================
let session = null; // { meta, parsed, video, playedSeconds, nowPlayingSent, scrobbled, allowed }
// Filter config is read directly from storage (no service-worker round-trips) and
// kept fresh via a change listener — zero periodic wakeups.
let filterCache = {
  enabled: true, categories: ["Music", "Entertainment"], connected: false,
  scrobbleAfter: DEFAULT_SCROBBLE_AFTER
};

function applyCfg(d) {
  if ("enabled" in d) filterCache.enabled = d.enabled !== false;
  if ("categories" in d && d.categories) filterCache.categories = d.categories;
  if ("sessionKey" in d) filterCache.connected = !!d.sessionKey;
  if ("scrobbleAfter" in d && Number.isFinite(d.scrobbleAfter)) filterCache.scrobbleAfter = d.scrobbleAfter;
  if ("noiseWords" in d && Array.isArray(d.noiseWords)) {
    userNoise = d.noiseWords.map((w) => String(w).trim().toLowerCase()).filter(Boolean);
  }
}

try {
  chrome.storage.local.get(
    ["enabled", "categories", "sessionKey", "scrobbleAfter", "noiseWords"]
  ).then(applyCfg, () => {});
} catch (e) { /* context not ready */ }

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !contextAlive()) return;
  // Noise words affect only future parsing — apply without touching playback state.
  if (changes.noiseWords) applyCfg({ noiseWords: changes.noiseWords.newValue });
  // Early-out for unrelated writes (nowPlaying/recent/stats) — keeps this cheap,
  // since the background writes those on every scrobble.
  let relevant = false;
  const d = {};
  for (const k of ["enabled", "categories", "sessionKey", "scrobbleAfter"]) {
    if (changes[k]) { d[k] = changes[k].newValue; relevant = true; }
  }
  if (!relevant) return;
  applyCfg(d);

  // React when scrobbling is paused or the account is disconnected: stop counting
  // and remove the live "Scrobbling now" card immediately.
  if (!filterCache.enabled || !filterCache.connected) {
    stopTicker();
    clearNowPlayingCard();
  } else {
    // Re-enabled/connected: resume counting if a video is actively playing.
    const v = getVideoEl();
    if (session && session.allowed && !session.scrobbled && v && !v.paused) startTicker();
  }
});

function categoryAllowed(category) {
  if (!category) return false;
  const allow = (filterCache.categories || []).map((c) => c.toLowerCase());
  return allow.includes(category.toLowerCase());
}

function getVideoEl() {
  return document.querySelector("video.html5-main-video") || document.querySelector("video");
}

function startSession(meta) {
  const parsed = parseTrack(meta);
  const allowed = categoryAllowed(meta.category);
  session = {
    meta, parsed,
    playedSeconds: 0,
    nowPlayingSent: false,
    scrobbled: false,
    allowed: allowed && !!parsed,
    timestamp: Math.floor(Date.now() / 1000)
  };
}

function maybeNowPlaying() {
  if (!session || !session.allowed || session.nowPlayingSent) return;
  if (!filterCache.enabled || !filterCache.connected) return;
  if (session.playedSeconds < NOW_PLAYING_AFTER_SECONDS) return;
  session.nowPlayingSent = true;
  safeSend({
    type: "NOW_PLAYING",
    track: trackPayload(session)
  });
}

function maybeScrobble(force) {
  if (!session || !session.allowed || session.scrobbled) return;
  if (!filterCache.enabled || !filterCache.connected) return;
  const threshold = filterCache.scrobbleAfter || DEFAULT_SCROBBLE_AFTER;
  const longEnough = session.playedSeconds >= threshold;
  if (!longEnough && !force) return;
  // Guard against absurdly short clips when "force"d by an early 'ended'
  if (force && session.playedSeconds < Math.min(threshold, 30)) return;
  session.scrobbled = true;
  safeSend({
    type: "SCROBBLE",
    track: trackPayload(session)
  });
}

function trackPayload(s) {
  return {
    artist: s.parsed.artist,
    title: s.parsed.title,
    duration: s.meta.lengthSeconds || undefined,
    videoId: s.meta.videoId,
    timestamp: s.timestamp
  };
}

// 1-second ticker counts only actively-played time. It runs only while an
// eligible, not-yet-scrobbled track is active, and self-suspends otherwise,
// so idle or non-music tabs consume no CPU.
let ticker = null;
function startTicker() {
  if (ticker) return;
  ticker = setInterval(tick, 1000);
}
function stopTicker() {
  if (ticker) { clearInterval(ticker); ticker = null; }
}
function tick() {
  if (!session || !session.allowed || session.scrobbled ||
      !filterCache.enabled || !filterCache.connected) {
    stopTicker();
    return;
  }
  const v = getVideoEl();
  if (v && !v.paused && !v.ended && v.readyState >= 2 && v.currentTime > 0) {
    session.playedSeconds += 1;
    maybeNowPlaying();
    maybeScrobble(false);
  }
}

// Remove the live "Scrobbling now" card (only messages the worker if one was shown).
function clearNowPlayingCard() {
  if (session && session.nowPlayingSent) {
    session.nowPlayingSent = false;
    safeSend({ type: "CLEAR_NOW_PLAYING" });
  }
}

// =================== metadata from the page probe ===================
window.addEventListener("message", (ev) => {
  if (ev.source !== window || ev.origin !== window.location.origin) return;
  if (!ev.data || ev.data.source !== TAG) return;
  const meta = ev.data.payload;
  if (!meta || !meta.videoId) return;
  // Anti-spoofing: on a /watch page the reported video id must match the URL.
  if (location.pathname === "/watch") {
    const v = new URLSearchParams(location.search).get("v");
    if (v && meta.videoId !== v) return;
  }
  if (session && session.meta.videoId === meta.videoId) {
    // Same video — category/length often arrive a beat after the first event.
    // Always re-evaluate eligibility so a late-arriving category enables scrobbling.
    session.meta = Object.assign({}, session.meta, meta);
    if (!session.parsed) session.parsed = parseTrack(meta);
    const nowAllowed = !!session.parsed && categoryAllowed(session.meta.category);
    if (nowAllowed && !session.allowed) {
      session.allowed = true;
      const v = getVideoEl();
      if (filterCache.enabled && filterCache.connected && v && !v.paused) startTicker();
    } else if (!nowAllowed && session.allowed) {
      session.allowed = false;
      stopTicker();
    }
    return;
  }
  startSession(meta);
  attachVideoHandlers();
  if (session.allowed) {
    startTicker();
  } else {
    // Not a scrobble candidate: stop ticking and clear the live card.
    stopTicker();
    safeSend({ type: "CLEAR_NOW_PLAYING" });
  }
});

// Event-driven playback handlers (no polling): keep the live card and the ticker
// in sync with whether the video is actually playing.
let handledVideo = null;
function attachVideoHandlers() {
  const v = getVideoEl();
  if (!v || v === handledVideo) return;
  handledVideo = v;
  v.addEventListener("ended", onEnded);
  v.addEventListener("pause", onPauseOrStop);
  v.addEventListener("play", onPlay);
}
function onEnded() {
  maybeScrobble(true);   // completed -> scrobble if eligible
  clearNowPlayingCard(); // stop showing "Scrobbling now"
  stopTicker();
}
function onPauseOrStop() {
  // Video no longer playing: drop the live card and stop counting to save CPU.
  clearNowPlayingCard();
  stopTicker();
}
function onPlay() {
  if (session && session.allowed && !session.scrobbled &&
      filterCache.enabled && filterCache.connected) {
    startTicker();
  }
}

// ask the probe to (re)send metadata when this script loads
function requestMeta() {
  window.postMessage({ source: TAG + "_REQ" }, window.location.origin);
}
document.addEventListener("yt-navigate-start", () => {
  // leaving the current video: stop counting and drop the live "now playing" card
  stopTicker();
  session = null;
  safeSend({ type: "CLEAR_NOW_PLAYING" });
});
document.addEventListener("yt-navigate-finish", () => setTimeout(requestMeta, 500));
window.addEventListener("load", () => setTimeout(requestMeta, 800));
setTimeout(requestMeta, 1200);
