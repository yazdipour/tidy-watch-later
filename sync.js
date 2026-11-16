// Tag sync between devices (chrome.storage.sync) + dropping tags of videos that are gone.
// Pure logic: storage areas are injected, so it runs under `node --test`, in the service worker
// (importScripts) and in the content script (pruneGone only).
//
// Why this shape: storage.sync allows ~100KB total, 8KB per item, ~120 writes/min. So tags are stored
// as a compact snapshot ("id:tagIndex,tagIndex;..." split into <8KB chunks) and writes are debounced.
(function (root) {
  const MAX_VIDEOS = 3000;     // hard cap on synced videos (~55KB); the most recently tagged are kept
  const CHUNK_CHARS = 6000;    // stay well under the 8KB-per-item limit
  const META = "wl_meta", CHUNK_PREFIX = "wl_c";
  const SAFE_ID = /^[^:;,\s]+$/;

  const toArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

  // ---- encoding ----
  function encode(vidTags, ts = 0) {
    const entries = Object.entries(vidTags || {}).filter(([id]) => SAFE_ID.test(id)).slice(-MAX_VIDEOS);
    const tags = [], index = new Map();
    const lines = entries.map(([id, v]) => {
      const idx = toArr(v).map((t) => {
        if (!index.has(t)) { index.set(t, tags.length); tags.push(t); }
        return index.get(t);
      });
      return `${id}:${idx.join(",")}`;
    });
    const chunks = [];
    let cur = "";
    for (const line of lines) {
      if (cur && cur.length + line.length + 1 > CHUNK_CHARS) { chunks.push(cur); cur = ""; }
      cur += (cur ? ";" : "") + line;
    }
    if (cur) chunks.push(cur);
    return { meta: { ts, tags, n: chunks.length }, chunks };
  }

  function decode(meta, chunks) {
    const tags = (meta && meta.tags) || [], out = {};
    for (const chunk of chunks || []) {
      if (typeof chunk !== "string") continue;
      for (const line of chunk.split(";")) {
        const i = line.indexOf(":");
        if (i < 1) continue;
        const rest = line.slice(i + 1);
        out[line.slice(0, i)] = rest ? rest.split(",").map(Number).filter((n) => tags[n] !== undefined).map((n) => tags[n]) : [];
      }
    }
    return out;
  }

  const canon = (vt) => Object.keys(vt || {}).sort().map((k) => `${k}:${toArr(vt[k]).join("\u0001")}`).join("\n");

  // ---- drop entries for videos that are no longer in the list ----
  // `present` = ids found on a fully loaded Watch Later page. Refuses to act on an empty list or one
  // that shares nothing with a large store: that means the page didn't parse, not that everything vanished.
  function pruneGone(store, present) {
    const keys = Object.keys(store || {}), here = new Set(present || []);
    if (!here.size || (keys.length && !keys.some((k) => here.has(k)))) return { kept: store, removed: [] };
    const kept = {}, removed = [];
    for (const k of keys) (here.has(k) ? (kept[k] = store[k]) : removed.push(k));
    return { kept, removed };
  }

  // ---- the sync controller ----
  // local/sync: chrome.storage areas. onChanged(fn(changes, areaName)): registers a change listener.
  // Local keys used: syncOn (user toggle), syncTs (timestamp of the snapshot we last matched), syncError.
  function createSync({ local, sync, onChanged, now = Date.now, delay = 1500 }) {
    let queue = Promise.resolve(), timer = null;
    const enqueue = (fn) => (queue = queue.then(fn).catch(() => {}));

    async function readRemote() {
      const all = await sync.get(null), meta = all[META];
      if (!meta) return null;
      const chunks = Array.from({ length: meta.n || 0 }, (_, i) => all[CHUNK_PREFIX + i]);
      if (chunks.some((c) => typeof c !== "string")) throw new Error("cloud snapshot incomplete (another device is mid-write)");
      return { ts: meta.ts || 0, data: decode(meta, chunks), meta, keys: Object.keys(all) };
    }

    async function push() {
      let { vidTags = {}, syncOn, syncTs = 0 } = await local.get(["vidTags", "syncOn", "syncTs"]);
      if (!syncOn) return;
      const remote = await readRemote();
      if (remote && remote.ts > syncTs) { // the cloud moved on since we last matched it: merge (local wins per video), never overwrite blindly
        vidTags = { ...remote.data, ...vidTags };
        syncTs = remote.ts;
        await local.set({ vidTags, syncTs });
      }
      const mine = encode(vidTags);
      if (!remote && !mine.chunks.length) return; // nothing here, nothing there
      if (remote && canon(remote.data) === canon(decode(mine.meta, mine.chunks))) return; // already in the cloud
      const ts = Math.max(now(), (remote ? remote.ts : 0) + 1, syncTs + 1); // newer than anything seen, even with a skewed clock
      const e = encode(vidTags, ts);
      const items = { [META]: e.meta };
      e.chunks.forEach((c, i) => (items[CHUNK_PREFIX + i] = c));
      try {
        await local.set({ syncTs: ts });
        const { [META]: meta, ...chunkItems } = items;
        if (Object.keys(chunkItems).length) await sync.set(chunkItems); // chunks first, meta last: readers never see a meta without its chunks
        await sync.set({ [META]: meta });
        const stale = (remote ? remote.keys : []).filter((k) => k.startsWith(CHUNK_PREFIX) && !(k in items));
        if (stale.length) await sync.remove(stale);
        await local.set({ syncError: "" });
      } catch (err) {
        await local.set({ syncTs, syncError: String((err && err.message) || err) });
      }
    }

    // first=true (just switched on) or unsynced local edits pending: union, local wins per video. Otherwise the newer snapshot replaces.
    async function pull(first = false) {
      const { vidTags = {}, syncOn, syncTs = 0 } = await local.get(["vidTags", "syncOn", "syncTs"]);
      if (!syncOn) return;
      const remote = await readRemote();
      if (!remote || (!first && remote.ts <= syncTs)) return;
      await local.set({ vidTags: first || timer ? { ...remote.data, ...vidTags } : remote.data, syncTs: remote.ts });
    }

    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { timer = null; enqueue(push); }, delay); };

    return {
      MAX_VIDEOS,
      start() {
        onChanged((changes, area) => {
          if (area === "local") {
            if (changes.syncOn) {
              if (changes.syncOn.newValue) enqueue(async () => { await pull(true); await push(); });
              else { clearTimeout(timer); timer = null; }
            }
            if (changes.vidTags && (changes.syncOn ? changes.syncOn.newValue : true)) schedule();
          } else if (area === "sync" && changes[META]) enqueue(() => pull());
        });
        enqueue(() => pull()); // worker (re)start: catch up with the cloud
      },
      // Push right now (tests, and before the worker may be suspended).
      flush() { clearTimeout(timer); timer = null; return enqueue(push); },
      idle: () => queue,
    };
  }

  const api = { MAX_VIDEOS, META, CHUNK_PREFIX, encode, decode, pruneGone, createSync };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TidySync = api;
})(typeof self !== "undefined" ? self : globalThis);
