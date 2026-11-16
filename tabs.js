const q = (id) => document.getElementById(id);
const store = chrome.storage.local;
store.remove("mode"); // legacy setting from when other API types existed
let tags = [], vt = {}, picked = new Set();
const toArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

// ---- tabs
const tabBtns = document.querySelectorAll(".tabs button");
const TABS = ["home", "tag", "ai", "remove", "bytag", "settings"];
function showTab(name) {
  tabBtns.forEach((x) => x.setAttribute("aria-selected", x.dataset.tab === name));
  TABS.forEach((t) => (q("tab-" + t).hidden = t !== name));
}
tabBtns.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.go)));

// ---- home: warn when the active tab isn't the Watch Later playlist
const WL_URL = "https://www.youtube.com/playlist?list=WL";
async function checkPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let onWL = false;
  try { const u = new URL(tab?.url || ""); onWL = u.hostname.endsWith("youtube.com") && u.pathname === "/playlist" && u.searchParams.get("list") === "WL"; } catch {}
  q("pageWarn").hidden = onWL;
}
q("openWL").addEventListener("click", () => chrome.tabs.create({ url: WL_URL }));
checkPage();

// ---- home: connection + tagged-video summary
async function renderHome() {
  const { base, model } = await store.get(["base", "model"]);
  const tagged = Object.values(vt).filter((v) => toArr(v).length).length;
  q("homeStatus").textContent = (model ? `Endpoint: ${base || "http://localhost:11434/v1/systemone"} · ${model}` : "No model set yet. Open Settings (gear icon).") +
    ` · ${tagged} tagged video${tagged === 1 ? "" : "s"}`;
}

// ---- load saved values
store.get(["tagList", "base", "model", "apiKey", "tagLimit", "tagRegen", "rlimit", "tagWithin", "btlimit", "btSel", "vidTags", "aiQuery", "aiMin", "aiLimit", "syncOn", "syncError", "tagPrompt"]).then((s) => {
  q("tagPrompt").value = Tagging.validTemplate(s.tagPrompt) ? s.tagPrompt : Tagging.DEFAULT_TEMPLATE; hintPrompt();
  q("syncOn").checked = !!s.syncOn; renderSync(s.syncError);
  tags = s.tagList || []; renderChips();
  q("base").value = s.base ?? "http://localhost:11434/v1/systemone";
  q("model").value = s.model || ""; q("key").value = s.apiKey || "";
  q("tagLimit").value = s.tagLimit ?? 10;
  q("tagRegen").checked = !!s.tagRegen; q("btlimit").value = s.btlimit ?? 10; picked = new Set(s.btSel || []); vt = s.vidTags || {}; renderPick(); renderHome();
  q("aiQuery").value = s.aiQuery || ""; q("aiMin").value = Math.round((s.aiMin ?? 0.6) * 100); q("aiMinVal").textContent = q("aiMin").value; q("aiLimit").value = s.aiLimit ?? 10;
  q("tagWithin").value = s.tagWithin ?? 40; q("rlimit").value = s.rlimit ?? 10;
});

// per-page options save on change
const num = (id, key, min) => q(id).addEventListener("change", () => {
  q(id).value = Math.max(min, Math.floor(+q(id).value || min)); store.set({ [key]: +q(id).value });
});
num("tagLimit", "tagLimit", 0); num("aiLimit", "aiLimit", 0); num("rlimit", "rlimit", 0); num("btlimit", "btlimit", 0);
q("tagWithin").addEventListener("change", () => {
  q("tagWithin").value = Math.min(100, Math.max(0, Math.round(+q("tagWithin").value || 0))); store.set({ tagWithin: +q("tagWithin").value });
});
// ---- question template: saved as typed; the hint says whether it will be used
function hintPrompt() {
  const v = q("tagPrompt").value.trim();
  q("tagPromptHint").textContent = !v ? "" : Tagging.validTemplate(v) ? "" : "Remove {tag}: tags are sent as choices, so this template is ignored.";
}
function savePrompt() { const v = q("tagPrompt").value.trim(); hintPrompt(); store.set({ tagPrompt: v === Tagging.DEFAULT_TEMPLATE ? "" : v }); }
q("tagPrompt").addEventListener("input", savePrompt);
q("tagPromptReset").addEventListener("click", () => { q("tagPrompt").value = Tagging.DEFAULT_TEMPLATE; savePrompt(); });

