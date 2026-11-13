const { test } = require("node:test");
const assert = require("node:assert/strict");
let definition,
  app,
  scene = 1001;
const calls = [],
  navigation = [];
const song = {
  id: 42,
  source: "soda",
  source_track_id: "platform-1",
  title: "歌曲 A&B + 中文",
  artist: "歌手",
  album: "专辑",
  duration: 180,
  cover_url: "https://cover.example/a.jpg",
  audio_kind: "full",
};
global.Page = (x) => (definition = x);
global.getApp = () => app;
global.getCurrentPages = () => [{ route: "pages/song/index" }];
global.wx = {
  cloud: {
    callContainer: async (options) => {
      calls.push(options);
      return {
        statusCode: 200,
        data: { status: "available", song, message: "" },
      };
    },
  },
  getLaunchOptionsSync: () => ({ scene }),
  showShareMenu: () => {},
  navigateTo: (x) => {
    navigation.push(x.url);
    x.complete?.();
  },
  reLaunch: () => {},
  showToast: () => {},
};
const {
  shareCard,
  shareQuery,
  readShared,
  restoreSong,
} = require("../dist/services/songs");
require("../dist/pages/song/index");
const tick = () => new Promise((r) => setImmediate(r));
const options = () =>
  Object.fromEntries(
    shareQuery(song)
      .split("&")
      .map((x) => {
        const at = x.indexOf("=");
        return [x.slice(0, at), x.slice(at + 1)];
      }),
  );
function make(current = null, playing = false) {
  calls.length = 0;
  navigation.length = 0;
  let plays = 0;
  app = {
    player: {
      state: { current, playing, loading: false, failed: false },
      play: async (value) => {
        plays++;
        app.player.state.current = value;
        app.player.state.playing = true;
      },
      toggle: async () => {
        app.player.state.playing = true;
      },
    },
  };
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData: (x) => Object.assign(page.data, x),
  };
  return { page, plays: () => plays };
}
test("share paths roundtrip stable platform identity and exclude audio/session/user and SQLite IDs", () => {
  const result = shareCard(song);
  assert.equal(result.path, "/pages/song/index?" + shareQuery(song));
  assert.equal(readShared(options()).title, song.title);
  assert.equal(readShared(options()).source_track_id, song.source_track_id);
  for (const key of ["audio_url", "sessionId", "openid", "id=42"])
    assert.ok(!result.path.includes(key));
  assert.equal(readShared({ s: "http://private", t: "x", q: "歌" }), null);
  assert.equal(readShared({ s: "soda", t: "../bad", q: "歌" }), null);
});
test("idle shared entry attempts once and repeated onShow does not create playback", async () => {
  scene = 1001;
  const { page, plays } = make();
  page.onLoad(options());
  assert.equal(calls.length, 0);
  assert.equal(plays(), 0);
  page.onShow();
  await tick();
  assert.equal(plays(), 1);
  assert.equal(calls.length, 1);
  page.onHide();
  page.onShow();
  await tick();
  assert.equal(plays(), 1);
  page.onUnload();
});
test("shared entry preserves another playing song and explicit play switches", async () => {
  const other = { ...song, source_track_id: "other" };
  const { page, plays } = make(other, true);
  page.onLoad(options());
  page.onShow();
  await tick();
  assert.equal(plays(), 0);
  assert.match(page.data.message, /保留当前播放/);
  await page.play();
  assert.equal(plays(), 1);
  page.onUnload();
});
test("same song reuses current playback without resolving a new playback session", async () => {
  const { page, plays } = make(song, true);
  page.onLoad(options());
  page.onShow();
  await tick();
  assert.equal(plays(), 0);
  await page.play();
  assert.equal(plays(), 0);
  page.onUnload();
});
test("timeline single page exposes song text but performs no cloud/music call", async () => {
  scene = 1154;
  const { page, plays } = make();
  page.onLoad(options());
  page.onShow();
  await tick();
  assert.equal(page.data.limited, true);
  assert.equal(calls.length, 0);
  assert.equal(plays(), 0);
  assert.equal(page.onShareTimeline().query, shareQuery(readShared(options())));
  page.onUnload();
  scene = 1001;
});
test("late shared-song response cannot start after page hides", async () => {
  let resolve;
  const original = global.wx.cloud.callContainer;
  global.wx.cloud.callContainer = () =>
    new Promise((r) => {
      resolve = r;
    });
  try {
    const { page, plays } = make();
    page.onLoad(options());
    page.onShow();
    page.onHide();
    resolve({ statusCode: 200, data: { status: "available", song } });
    await tick();
    assert.equal(plays(), 0);
    page.onUnload();
  } finally {
    global.wx.cloud.callContainer = original;
  }
});
test("restore refuses response for another platform track", async () => {
  const original = global.wx.cloud.callContainer;
  global.wx.cloud.callContainer = async () => ({
    statusCode: 200,
    data: {
      status: "available",
      song: { ...song, source_track_id: "other" },
      message: "不匹配",
    },
  });
  try {
    await assert.rejects(restoreSong(song), /不匹配/);
  } finally {
    global.wx.cloud.callContainer = original;
  }
});
