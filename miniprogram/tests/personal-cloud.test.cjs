const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createPersonal, APP_ID } = require("../cloudfunctions/personal/core");
const context = (openid) => ({
  APPID: APP_ID,
  OPENID: openid,
  SOURCE: "wx_client",
});
const song = (id = "1", source = "soda") => ({
  source,
  source_track_id: id,
  title: "歌曲 " + id,
  artist: "歌手",
  album: "",
  cover_url: "",
  duration: 180,
  audio_url: "https://secret.example",
  id: 999,
});
function setup() {
  const docs = new Map();
  let tail = Promise.resolve(),
    time = 10000;
  const removed = [];
  let validated = 0;
  const handle = createPersonal({
    clock: () => time++,
    store: {
      transact(owner, update) {
        const next = tail.then(async () => {
          const value = await update(docs.get(owner));
          if (value.doc) docs.set(owner, value.doc);
          return value.result;
        });
        tail = next.catch(() => {});
        return next;
      },
    },
    storage: {
      validate: async () => {
        validated++;
      },
      remove: async (x) => removed.push(x),
    },
  });
  return {
    handle,
    docs,
    removed,
    validated: () => validated,
    call: (action, data = {}, who = "a") =>
      handle({ action, data }, context(who)),
  };
}
const sync = (kind, ops, epoch = 0) => ({ kind, ops, epoch });
test("personal cloud rejects spoofed identities and keeps users isolated", async () => {
  const s = setup();
  assert.equal(
    (await s.handle({ action: "profile.enable" }, {})).error.code,
    "unauthenticated",
  );
  assert.equal(
    (
      await s.handle(
        { action: "profile.enable" },
        { ...context("a"), APPID: "wrong" },
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await s.handle(
        { action: "profile.enable", openid: "victim" },
        context("a"),
      )
    ).error.code,
    "invalid_identity",
  );
  assert.equal((await s.call("profile.get")).data.active, false);
  assert.equal(s.docs.size, 0);
  await s.call("profile.enable");
  await s.call("mark.set", {
    kind: "favorite",
    value: true,
    song: song(),
    opId: "first",
  });
  const b = await s.call("profile.enable", {}, "b");
  assert.equal(b.data.favorite.length, 0);
  assert.equal(s.docs.size, 2);
  assert.equal((await s.call("profile.get")).data.favorite.length, 1);
});
test("favorite and like are independent, set is idempotent and snapshots exclude temporary URLs and local IDs", async () => {
  const s = setup();
  await s.call("profile.enable");
  const body = { kind: "favorite", value: true, song: song(), opId: "one" };
  await Promise.all([s.call("mark.set", body), s.call("mark.set", body)]);
  await s.call("mark.set", { ...body, kind: "like", opId: "two" });
  let v = (await s.call("profile.get")).data;
  assert.equal(v.favorite.length, 1);
  assert.equal(v.like.length, 1);
  assert.equal(v.favorite[0].song.id, undefined);
  assert.equal(v.favorite[0].song.audio_url, undefined);
  await s.call("mark.set", { ...body, value: false, opId: "three" });
  v = (await s.call("profile.get")).data;
  assert.equal(v.favorite.length, 0);
  assert.equal(v.like.length, 1);
  assert.equal(
    (await s.call("mark.set", { ...body, song: { ...song(), source: "evil" } }))
      .ok,
    false,
  );
});
test("history deduplicates, orders timestamps, caps search at 20 and rejects old epoch after deletion/clear", async () => {
  const s = setup();
  await s.call("profile.enable");
  const ops = Array.from({ length: 25 }, (_, i) => ({
    id: "q" + i,
    type: "put",
    query: "关键词" + i,
    at: 100 + i,
  }));
  let v = await s.call("history.sync", sync("search", ops));
  assert.equal(v.data.search.items.length, 20);
  assert.equal(v.data.search.items[0].query, "关键词24");
  v = await s.call(
    "history.sync",
    sync("search", [{ id: "repeat", type: "put", query: "关键词5", at: 1000 }]),
  );
  assert.equal(v.data.search.items[0].query, "关键词5");
  v = await s.call(
    "history.sync",
    sync("search", [{ id: "del", type: "remove", key: "关键词5" }]),
  );
  assert.equal(v.data.search.epoch, 1);
  v = await s.call(
    "history.sync",
    sync("search", [{ id: "late", type: "put", query: "关键词5", at: 9999 }]),
  );
  assert.equal(v.data.conflict, true);
  assert.ok(!v.data.search.items.some((x) => x.query === "关键词5"));
  v = await s.call(
    "history.sync",
    sync("search", [{ id: "clear", type: "clear" }], 1),
  );
  assert.equal(v.data.search.epoch, 2);
  v = await s.call("history.sync", sync("search", ops, 1));
  assert.equal(v.data.search.items.length, 0);
  assert.equal(v.data.conflict, true);
});
test("recent keeps 100 distinct stable songs and event retries never reorder or duplicate", async () => {
  const s = setup();
  await s.call("profile.enable");
  const ops = Array.from({ length: 105 }, (_, i) => ({
    id: "play" + i,
    type: "put",
    song: song(String(i)),
    at: 100 + i,
    sourceName: "网易云音乐",
  }));
  let v = await s.call("history.sync", sync("recent", ops));
  assert.equal(v.data.recent.items.length, 100);
  assert.equal(v.data.recent.items[0].key, "soda:104");
  await s.call("history.sync", sync("recent", [{ ...ops[104], at: 9999 }]));
  v = await s.call(
    "history.sync",
    sync("recent", [
      { id: "new-session", type: "put", song: song("10"), at: 500 },
    ]),
  );
  assert.equal(v.data.recent.items[0].key, "soda:10");
  assert.equal(v.data.recent.items.length, 100);
  assert.equal(v.data.recent.items[1].at, 204);
});
test("avatar is scoped to owner and old avatar cleaned only after committed replacement", async () => {
  const s = setup();
  const v = (await s.call("profile.enable")).data;
  assert.equal(
    (
      await s.call("avatar.set", {
        fileID: "cloud://env/avatars/other/abcdefgh.jpg",
      })
    ).ok,
    false,
  );
  const file = "cloud://env/avatars/" + v.userKey + "/abcdefgh.jpg";
  assert.equal((await s.call("avatar.set", { fileID: file })).ok, true);
  await s.call("avatar.set", { fileID: file.replace("abcdefgh", "ijklmnop") });
  assert.deepEqual(s.removed, [file]);
  assert.equal(s.validated(), 2);
});
test("invalid history input and per-user request limits fail without corrupting stored state", async () => {
  const s = setup();
  await s.call("profile.enable");
  assert.equal(
    (
      await s.call(
        "history.sync",
        sync("search", [{ id: "x", type: "inject", query: "x" }]),
      )
    ).ok,
    false,
  );
  for (let i = 0; i < 130; i++) await s.call("profile.get");
  const limit = await s.call("profile.get");
  assert.equal(limit.error.code, "rate_limited");
  assert.equal((await s.call("profile.enable", {}, "b")).ok, true);
});

test("non-client invocations and excessive avatar probes are rejected before downloading images", async () => {
  const s = setup();
  assert.equal(
    (
      await s.handle(
        { action: "profile.enable" },
        { ...context("a"), SOURCE: "scf" },
      )
    ).error.code,
    "unauthenticated",
  );
  const owner = (await s.call("profile.enable")).data.userKey;
  const file = "cloud://env/avatars/" + owner + "/abcdefgh.jpg";
  for (let i = 0; i < 5; i++)
    assert.equal((await s.call("avatar.set", { fileID: file })).ok, true);
  assert.equal(
    (await s.call("avatar.set", { fileID: file })).error.code,
    "rate_limited",
  );
  assert.equal(s.validated(), 5);
});
