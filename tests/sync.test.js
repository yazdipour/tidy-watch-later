const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../sync.js");

const id = (n) => `vid${String(n).padStart(8, "0")}`;
const many = (n, tags = ["music", "news"]) => Object.fromEntries(Array.from({ length: n }, (_, i) => [id(i), [tags[i % tags.length]]]));

// In-memory stand-in for chrome.storage.{local,sync} that fires onChanged like the real thing.
function fakeArea(name, bus, { quota = Infinity } = {}) {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const ks = typeof keys === "string" ? [keys] : keys;
      return structuredClone(Object.fromEntries(ks.filter((k) => k in data).map((k) => [k, data[k]])));
    },
    async set(obj) {
      const changes = {};
      const bytes = Object.values({ ...data, ...obj }).reduce((n, v) => n + JSON.stringify(v).length, 0);
      if (bytes > quota) throw new Error("QUOTA_BYTES quota exceeded");
      for (const [k, v] of Object.entries(obj)) {
        if (JSON.stringify(data[k]) === JSON.stringify(v)) continue;
        changes[k] = { oldValue: data[k], newValue: structuredClone(v) }; data[k] = structuredClone(v);
      }
      if (Object.keys(changes).length) bus.emit(changes, name);
    },
    async remove(keys) {
      const changes = {};
      for (const k of [].concat(keys)) if (k in data) { changes[k] = { oldValue: data[k] }; delete data[k]; }
      if (Object.keys(changes).length) bus.emit(changes, name);
    },
  };
}
const makeBus = () => { const fns = []; return { emit: (c, a) => fns.forEach((f) => f(c, a)), on: (f) => fns.push(f) }; };

// One "device": its own local storage + controller, sharing one cloud `sync` area with other devices.
function device(cloud, { now, quota } = {}) {
  const bus = makeBus(), local = fakeArea("local", bus);
  let t = 1000; const clock = now || (() => ++t);
  const s = S.createSync({ local, sync: cloud.area, onChanged: bus.on, now: clock, delay: 1e9 });
  cloud.devices.push({ bus, s });
  return { local, s, bus };
}
function makeCloud() {
  const cloud = { devices: [] };
  const bus = makeBus();
  cloud.area = fakeArea("sync", { emit: (c, a) => { bus.emit(c, a); cloud.devices.forEach((d) => d.bus.emit(c, a)); } }, { quota: 100 * 1024 });
  return cloud;
}
const settle = async (...ds) => { for (let i = 0; i < 3; i++) for (const d of ds) { await d.s.flush(); await d.s.idle(); } };

// ---------- encoding ----------
test("encode/decode round-trips tags, empty tag lists and odd tag names", () => {
  const vt = { [id(1)]: ["music", "ünï; cødé:1,2"], [id(2)]: [], [id(3)]: ["news"] };
  const e = S.encode(vt);
  assert.deepEqual(S.decode(e.meta, e.chunks), vt);
});

test("encode keeps every item under the 8KB sync item limit and total under 100KB for 3000 videos", () => {
  const e = S.encode(many(3000));
  const items = [e.meta, ...e.chunks];
  assert.ok(items.every((x) => JSON.stringify(x).length < 8000));
  assert.ok(items.reduce((n, x) => n + JSON.stringify(x).length, 0) < 100 * 1024 * 0.6);
  assert.equal(Object.keys(S.decode(e.meta, e.chunks)).length, 3000);
});

test("encode caps at MAX_VIDEOS, keeping the most recently added", () => {
  const e = S.encode(many(S.MAX_VIDEOS + 50));
  const back = S.decode(e.meta, e.chunks);
  assert.equal(Object.keys(back).length, S.MAX_VIDEOS);
  assert.ok(!(id(0) in back) && id(S.MAX_VIDEOS + 49) in back);
});

test("decode survives missing or corrupt chunks", () => {
  const e = S.encode(many(10));
  assert.deepEqual(S.decode(e.meta, [undefined]), {});
  assert.doesNotThrow(() => S.decode({ ts: 1, tags: ["a"], n: 1 }, ["garbage;;:;x:99;"]));
});

// ---------- pruning ----------
test("pruneGone drops entries whose video is no longer in the list", () => {
  const r = S.pruneGone({ a1: ["x"], b2: ["y"], c3: [] }, ["a1", "c3", "new9"]);
  assert.deepEqual(r.kept, { a1: ["x"], c3: [] });
  assert.deepEqual(r.removed, ["b2"]);
});

test("pruneGone does nothing when the list looks empty or unrelated (broken page, wrong list)", () => {
  const store = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [id(i), ["x"]]));
  assert.deepEqual(S.pruneGone(store, []).removed, []);
  assert.deepEqual(S.pruneGone(store, ["zzzzzzzzzzz", "yyyyyyyyyyy"]).removed, []); // zero overlap
  assert.deepEqual(S.pruneGone({ a1: ["x"] }, ["other"]).removed, []);              // zero overlap, even tiny store
});

test("pruneGone returns the same data when everything is present", () => {
  const store = many(5);
  assert.deepEqual(S.pruneGone(store, Object.keys(store)).kept, store);
});

