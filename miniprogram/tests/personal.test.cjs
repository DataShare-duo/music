const { test } = require("node:test");
const assert = require("node:assert/strict");
global.wx = {
  cloud: { callContainer: async () => ({ statusCode: 200, data: {} }) },
  showModal: async () => ({ confirm: true }),
};
const { PersonalStore } = require("../dist/services/personal");
const { createPersonal, APP_ID } = require("../cloudfunctions/personal/core");
const song = (id = "1") => ({
  source: "soda",
  source_track_id: id,
  title: "歌曲 " + id,
  artist: "歌手",
  album: "",
  cover_url: "",
  duration: 180,
});
function fixture() {
  let document,
    tail = Promise.resolve(),
    n = 0,
    offline = false;
  const handle = createPersonal({
    store: {
      transact(_, update) {
        const next = tail.then(async () => {
          const v = await update(document);
          document = v.doc;
          return v.result;
        });
        tail = next.catch(() => {});
        return next;
      },
    },
    storage: { validate: async () => {}, remove: async () => {} },
  });
  const call = async (action, data = {}) => {
    if (offline) throw new Error("offline");
    const r = await handle(
      { action, data },
      { APPID: APP_ID, OPENID: "owner", SOURCE: "wx_client" },
    );
    if (!r.ok) throw new Error(r.error.message);
    return r.data;
  };
  const make = () => {
    let local;
    const store = new PersonalStore(call, async () => String(++n), {
      read: () => undefined,
      write: (x) => {
        local = structuredClone(x);
      },
    });
    return { store, local: () => local };
  };
  return {
    make,
    call,
    offline: (x) => {
      offline = x;
    },
  };
}
const tick = () => new Promise((r) => setImmediate(r));
async function settle(...stores) {
  for (let n = 0; n < 40; n++) {
    await tick();
    if (stores.every((s) => !s.syncing && !s.syncRequested)) {
      await tick();
      return;
    }
  }
  throw new Error("sync did not drain");
}
test("guest search and actual play stay local, are bounded, and merge only after confirmation", async () => {
  const f = fixture(),
    { store } = f.make();
  for (let i = 0; i < 25; i++) store.recordSearch("关键词" + i);
  store.recordPlayed(song(), "session1", "酷我音乐");
  store.recordPlayed(song(), "session1", "酷我音乐");
  await store.operationChain;
  assert.equal(store.data.active, false);
  assert.equal(store.data.search.items.length, 20);
  assert.equal(store.data.recent.items.length, 1);
  assert.equal(await store.enable(), true);
  await settle(store);
  const remote = await f.call("profile.get");
  assert.equal(remote.search.items.length, 20);
  assert.equal(remote.recent.items.length, 1);
  const { store: second } = f.make();
  await second.enable();
  await settle(second);
  assert.equal(second.data.recent.items[0].key, "soda:1");
});
test("cloud failure preserves bounded local history and retries without duplication", async () => {
  const f = fixture(),
    { store } = f.make();
  await store.enable();
  f.offline(true);
  store.recordSearch("离线搜索");
  store.recordPlayed(song(), "actual1", "汽水音乐");
  await store.operationChain;
  await settle(store);
  assert.ok(store.data.error);
  assert.equal(store.data.search.items.length, 1);
  assert.ok(store.data.search.pending.length);
  f.offline(false);
  await store.sync();
  await settle(store);
  assert.equal(store.data.search.pending.length, 0);
  assert.equal((await f.call("profile.get")).search.items.length, 1);
  assert.equal(store.data.error, "");
});
test("cloud deletion epochs prevent a second device replaying stale search and recent puts", async () => {
  const f = fixture(),
    a = f.make().store,
    b = f.make().store;
  await a.enable();
  await b.enable();
  a.recordSearch("旧搜索");
  a.recordPlayed(song(), "first", "网易云音乐");
  await a.operationChain;
  await settle(a);
  await b.sync();
  f.offline(true);
  a.recordSearch("旧搜索");
  a.recordPlayed(song(), "second", "网易云音乐");
  await a.operationChain;
  await settle(a);
  f.offline(false);
  await b.clear("search");
  await b.clear("recent");
  await settle(b);
  await a.sync();
  await settle(a);
  assert.equal(a.data.search.items.length, 0);
  assert.equal(a.data.recent.items.length, 0);
  const v = await f.call("profile.get");
  assert.equal(v.search.items.length, 0);
  assert.equal(v.recent.items.length, 0);
});
test("new search after a completed clear is accepted, manual deletion does not require login as guest", async () => {
  const f = fixture(),
    s = f.make().store;
  s.recordSearch("中文 %41");
  await s.operationChain;
  await s.remove("search", "中文 %41");
  assert.equal(s.data.search.items.length, 0);
  await s.enable();
  await s.clear("search");
  await settle(s);
  s.recordSearch("新的歌");
  await s.operationChain;
  await settle(s);
  assert.equal((await f.call("profile.get")).search.items[0].query, "新的歌");
});
test("mark response never mutates the captured stable identity and latest revision wins", async () => {
  const f = fixture(),
    s = f.make().store;
  await s.enable();
  const captured = song("1");
  const task = s.mark("favorite", captured, true);
  captured.source_track_id = "2";
  await task;
  assert.equal(s.data.favorite[0].key, "soda:1");
  await s.mark("like", song("1"), true);
  assert.equal(s.has("like", song("1")), true);
  await s.mark("favorite", song("1"), false);
  assert.equal(s.has("favorite", song("1")), false);
  assert.equal(s.has("like", song("1")), true);
});
test("cancelled activation does not create an account, and corrupt local cache is ignored", async () => {
  const f = fixture();
  global.wx.showModal = async () => ({ confirm: false });
  try {
    const s = new PersonalStore(f.call, async () => "x", {
      read: () => ({ search: { items: ["broken"] } }),
      write: () => {},
    });
    assert.equal(await s.enable(), false);
    assert.equal((await f.call("profile.get")).active, false);
    assert.equal(s.data.recent.items.length, 0);
  } finally {
    global.wx.showModal = async () => ({ confirm: true });
  }
});

test("offline queue never silently drops deletion barriers to make room for newer history", async () => {
  const f = fixture(),
    s = f.make().store;
  for (let i = 0; i < 120; i++) await s.remove("recent", "soda:" + i);
  assert.equal(s.data.recent.pending.length, 120);
  s.recordPlayed(song("new"), "new-event", "汽水音乐");
  await s.operationChain;
  await settle(s);
  assert.equal(s.data.recent.pending.length, 120);
  assert.ok(s.data.recent.pending.every((x) => x.type === "remove"));
  assert.match(s.data.error, /队列已满/);
});
