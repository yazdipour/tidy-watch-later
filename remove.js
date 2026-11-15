const $ = (id) => document.getElementById(id);
// Removals pause to load more videos after this many (fixed, not a setting).
const REMOVE_CHUNK = 10;
const slider = $("n"), val = $("val"), status = $("status"), go = $("go"), stop = $("stop"), rbar = $("rbar");

// Runs inside the YouTube page. Must be self-contained.
async function wlTask(o) {
  const { threshold, dryRun, limit, chunk, kind } = o, idSet = o.ids ? new Set(o.ids) : null;
  const vid = (el) => /[?&]v=([\w-]{11})/.exec(el.querySelector("a[href*='watch?v=']")?.getAttribute("href") || "")?.[1];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ITEMS = "ytd-playlist-video-renderer, yt-lockup-view-model";
  if (!/[?&]list=WL\b/.test(location.search)) return { error: "Not on the Watch Later page (youtube.com/playlist?list=WL)." };

  const watchedPct = (el) => {
    const bar = el.querySelector("[class*='ResumePlaybackProgress'], #progress, [class*='ProgressBarSegment']");
    const m = bar && /width:\s*([\d.]+)%/.exec(bar.getAttribute("style") || "");
    if (m) return parseFloat(m[1]);
    // Fallback: YouTube's "WATCHED" overlay means fully watched.
    return /^\s*watched\s*$/i.test(el.querySelector("ytd-thumbnail-overlay-playback-status-renderer")?.textContent || "") ? 100 : 0;
  };
  const matches = () => [...document.querySelectorAll(ITEMS)].filter((el) => (idSet ? idSet.has(vid(el)) : watchedPct(el) >= threshold));

  const count = () => document.querySelectorAll(ITEMS).length;
  if (!dryRun && window.__wlState?.state === "running" && Date.now() - window.__wlState.ts < 20000) return { error: "A removal run is already in progress." };
  if (dryRun) return { total: count(), count: matches().length };

  // Work in chunks: remove matches among loaded items, then load more, repeat.
  window.__wlStop = false;
  let removed = 0, failed = 0, idle = 0, inChunk = 0;
  const report = (state = "running") => { window.__wlState = { kind, state, removed, failed, loaded: count(), limit, ts: Date.now() }; };
  report();
  while (!window.__wlStop && !(limit > 0 && removed + failed >= limit)) {
    const el = matches()[0];
    if (el) {
      el.scrollIntoView({ block: "center" });
      const menuBtn = el.querySelector("ytd-menu-renderer button, button[aria-label*='ction' i]");
      let ok = false;
      if (menuBtn) {
        menuBtn.click();
        await sleep(300);
        const item = [...document.querySelectorAll("ytd-menu-service-item-renderer, yt-list-item-view-model")]
          .find((i) => /remove from/i.test(i.textContent) && i.offsetParent !== null);
        if (item) { item.click(); ok = true; await sleep(600); } else { document.body.click(); await sleep(200); }
      }
      ok ? removed++ : failed++;
      if (ok && idSet) { // forget the saved tags of a video that is gone
        const id = vid(el), { vidTags = {} } = await chrome.storage.local.get("vidTags");
        if (id in vidTags) { delete vidTags[id]; await chrome.storage.local.set({ vidTags }); }
      }
      if (el.isConnected) el.remove(); // advance either way
      report();
      // Chunk boundary: pause and load the next page before continuing.
      if (chunk > 0 && ++inChunk >= chunk) {
        inChunk = 0;
        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleep(1500);
      }
      continue;
    }
    // No matches in loaded items: fetch the next chunk.
    const before = count();
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(1200);
    idle = count() === before ? idle + 1 : 0;
    report();
    if (idle >= 2) break; // end of list
  }
  report(window.__wlStop ? "stopped" : "done");
  return { removed, failed, stopped: window.__wlStop };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
const onPlaylist = (tab) => !!tab?.url?.includes("youtube.com/playlist");
const execIn = async (tab, opts) => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: wlTask, args: [opts] }))[0].result;

