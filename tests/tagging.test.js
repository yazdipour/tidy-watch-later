const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../tagging.js");

const noSleep = async () => {};
const vids = (n) => Array.from({ length: n }, (_, i) => ({ id: `vid${String(i).padStart(8, "0")}`, title: `Title ${i}`, channel: `Chan ${i % 3}` }));
const httpErr = (status, body) => Object.assign(new Error(`${status} ${body}`), { status, body });

// Fake endpoint: enforces a question limit, answers p(videoId, tagIndex), records every request.
function server({ limit = Infinity, p = () => 0.9, fail = () => null } = {}) {
  const requests = [];
  const send = async (spec) => {
    requests.push(spec);
    const f = fail(spec, requests.length); if (f) throw f;
    if (spec.questions.length > limit) throw httpErr(400, `{"error":"questions must contain 1–${limit} fields"}`);
    return Object.fromEntries(spec.questions.map((q) => {
      const { id, t } = T.parseName(q.name);
      if (!q.criteria) return [q.name, p(id, t)];
      return [q.name, Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === "none" ? 0 : p(id, +k.slice(1))]))]; // choice: p per tag
    }));
  };
  return { send, requests };
}

// ---------- names ----------
test("question names round-trip, including ids with - and _", () => {
  for (const id of ["PE8nJxZq2qI", "a-B_c-D1234", "__abc__t1__"]) {
    assert.deepEqual(T.parseName(T.nameFor(id, 7)), { id, t: 7 });
  }
  assert.equal(T.parseName("garbage"), null);
});

// ---------- batching ----------
test("planBatches uses the fewest requests and covers every pair exactly once", () => {
  const pairs = T.makePairs(vids(10), 7); // 70 pairs
  const b = T.planBatches(pairs, 64);
  assert.deepEqual(b.map((x) => x.length), [64, 6]);
  assert.equal(b.length, Math.ceil(70 / 64));
  assert.equal(new Set(b.flat().map((p) => T.nameFor(p.id, p.t))).size, 70);
});

test("planBatches handles cap smaller than the tag count (splits one video's tags)", () => {
  const b = T.planBatches(T.makePairs(vids(2), 5), 3);
  assert.deepEqual(b.map((x) => x.length), [3, 3, 3, 1]);
});

test("planBatches never loops on bad caps", () => {
  assert.equal(T.planBatches(T.makePairs(vids(3), 2), 0).length, 6); // clamps to 1
});

test("buildBatch: one choice question per video, tags as criteria plus none", () => {
  const vs = vids(3), byId = Object.fromEntries(vs.map((v) => [v.id, v]));
  const batch = [{ id: vs[0].id, t: 0 }, { id: vs[1].id, t: 0 }];
  const spec = T.buildBatch(batch, byId, ["music", "news"]);
  assert.equal(spec.questions.length, 2);
  assert.ok(spec.questions[0].instructions.includes(vs[0].title) && spec.questions[0].instructions.includes(vs[0].channel));
  assert.deepEqual(spec.questions[0].criteria, { t0: "music", t1: "news", none: "None of these tags fit" });
  assert.ok(!JSON.stringify(spec).includes(vs[2].title)); // not in this batch
  assert.ok(!spec.questions[0].instructions.includes(vs[0].id)); // titles, not ids
  assert.equal(T.parseName(spec.questions[1].name).id, vs[1].id);
});

test("buildBatch flattens newlines in titles", () => {
  const spec = T.buildBatch([{ id: "x", t: 0 }], { x: { id: "x", title: "a\nb\n\nc", channel: "d\ne" } }, ["t"]);
  assert.ok(spec.questions[0].instructions.includes('"a b c" by d e'));
});

// ---------- limit detection ----------
test("parseLimit reads limits from common wordings", () => {
  const cases = [
    ["questions must contain 1–64 fields", 64],
    ['{"error":"questions must contain 1-32 fields"}', 32],
    ["too many questions (max 32)", 32],
    ["at most 100 questions per request", 100],
    ["maximum of 400 questions", 400],
    ["limit is 50", 50],
    ["Exceeds 200 questions", 200],
    ["model 'd3' not found", null],
    ["", null],
    [undefined, null],
  ];
  for (const [text, want] of cases) assert.equal(T.parseLimit(text), want, String(text));
});

