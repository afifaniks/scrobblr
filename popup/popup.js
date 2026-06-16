const $ = (id) => document.getElementById(id);

const COLLAPSED_COUNT = 5;
const MAX_COUNT = 50;
let expanded = false;
let lastState = null;

function timeAgo(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}

function render(state) {
  lastState = state;
  // toggle + pause label
  $("enabledToggle").checked = !!state.enabled;
  const tl = $("toggleLabel");
  tl.textContent = state.enabled ? "On" : "Paused";
  tl.classList.toggle("paused", !state.enabled);

  // status
  const dot = $("statusDot");
  const title = $("statusTitle");
  const sub = $("statusSub");
  const action = $("statusAction");
  dot.className = "status-dot";
  action.hidden = true;

  if (!state.hasCreds) {
    dot.classList.add("err");
    title.textContent = "Setup needed";
    sub.textContent = "Add your Last.fm API key in settings.";
    action.hidden = false;
    action.textContent = "Open settings";
    action.onclick = () => chrome.runtime.openOptionsPage();
  } else if (!state.connected) {
    dot.classList.add("warn");
    title.textContent = "Not connected";
    sub.textContent = "Connect your Last.fm account.";
    action.hidden = false;
    action.textContent = "Connect";
    action.onclick = () => chrome.runtime.openOptionsPage();
  } else {
    dot.classList.add("ok");
    title.textContent = "Connected as " + state.username;
    const cats = (state.categories || []).join(", ");
    sub.textContent = (state.enabled ? "Scrobbling" : "Paused") + " · " + cats;
  }

  // now playing (live)
  const np = state.nowPlaying;
  const npCard = $("nowPlayingCard");
  if (np && np.title) {
    npCard.hidden = false;
    npCard.classList.toggle("scrobbled", !!np.scrobbled);
    $("npLabel").textContent = np.scrobbled ? "Scrobbled" : "Scrobbling now";
    $("npTitle").textContent = np.title;
    $("npArtist").textContent = np.artist;
  } else {
    npCard.hidden = true;
  }

  // recent
  const list = $("recentList");
  const empty = $("recentEmpty");
  const toggle = $("recentToggle");
  list.innerHTML = "";
  const recent = (state.recent || []).slice(0, MAX_COUNT);
  $("scrobbleCount").textContent = (state.stats && state.stats.scrobbles) || recent.length;

  if (recent.length === 0) {
    empty.hidden = false;
    toggle.hidden = true;
  } else {
    empty.hidden = true;
    const shown = expanded ? recent : recent.slice(0, COLLAPSED_COUNT);
    for (const r of shown) {
      const li = document.createElement("li");

      const text = document.createElement("div");
      text.className = "ri-text";
      text.innerHTML =
        '<div class="ri-title">' + esc(r.title) +
        '</div><div class="ri-artist">' + esc(r.artist) + "</div>";

      const time = document.createElement("div");
      time.className = "ri-time";
      time.textContent = timeAgo(r.ts);

      const del = document.createElement("button");
      del.className = "ri-del";
      del.title = "Unscrobble";
      del.innerHTML = "&times;";
      del.onclick = (e) => { e.stopPropagation(); unscrobble(r, del); };

      if (r.videoId) {
        li.classList.add("clickable");
        li.title = "Open on YouTube";
        li.onclick = () => chrome.tabs.create({
          url: "https://www.youtube.com/watch?v=" + encodeURIComponent(r.videoId)
        });
      }

      li.append(text, time, del);
      list.appendChild(li);
    }

    // show-all / show-less toggle
    if (recent.length > COLLAPSED_COUNT) {
      toggle.hidden = false;
      toggle.textContent = expanded ? "Show less" : "Show all (" + recent.length + ")";
    } else {
      toggle.hidden = true;
    }
  }
}

function unscrobble(entry, btn) {
  btn.disabled = true;
  btn.classList.add("busy");
  chrome.runtime.sendMessage({ type: "UNSCROBBLE", entry }, (r) => {
    const remote = r && r.remote;
    if (remote && remote.ok) {
      toast("Removed from Last.fm ✓");
    } else if (remote && remote.code === "no-tab") {
      toast("Removed from history. Open last.fm (signed in), then unscrobble again to delete it there.");
    } else if (remote && remote.error) {
      toast("Removed from history. Last.fm delete failed: " + remote.error);
    }
    load();
  });
}

let toastTimer = null;
function toast(text) {
  let t = $("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 4200);
}

function load() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
    if (state && state.ok) render(state);
  });
}

$("enabledToggle").addEventListener("change", (e) => {
  chrome.runtime.sendMessage({ type: "SET_ENABLED", enabled: e.target.checked }, load);
});
$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("recentToggle").addEventListener("click", () => {
  expanded = !expanded;
  if (lastState) render(lastState);
});

document.addEventListener("DOMContentLoaded", load);
// keep the popup live while it's open (now-playing + recency)
setInterval(load, 4000);
