const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
let definition, app;
const selected = [],
  toasts = [];
global.Page = (value) => {
  definition = value;
};
global.getApp = () => app;
global.wx = {
  showShareMenu() {},
  getWindowInfo: () => ({ statusBarHeight: 24, windowWidth: 390 }),
  getMenuButtonBoundingClientRect: () => ({ left: 290 }),
  showToast: (value) => toasts.push(value.title),
};
require("../dist/pages/player/index.js");
const song = (id, source = "soda") => ({
  id,
  source,
  source_track_id: String(id),
  title: "歌曲" + id,
  artist: "歌手",
  album: "",
  cover_url: "",
  duration: 180,
  audio_kind: "full",
});
const touch = (y, timeStamp = 10, end = false) => ({
  touches: end ? [] : [{ identifier: 1, clientX: 150, clientY: y }],
  changedTouches: [{ identifier: 1, clientX: 150, clientY: y }],
  timeStamp,
});
function setup() {
  selected.length = 0;
  toasts.length = 0;
  const songs = [song(1), song(2, "netease")];
  const state = {
    current: songs[0],
    playing: true,
    loading: false,
    sessionId: "one",
    position: 0,
    duration: 180,
    sourceName: "汽水音乐",
  };
  app = {
    player: {
      state,
      queueSnapshot: () => songs.map((x) => ({ ...x })),
      next: (direction) => selected.push(direction),
      play: (value) =>
        selected.push(value.source + ":" + value.source_track_id),
    },
  };
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(values, complete) {
      Object.assign(this.data, values);
      complete?.();
    },
  };
  page.onLoad();
  page.visible = true;
  page.renderPlayer(state);
  return { page, state, songs };
}
test("page gestures skip once and ignore loading, hidden pages and a changed playback session", () => {
  const { page, state } = setup();
  const flick = () => {
    page.swipeStart(touch(250));
    page.swipeEnd(touch(100, 200, true));
  };
  flick();
  page.swipeEnd(touch(100, 201, true));
  assert.deepEqual(selected, [1]);
  state.loading = true;
  flick();
  state.loading = false;
  page.swipeStart(touch(250));
  state.sessionId = "two";
  page.swipeEnd(touch(100, 200, true));
  page.swipeStart(touch(250));
  page.onHide();
  page.swipeEnd(touch(100, 200, true));
  assert.deepEqual(selected, [1]);
});
test("opening queue, lyric browsing, view switching or cancellation cannot finish a pending swipe", () => {
  const { page } = setup();
  for (const cancel of [
    () => page.openQueue(),
    () => page.manualStart(),
    () => page.toggleLyrics(),
    () => page.cancelSwipe(),
  ]) {
    page.closeQueue();
    page.swipeStart(touch(250));
    cancel();
    page.swipeEnd(touch(100, 200, true));
  }
  assert.deepEqual(selected, []);
  page.openQueue();
  page.swipeStart(touch(250));
  page.swipeEnd(touch(100, 200, true));
  assert.deepEqual(selected, []);
});
test("queue reflects live content, actual current source and stable platform identities", () => {
  const { page, state, songs } = setup();
  page.openQueue();
  assert.equal(page.data.queueCount, 2);
  assert.equal(page.data.queueItems[0].active, true);
  assert.equal(page.data.queueItems[1].sourceName, "网易云音乐");
  const first = page.data.queueItems;
  page.renderPlayer(state);
  assert.equal(page.data.queueItems, first);
  state.current = songs[1];
  state.sourceName = "酷我音乐";
  page.renderPlayer(state);
  assert.equal(page.data.queueItems[1].sourceName, "酷我音乐");
  assert.equal(page.data.queueActiveId, "queue-row-1");
  songs.splice(0, 1);
  page.renderPlayer(state);
  assert.equal(page.data.queueCount, 1);
  assert.equal(page.data.queueItems.length, 1);
  assert.equal(page.data.queueActiveId, "queue-row-0");
});
test("queue taps preserve existing playback for the current song and cannot resurrect removed tracks", () => {
  const { page, songs } = setup();
  const tap = (key) =>
    page.selectQueueSong({ currentTarget: { dataset: { key } } });
  tap("soda:1");
  assert.deepEqual(selected, []);
  page.openQueue();
  tap("netease:2");
  assert.deepEqual(selected, ["netease:2"]);
  assert.equal(page.data.queueOpen, false);
  page.openQueue();
  songs.pop();
  tap("netease:2");
  assert.deepEqual(selected, ["netease:2"]);
  assert.match(toasts.at(-1), /移除/);
});
test("cover preview follows lyrics without scrolling hidden nodes or altering playback", () => {
  const { page } = setup();
  let followed = 0;
  page.lyrics = {
    follow: () => {
      followed++;
    },
  };
  page.renderLyrics({
    status: "synced",
    lines: [
      { time_ms: 0, text: "第一句" },
      { time_ms: 1000, text: "第二句" },
    ],
    activeIndex: 0,
    following: true,
    scrollRevision: 1,
    sourceName: "汽水音乐",
  });
  assert.equal(page.data.previewLine, "第一句");
  assert.equal(page.data.previewNext, "第二句");
  page.toggleLyrics();
  assert.equal(page.data.lyricsVisible, true);
  assert.equal(followed, 1);
  page.toggleLyrics();
  page.renderLyrics({
    status: "plain",
    lines: [],
    plainText: "\n纯文本歌词",
    activeIndex: -1,
    following: true,
    scrollRevision: 2,
  });
  assert.equal(page.data.previewLine, "纯文本歌词");
  assert.equal(page.data.previewNext, "");
  assert.deepEqual(selected, []);
});
test("only artwork and song metadata capture switching gestures, not lyrics, sliders or queue scrolling", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/pages/player/index.wxml"),
    "utf8",
  );
  assert.equal((source.match(/bindtouchstart="swipeStart"/g) || []).length, 2);
  for (const node of source.matchAll(/<(scroll-view|slider)\b[^>]*>/g)) {
    assert.ok(
      !node[0].includes("swipeStart") && !node[0].includes("swipeMove"),
    );
  }
  assert.ok(!source.includes('class="full-player" bindtouchstart'));
  assert.ok(source.includes('bindtouchcancel="cancelSwipe"'));
  assert.ok(!source.includes('bindtap="shareTimeline"'));
});