test("nextCap: exact limit, halving fallback, and non-limit errors", () => {
  assert.equal(T.nextCap(httpErr(400, "questions must contain 1–64 fields"), 400, 400), 64);
  assert.equal(T.nextCap(httpErr(400, "too many questions"), 400, 400), 200); // no number -> halve
  assert.equal(T.nextCap(httpErr(400, "max 64 questions"), 64, 50), null);    // we were already within the limit
  assert.equal(T.nextCap(httpErr(401, "bad key"), 400, 400), null);
  assert.equal(T.nextCap(httpErr(400, "model does not support x"), 400, 400), null);
  assert.equal(T.nextCap(httpErr(400, "too many questions"), 400, 1), null);  // can't shrink a single question
  assert.equal(T.nextCap(new Error("network"), 400, 10), null);
});

// ---------- runBatches: discovery, adaptation, caching signal ----------
test("discovers the limit from the error, re-plans, and reports the new cap", async () => {
  const s = server({ limit: 64 });
  const v = vids(70), byId = Object.fromEntries(v.map((x) => [x.id, x]));
  const r = await T.runBatches({ pairs: T.makePairs(v, 1), cap: 400, send: (b) => s.send(T.buildBatch(b, byId, ["t"])), sleep: noSleep });
  assert.equal(r.cap, 64);
  assert.equal(r.capChanged, true);
  assert.equal(r.failed.length, 0);
  assert.equal(Object.keys(r.probs).length, 70);
  // 1 rejected probe (70 > 64) + 2 good requests
  assert.deepEqual(s.requests.map((x) => x.questions.length), [70, 64, 6]);
});

test("a cached cap avoids the failed probe entirely", async () => {
  const s = server({ limit: 64 });
  const out = await T.tagVideos({ videos: vids(70), tags: ["a", "b", "c"], cap: 64, send: s.send, sleep: noSleep });
  assert.equal(out.capChanged, false);
  assert.deepEqual(s.requests.map((x) => x.questions.length), [64, 6]);
});

test("halves when the message gives no number, until it fits", async () => {
  const requests = [];
  const send = async (batch) => {
    requests.push(batch.length);
    if (batch.length > 25) throw httpErr(400, "too many questions");
    return Object.fromEntries(batch.map((p) => [T.nameFor(p.id, p.t), 0.9]));
  };
  const r = await T.runBatches({ pairs: T.makePairs(vids(10), 10), cap: 100, send, sleep: noSleep });
  assert.equal(r.failed.length, 0);
  assert.equal(r.cap, 25);
  assert.deepEqual(requests, [100, 50, 25, 25, 25, 25]);
});

test("different endpoints keep independent limits (nothing shared in the pure runner)", async () => {
  const a = server({ limit: 64 }), b = server({ limit: 8 });
  const tags = ["x", "y"];
  const ra = await T.tagVideos({ videos: vids(100), tags, cap: 400, send: a.send, sleep: noSleep });
  const rb = await T.tagVideos({ videos: vids(100), tags, cap: 400, send: b.send, sleep: noSleep });
  assert.equal(ra.cap, 64); assert.equal(rb.cap, 8);
});

// ---------- retries & partial failures ----------
test("transient failures retry only that batch, with backoff", async () => {
  let hits = 0; const sleeps = [];
  const s = server({ limit: 64, fail: (spec) => (spec.questions.some((q) => q.name.startsWith("vid00000009")) && ++hits <= 2 ? httpErr(503, "busy") : null) });
  const r = await T.tagVideos({ videos: vids(30), tags: ["a", "b"], cap: 20, send: s.send, retries: 2, baseDelay: 10, sleep: async (ms) => sleeps.push(ms) });
  assert.equal(Object.keys(r.tagged).length, 30);
  assert.equal(r.failedIds.length, 0);
  assert.deepEqual(sleeps, [10, 20]);
  // 30 videos / 20 = 2 batches + 2 retries of the same single batch
  assert.equal(s.requests.length, 4);
});

test("a batch that keeps failing is dropped alone: other videos still succeed", async () => {
  // batch 2 of 2 (videos 20..29) always 500s
  const s = server(); const orig = s.send;
  const send = async (spec) => { if (spec.questions.some((q) => /^vid0000002\d__/.test(q.name))) { throw httpErr(500, "boom"); } return orig(spec); };
  const r = await T.tagVideos({ videos: vids(30), tags: ["a", "b"], cap: 20, send, retries: 1, baseDelay: 1, sleep: noSleep });
  assert.deepEqual(r.failedIds.sort(), vids(30).slice(20, 30).map((v) => v.id)); // exactly the 10 videos in the bad batch
  assert.equal(Object.keys(r.tagged).length, 20);
  assert.equal(r.errors.length, 1);
  assert.equal(r.fatal, null);
  for (const id of r.failedIds) assert.ok(!(id in r.tagged)); // failed videos are NOT saved -> a re-run retries them
});

