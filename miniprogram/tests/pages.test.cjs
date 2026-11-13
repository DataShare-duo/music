const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
let app, definition;
const calls = [],
  navigation = [];
const song = (id = 1) => ({
  id,
  source: "soda",
  source_track_id: String(id),
  title: "歌曲 " + id,
  artist: "歌手",
  album: "专辑",
  cover_url: "",
  duration: 180,
  audio_kind: "full",
  play_source_name: "网易云音乐",
});
const result = (items = [song()]) => ({
  items,
  count: items.length,
  refreshing: false,
  message: null,
  has_more: true,
  page: 1,
});
global.Page = (options) => {
  definition = options;
};
global.wx = {
  cloud: {
    callContainer: async (options) => {
      calls.push(options);
      return { statusCode: 200, data: result() };
    },
  },
  navigateTo: (options) => navigation.push(options.url),
  reLaunch: (options) => navigation.push(options.url),
};
global.getApp = () => app;
const {
  registerMusicPage,
  presentSongs,
} = require("../dist/shared/music-page.js");
const flush = () => new Promise((r) => setImmediate(r));
function make(mode, options = {}) {
  calls.length = 0;
  navigation.length = 0;
  const hidden = new Set();
  const listeners = new Set();
  const played = [];
  let toggled = 0;
  app = {
    startupError: "",
    player: {
      availabilityRevision: 0,
      state: { current: null },
      acceptAvailable: (songs) => songs.filter((song) => !hidden.has(song.id)),
      subscribe: (fn) => {
        listeners.add(fn);
        fn({ current: null, playing: false });
        return () => listeners.delete(fn);
      },
      play: async (song, queue) => played.push({ song, queue }),
      toggle: async () => {
        toggled++;
      },
    },
  };
  registerMusicPage(mode);
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(values) {
      Object.assign(this.data, values);
    },
  };
  page.onLoad(options);
  return { page, listeners, hidden, played, toggled: () => toggled };
}
test("canonical home is first and legacy experience entry and fallback route both exist", () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../src/app.json"), "utf8"),
  );
  assert.equal(config.entryPagePath, "pages/home/index");
  assert.equal(config.pages[0], config.entryPagePath);
  assert.ok(config.pages.includes("page/index/index"));
  require("../dist/page/index/index.js");
  definition.onLoad();
  assert.equal(navigation.at(-1), "/pages/home/index");
  let application;
  global.App = (opts) => {
    application = opts;
  };
  require("../dist/app.js");
  application.onPageNotFound();
  assert.equal(navigation.at(-1), "/pages/home/index");
});
test("home mood and search navigation encode keywords and subscriptions/polling stop when hidden", async () => {
  const { page, listeners } = make("home");
  page.onShow();
  await flush();
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.featured.length, 1);
  assert.equal(page.data.items[0].sourceText, "网易云音乐");
  page.mood({ currentTarget: { dataset: { query: "华语 流行" } } });
  assert.equal(
    navigation.at(-1),
    "/pages/search/index?q=" + encodeURIComponent("华语 流行"),
  );
  page.openSearch();
  assert.equal(navigation.at(-1), "/pages/search/index");
  page.onHide();
  assert.equal(listeners.size, 0);
  assert.equal(page.catalog.timer, undefined);
  page.onUnload();
});
test("search stays idle until submit, source switches issue one request and pagination uses submitted query", async () => {
  const { page } = make("search");
  page.onShow();
  await flush();
  assert.equal(calls.length, 0);
  page.setData({ query: "陈奕迅" });
  page.search();
  await flush();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].path.includes("q=" + encodeURIComponent("陈奕迅")));
  page.sourceChange({ detail: { value: "1" } });
  await flush();
  assert.equal(calls.length, 2);
  assert.ok(calls[1].path.includes("source=netease"));
  page.setData({ query: "未提交内容" });
  page.nextPage();
  await flush();
  assert.equal(calls.length, 3);
  assert.ok(
    calls[2].path.includes("page=2") &&
      calls[2].path.includes(encodeURIComponent("陈奕迅")),
  );
  page.previousPage();
  await flush();
  assert.equal(page.data.page, 1);
  page.onHide();
  page.onUnload();
});
test("list clicks preserve queue and current song toggles without new session; hidden songs leave cards/list", async () => {
  const { page, played, hidden, toggled } = make("home");
  page.onShow();
  await flush();
  page.playSong({ currentTarget: { dataset: { id: "1" } } });
  assert.equal(played.length, 1);
  assert.equal(played[0].queue.length, 1);
  app.player.state.current = song();
  page.playSong({ currentTarget: { dataset: { id: "1" } } });
  assert.equal(toggled(), 1);
  assert.equal(played.length, 1);
  hidden.add(1);
  page.renderResult(page.catalog.state);
  assert.equal(page.data.items.length, 0);
  assert.equal(page.data.featured.length, 0);
  page.onHide();
  page.onUnload();
});
test("source label and playable time formatting do not render playback kind", () => {
  const [view] = presentSongs([song()]);
  assert.equal(view.durationText, "3:00");
  assert.equal(view.sourceText, "网易云音乐");
  assert.equal(view.number, "01");
});