// ---- tag sync (the background worker does the work; this is just the switch)
const renderSync = (err) => { q("syncStatus").textContent = err ? `Sync problem: ${err}` : ""; };
q("syncOn").addEventListener("change", () => store.set({ syncOn: q("syncOn").checked, syncError: "" }));
q("tagRegen").addEventListener("change", () => store.set({ tagRegen: q("tagRegen").checked }));

// ---- tag chips
function renderChips() {
  q("chips").replaceChildren(...tags.map((t) => {
    const c = document.createElement("span"); c.className = "chip"; c.append(t);
    const x = document.createElement("button"); x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", "Remove tag " + t);
    x.onclick = () => { tags = tags.filter((y) => y !== t); store.set({ tagList: tags }); renderChips(); };
    c.append(x); return c;
  }));
}
function addTags(text) {
  for (const t of text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))
    if (!tags.some((y) => y.toLowerCase() === t.toLowerCase())) tags.push(t);
  store.set({ tagList: tags }); renderChips(); q("tagInput").value = "";
}
q("tagInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTags(q("tagInput").value); }
  else if (e.key === "Backspace" && !q("tagInput").value && tags.length) { tags.pop(); store.set({ tagList: tags }); renderChips(); }
});
q("tagInput").addEventListener("blur", () => addTags(q("tagInput").value));

// ---- settings (endpoint only; run options live on each page)
// Lets the background worker reach non-localhost endpoints. Returns an error string, or null when OK.
async function ensureOrigin(base) {
  try {
    const origin = new URL(base).origin + "/*";
    if (!(await chrome.permissions.contains({ origins: [origin] })) && !(await chrome.permissions.request({ origins: [origin] })))
      return "Permission to reach that endpoint was denied.";
  } catch { return "Invalid endpoint URL."; }
  return null;
}
const formBase = () => q("base").value.trim().replace(/\/+$/, "");

q("saveSettings").addEventListener("click", async () => {
  const problem = await ensureOrigin(formBase());
  if (problem) { q("keyStatus").textContent = problem; return; }
  await store.set({ base: formBase(), model: q("model").value.trim(), apiKey: q("key").value.trim() });
  q("keyStatus").textContent = "Saved.";
});

function showTest(ok, text) { // green on success; red on failure, which also reveals the CORS help
  q("testStatus").textContent = text;
  q("testStatus").classList.toggle("ok", ok === true);
  q("testStatus").classList.toggle("bad", ok === false);
  q("corsInfo").hidden = ok !== false;
}
q("testConn").addEventListener("click", async () => {
  q("testErr").hidden = true; q("corsInfo").hidden = true;
  q("testStatus").classList.remove("ok", "bad");
  const problem = await ensureOrigin(formBase());
  if (problem) { showTest(false, problem); return; }
  q("testConn").disabled = true; q("testStatus").textContent = "Testing… the first request can take a while if the model has to load.";
  const r = await chrome.runtime.sendMessage({ type: "test", base: formBase(), model: q("model").value.trim(), apiKey: q("key").value.trim() })
    .catch((e) => ({ error: e.message }));
  q("testConn").disabled = false;
  if (r?.ok) showTest(true, `Connected. The model answered in ${(r.ms / 1000).toFixed(1)}s (test question scored ${Math.round(r.p * 100)}%). Remember to press Save.`);
  else { showTest(false, "Connection failed:"); q("testErr").textContent = r?.error || "No response from the extension's background worker."; q("testErr").hidden = false; }
});

