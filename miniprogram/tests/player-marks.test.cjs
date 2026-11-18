const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
let definition, app;
global.Page = (value) => {
  definition = value;
};
global.getApp = () => app;
global.wx = {
  showShareMenu() {},
  getWindowInfo: () => ({ statusBarHeight: 24, windowWidth: 390 }),
  getMenuButtonBoundingClientRect: () => ({ left: 290 }),
};
const { PersonalStore, songKey } = require("../dist/services/personal.js");
require("../dist/pages/player/index.js");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const track = (id) => ({
  id,
  source: "soda",
  source_track_id: String(id),
  title: "歌曲 " + id,
  artist: "歌手",
  album: "",
  cover_url: "",
  duration: 180,
  audio_kind: "full",
});
const entry = (song) => ({ key: songKey(song), song, at: 1 });
const view = (revision, favorite = [], like = []) => ({
  revision,
  active: true,
  userKey: "test-user",
  avatar: "",
  favorite,
  like,
  search: null,
  recent: null,
});
const tap = (kind) => ({ currentTarget: { dataset: { kind } } });
function setup() {
  const requests = [],
    patches = [];
  let nextId = 0;
  const personal = new PersonalStore(
    (action, data) =>
      new Promise((resolve, reject) =>
        requests.push({ action, data, resolve, reject }),
      ),
    async () => "op-" + ++nextId,
    { read: () => null, write() {} },
  );
  personal.data.active = true;
  personal.data.userKey = "test-user";
  const state = {
    current: track(1),
    playing: true,
    loading: false,
    failed: false,
    position: 12,
    duration: 180,
    sourceName: "汽水音乐",
    sessionId: "one",
    message: "",
    queueEnded: false,
    continuing: false,
  };
  app = { personal, player: { state, queueSnapshot: () => [state.current] } };
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(values, complete) {
      patches.push(values);
      Object.assign(this.data, values);
      complete?.();
    },
  };
  page.onLoad();
  page.visible = true;
  page.personalUnsubscribe = personal.subscribe((state) => {
    page.renderPlayer(app.player.state);
    page.setData({ personalError: state.error });
  });
  return { page, personal, state, requests, patches };
}

test("pending favorite never dims either action; like submits independently and each response updates only its own mark", async () => {
  const { page, state, requests, patches } = setup();
  const favorite = page.toggleMark(tap("favorite"));
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(page.data.favorite, false);
  assert.equal(page.data.liked, false);
  assert.equal(page.data.hasSong, true);
  const like = page.toggleMark(tap("like"));
  await flush();
  assert.deepEqual(
    requests.map((r) => r.data.kind),
    ["favorite", "like"],
  );
  requests[0].resolve(view(1, [entry(state.current)]));
  await favorite;
  assert.equal(page.data.favorite, true);
  assert.equal(page.data.liked, false);
  requests[1].resolve(view(2, [entry(state.current)], [entry(state.current)]));
  await like;
  assert.equal(page.data.favorite, true);
  assert.equal(page.data.liked, true);
  assert.equal(state.playing, true);
  assert.ok(patches.every((p) => !("markLoading" in p) && !("disabled" in p)));
});

test("repeat taps on the same song and mark are deduplicated without a shared button lock", async () => {
  const { page, state, requests } = setup();
  const first = page.toggleMark(tap("favorite"));
  const repeat = page.toggleMark(tap("favorite"));
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].action, "mark.set");
  requests[0].resolve(view(1, [entry(state.current)]));
  await Promise.all([first, repeat]);
  assert.equal(page.data.favorite, true);
  const remove = page.toggleMark(tap("favorite"));
  await flush();
  assert.equal(requests[1].data.value, false);
  requests[1].resolve(view(2));
  await remove;
  assert.equal(page.data.favorite, false);
});

test("out-of-order favorite and like responses cannot roll back the newer personal state", async () => {
  const { page, state, requests } = setup();
  const favorite = page.toggleMark(tap("favorite"));
  const like = page.toggleMark(tap("like"));
  await flush();
  requests[1].resolve(view(2, [entry(state.current)], [entry(state.current)]));
  await like;
  requests[0].resolve(view(1, [entry(state.current)]));
  await favorite;
  assert.equal(page.data.favorite, true);
  assert.equal(page.data.liked, true);
});

test("switching songs during a save does not block the new song or apply old marks to it", async () => {
  const { page, state, requests } = setup();
  const oldSong = state.current;
  const oldMark = page.toggleMark(tap("favorite"));
  await flush();
  state.current = track(2);
  state.sessionId = "two";
  page.renderPlayer(state);
  const newMark = page.toggleMark(tap("like"));
  await flush();
  assert.equal(requests[1].data.song.source_track_id, "2");
  requests[0].resolve(view(1, [entry(oldSong)]));
  await oldMark;
  assert.equal(page.data.favorite, false);
  assert.equal(page.data.liked, false);
  requests[1].resolve(view(2, [entry(oldSong)], [entry(state.current)]));
  await newMark;
  assert.equal(page.data.favorite, false);
  assert.equal(page.data.liked, true);
  assert.equal(state.sessionId, "two");
});

test("failed saves release the per-mark guard for retry and never interrupt playback", async () => {
  const { page, state, requests } = setup();
  const first = page.toggleMark(tap("favorite"));
  await flush();
  requests[0].reject(new Error("网络异常，请重试"));
  await first;
  assert.match(page.data.personalError, /网络异常/);
  assert.equal(page.data.favorite, false);
  assert.equal(state.playing, true);
  const retry = page.toggleMark(tap("favorite"));
  await flush();
  requests[1].resolve(view(1, [entry(state.current)]));
  await retry;
  assert.equal(page.data.favorite, true);
  assert.equal(page.data.personalError, "");
});

test("invalid marks and no-song clicks make no request; native disabled and pressed styles remain transparent", async () => {
  const { page, state, requests } = setup();
  await page.toggleMark(tap("unknown"));
  state.current = null;
  await page.toggleMark(tap("favorite"));
  assert.equal(requests.length, 0);
  const markup = fs.readFileSync(
    path.join(__dirname, "../src/pages/player/index.wxml"),
    "utf8",
  );
  const buttons = [
    ...markup.matchAll(/<button\b[^>]*data-kind="(?:favorite|like)"[^>]*>/g),
  ];
  assert.equal(buttons.length, 2);
  for (const [button] of buttons)
    assert.ok(button.includes('disabled="{{!hasSong}}"'));
  assert.ok(!markup.includes("markLoading"));
  const css = fs.readFileSync(
    path.join(__dirname, "../src/pages/player/index.wxss"),
    "utf8",
  );
  for (const selector of [
    ".personal-action[disabled]",
    ".personal-action-pressed",
  ]) {
    const start = css.indexOf(selector + " {");
    assert.notEqual(start, -1);
    assert.match(
      css.slice(start, css.indexOf("}", start)),
      /background: transparent/,
    );
  }
});