// ---------- sync between devices ----------
test("sync is off by default: nothing is written to the cloud", async () => {
  const cloud = makeCloud(), A = device(cloud);
  A.s.start();
  await A.local.set({ vidTags: many(5) });
  await settle(A);
  assert.deepEqual(cloud.area.data, {});
});

test("tags set on device A show up on device B", async () => {
  const cloud = makeCloud(), A = device(cloud), B = device(cloud);
  A.s.start(); B.s.start();
  await A.local.set({ syncOn: true, vidTags: { [id(1)]: ["music"] } });
  await B.local.set({ syncOn: true });
  await settle(A, B);
  assert.deepEqual(B.local.data.vidTags, { [id(1)]: ["music"] });
});

test("enabling sync on a fresh device merges, keeping its own tags", async () => {
  const cloud = makeCloud(), A = device(cloud), B = device(cloud);
  A.s.start(); B.s.start();
  await A.local.set({ syncOn: true, vidTags: { [id(1)]: ["music"], [id(2)]: ["news"] } });
  await settle(A);
  await B.local.set({ vidTags: { [id(3)]: ["tech"], [id(2)]: ["old"] } });
  await B.local.set({ syncOn: true });
  await settle(A, B);
  const want = { [id(1)]: ["music"], [id(2)]: ["old"], [id(3)]: ["tech"] }; // local wins on conflict during first merge
  assert.deepEqual(B.local.data.vidTags, want);
  assert.deepEqual(A.local.data.vidTags, want);
});

test("a prune on one device (video gone) removes the tags on the other device", async () => {
  const cloud = makeCloud(), A = device(cloud), B = device(cloud);
  A.s.start(); B.s.start();
  await A.local.set({ syncOn: true, vidTags: { [id(1)]: ["a"], [id(2)]: ["b"] } });
  await B.local.set({ syncOn: true });
  await settle(A, B);
  assert.equal(Object.keys(B.local.data.vidTags).length, 2);
  await A.local.set({ vidTags: S.pruneGone(A.local.data.vidTags, [id(1)]).kept });
  await settle(A, B);
  assert.deepEqual(B.local.data.vidTags, { [id(1)]: ["a"] });
});

test("the most recent change wins and devices converge without ping-pong", async () => {
  const cloud = makeCloud(), A = device(cloud), B = device(cloud);
  A.s.start(); B.s.start();
  await A.local.set({ syncOn: true, vidTags: { [id(1)]: ["a"] } });
  await B.local.set({ syncOn: true });
  await settle(A, B);
  await B.local.set({ vidTags: { [id(1)]: ["b"] } });
  await settle(A, B);
  assert.deepEqual(A.local.data.vidTags, { [id(1)]: ["b"] });
  const writes = []; const orig = cloud.area.set; cloud.area.set = async (o) => { writes.push(o); return orig(o); };
  await settle(A, B);
  assert.equal(writes.length, 0); // quiet once converged
});

test("clearing all tags on one device clears them everywhere", async () => {
  const cloud = makeCloud(), A = device(cloud), B = device(cloud);
  A.s.start(); B.s.start();
  await A.local.set({ syncOn: true, vidTags: many(10) });
  await B.local.set({ syncOn: true });
  await settle(A, B);
  await A.local.set({ vidTags: {} });
  await settle(A, B);
  assert.deepEqual(B.local.data.vidTags, {});
});

test("shrinking the data removes stale chunks from the cloud", async () => {
  const cloud = makeCloud(), A = device(cloud);
  A.s.start();
  await A.local.set({ syncOn: true, vidTags: many(2500) });
  await settle(A);
  const before = Object.keys(cloud.area.data).length;
  assert.ok(before > 3);
  await A.local.set({ vidTags: many(10) });
  await settle(A);
  assert.ok(Object.keys(cloud.area.data).length < before);
  assert.equal(Object.keys(S.decode(cloud.area.data[S.META], Object.keys(cloud.area.data).filter((k) => k.startsWith(S.CHUNK_PREFIX)).sort().map((k) => cloud.area.data[k]))).length, 10);
});

test("a clock-skewed device cannot be ignored: its write still gets a newer timestamp", async () => {
  const cloud = makeCloud(), A = device(cloud, { now: () => 9_000_000 }), B = device(cloud, { now: () => 5 });
  A.s.start(); B.s.start();
  await A.local.set({ syncOn: true, vidTags: { [id(1)]: ["a"] } });
  await B.local.set({ syncOn: true });
  await settle(A, B);
  await B.local.set({ vidTags: { [id(1)]: ["b"] } });
  await settle(A, B);
  assert.deepEqual(A.local.data.vidTags, { [id(1)]: ["b"] });
});

test("a failed cloud write (quota) is reported and local data is untouched", async () => {
  const cloud = makeCloud(); cloud.area.set = async () => { throw new Error("QUOTA_BYTES quota exceeded"); };
  const A = device(cloud); A.s.start();
  await A.local.set({ syncOn: true, vidTags: many(5) });
  await settle(A);
  assert.match(A.local.data.syncError, /quota/i);
  assert.equal(Object.keys(A.local.data.vidTags).length, 5);
});

test("a successful sync clears an earlier error", async () => {
  const cloud = makeCloud(), A = device(cloud); A.s.start();
  await A.local.set({ syncOn: true, syncError: "old", vidTags: many(2) });
  await settle(A);
  assert.equal(A.local.data.syncError, "");
});