// ---- about + CORS info
const GITHUB_URL = "https://github.com/yazdipour/tidy-watch-later";
const DONATE_URL = "https://github.com/sponsors/yazdipour";
q("ver").textContent = chrome.runtime.getManifest().version;
q("verLink").href = GITHUB_URL + "/releases";
for (const [id, url] of [["ghLink", GITHUB_URL], ["donateLink", DONATE_URL]]) {
  if (url) q(id).href = url; else { q(id).setAttribute("aria-disabled", "true"); q(id).title = "Link not configured yet"; }
}
q("origin").textContent = `chrome-extension://${chrome.runtime.id}`;
q("copyOrigin").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(q("origin").textContent); q("copyOrigin").textContent = "Copied"; setTimeout(() => (q("copyOrigin").textContent = "Copy"), 1500); } catch {}
});

// ---- tagging (the run itself lives in the page; the popup only displays it)
async function toContent(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes("youtube.com/playlist")) throw new Error("Open your Watch Later playlist first.");
  try { return await chrome.tabs.sendMessage(tab.id, msg); }
  catch { throw new Error("Reload the YouTube tab once, then try again."); }
}

function renderTag(r) {
  if (!r || r.state === "idle") return;
  const running = r.state === "running";
  q("tagGo").hidden = running; q("tagStop").hidden = !running; q("tagBar").hidden = !running;
  q("tagErr").hidden = r.state !== "error";
  if (running) {
    if (r.limit > 0) { q("tagBar").max = r.limit; q("tagBar").value = r.processed; } else q("tagBar").removeAttribute("value");
    q("tagStatus").textContent = `Tagging… ${r.tagged} tagged · ${r.loaded} videos loaded`;
  } else if (r.state === "error") {
    q("tagStatus").textContent = `Failed after tagging ${r.tagged ?? 0} videos:`; q("tagErr").textContent = r.error;
  } else {
    q("tagStatus").textContent = `${r.state === "stopped" ? "Stopped. " : "Done. "}Tagged ${r.tagged} videos.` +
      (r.failed ? ` ${r.failed} failed (not saved; run again to retry).` : "");
    if (r.failed && r.warn) { q("tagErr").textContent = r.warn; q("tagErr").hidden = false; }
  }
}

q("tagGo").addEventListener("click", async () => {
  addTags(q("tagInput").value);
  const s = await store.get(["base", "model"]);
  if (!tags.length) { q("tagStatus").textContent = "Add at least one tag."; return; }
  if (!s.base || !s.model) { q("tagStatus").textContent = "Set endpoint and model in Settings first."; return; }
  q("tagErr").hidden = true; q("tagStatus").textContent = "Starting…";
  try {
    const r = await toContent({ type: "tagRun" });
    if (r.error) q("tagStatus").textContent = r.error;
    else renderTag({ state: "running", tagged: 0, processed: 0, loaded: 0, limit: +q("tagLimit").value });
  } catch (e) { q("tagStatus").textContent = e.message; }
});
q("tagStop").addEventListener("click", () => toContent({ type: "tagStop" }).catch(() => {}));
q("tagClear").addEventListener("click", async () => {
  await store.set({ vidTags: {} });
  q("tagStatus").textContent = "Cleared.";
});

chrome.runtime.onMessage.addListener((m) => { if (m.tagState) renderTag(m.tagState); });
toContent({ type: "tagGet" }).then(renderTag).catch(() => {}); // pick up a run already in progress

// ---- By tag: remove videos carrying selected tags
const matchIds = () => Object.entries(vt).filter(([, v]) => toArr(v).some((x) => picked.has(x))).map(([id]) => id);
const byTag = createRunner({
  kind: "tags", go: q("btGo"), stop: q("btStop"), bar: q("btBar"), status: q("btStatus"),
  lock: [q("btlimit")],
  afterIdle: () => renderPick(),
  opts: () => ({ ids: matchIds(), limit: +q("btlimit").value || 0, chunk: REMOVE_CHUNK }),
});

