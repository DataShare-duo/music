const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
let pageDefinition,
  route = "pages/home/index",
  navigation,
  app;
const calls = [],
  actions = [],
  toasts = [];
const snapshot = {
  current: {
    id: 1,
    title: "测试曲",
    artist: "歌手",
    cover_url: "https://cover.example/a.jpg",
  },
  source: "netease",
  sourceTrackId: "actual",
  sourceName: "网易云音乐",
  sessionId: "one",
  linkVersion: 1,
  position: 1.5,
  duration: 90,
  playing: true,
  loading: false,
  failed: false,
  queueEnded: false,
  message: "",
};
const lyrics = {
  status: "synced",
  source: "netease",
  source_track_id: "actual",
  source_name: "网易云音乐",
  lines: [
    { time_ms: 0, text: "测试甲" },
    { time_ms: 1000, text: "测试乙" },
  ],
  plain_text: "",
  message: "",
  retry_after: 0,
};
const listeners = new Set();
global.getApp = () => app;
global.getCurrentPages = () => [{ route }];
global.Page = (options) => {
  pageDefinition = options;
};
global.wx = {
  cloud: {
    callContainer: async (options) => {
      calls.push(options);
      return { statusCode: 200, data: lyrics };
    },
  },
  navigateTo: (options) => {
    navigation = options;
  },
  navigateBack: () => actions.push("back"),
  reLaunch: () => actions.push("home"),
  showToast: (options) => toasts.push(options.title),
  getWindowInfo: () => ({ statusBarHeight: 44, windowWidth: 390 }),
  getMenuButtonBoundingClientRect: () => ({ left: 300 }),
  nextTick: (fn) => fn(),
  createSelectorQuery: () => {
    const q = {
      in: () => q,
      select: () => q,
      boundingClientRect: () => q,
      scrollOffset: () => q,
      exec: (callback) =>
        callback([
          { top: 100, height: 400 },
          { scrollTop: 20 },
          { top: 340, height: 80 },
        ]),
    };
    return q;
  },
};
const flush = () => new Promise((r) => setImmediate(r));
const { openPlayer } = require("../dist/routes.js");
test("player entry guards no song, repeated navigation and already open full page", () => {
  app = { player: { state: { current: null } } };
  openPlayer();
  assert.match(toasts.at(-1), /选择歌曲/);
  app.player.state.current = { id: 1 };
  openPlayer();
  assert.equal(navigation.url, "/pages/player/index");
  const first = navigation;
  openPlayer();
  assert.equal(navigation, first);
  first.complete();
  route = "pages/player/index";
  openPlayer();
  assert.equal(navigation, first);
  route = "pages/home/index";
});
test("full page subscribes without new playback, centres active lyric and exits without stopping audio", async () => {
  app = {
    startupError: "",
    player: {
      snapshot: () => snapshot,
      subscribe: (fn) => {
        listeners.add(fn);
        fn(snapshot);
        return () => listeners.delete(fn);
      },
      toggle: () => actions.push("toggle"),
      next: (dir) => actions.push(dir),
      seek: (value) => actions.push(value),
    },
  };
  require("../dist/pages/player/index.js");
  const page = {
    ...pageDefinition,
    data: structuredClone(pageDefinition.data),
    setData(value, complete) {
      Object.assign(this.data, value);
      complete?.();
    },
  };
  page.onLoad();
  page.onShow();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.ok(calls[0].path.endsWith("/lyrics"));
  assert.equal(page.data.lyricStatus, "synced");
  assert.equal(page.data.activeIndex, 1);
  assert.equal(page.data.lyricScrollTop, 100);
  assert.equal(page.data.statusTop, 44);
  page.coverFailed();
  assert.equal(page.data.coverBroken, true);
  page.manualStart();
  page.manualEnd();
  assert.equal(page.data.following, false);
  page.followLyrics();
  assert.equal(page.data.following, true);
  page.toggle();
  page.next();
  page.previous();
  page.seek({ detail: { value: 30 } });
  page.back();
  assert.deepEqual(actions, ["toggle", 1, -1, 30, "back"]);
  page.onHide();
  assert.equal(listeners.size, 0);
  assert.equal(page.lyrics.visible, false);
  page.onShow();
  await flush();
  assert.equal(calls.length, 1);
  page.onUnload();
  assert.equal(listeners.size, 0);
});
test("bottom playback controls and slider stop navigation event bubbling", () => {
  const text = fs.readFileSync(
    path.join(__dirname, "../src/components/player-bar/index.wxml"),
    "utf8",
  );
  assert.ok(text.includes('bindtap="openPlayer"'));
  assert.ok(text.includes('class="controls" catchtap="stopBubble"'));
  assert.ok(text.includes('<slider catchtap="stopBubble"'));
  const config = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../src/pages/player/index.json"),
      "utf8",
    ),
  );
  assert.equal(config.navigationStyle, "custom");
  assert.equal(config.disableScroll, true);
});
