// Background service worker: Last.fm auth + scrobbling.
import { md5 } from "./md5.js";

const API_ROOT = "https://ws.audioscrobbler.com/2.0/";

// ---------- storage helpers ----------
async function getCfg() {
  const d = await chrome.storage.local.get([
    "apiKey", "apiSecret", "sessionKey", "username",
    "enabled", "categories", "noiseWords", "scrobbleAfter", "recent", "stats", "nowPlaying"
  ]);
  return {
    apiKey: (d.apiKey || "").trim(),
    apiSecret: (d.apiSecret || "").trim(),
    sessionKey: d.sessionKey || "",
    username: d.username || "",
    enabled: d.enabled !== false, // default on
    categories: d.categories || ["Music", "Entertainment"],
    noiseWords: Array.isArray(d.noiseWords) ? d.noiseWords : [],
    scrobbleAfter: Number.isFinite(d.scrobbleAfter) ? d.scrobbleAfter : 60,
    recent: d.recent || [],
    stats: d.stats || { scrobbles: 0 },
    nowPlaying: d.nowPlaying || null
  };
}

// ---------- signed Last.fm request ----------
function signParams(params, secret) {
  const keys = Object.keys(params).filter((k) => k !== "format").sort();
  let s = "";
  for (const k of keys) s += k + params[k];
  s += secret;
  return md5(s);
}

async function callLastfm(method, params, { signed = false, post = false } = {}) {
  const { apiKey, apiSecret } = await getCfg();
  if (!apiKey || !apiSecret) throw new Error("Missing API key/secret. Open the extension options.");
  const all = { method, api_key: apiKey, ...params };
  if (signed) all.api_sig = signParams(all, apiSecret);
  all.format = "json";

  let url = API_ROOT;
  let opts = {};
  if (post) {
    opts = {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(all).toString()
    };
  } else {
    url += "?" + new URLSearchParams(all).toString();
  }
  const res = await fetch(url, opts);
  const json = await res.json();
  if (json.error) throw new Error(`Last.fm error ${json.error}: ${json.message}`);
  return json;
}

// ---------- auth (web flow via chrome.identity) ----------
// Uses launchWebAuthFlow so the browser itself detects when Last.fm redirects
// back — no polling, no manual "finish" step. Returns the username on success
// and surfaces the real Last.fm error otherwise.
function redirectUri() {
  return chrome.identity.getRedirectURL("lastfm");
}

async function connect() {
  const { apiKey, apiSecret } = await getCfg();
  if (!apiKey || !apiSecret) throw new Error("Enter your API key and secret first, then save.");

  // Pre-validate the key+secret with a signed call so a wrong/swapped secret
  // produces a clear message instead of failing silently after approval.
  try {
    await callLastfm("auth.getToken", {}, { signed: true });
  } catch (e) {
    if (/signature|invalid api key|13|10/i.test(e.message)) {
      throw new Error("API key or shared secret looks incorrect — check both in step 1. (" + e.message + ")");
    }
    throw e;
  }

  const authUrl =
    "https://www.last.fm/api/auth/?api_key=" + encodeURIComponent(apiKey) +
    "&cb=" + encodeURIComponent(redirectUri());

  let finalUrl;
  try {
    finalUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  } catch (e) {
    throw new Error("Authorization window was closed before approving.");
  }
  if (!finalUrl) throw new Error("No response from Last.fm.");

  // Last.fm appends ?token=... to the callback
  const u = new URL(finalUrl);
  const token = u.searchParams.get("token");
  if (!token) throw new Error("Last.fm did not return a token. Check that your API key is correct.");

  let json;
  try {
    json = await callLastfm("auth.getSession", { token }, { signed: true });
  } catch (e) {
    if (/\b13\b|signature/i.test(e.message)) {
      throw new Error(
        "Shared secret doesn't match this API key (Last.fm error 13). Last.fm recognizes the " +
        "key, so the Shared Secret is wrong or swapped — re-copy it from your API account page " +
        "(it's the value labelled \"Shared secret\", separate from the API key)."
      );
    }
    throw e;
  }
  if (!json.session || !json.session.key) throw new Error("Last.fm did not return a session.");
  await chrome.storage.local.set({ sessionKey: json.session.key, username: json.session.name });
  return { username: json.session.name };
}

