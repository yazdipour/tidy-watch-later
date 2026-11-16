(() => {
  const ITEMS = "ytd-playlist-video-renderer, yt-lockup-view-model";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = chrome.storage.local;
  let vidTags = {}, tagList = [], filter = null, stopFlag = false, stopNow = null, timer; // stopNow: resolves when Stop is pressed, to cut short a pending request
  let aiOn = false, aiScores = {}, aiMin = 0.6, aiQuery = "", aiLimit = 10;

  const toArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  // End of the list = nothing new after two scrolls AND no "loading more" spinner. YouTube can take many
// seconds to fetch the next page, so while the spinner is there keep waiting (up to ~20s as a safety net).
const listEnded = (idle) => idle >= 15 || (idle >= 2 && !document.querySelector("ytd-continuation-item-renderer"));
const onWL = () => location.pathname === "/playlist" && /[?&]list=WL\b/.test(location.search);
  const idOf = (el) => /[?&]v=([\w-]{11})/.exec(el.querySelector("a[href*='watch?v=']")?.getAttribute("href") || "")?.[1];
  const txt = (el, sel) => (el.querySelector(sel)?.textContent || "").replace(/\s+/g, " ").trim();
  const watchedPct = (el) => {
    const bar = el.querySelector("[class*='ResumePlaybackProgress'], #progress, [class*='ProgressBarSegment']");
    const m = bar && /width:\s*([\d.]+)%/.exec(bar.getAttribute("style") || "");
    return m ? parseFloat(m[1]) : 0;
  };
  // "1.2M views • 3 years ago": join the separate spans so words don't run together.
  const metaText = (el) => {
    const box = el.querySelector("#video-info, #metadata-line, [class*='lockup-metadata'] [class*='metadata']");
    if (!box) return "";
    const parts = [...box.querySelectorAll("span, yt-content-metadata-view-model div")].filter((n) => !n.querySelector("span, div"))
      .map((n) => n.textContent.replace(/\s+/g, " ").trim()).filter((t) => t && t !== "\u2022");
    return (parts.length ? parts.join(" \u2022 ") : box.textContent.replace(/\s+/g, " ").trim());
  };
  // Everything useful the list shows: title, channel, duration, "views • age" text, watched %.
  // (The Watch Later page shows no "date added"; list position is passed separately as `pos`.)
  const info = (el) => ({
    id: idOf(el),
    title: (el.querySelector("#video-title, [class*='lockup-metadata'] a, a[title]")?.textContent || "").trim(),
    channel: (el.querySelector("ytd-channel-name, [class*='ChannelName'], #channel-name")?.textContent || "").trim().split("\n")[0].trim(),
    duration: txt(el, ".ytBadgeShapeText, #time-status #text"),
    meta: metaText(el).slice(0, 120),
    watched: watchedPct(el),
  });

  function render() {
    document.getElementById("wlm-bar")?.remove();
    // Hidden non-matches shrink the page, so YouTube's infinite scroll keeps fetching pages to fill it.
    // While the AI filter is on and no scan is running, hide the "loading more" spinner to stop that.
    document.documentElement.classList.toggle("wlm-ai-idle", onWL() && aiOn && ai.state !== "running");
    if (!onWL()) return;
    // A filter on a tag nobody carries anymore (tags cleared / last chip removed) would hide every video.
    if (filter && !Object.values(vidTags).some((v) => toArr(v).includes(filter))) filter = null;
    const items = [...document.querySelectorAll(ITEMS)];
    // Scoring runs in batches, so a scan can overshoot the limit; show only the best `aiLimit` matches.
    const ranked = Object.entries(aiScores).filter(([, p]) => p >= aiMin).sort((a, b) => b[1] - a[1]);
    const keep = new Set((aiLimit > 0 ? ranked.slice(0, aiLimit) : ranked).map(([id]) => id));
    for (const el of items) {
      const id = idOf(el), tg = toArr(id && vidTags[id]), key = tg.join("\u0001");
      let box = el.querySelector(".wlm-chips");
      if (tg.length) {
        if (!box) {
          box = document.createElement("div"); box.className = "wlm-chips";
          (el.querySelector("#meta, #metadata, [class*='lockup-metadata']") || el).appendChild(box);
        }
        if (box.dataset.k !== key) {
          box.dataset.k = key;
          box.replaceChildren(...tg.map((t) => {
            const s = document.createElement("span"); s.className = "wlm-chip"; s.append(t);
            const x = document.createElement("button");
            x.type = "button"; x.className = "wlm-x"; x.textContent = "\u00d7"; x.title = `Remove tag "${t}"`; x.setAttribute("aria-label", x.title);
            x.onclick = async (e) => { // drop this tag from this video; keep [] so it isn't auto re-tagged
              e.preventDefault(); e.stopPropagation();
              const { vidTags: cur = {} } = await store.get("vidTags");
              cur[id] = toArr(cur[id]).filter((y) => y !== t);
              await store.set({ vidTags: cur });
            };
            s.append(x); return s;
          }));
        }
      } else box?.remove();
      let sc = el.querySelector(".wlm-score");
      if (aiOn && id && typeof aiScores[id] === "number") {
        if (!sc) { sc = document.createElement("span"); sc.className = "wlm-score"; (el.querySelector("#meta, #metadata, [class*='lockup-metadata']") || el).appendChild(sc); }
        const label = `${Math.round(aiScores[id] * 100)}% match`;
        if (sc.textContent !== label) sc.textContent = label;
      } else sc?.remove();
      const aiHidden = aiOn && !(id && keep.has(id)); // AI filter shows only scored matches
      el.style.display = (filter && !tg.includes(filter)) || aiHidden ? "none" : "";
    }
    const anyTags = Object.values(vidTags).some((v) => toArr(v).length);
    if (!anyTags && !aiOn) return;
    const bar = document.createElement("div"); bar.id = "wlm-bar";
    if (aiOn) {
      const shown = keep.size;
      const b = document.createElement("button");
      b.className = "ai"; b.textContent = `AI: \u201c${aiQuery.slice(0, 30)}${aiQuery.length > 30 ? "\u2026" : ""}\u201d \u00b7 ${shown} \u2715`;
      b.title = "Show all videos again"; b.onclick = () => store.set({ aiOn: false });
      bar.appendChild(b);
    }
    if (anyTags) for (const t of [null, ...tagList]) {
      const b = document.createElement("button");
      b.textContent = t ?? "All"; b.className = filter === t ? "on" : "";
      b.onclick = () => { filter = t; render(); };
      bar.appendChild(b);
    }
    document.body.appendChild(bar);
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(render, 300); schedulePrune(); };

  // Forget tags and AI scores of videos that are no longer in Watch Later (removed here, on your phone, anywhere).
  // Only runs once the whole list is loaded: a partly loaded list would look like "everything else is gone".
  let pruneTimer;
  const schedulePrune = () => { clearTimeout(pruneTimer); pruneTimer = setTimeout(prune, 3000); };
  let lastPruneKey = "";
  async function prune() {
    if (!onWL()) return;
    const ids = [...document.querySelectorAll(ITEMS)].map(idOf).filter(Boolean);
    if (!ids.length || document.querySelector("ytd-continuation-item-renderer")) return; // empty page, or more still loading
    const key = ids.join(","); // act only when the list was identical on two checks in a row (not mid-render)
    if (key !== lastPruneKey) { lastPruneKey = key; schedulePrune(); return; }
    const cur = await store.get(["vidTags", "aiScores"]), patch = {};
    for (const key of ["vidTags", "aiScores"]) {
      const r = TidySync.pruneGone(cur[key] || {}, ids);
      if (r.removed.length) patch[key] = r.kept;
    }
    if (Object.keys(patch).length) await store.set(patch);
  }

  async function load() {
    ({ vidTags = {}, tagList = [], aiOn = false, aiScores = {}, aiMin = 0.6, aiScoredQuery: aiQuery = "", aiLimit = 10 } = await store.get(["vidTags", "tagList", "aiOn", "aiScores", "aiMin", "aiScoredQuery", "aiLimit"]));
    render();
  }
  store.onChanged.addListener(load);
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  store.set({ aiOn: false }).then(load); // the AI filter is per page view: a refresh shows every video again

  // Run state lives here (in the page), so it survives the popup closing.
  let run = { state: "idle" };
  const setRun = (p) => { run = { ...run, ...p }; try { chrome.runtime.sendMessage({ tagState: run }).catch(() => {}); } catch {} };

  async function tagRun() {
    if (run.state === "running") return { error: "Tagging is already running." };
    if (ai.state === "running") return { error: "The AI filter is running. Wait for it or stop it first." };
    if (!onWL()) return { error: "Not on the Watch Later page." };
    const { tagList: tags = [], tagLimit = 10, tagRegen = false } = await store.get(["tagList", "tagLimit", "tagRegen"]);
    if (!tags.length) return { error: "Enter at least one tag." };
    stopFlag = false;
    const unit = (await chrome.runtime.sendMessage({ type: "plan", tags }).catch(() => null))?.unit || 20; // calculated, not user-set
    const count = () => document.querySelectorAll(ITEMS).length;
    setRun({ state: "running", tagged: 0, processed: 0, loaded: count(), limit: tagLimit, error: null });

    (async () => {
      const attempted = new Set(); let tagged = 0, failed = 0, warn = "", idle = 0;
      const report = () => setRun({ tagged, failed, warn, processed: attempted.size, loaded: count() });
      while (!stopFlag && !(tagLimit > 0 && attempted.size >= tagLimit)) {
        if (!onWL()) return setRun({ state: "error", error: "You left the Watch Later page." });
        const { vidTags: cur = {} } = await store.get("vidTags");
        const room = tagLimit > 0 ? Math.min(unit, tagLimit - attempted.size) : unit;
        const todo = [...document.querySelectorAll(ITEMS)].map(info)
          .filter((v) => v.id && v.title && (tagRegen || !(v.id in cur)) && !attempted.has(v.id)).slice(0, room);
        if (todo.length) {
          idle = 0; todo.forEach((v) => attempted.add(v.id)); report();
          const r = await chrome.runtime.sendMessage({ type: "classify", items: todo, tags });
          if (r?.error) return setRun({ state: "error", error: r.error, tagged });
          tagged += r.n; failed += r.failed || 0; warn = r.warn || warn; report(); continue;
        }
        const before = count();
        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleep(1200);
        idle = count() === before ? idle + 1 : 0;
        report();
        if (listEnded(idle)) break;
      }
      setRun({ state: stopFlag ? "stopped" : "done", tagged, failed, warn, processed: attempted.size, loaded: count() });
    })().catch((e) => setRun({ state: "error", error: e.message }));
    return { started: true };
  }

  // ---- AI filter run (state lives here too, so the popup can close and reopen) ----
  let ai = { state: "idle" };
  const setAi = (p) => { const was = ai.state; ai = { ...ai, ...p }; if (ai.state !== was) render(); try { chrome.runtime.sendMessage({ aiState: ai }).catch(() => {}); } catch {} };

  async function aiStart() {
    if (ai.state === "running") return { error: "The AI filter is already running." };
    if (run.state === "running") return { error: "Tagging is running. Wait for it or stop it first." };
    if (!onWL()) return { error: "Not on the Watch Later page." };
    const { aiQuery: q = "", aiScoredQuery, aiScores: old = {}, aiLimit = 10 } = await store.get(["aiQuery", "aiScoredQuery", "aiScores", "aiLimit"]);
    const query = q.trim();
    if (!query) return { error: "Describe what you are looking for first." };
    const scores = query === aiScoredQuery ? { ...old } : {}; // same request: keep scores and just scan further
    await store.set({ aiOn: true, aiScoredQuery: query, aiScores: scores });
    stopFlag = false;
    const stopped = new Promise((r) => { stopNow = r; });
    const unitBase = (await chrome.runtime.sendMessage({ type: "plan", tags: [query] }).catch(() => null))?.unit || 20;
    const unit = aiLimit > 0 ? Math.min(unitBase, Math.max(5, aiLimit)) : unitBase; // small steps when stopping early, so we overshoot the limit by little
    const count = () => document.querySelectorAll(ITEMS).length;
    let failed = 0, warn = "", idle = 0;
    const attempted = new Set();
    const matches = (min) => Object.values(scores).filter((p) => p >= min).length; // may exceed aiLimit: batches overshoot
    const shownCount = (min) => (aiLimit > 0 ? Math.min(aiLimit, matches(min)) : matches(min));
    const report = async () => setAi({ scanned: Object.keys(scores).length, matches: shownCount((await store.get("aiMin")).aiMin ?? 0.6), failed, warn, loaded: count() });
    setAi({ state: "running", limit: aiLimit, failed: 0, warn: "", error: null });
    await report();

    (async () => {
      while (!stopFlag) {
        const min = (await store.get("aiMin")).aiMin ?? 0.6; // the slider can move mid-run
        if (aiLimit > 0 && matches(min) >= aiLimit) break;
        if (!onWL()) return setAi({ state: "error", error: "You left the Watch Later page." });
        const todo = [...document.querySelectorAll(ITEMS)].map((el, pos) => ({ ...info(el), pos }))
          .filter((v) => v.id && v.title && !(v.id in scores) && !attempted.has(v.id)).slice(0, unit);
        if (todo.length) {
          idle = 0; todo.forEach((v) => attempted.add(v.id));
          const r = await Promise.race([chrome.runtime.sendMessage({ type: "score", items: todo, query }), stopped.then(() => "stop")]);
          if (r === "stop") break; // drop the in-flight batch; those videos are simply re-scored next run
          if (r?.error) return setAi({ state: "error", error: r.error });
          Object.assign(scores, r.scores); failed += r.failed || 0; warn = r.warn || warn; await report(); continue;
        }
        const before = count();
        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleep(1200);
        idle = count() === before ? idle + 1 : 0;
        await report();
        if (listEnded(idle)) break;
      }
      await report();
      setAi({ state: stopFlag ? "stopped" : "done" });
    })().catch((e) => setAi({ state: "error", error: e.message }));
    return { started: true };
  }

  chrome.runtime.onMessage.addListener((m, _s, send) => {
    if (m.type === "aiRun") { aiStart().then(send); return true; }
    if (m.type === "aiStop") { stopFlag = true; stopNow?.(); send({}); }
    if (m.type === "aiGet") send(ai);
  });

  chrome.runtime.onMessage.addListener((m, _s, send) => {
    if (m.type === "tagRun") { tagRun().then(send); return true; }
    if (m.type === "tagStop") { stopFlag = true; send({}); }
    if (m.type === "tagGet") send(run);
  });
})();