test("a failed batch leaves its videos unsaved while earlier batches are kept", async () => {
  // 3 videos, cap 2 -> batch1: v0 v1, batch2: v2. Fail batch 2.
  const s = server({ fail: (_s, n) => (n >= 2 ? httpErr(500, "x") : null) });
  const r = await T.tagVideos({ videos: vids(3), tags: ["a", "b"], cap: 2, send: s.send, retries: 0, sleep: noSleep });
  assert.deepEqual(Object.keys(r.tagged), [vids(3)[0].id, vids(3)[1].id]);
  assert.equal(r.failedIds.length, 1);
});

test("auth/unknown-model errors are fatal: stop immediately, don't burn requests", async () => {
  const s = server({ fail: () => httpErr(401, "bad key") });
  const r = await T.tagVideos({ videos: vids(50), tags: ["a", "b"], cap: 10, send: s.send, sleep: noSleep });
  assert.equal(r.fatal.status, 401);
  assert.equal(s.requests.length, 1);
  assert.equal(r.failedIds.length, 50);
  assert.deepEqual(r.tagged, {});
});

test("network errors (no status) are treated as transient", async () => {
  let n = 0;
  const send = async (spec) => { if (n++ < 1) throw new Error("Failed to fetch"); return Object.fromEntries(spec.questions.map((q) => [q.name, { t0: 0.9, none: 0 }])); };
  const r = await T.tagVideos({ videos: vids(2), tags: ["a"], cap: 10, send, retries: 2, baseDelay: 1, sleep: noSleep });
  assert.equal(Object.keys(r.tagged).length, 2);
});

test("a server that omits some answers: those videos fail, the rest are kept", async () => {
  const send = async (spec) => Object.fromEntries(spec.questions.filter((q) => !q.name.startsWith("vid00000001")).map((q) => [q.name, { t0: 0.9, none: 0 }]));
  const r = await T.tagVideos({ videos: vids(3), tags: ["a"], cap: 10, send, sleep: noSleep });
  assert.equal(r.failedIds.length, 1);
  assert.equal(Object.keys(r.tagged).length, 2);
});

// ---------- no duplicate processing ----------
test("duplicate videos are processed once; no pair is ever answered twice", async () => {
  const s = server({ limit: 64 });
  const v = vids(5), dup = [...v, ...v, v[0]];
  const r = await T.tagVideos({ videos: dup, tags: ["a", "b", "c"], cap: 400, send: s.send, sleep: noSleep });
  assert.equal(Object.keys(r.tagged).length, 5);
  const asked = s.requests.flatMap((x) => x.questions.map((q) => q.name));
  // the rejected probe is the only place pairs repeat; every accepted request is disjoint
  const okRequests = s.requests.filter((x) => x.questions.length <= 64).flatMap((x) => x.questions.map((q) => q.name));
  assert.equal(new Set(okRequests).size, okRequests.length);
  assert.equal(new Set(asked).size, 5);
});

test("after a re-plan, pairs that already succeeded are not re-sent", async () => {
  // cap 40 works for batch 1, then the server tightens to 10 mid-run
  let calls = 0; const accepted = [];
  const send = async (b) => {
    calls++;
    if (calls > 1 && b.length > 10) throw httpErr(400, "questions must contain 1–10 fields");
    b.forEach((p) => accepted.push(T.nameFor(p.id, p.t)));
    return Object.fromEntries(b.map((p) => [T.nameFor(p.id, p.t), 0.9]));
  };
  const r = await T.runBatches({ pairs: T.makePairs(vids(20), 4), cap: 40, send, sleep: noSleep }); // 80 pairs
  assert.equal(r.failed.length, 0);
  assert.equal(accepted.length, 80);
  assert.equal(new Set(accepted).size, 80);
});

