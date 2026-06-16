const $ = (id) => document.getElementById(id);
let state = null;

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function load() {
  state = await send({ type: "GET_STATE" });
  if (!state || !state.ok) return;
  $("enabled").checked = !!state.enabled;
  $("scrobbleAfter").value = state.scrobbleAfter || 60;
  renderConnect();
  renderChips();
  renderNoise();
  renderBuiltinNoise();
  // Pre-fill creds from storage for convenience
  const stored = await chrome.storage.local.get(["apiKey", "apiSecret"]);
  if (stored.apiKey) $("apiKey").value = stored.apiKey;
  if (stored.apiSecret) $("apiSecret").value = stored.apiSecret;
  // Show this extension's redirect URI (handy if Last.fm needs a Callback URL)
  const ru = await send({ type: "GET_REDIRECT_URI" });
  if (ru && ru.ok) $("redirectUri").textContent = ru.uri;
}

function renderConnect() {
  const ok = state.connected;
  $("csDot").className = "cs-dot" + (ok ? " ok" : "");
  $("csText").textContent = ok ? "Connected as " + state.username : "Not connected";
  $("connectBtn").hidden = ok;
  $("disconnectBtn").hidden = !ok;
}

function renderChips() {
  const wrap = $("chips");
  wrap.innerHTML = "";
  (state.categories || []).forEach((cat) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = "<span></span><span class='x' title='Remove'>&times;</span>";
    chip.firstChild.textContent = cat;
    chip.querySelector(".x").onclick = () => removeCat(cat);
    wrap.appendChild(chip);
  });
}

async function saveCategories(cats) {
  state.categories = cats;
  await send({ type: "SET_CATEGORIES", categories: cats });
  renderChips();
}

function removeCat(cat) {
  saveCategories(state.categories.filter((c) => c !== cat));
}

function addCat() {
  const v = $("newCat").value.trim();
  if (!v) return;
  const exists = state.categories.some((c) => c.toLowerCase() === v.toLowerCase());
  if (!exists) saveCategories([...state.categories, v]);
  $("newCat").value = "";
}

// ---- cleanup (noise) words ----
function renderNoise() {
  const wrap = $("noiseChips");
  wrap.innerHTML = "";
  (state.noiseWords || []).forEach((w) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = "<span></span><span class='x' title='Remove'>&times;</span>";
    chip.firstChild.textContent = w;
    chip.querySelector(".x").onclick = () => removeNoise(w);
    wrap.appendChild(chip);
  });
}

// Built-in (always-on) words, shown as locked chips for transparency.
function renderBuiltinNoise() {
  const wrap = $("builtinChips");
  if (!wrap) return;
  wrap.innerHTML = "";
  const list = (typeof YTS_BUILTIN_NOISE !== "undefined") ? YTS_BUILTIN_NOISE : [];
  list.forEach((w) => {
    const chip = document.createElement("span");
    chip.className = "chip locked";
    chip.title = "Built-in — always applied";
    chip.textContent = w;
    wrap.appendChild(chip);
  });
}

async function saveNoise(words) {
  state.noiseWords = words;
  await send({ type: "SET_NOISE", words });
  renderNoise();
}

function removeNoise(w) {
  saveNoise((state.noiseWords || []).filter((x) => x !== w));
}

function addNoise() {
  const v = $("newNoise").value.trim();
  if (!v) return;
  const exists = (state.noiseWords || []).some((x) => x.toLowerCase() === v.toLowerCase());
  if (!exists) saveNoise([...(state.noiseWords || []), v]);
  $("newNoise").value = "";
}

function msg(el, text, isErr) {
  el.textContent = text;
  el.className = "inline-msg" + (isErr ? " err" : "");
  if (text) setTimeout(() => { el.textContent = ""; }, 4000);
}

// ---- credentials ----
$("saveCreds").addEventListener("click", async () => {
  const apiKey = $("apiKey").value.trim();
  const apiSecret = $("apiSecret").value.trim();
  if (!apiKey || !apiSecret) return msg($("credsMsg"), "Enter both fields.", true);
  await send({ type: "SET_CREDS", apiKey, apiSecret });
  state.hasCreds = true;
  msg($("credsMsg"), "Saved ✓");
});

// ---- connect flow (Last.fm web auth via chrome.identity) ----
$("connectBtn").addEventListener("click", async () => {
  const btn = $("connectBtn");
  // Always persist the current field values first, so Connect can't run with a
  // stale/empty secret (the usual cause of an "invalid signature" error).
  const apiKey = $("apiKey").value.trim();
  const apiSecret = $("apiSecret").value.trim();
  if (!apiKey || !apiSecret) {
    return msg($("connectMsg"), "Enter your API key and secret above first.", true);
  }
  if (apiKey === apiSecret) {
    return msg($("connectMsg"), "API key and Shared secret are identical — these are two different values.", true);
  }
  await send({ type: "SET_CREDS", apiKey, apiSecret });
  state.hasCreds = true;

  btn.disabled = true;
  msg($("connectMsg"), "Opening Last.fm…");
  const r = await send({ type: "CONNECT" });
  btn.disabled = false;
  if (r && r.ok) {
    msg($("connectMsg"), "Connected ✓");
    await load();
  } else {
    msg($("connectMsg"), (r && r.error) || "Couldn't connect.", true);
  }
});

$("disconnectBtn").addEventListener("click", async () => {
  await send({ type: "DISCONNECT" });
  await load();
});

// ---- categories ----
$("addCat").addEventListener("click", addCat);
$("newCat").addEventListener("keydown", (e) => { if (e.key === "Enter") addCat(); });

// ---- cleanup words ----
$("addNoise").addEventListener("click", addNoise);
$("newNoise").addEventListener("keydown", (e) => { if (e.key === "Enter") addNoise(); });

// ---- enable toggle ----
$("enabled").addEventListener("change", (e) => {
  send({ type: "SET_ENABLED", enabled: e.target.checked });
});

// ---- scrobble threshold ----
$("scrobbleAfter").addEventListener("change", async (e) => {
  const r = await send({ type: "SET_SCROBBLE_AFTER", seconds: e.target.value });
  if (r && r.ok) {
    e.target.value = r.scrobbleAfter; // reflect clamped value
    msg($("behaviourMsg"), "Saved ✓");
  }
});

document.addEventListener("DOMContentLoaded", load);
