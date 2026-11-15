// Pure tagging logic: batching, limit discovery, retries, ranking.
// No chrome.* or fetch in here, so it can be unit-tested with `node --test` and loaded in the
// service worker with importScripts(). Transport is injected as `send`.
(function (root) {
  const DEFAULT_CAP = 400; // optimistic start; real limits are discovered from the server and cached

  // ---- deterministic question names: "<videoId>__t<tagIndex>" ----
  const nameFor = (id, t) => `${id}__t${t}`;
  const parseName = (name) => {
    const m = /^(.+)__t(\d+)$/.exec(name);
    return m ? { id: m[1], t: +m[2] } : null;
  };

  // ---- batching ----
  // One yes/no question per (video, tag). Packing pairs sequentially needs the fewest requests:
  // ceil(videos * tags / cap). Each request only describes the videos it actually asks about.
  const makePairs = (videos, tagCount) =>
    videos.flatMap((v) => Array.from({ length: tagCount }, (_, t) => ({ id: v.id, t })));

  function planBatches(pairs, cap) {
    const size = Math.max(1, Math.floor(cap));
    const out = [];
    for (let i = 0; i < pairs.length; i += size) out.push(pairs.slice(i, i + size));
    return out;
  }

  // ---- limit detection ----
  const LIMIT_WORDS = /too many|too large|exceed|must contain|at most|maximum|\blimit|capped/i;

  // Pull a numeric question limit out of an error message, or null.
  function parseLimit(text) {
    const t = String(text || "");
    const patterns = [
      /(\d+)\s*[–—-]\s*(\d+)\s*(?:fields|questions|items)/i, // "must contain 1–64 fields" -> upper bound
      /(?:at most|no more than|up to|maximum(?: of)?|max(?:imum)?(?: is)?|limit(?: of| is)?|exceeds?)\s*:?\s*(\d+)/i,
      /(\d+)\s*(?:questions|fields)\s*(?:max|maximum|limit)/i,
    ];
    for (const [i, re] of patterns.entries()) {
      const m = re.exec(t);
      if (m) { const n = +(i === 0 ? m[2] : m[1]); if (n > 0) return n; }
    }
    return null;
  }

  // Smaller cap to retry with, or null if this error isn't about request size.
  function nextCap(err, cap, size) {
    if (![400, 413, 422].includes(err && err.status) || size <= 1) return null;
    const text = (err.body || err.message || "");
    const parsed = parseLimit(text);
    // An exact limit that our batch already satisfied means the error is about something else.
    if (parsed != null) return parsed < size ? Math.min(cap, parsed) : null;
    return LIMIT_WORDS.test(text) ? Math.min(cap, Math.max(1, Math.floor(size / 2))) : null;
  }

  // Network errors, timeouts, rate limits and 5xx are worth retrying; other 4xx are not.
  const isTransient = (e) => !e || e.status === undefined || e.status === 408 || e.status === 429 || e.status >= 500;

  // ---- request body: each video described once per request, tags never repeated ----
  const PREAMBLE = "For each numbered video below, judge whether it fits the tag named in the question, using only its title and channel.";
  const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // Text and instructions use short per-request labels ([0], [1]...): 11-char video ids cost many
  // tokens and would repeat in every question. Question *names* still carry the real ids.
  function buildBatch(batch, byId, tags) {
    const ids = [...new Set(batch.map((p) => p.id))];
    const label = Object.fromEntries(ids.map((id, k) => [id, k]));
    const lines = ids.map((id) => {
      const v = byId[id];
      return `[${label[id]}] ${oneLine(v.title)}${v.channel ? " by " + oneLine(v.channel) : ""}`;
    });
    return {
      text: PREAMBLE + "\n" + lines.join("\n"),
      questions: batch.map((p) => ({ name: nameFor(p.id, p.t), instructions: `[${label[p.id]}] fits "${tags[p.t]}"?` })),
    };
  }

  // ---- the batch runner ----
  // Sends `pairs` in batches of <= cap. On a size error: shrink the cap and re-plan only the unsent
  // pairs. On a transient error: retry just that batch. Finished pairs are never sent twice.
  async function runBatches({ pairs, cap, send, retries = 2, baseDelay = 500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    const seen = new Set(), unique = [];
    for (const p of pairs) { const k = nameFor(p.id, p.t); if (!seen.has(k)) { seen.add(k); unique.push(p); } }

    const startCap = cap, probs = {}, done = new Set(), failed = [], errors = [];
    let fatal = null, calls = 0;
    let queue = planBatches(unique, cap);

    while (queue.length && !fatal) {
      const batch = queue.shift().filter((p) => !done.has(nameFor(p.id, p.t)));
      if (!batch.length) continue;
      for (let attempt = 0; ; attempt++) {
        try {
          calls++;
          const got = await send(batch);
          for (const p of batch) {
            const k = nameFor(p.id, p.t);
            if (typeof got[k] === "number") { probs[k] = got[k]; done.add(k); } else failed.push(p); // server skipped it
          }
          break;
        } catch (e) {
          const smaller = nextCap(e, cap, batch.length);
          if (smaller) { // re-plan everything not yet done at the discovered size
            cap = smaller;
            queue = planBatches([...batch, ...queue.flat()], cap);
            break;
          }
          if (!isTransient(e)) { fatal = e; failed.push(...batch); break; } // auth, 404, bad request: stop
          if (attempt >= retries) { errors.push(e); failed.push(...batch); break; } // give up on this batch only
          await sleep(baseDelay * 2 ** attempt);
        }
      }
    }
    if (fatal) failed.push(...queue.flat()); // never attempted
    return { probs, failed, errors, fatal, calls, cap, capChanged: cap !== startCap };
  }

  // How many videos to hand over per work unit (progress, saving and Stop happen between units).
  // Sized so a unit fills whole requests: no half-empty trailing request, but not so big that a
  // slow model leaves the user waiting minutes without any progress.
  function workUnit(cap, tagCount) {
    const per = Math.max(1, Math.floor(cap / Math.max(1, tagCount))); // videos that fit one request
    return per >= 20 ? Math.min(per, 60) : per * Math.ceil(20 / per);
  }

  // ---- ranking ----
  // Tags at or above `min`, most confident first, at most `max`. null if any answer is missing.
  function rankVideo(probs, id, tags, min, max) {
    const scored = tags.map((tag, i) => ({ tag, i, p: probs[nameFor(id, i)] }));
    if (scored.some((s) => typeof s.p !== "number")) return null;
    return scored.filter((s) => s.p >= min).sort((a, b) => b.p - a.p || a.i - b.i).slice(0, max).map((s) => s.tag);
  }

  // ---- everything together ----
  // send(spec) -> { [questionName]: probability }, spec = { text, questions: [{name, instructions}] }
  async function tagVideos({ videos, tags, cap = DEFAULT_CAP, min = 0.5, max = 3, send, retries, baseDelay, sleep }) {
    const byId = {};
    for (const v of videos) if (v.id && !byId[v.id]) byId[v.id] = v; // no duplicate videos
    const list = Object.values(byId);

    const run = await runBatches({
      pairs: makePairs(list, tags.length), cap, retries, baseDelay, sleep,
      send: (batch) => send(buildBatch(batch, byId, tags)),
    });

    const tagged = {}, failedIds = [];
    for (const v of list) {
      const r = rankVideo(run.probs, v.id, tags, min, max);
      r ? (tagged[v.id] = r) : failedIds.push(v.id); // incomplete videos are not saved, so a re-run retries them
    }
    return { tagged, failedIds, errors: run.errors, fatal: run.fatal, calls: run.calls, cap: run.cap, capChanged: run.capChanged };
  }

  // ---- AI filter: score every video against one free-text request ----
  // The request is stated once per HTTP request; each video is one short question.
  function buildFilterBatch(batch, byId, query) {
    const ids = [...new Set(batch.map((p) => p.id))];
    const label = Object.fromEntries(ids.map((id, k) => [id, k]));
    const lines = ids.map((id) => {
      const v = byId[id], parts = [oneLine(v.title)];
      if (v.channel) parts.push("channel: " + oneLine(v.channel));
      if (v.duration) parts.push("duration " + oneLine(v.duration));
      if (v.meta) parts.push(oneLine(v.meta));
      if (v.watched > 0) parts.push(`already watched ${Math.round(v.watched)}%`);
      if (Number.isInteger(v.pos)) parts.push(`list position ${v.pos + 1}`);
      return `[${label[id]}] ${parts.join(" | ")}`;
    });
    return {
      text: `Request: ${oneLine(query)}\nFor each numbered video below, judge how well it matches the request, using its title, channel and details.\n` + lines.join("\n"),
      questions: batch.map((p) => ({ name: nameFor(p.id, 0), instructions: `Does [${label[p.id]}] match the request?` })),
    };
  }

  // send(spec) -> { [questionName]: probability }. Same batching, limit discovery and retries as tagging.
  async function scoreVideos({ videos, query, cap = DEFAULT_CAP, send, retries, baseDelay, sleep }) {
    const byId = {};
    for (const v of videos) if (v.id && !byId[v.id]) byId[v.id] = v;
    const list = Object.values(byId);
    const run = await runBatches({
      pairs: list.map((v) => ({ id: v.id, t: 0 })), cap, retries, baseDelay, sleep,
      send: (batch) => send(buildFilterBatch(batch, byId, query)),
    });
    const scores = {}, failedIds = [];
    for (const v of list) { const p = run.probs[nameFor(v.id, 0)]; typeof p === "number" ? (scores[v.id] = p) : failedIds.push(v.id); }
    return { scores, failedIds, errors: run.errors, fatal: run.fatal, calls: run.calls, cap: run.cap, capChanged: run.capChanged };
  }

  const api = { DEFAULT_CAP, nameFor, parseName, makePairs, planBatches, parseLimit, nextCap, isTransient, buildBatch, runBatches, workUnit, rankVideo, tagVideos, buildFilterBatch, scoreVideos };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Tagging = api;
})(typeof self !== "undefined" ? self : globalThis);