// ---------- ranking ----------
test("rankVideo: keeps every tag within X of the top score, best first, ties by tag order", () => {
  const tags = ["a", "b", "c", "d"], id = "v";
  const p = (arr, none = 0) => ({ [T.nameFor(id, 0)]: { t0: arr[0], t1: arr[1], t2: arr[2], t3: arr[3], none } });
  assert.deepEqual(T.rankVideo(p([0.1, 0.5, 0.3, 0.05]), id, tags, 0.5), ["b", "c"]);       // cut = 0.25
  assert.deepEqual(T.rankVideo(p([0.1, 0.5, 0.3, 0.05]), id, tags, 0), ["b"]);              // 0 = best only
  assert.deepEqual(T.rankVideo(p([0.1, 0.5, 0.3, 0.05]), id, tags, 1), ["b", "c", "a", "d"]); // 1 = everything
  assert.deepEqual(T.rankVideo(p([0.25, 0.25, 0.25, 0.25]), id, tags, 0), ["a", "b", "c", "d"]); // stable ties
  assert.deepEqual(T.rankVideo(p([0.5, 0.25, 0.1, 0.05]), id, tags, 0.5), ["a", "b"]);      // threshold inclusive
});

test("rankVideo: none on top means no tags; none never counts as a tag", () => {
  const tags = ["a", "b"], id = "v", key = T.nameFor(id, 0);
  assert.deepEqual(T.rankVideo({ [key]: { t0: 0.3, t1: 0.2, none: 0.5 } }, id, tags, 0.9), []);
  assert.deepEqual(T.rankVideo({ [key]: { t0: 0.5, t1: 0.2, none: 0.3 } }, id, tags, 0.9), ["a", "b"]);
  assert.deepEqual(T.rankVideo({ [key]: { t0: 0.6, t1: 0.3 } }, id, tags, 0.1), ["a"]);   // server may omit none
});

test("rankVideo returns null when an answer is missing", () => {
  assert.equal(T.rankVideo({}, "v", ["a"], 0.5), null);
  assert.equal(T.rankVideo({ [T.nameFor("v", 0)]: { t0: 0.9 } }, "v", ["a", "b"], 0.5), null);
});

test("tagVideos end-to-end: the within threshold decides which tags are kept", async () => {
  const table = { a: 0.5, b: 0.05, c: 0.3, d: 0.15 };
  const s = server({ p: (_id, t) => table["abcd"[t]] });
  const tags = ["a", "b", "c", "d"];
  const best = await T.tagVideos({ videos: vids(2), tags, within: 0, send: s.send, sleep: noSleep });
  assert.deepEqual(Object.values(best.tagged)[0], ["a"]);
  const mid = await T.tagVideos({ videos: vids(2), tags, within: 0.5, send: s.send, sleep: noSleep });
  assert.deepEqual(Object.values(mid.tagged)[0], ["a", "c"]);
  const all = await T.tagVideos({ videos: vids(2), tags, within: 1, send: s.send, sleep: noSleep });
  assert.deepEqual(Object.values(all.tagged)[0], ["a", "c", "d", "b"]);
});

test("request count is minimal: ceil(videos/cap), independent of tag count", async () => {
  for (const [v, t, cap] of [[100, 7, 64], [20, 3, 64], [5, 40, 64], [1, 1, 64], [1000, 6, 400]]) {
    const s = server();
    await T.tagVideos({ videos: vids(v), tags: Array.from({ length: t }, (_, i) => `t${i}`), cap, send: s.send, sleep: noSleep });
    assert.equal(s.requests.length, Math.ceil(v / cap), `${v}x${t}@${cap}`);
  }
});

test("workUnit fills whole requests and stays bounded", () => {
  assert.equal(T.workUnit(64, 7), 27);    // 9 videos/request x3 -> 189 questions ~ 3 full requests
  assert.equal(T.workUnit(400, 7), 57);   // 57 videos/request, one request per unit
  assert.equal(T.workUnit(400, 1), 60);   // capped so progress isn't minutes apart
  assert.equal(T.workUnit(64, 70), 20);   // more tags than one request holds: still progresses
  assert.equal(T.workUnit(1, 5), 20);
  for (const [cap, tags] of [[64, 3], [64, 10], [100, 6], [8, 2]]) {
    const u = T.workUnit(cap, tags); assert.ok(u >= 1 && u <= 60 || u >= 20, `${cap}/${tags}`);
  }
});