// ---------- now playing + scrobble ----------
async function updateNowPlaying(track) {
  const { sessionKey } = await getCfg();
  // Always reflect the live track in the UI, even before/without a session.
  await chrome.storage.local.set({
    nowPlaying: {
      artist: track.artist, title: track.title,
      videoId: track.videoId || null, duration: track.duration || null,
      ts: track.timestamp || Math.floor(Date.now() / 1000),
      scrobbled: false, updatedAt: Date.now()
    }
  });
  setIconState(true);
  if (!sessionKey) return;
  const params = { artist: track.artist, track: track.title, sk: sessionKey };
  if (track.album) params.album = track.album;
  if (track.duration) params.duration = String(track.duration);
  await callLastfm("track.updateNowPlaying", params, { signed: true, post: true });
}

async function clearNowPlaying() {
  await chrome.storage.local.set({ nowPlaying: null });
  setIconState(false);
}

async function markNowPlayingScrobbled(track) {
  const { nowPlaying } = await getCfg();
  if (nowPlaying && nowPlaying.artist === track.artist && nowPlaying.title === track.title) {
    nowPlaying.scrobbled = true;
    nowPlaying.updatedAt = Date.now();
    await chrome.storage.local.set({ nowPlaying });
  }
}

async function scrobble(track) {
  const { sessionKey } = await getCfg();
  if (!sessionKey) throw new Error("Not connected to Last.fm.");
  const ts = track.timestamp || Math.floor(Date.now() / 1000);
  const params = {
    artist: track.artist, track: track.title, timestamp: String(ts), sk: sessionKey
  };
  if (track.album) params.album = track.album;
  if (track.duration) params.duration = String(track.duration);
  await callLastfm("track.scrobble", params, { signed: true, post: true });
  await recordScrobble(track, ts);
  await markNowPlayingScrobbled(track);
}

// ---------- unscrobble ----------
// Last.fm has no official "delete scrobble" API method. This removes the entry
// from the extension's own history and makes a best-effort deletion on Last.fm
// using the website's logged-in session (the user's existing last.fm cookies).
async function unscrobble(entry) {
  // 1) always remove from local history
  const { recent, stats } = await getCfg();
  const next = recent.filter(
    (r) => !(r.artist === entry.artist && r.title === entry.title && r.ts === entry.ts)
  );
  await chrome.storage.local.set({
    recent: next,
    stats: { scrobbles: Math.max(0, (stats.scrobbles || 0) - 1) }
  });

  // 2) best-effort removal from Last.fm via the website endpoint
  const remote = await removeScrobbleRemote(entry).catch((e) => ({ ok: false, error: e.message }));
  return { local: true, remote };
}

// Deletion must run as a FIRST-PARTY request from a logged-in last.fm tab,
// otherwise Last.fm's CSRF check rejects the extension's Origin with a 403.
// We inject into an existing www.last.fm tab and perform the delete there.
async function removeScrobbleRemote(entry) {
  const { username } = await getCfg();
  if (!username) return { ok: false, error: "Not connected." };

  const tabs = await chrome.tabs.query({ url: "https://www.last.fm/*" });
  if (!tabs.length) {
    return { ok: false, code: "no-tab", error: "Open last.fm (signed in) to delete it there too." };
  }

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      world: "MAIN",
      func: lastfmDeleteInPage,
      args: [username, entry.artist, entry.title, String(entry.ts)]
    });
    return (res && res.result) || { ok: false, error: "No result from last.fm tab." };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Runs inside the last.fm page (first-party origin + cookies). Must be self-contained.
function lastfmDeleteInPage(username, artist, track, timestamp) {
  const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  if (!m) return { ok: false, error: "Not logged into last.fm in this tab." };
  const csrf = decodeURIComponent(m[1]);
  const body = new URLSearchParams({
    csrfmiddlewaretoken: csrf,
    artist_name: artist,
    track_name: track,
    timestamp: timestamp,
    ajax: "1"
  });
  return fetch("https://www.last.fm/user/" + encodeURIComponent(username) + "/library/delete", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-CSRFToken": csrf },
    body: body.toString(),
    credentials: "include"
  })
    .then((r) => (r.ok ? { ok: true } : { ok: false, error: "Last.fm returned " + r.status }))
    .catch((e) => ({ ok: false, error: e.message }));
}