// Reproduce the actual navigation boundary, not just the outgoing URL.
test("all six mood routes decode once for both input and cloud search", async () => {
  const { page: home } = make("home");
  const moods = home.data.moods.map((mood) => mood.title);
  home.onUnload();
  for (const query of moods) {
    home.mood({ currentTarget: { dataset: { query } } });
    const encoded = navigation.at(-1).split("?q=")[1];
    const { page } = make("search", { q: encoded });
    try {
      assert.equal(page.data.query, query);
      assert.equal(page.data.searched, query);
      assert.equal(page.catalog.query, query);
      page.onShow();
      await flush();
      assert.equal(calls.length, 1);
      assert.equal(
        new URL(calls[0].path, "https://test.invalid").searchParams.get("q"),
        query,
      );
    } finally {
      page.onHide();
      page.onUnload();
    }
  }
});
test("route decoding preserves special and literal encoded characters and tolerates malformed external routes", async () => {
  const queries = [
    "华语 流行",
    "A&B + C",
    "音乐 🎵",
    "100%喜欢",
    "%41",
    "%E6%8A%96",
  ];
  const routes = queries.map((query) => [encodeURIComponent(query), query]);
  routes.push(["已经是中文", "已经是中文"], ["损坏%E6%ZZ", "损坏%E6%ZZ"]);
  for (const [route, query] of routes) {
    const { page } = make("search", { q: route });
    try {
      page.onShow();
      await flush();
      assert.equal(page.data.query, query);
      assert.equal(page.data.searched, query);
      assert.equal(
        new URL(calls[0].path, "https://test.invalid").searchParams.get("q"),
        query,
      );
      page.sourceChange({ detail: { value: "2" } });
      await flush();
      page.nextPage();
      await flush();
      const request = new URL(calls.at(-1).path, "https://test.invalid");
      assert.equal(request.searchParams.get("q"), query);
      assert.equal(request.searchParams.get("source"), "kuwo");
      assert.equal(request.searchParams.get("page"), "2");
    } finally {
      page.onHide();
      page.onUnload();
    }
  }
});
test("manual searches are never URI-decoded and pagination honors disabled states", async () => {
  const { page } = make("search");
  try {
    page.onShow();
    page.setData({ query: "%41 + 民谣" });
    page.search();
    await flush();
    assert.equal(
      new URL(calls[0].path, "https://test.invalid").searchParams.get("q"),
      "%41 + 民谣",
    );
    const count = calls.length;
    page.previousPage();
    page.setData({ hasMore: false });
    page.nextPage();
    assert.equal(calls.length, count);
    assert.equal(page.data.page, 1);
    page.setData({ hasMore: true, loading: true });
    page.nextPage();
    assert.equal(calls.length, count);
  } finally {
    page.onHide();
    page.onUnload();
  }
});
