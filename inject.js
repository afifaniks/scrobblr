// Runs in the PAGE context so it can read YouTube's internal player data
// (ytInitialPlayerResponse / the <ytd-player> API), which the isolated
// content script cannot reach. Posts sanitized metadata back via window.postMessage.
(function () {
  const TAG = "YTSCROBBLER";

  function getPlayer() {
    const el = document.getElementById("movie_player");
    if (el && typeof el.getVideoData === "function") return el;
    return null;
  }

  function readMeta() {
    let videoId = null, title = null, author = null, lengthSeconds = null, category = null;

    // 1) Live player API (most reliable, updates on SPA navigation)
    const p = getPlayer();
    if (p) {
      try {
        const vd = p.getVideoData();
        if (vd) { videoId = vd.video_id; title = vd.title; author = vd.author; }
        if (typeof p.getDuration === "function") lengthSeconds = Math.round(p.getDuration());
        // Current player response carries the up-to-date category (survives SPA nav)
        if (typeof p.getPlayerResponse === "function") {
          const pr = p.getPlayerResponse();
          const c = pr && pr.microformat &&
            pr.microformat.playerMicroformatRenderer &&
            pr.microformat.playerMicroformatRenderer.category;
          if (c) category = c;
        }
      } catch (e) { /* ignore */ }
    }

    // 2) ytInitialPlayerResponse for category + fallback details
    const r = window.ytInitialPlayerResponse;
    if (r) {
      try {
        const vd = r.videoDetails;
        if (vd) {
          videoId = videoId || vd.videoId;
          title = title || vd.title;
          author = author || vd.author;
          lengthSeconds = lengthSeconds || parseInt(vd.lengthSeconds, 10) || null;
        }
        const cat = r.microformat &&
          r.microformat.playerMicroformatRenderer &&
          r.microformat.playerMicroformatRenderer.category;
        if (cat && !category) category = cat; // don't override the live player value
      } catch (e) { /* ignore */ }
    }

    if (!videoId || !title) return null;
    return { videoId, title, author, lengthSeconds, category };
  }

  let lastSent = null;
  function emit() {
    const m = readMeta();
    if (!m) return;
    const sig = m.videoId + "|" + m.category + "|" + m.lengthSeconds;
    if (sig === lastSent) return;
    lastSent = sig;
    window.postMessage({ source: TAG, payload: m }, window.location.origin);
  }

  // Respond to explicit requests from the content script
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.origin !== window.location.origin) return;
    if (!ev.data || ev.data.source !== TAG + "_REQ") return;
    lastSent = null; // force re-emit
    emit();
  });

  // YouTube SPA navigation events
  window.addEventListener("yt-navigate-finish", () => setTimeout(emit, 300));
  document.addEventListener("yt-page-data-updated", () => setTimeout(emit, 300));

  // Initial + a few retries while the player boots
  let tries = 0;
  const iv = setInterval(() => {
    emit();
    if (++tries > 20) clearInterval(iv);
  }, 500);
})();