async function recordScrobble(track, ts) {
  const { recent, stats } = await getCfg();
  const entry = {
    artist: track.artist, title: track.title, ts,
    videoId: track.videoId || null
  };
  const next = [entry, ...recent].slice(0, 50);
  await chrome.storage.local.set({
    recent: next,
    stats: { scrobbles: (stats.scrobbles || 0) + 1 }
  });
}

// Toolbar icon doubles as a play/scrobble indicator: coloured when a track is
// playing, muted grey when idle. (No numeric badge.)
function setIconState(active) {
  const base = active ? "icons/active" : "icons/idle";
  const path = { 16: base + "16.png", 48: base + "48.png", 128: base + "128.png" };
  try {
    chrome.action.setIcon({ path }, () => void chrome.runtime.lastError);
  } catch (e) { /* ignore */ }
}

// ---------- message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Defense in depth: only accept messages from this extension's own contexts.
  // (Web pages can't reach us anyway — no externally_connectable is declared.)
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "unauthorized sender" });
    return false;
  }
  (async () => {
    try {
      switch (msg && msg.type) {
        case "GET_STATE": {
          const cfg = await getCfg();
          sendResponse({
            ok: true,
            connected: !!cfg.sessionKey,
            hasCreds: !!(cfg.apiKey && cfg.apiSecret),
            username: cfg.username,
            enabled: cfg.enabled,
            categories: cfg.categories,
            noiseWords: cfg.noiseWords,
            scrobbleAfter: cfg.scrobbleAfter,
            recent: cfg.recent,
            stats: cfg.stats,
            nowPlaying: cfg.nowPlaying
          });
          break;
        }
        case "NOW_PLAYING": {
          const cfg = await getCfg();
          if (cfg.enabled && cfg.sessionKey) await updateNowPlaying(msg.track);
          sendResponse({ ok: true });
          break;
        }
        case "SCROBBLE": {
          const cfg = await getCfg();
          if (cfg.enabled && cfg.sessionKey) await scrobble(msg.track);
          sendResponse({ ok: true });
          break;
        }
        case "CLEAR_NOW_PLAYING": {
          await clearNowPlaying();
          sendResponse({ ok: true });
          break;
        }
        case "UNSCROBBLE": {
          const r = await unscrobble(msg.entry);
          sendResponse({ ok: true, ...r });
          break;
        }
        case "CONNECT": {
          const r = await connect();
          sendResponse({ ok: true, ...r });
          break;
        }
        case "GET_REDIRECT_URI": {
          sendResponse({ ok: true, uri: redirectUri() });
          break;
        }
        case "SET_ENABLED": {
          await chrome.storage.local.set({ enabled: !!msg.enabled });
          sendResponse({ ok: true });
          break;
        }
        case "SET_CATEGORIES": {
          const cats = Array.isArray(msg.categories)
            ? [...new Set(msg.categories.map((c) => String(c).trim()).filter(Boolean))].slice(0, 50)
            : [];
          await chrome.storage.local.set({ categories: cats });
          sendResponse({ ok: true });
          break;
        }
        case "SET_NOISE": {
          const seen = new Set();
          const out = [];
          for (const w of (Array.isArray(msg.words) ? msg.words : [])) {
            const t = String(w).trim().slice(0, 60);
            if (!t) continue;
            const key = t.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(t);
            if (out.length >= 100) break;
          }
          await chrome.storage.local.set({ noiseWords: out });
          sendResponse({ ok: true });
          break;
        }
        case "SET_SCROBBLE_AFTER": {
          let n = parseInt(msg.seconds, 10);
          if (!Number.isFinite(n)) n = 60;
          n = Math.max(10, Math.min(3600, n)); // 10s .. 60min
          await chrome.storage.local.set({ scrobbleAfter: n });
          sendResponse({ ok: true, scrobbleAfter: n });
          break;
        }
        case "SET_CREDS": {
          const apiKey = String(msg.apiKey || "").trim();
          const apiSecret = String(msg.apiSecret || "").trim();
          await chrome.storage.local.set({ apiKey, apiSecret });
          sendResponse({ ok: true });
          break;
        }
        case "DISCONNECT": {
          await chrome.storage.local.set({ sessionKey: "", username: "" });
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message: " + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async response
});

// initialise badge on startup
// Clear any legacy numeric badge and set the icon to reflect current state.
chrome.action.setBadgeText({ text: "" });
getCfg().then((c) => setIconState(!!c.nowPlaying));