// Run state lives in the page (window.__wlState), so a reopened popup can pick it up.
async function readState() {
  try {
    const tab = await activeTab();
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__wlState || null });
    return res.result;
  } catch { return null; }
}
const doneText = (s) => `${s.state === "stopped" ? "Stopped. " : "Done. "}Removed ${s.removed}${s.failed ? `, ${s.failed} failed` : ""}.`;

// Drives one removal tab (watched / by-tag): start, stop, progress, follow a run after the popup reopens.
function createRunner(c) {
  let pollT;
  const live = (s) => s?.kind === c.kind && s.state === "running" && Date.now() - s.ts < 20000;
  const mine = (s) => s?.kind === c.kind;
  function showRunning(s) {
    c.go.hidden = true; c.stop.hidden = false; c.lock.forEach((e) => (e.disabled = true)); c.bar.hidden = false;
    if (s.limit > 0) { c.bar.max = s.limit; c.bar.value = s.removed + s.failed; } else c.bar.removeAttribute("value");
    c.status.textContent = `Removing… ${s.removed} removed${s.failed ? `, ${s.failed} failed` : ""} · ${s.loaded} videos loaded`;
  }
  function showIdle() {
    c.go.hidden = false; c.stop.hidden = true; c.lock.forEach((e) => (e.disabled = false)); c.bar.hidden = true; c.afterIdle();
  }
  function poll() {
    clearInterval(pollT);
    pollT = setInterval(async () => {
      const s = await readState();
      if (live(s)) showRunning(s);
      else if (mine(s)) { clearInterval(pollT); showIdle(); c.status.textContent = doneText(s); }
    }, 700);
  }
  c.stop.addEventListener("click", async () => {
    const tab = await activeTab();
    chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.__wlStop = true; } });
  });
  return {
    async start() {
      const tab = await activeTab();
      if (!onPlaylist(tab)) { c.status.textContent = "Open your Watch Later playlist first."; return; }
      const o = c.opts();
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.__wlState = null; window.__wlStop = false; } });
      showRunning({ removed: 0, failed: 0, loaded: 0, limit: o.limit });
      poll();
      const res = await execIn(tab, { ...o, kind: c.kind, dryRun: false }).catch((e) => ({ error: e.message }));
      if (res.error) { clearInterval(pollT); showIdle(); c.status.textContent = res.error; }
    },
    // On popup open: true if a run (or its result) was shown.
    async follow() {
      const s = await readState();
      if (live(s)) { showRunning(s); poll(); return true; }
      if (mine(s)) { showIdle(); c.status.textContent = doneText(s); return true; }
      return false;
    },
  };
}

// ---- Watched tab
const watched = createRunner({
  kind: "watched", go, stop, bar: rbar, status, lock: [slider, $("rlimit")],
  afterIdle: () => (go.disabled = false),
  opts: () => ({ threshold: +slider.value, limit: +$("rlimit").value || 0, chunk: REMOVE_CHUNK, ids: null }),
});

let timer;
async function preview() {
  const tab = await activeTab();
  if (!onPlaylist(tab)) { status.textContent = "Open your Watch Later playlist first."; go.disabled = true; return; }
  const r = await execIn(tab, { threshold: +slider.value, dryRun: true }).catch((e) => ({ error: e.message }));
  if (r.error) { status.textContent = r.error; go.disabled = true; return; }
  status.textContent = `${r.count} of ${r.total} currently loaded videos match.`;
  go.disabled = false; // Start always allowed: it keeps loading more chunks
}
slider.addEventListener("input", () => {
  val.textContent = slider.value;
  clearTimeout(timer);
  timer = setTimeout(preview, 300);
});
go.addEventListener("click", () => watched.start());
watched.follow().then((handled) => { if (!handled) preview(); });