function renderPick() {
  const counts = {};
  for (const v of Object.values(vt)) toArr(v).forEach((x) => (counts[x] = (counts[x] || 0) + 1));
  const names = Object.keys(counts).sort();
  picked = new Set([...picked].filter((x) => counts[x]));
  q("tagPick").replaceChildren(...names.map((n) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "pick"; b.textContent = `${n} · ${counts[n]}`; b.setAttribute("aria-pressed", picked.has(n));
    b.onclick = () => { picked.has(n) ? picked.delete(n) : picked.add(n); store.set({ btSel: [...picked] }); renderPick(); };
    return b;
  }));
  if (!q("btBar").hidden) return; // a run is in progress: the runner owns the status line
  const n = matchIds().length;
  q("btGo").disabled = n === 0;
  q("btStatus").textContent = names.length ? (n ? `${n} video${n > 1 ? "s" : ""} match the selected tags.` : "Select the tags to remove.")
    : "No tagged videos yet. Run the Tagging tab first.";
}
chrome.storage.onChanged.addListener((c) => {
  if (c.syncError) renderSync(c.syncError.newValue); if (c.vidTags) { vt = c.vidTags.newValue || {}; renderPick(); } if (c.vidTags || c.base || c.model) renderHome(); });

q("btGo").addEventListener("click", () => {
  const n = matchIds().length;
  if (confirm(`Remove ${n} video${n > 1 ? "s" : ""} tagged ${[...picked].join(", ")} from Watch Later? This can't be undone.`)) byTag.start();
});
byTag.follow();

// ---- AI filter (the run lives in the page; the popup only displays it and edits settings)
q("aiQuery").addEventListener("input", () => store.set({ aiQuery: q("aiQuery").value }));
q("aiMin").addEventListener("input", () => { // the page re-filters instantly from storage
  q("aiMinVal").textContent = q("aiMin").value; store.set({ aiMin: +q("aiMin").value / 100 });
});

let aiRunning = false; // the one AI button doubles as Start / Stop
function renderAi(r) {
  if (!r || r.state === "idle") return;
  const running = r.state === "running";
  aiRunning = running; q("aiGo").textContent = running ? "Stop" : "Find videos"; q("aiGo").classList.toggle("secondary", running); q("aiGo").disabled = false; q("aiBar").hidden = !running;
  q("aiErr").hidden = r.state !== "error" && !(r.failed && r.warn);
  const tail = r.failed ? ` ${r.failed} failed (will be retried next run).` : "";
  if (running) {
    if (r.limit > 0) { q("aiBar").max = r.limit; q("aiBar").value = Math.min(r.matches || 0, r.limit); } else q("aiBar").removeAttribute("value");
    q("aiStatus").textContent = `Scoring… ${r.scanned || 0} scanned · ${r.matches || 0} matches`;
  } else if (r.state === "error") {
    q("aiStatus").textContent = `Failed after scanning ${r.scanned || 0} videos:`; q("aiErr").textContent = r.error;
  } else {
    q("aiStatus").textContent = `${r.state === "stopped" ? "Stopped. " : "Done. "}${r.matches} matching of ${r.scanned} scanned.` + tail;
    if (r.failed && r.warn) q("aiErr").textContent = r.warn;
  }
}
q("aiGo").addEventListener("click", async () => {
  if (aiRunning) { q("aiGo").disabled = true; q("aiStatus").textContent = "Stopping…"; toContent({ type: "aiStop" }).catch(() => {}); return; }
  const { base, model } = await store.get(["base", "model"]);
  if (!base || !model) { q("aiStatus").textContent = "Set endpoint and model in Settings first."; return; }
  if (!q("aiQuery").value.trim()) { q("aiStatus").textContent = "Describe what you are looking for first."; return; }
  await store.set({ aiQuery: q("aiQuery").value });
  q("aiErr").hidden = true; q("aiStatus").textContent = "Starting…";
  try {
    const r = await toContent({ type: "aiRun" });
    if (r.error) q("aiStatus").textContent = r.error;
    else renderAi({ state: "running", scanned: 0, matches: 0, limit: +q("aiLimit").value });
  } catch (e) { q("aiStatus").textContent = e.message; }
});
q("aiClear").addEventListener("click", async () => { await store.set({ aiOn: false }); q("aiStatus").textContent = "Showing all videos."; });
chrome.runtime.onMessage.addListener((m) => { if (m.aiState) renderAi(m.aiState); });
toContent({ type: "aiGet" }).then(renderAi).catch(() => {});
