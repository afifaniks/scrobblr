// Single source of truth for the built-in title-cleanup words.
// Loaded by both the content script (parsing) and the options page (display).
// Uses `var` so the binding is shared across content-script files.
var YTS_BUILTIN_NOISE = [
  "official video", "official music video", "official audio", "official lyric video",
  "official lyrics video", "official visualizer", "official mv", "official hd video",
  "music video", "lyric video", "lyrics video", "lyrics", "lyric", "visualizer",
  "audio", "video oficial", "video", "hd", "hq", "4k", "8k", "mv",
  "explicit", "explicit version", "clean version", "radio edit",
  "remastered", "remaster", "full album", "full song",
  "color coded", "with lyrics", "official", "live performance"
];

if (typeof self !== "undefined") self.YTS_BUILTIN_NOISE = YTS_BUILTIN_NOISE;