// ---------- AI filter ----------
test("buildFilterBatch: request stated once, metadata included, short labels, one question per video", () => {
  const vs = [
    { id: "idAAAAAAAA1", title: "Learn Rust\nin 1 hour", channel: "Fireship", duration: "59:12", meta: "1.2M views • 3 years ago", watched: 40, pos: 0 },
    { id: "idAAAAAAAA2", title: "Cat video", channel: "", pos: 7 },
  ];
  const byId = Object.fromEntries(vs.map((v) => [v.id, v]));
  const spec = T.buildFilterBatch(vs.map((v) => ({ id: v.id, t: 0 })), byId, "beginner Rust tutorials");
  assert.equal(spec.text.split("beginner Rust tutorials").length - 1, 1);       // not repeated per video
  assert.ok(spec.text.includes("[0] Learn Rust in 1 hour | channel: Fireship | duration 59:12 | 1.2M views • 3 years ago | already watched 40% | list position 1"));
  assert.ok(spec.text.includes("[1] Cat video | list position 8"));              // missing fields are simply omitted
  assert.deepEqual(spec.questions.map((q) => q.instructions), ["Does [0] match the request?", "Does [1] match the request?"]);
  assert.equal(T.parseName(spec.questions[1].name).id, "idAAAAAAAA2");
  assert.ok(!spec.text.includes("idAAAAAAAA1"));                                 // ids stay out of the prompt
});

test("scoreVideos returns a probability per video, dedupes, and discovers the limit", async () => {
  const s = server({ limit: 25, p: (id) => (id.endsWith("7") ? 0.95 : 0.1) });
  const videos = vids(60);
  const r = await T.scoreVideos({ videos: [...videos, videos[0]], query: "q", cap: 400, send: s.send, sleep: noSleep });
  assert.equal(Object.keys(r.scores).length, 60);
  assert.equal(r.cap, 25);
  assert.equal(r.failedIds.length, 0);
  assert.equal(r.scores[videos[7].id], 0.95);
  assert.deepEqual(s.requests.map((x) => x.questions.length), [60, 25, 25, 10]); // 1 rejected probe, then ceil(60/25) = 3
});

test("scoreVideos: a failing batch only fails its own videos", async () => {
  const send = async (spec) => {
    if (spec.questions.some((q) => /^vid0000002\d__/.test(q.name))) throw httpErr(500, "boom");
    return Object.fromEntries(spec.questions.map((q) => [q.name, 0.8]));
  };
  const r = await T.scoreVideos({ videos: vids(30), query: "q", cap: 10, send, retries: 0, sleep: noSleep });
  assert.equal(r.failedIds.length, 10);
  assert.equal(Object.keys(r.scores).length, 20);
});

// ---------- custom question template ----------
test("template placeholders are filled per question", () => {
  const vs = vids(2), byId = Object.fromEntries(vs.map((v) => [v.id, v]));
  const batch = [{ id: vs[0].id, t: 0 }, { id: vs[1].id, t: 0 }];
  const spec = T.buildBatch(batch, byId, ["music", "news"], 'Which tag fits "{title}" from {channel}?');
  assert.equal(spec.questions[0].instructions, `Which tag fits "${vs[0].title}" from ${vs[0].channel}?`);
  assert.equal(spec.questions[1].instructions, `Which tag fits "${vs[1].title}" from ${vs[1].channel}?`);
  assert.equal(T.parseName(spec.questions[1].name).id, vs[1].id);   // names still carry the real ids
});

test("template values are inserted literally (no $ patterns, no re-expansion) and one-lined", () => {
  const byId = { a: { id: "a", title: "Cost: $& $1 {channel}\nline2", channel: "C" } };
  const spec = T.buildBatch([{ id: "a", t: 0 }], byId, ["x"], "{title} / {channel} / {nope}");
  assert.equal(spec.questions[0].instructions, "Cost: $& $1 {channel} line2 / C / {nope}");
});

test("a template containing {tag} (old format) or empty is ignored in favour of the default", () => {
  const vs = vids(1), byId = { [vs[0].id]: vs[0] };
  const want = T.DEFAULT_TEMPLATE.replace("{title}", vs[0].title).replace("{channel}", vs[0].channel);
  assert.equal(T.buildBatch([{ id: vs[0].id, t: 0 }], byId, ["music"], "Is {title} about {tag}?").questions[0].instructions, want);
  assert.equal(T.buildBatch([{ id: vs[0].id, t: 0 }], byId, ["music"], "  ").questions[0].instructions, want);
  assert.equal(T.validTemplate("Is {title} about {tag}?"), false);
  assert.equal(T.validTemplate("  "), false);
  assert.equal(T.validTemplate("Which tag fits {title}?"), true);
});

test("tagVideos passes the template through to the endpoint", async () => {
  const s = server();
  const out = await T.tagVideos({ videos: vids(2), tags: ["music"], send: s.send, template: "{channel}: {title} -> which tag?" });
  assert.equal(Object.keys(out.tagged).length, 2);
  assert.ok(s.requests[0].questions[0].instructions.endsWith("-> which tag?"));
});
