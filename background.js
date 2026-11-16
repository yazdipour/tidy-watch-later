// Calls the Systemone endpoint. Runs here (not in the page) to avoid CORS.
importScripts("tagging.js", "sync.js"); // pure batching / retry / ranking logic and tag sync (unit-tested)
// Opt-in tag sync across devices (chrome.storage.sync). Listeners are registered at top level so Chrome wakes the worker.
TidySync.createSync({
  local: chrome.storage.local, sync: chrome.storage.sync,
  onChanged: (fn) => chrome.storage.onChanged.addListener(fn),
}).start();

const DEF = { base: "http://localhost:11434/v1/systemone", model: "", apiKey: "", tagMax: 3, tagMin: 0.5 };

async function post(url, apiKey, body) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey && { Authorization: "Bearer " + apiKey }) },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Could not reach ${url}\n${e.message}\nIs the server running, and is the URL right?\nIf it is running, it may be blocking this extension (CORS): see the note under Test connection in Settings.`); // no .status => treated as transient
  }
  if (!res.ok) {
    const text = await res.text();
    let hint = "";
    if (res.status === 403) hint = "\n\nHint: 403 from a local server is usually an origin (CORS) rejection. For Ollama, restart it with OLLAMA_ORIGINS=\"chrome-extension://*\".";
    if (res.status === 404) hint = "\n\nHint: 404 usually means a wrong endpoint URL (enter the full URL, including the /systemone path) or an unknown model name.";
    console.error("Tagging request failed", url, res.status, text);
    const err = new Error(`POST ${url}\n→ ${res.status} ${res.statusText}\n${text.slice(0, 3000)}${hint}`);
    err.status = res.status; err.body = text;
    throw err;
  }
  return res.json();
}

// Systemone: POST to the full endpoint URL the user entered, "noul" questions -> answers[name].noul (probability).
// `criteria` is optional on the server, so it is omitted to save tokens.
const systemone = (s) => async (spec) => {
  const { answers } = await post(s.base, s.apiKey, {
    model: s.model, state: spec.text,
    questions: Object.fromEntries(spec.questions.map((q) => [q.name, { type: "noul", instructions: q.instructions }])),
  });
  return Object.fromEntries(Object.entries(answers).map(([n, a]) => [n, a.noul]));
};

const settings = async () => {
  const s = { ...DEF, ...(await chrome.storage.local.get(["base", "model", "apiKey", "tagMax", "tagMin"])) };
  s.base = s.base.replace(/\/+$/, "");
  return s;
};
// Limits differ per endpoint/model, so each one's discovered question cap is cached separately.
const limitKey = (s) => `systemone|${s.base}|${s.model}`;

async function classify(items, tags) {
  const s = await settings();
  if (!s.model) throw new Error("No model set (Settings tab).");
  const { limits = {} } = await chrome.storage.local.get("limits");
  const r = await Tagging.tagVideos({
    videos: items, tags, cap: limits[limitKey(s)]?.cap ?? Tagging.DEFAULT_CAP, min: s.tagMin, max: s.tagMax, send: systemone(s),
  });
  if (r.capChanged) await chrome.storage.local.set({ limits: { ...limits, [limitKey(s)]: { cap: r.cap } } });

  const failed = r.failedIds.length, problem = r.fatal || r.errors[0];
  if (problem && !Object.keys(r.tagged).length) throw problem; // nothing worked: surface the real error

  const { vidTags = {} } = await chrome.storage.local.get("vidTags");
  await chrome.storage.local.set({ vidTags: { ...vidTags, ...r.tagged } });
  return { n: Object.keys(r.tagged).length, failed, warn: problem ? problem.message : "" };
}

// AI filter: one probability per video for the user's free-text request.
async function score(items, query) {
  const s = await settings();
  if (!s.model) throw new Error("No model set (Settings tab).");
  const { limits = {} } = await chrome.storage.local.get("limits");
  const r = await Tagging.scoreVideos({ videos: items, query, cap: limits[limitKey(s)]?.cap ?? Tagging.DEFAULT_CAP, send: systemone(s) });
  if (r.capChanged) await chrome.storage.local.set({ limits: { ...limits, [limitKey(s)]: { cap: r.cap } } });
  const problem = r.fatal || r.errors[0];
  if (problem && !Object.keys(r.scores).length) throw problem;
  const { aiScores = {} } = await chrome.storage.local.get("aiScores");
  await chrome.storage.local.set({ aiScores: { ...aiScores, ...r.scores } });
  return { scores: r.scores, failed: r.failedIds.length, warn: problem ? problem.message : "" };
}

// Settings > Test connection: one tiny question using the values currently in the form (saved or not).
async function testConnection({ base, model, apiKey }) {
  if (!model) throw new Error("Enter a model name first.");
  const t0 = performance.now();
  const probs = await systemone({ base: String(base).trim().replace(/\/+$/, ""), model, apiKey })({
    text: "A video titled 'Cute kitten plays with yarn'.",
    questions: [{ name: "ping", instructions: "Is this about an animal?" }],
  });
  if (typeof probs.ping !== "number") throw new Error("The server answered, but not in the Systemone format I expected:\n" + JSON.stringify(probs).slice(0, 300));
  return { ok: true, ms: Math.round(performance.now() - t0), p: probs.ping };
}

// Work-unit size for the content script, derived from the (cached) question limit for this endpoint/model.
async function planUnit(tags) {
  const s = await settings();
  const { limits = {} } = await chrome.storage.local.get("limits");
  return Tagging.workUnit(limits[limitKey(s)]?.cap ?? Tagging.DEFAULT_CAP, tags.length);
}

chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m.type === "plan") { planUnit(m.tags).then((unit) => send({ unit }), () => send({ unit: 20 })); return true; }
  if (m.type === "test") { testConnection(m).then(send, (e) => send({ error: e.message })); return true; }
  if (m.type === "score") { score(m.items, m.query).then(send, (e) => send({ error: e.message })); return true; }
  if (m.type !== "classify") return;
  classify(m.items, m.tags).then((r) => send(r), (e) => send({ error: e.message }));
  return true;
});
