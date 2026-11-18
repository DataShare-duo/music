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
  const { TestClock } = require("./helpers/clock.cjs");
  const { TrackTransition } = require("../dist/shared/player-transition.js");
  const clock = new TestClock();
  page.motion = new TrackTransition(
    (frame, done) => page.renderMotion(frame, done),
    clock,
  );
  page.swipeHeight = 400;
  const flick = () => {
    page.swipeStart(touch(250));
    page.swipeEnd(touch(100, 200, true));
  };
  flick();
  page.swipeEnd(touch(100, 201, true));
  assert.equal(page.data.transitionPhase, "leaving");
  assert.deepEqual(selected, []);
  clock.tick(188);
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
  assert.ok(source.includes('bindtouchcancel="swipeCancel"'));
  assert.ok(!source.includes('bindtap="shareTimeline"'));
});

test("current-song-list entry and sheet use 此刻歌单, with song counts only inside the sheet", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/pages/player/index.wxml"),
    "utf8",
  );
  const entry = source.match(
    /<button\b[^>]*bindtap="openQueue"[^>]*>[\s\S]*?<\/button>/,
  )?.[0];
  assert.ok(entry);
  assert.ok(entry.includes("<text>此刻歌单</text>"));
  assert.ok(entry.includes('aria-label="查看此刻歌单"'));
  assert.ok(entry.includes('src="/assets/icons/queue.svg"'));
  assert.ok(!entry.includes("queueCount") && !entry.includes("queue-count"));
  assert.ok(source.includes('aria-label="此刻歌单"'));
  assert.ok(source.includes('class="queue-title">此刻歌单</text>'));
  assert.ok(source.includes('aria-label="关闭此刻歌单"'));
  assert.ok(source.includes('class="queue-total">{{queueCount}} 首</text>'));
  assert.equal((source.match(/\{\{queueCount\}\}/g) || []).length, 1);
  const css = fs.readFileSync(
    path.join(__dirname, "../src/pages/player/index.wxss"),
    "utf8",
  );
  assert.match(css, /\.utility-button \{[^}]*white-space: nowrap;/);
  assert.ok(!css.includes(".queue-count"));
});

test("此刻歌单 keeps live counts for empty, single-song and 100-song lists", () => {
  const { page, songs } = setup();
  page.openQueue();
  for (const count of [0, 1, 100]) {
    songs.splice(
      0,
      songs.length,
      ...Array.from({ length: count }, (_, i) => song(i + 1)),
    );
    page.renderPlayer(app.player.state);
    assert.equal(page.data.queueCount, count);
    assert.equal(page.data.queueItems.length, count);
  }
  assert.deepEqual(selected, []);
});
