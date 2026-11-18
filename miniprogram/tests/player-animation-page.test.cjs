const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { TestClock } = require("./helpers/clock.cjs");
const {
  TrackTransition,
  transitionTiming: timing,
} = require("../dist/shared/player-transition.js");
let definition, app;
const toasts = [];
global.Page = (options) => {
  definition = options;
};
global.getApp = () => app;
global.wx = {
  showShareMenu() {},
  showToast: (options) => toasts.push(options.title),
  getWindowInfo: () => ({ statusBarHeight: 24, windowWidth: 390 }),
  getMenuButtonBoundingClientRect: () => ({ left: 290 }),
  nextTick: (fn) => fn(),
};
require("../dist/pages/player/index.js");
const track = (id) => ({
  id,
  source: "soda",
  source_track_id: String(id),
  title: "歌曲 " + id,
  artist: "歌手",
  album: "",
  cover_url: "https://cover.example/" + id,
  duration: 180,
  audio_kind: "full",
});
const touch = (y, at = 10, end = false) => ({
  touches: end ? [] : [{ identifier: 1, clientX: 100, clientY: y }],
  changedTouches: [{ identifier: 1, clientX: 100, clientY: y }],
  timeStamp: at,
});
const out = timing.leave + timing.eventGrace,
  inside = timing.frame + timing.enter + timing.eventGrace;
function setup() {
  const clock = new TestClock(),
    patches = [],
    songs = [track(1), track(2), track(3)],
    calls = [];
  toasts.length = 0;
  const state = {
    current: songs[0],
    sessionId: "one",
    playing: true,
    loading: false,
    failed: false,
    position: 12,
    duration: 180,
    sourceName: "汽水音乐",
    queueEnded: false,
    continuing: false,
    message: "",
  };
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(value, done) {
      patches.push(value);
      Object.assign(this.data, value);
      done?.();
    },
  };
  app = {
    player: {
      state,
      queueSnapshot: () => songs.map((x) => ({ ...x })),
      next(direction) {
        calls.push(direction);
        const i = songs.findIndex((x) => x.id === state.current.id);
        state.current = songs[(i + direction + songs.length) % songs.length];
        state.sessionId = "";
        state.loading = true;
        state.playing = false;
        state.position = state.duration = 0;
        page.renderPlayer(state);
        return new Promise(() => {});
      },
      toggle() {
        calls.push("toggle");
        state.playing = !state.playing;
      },
      seek(value) {
        calls.push(["seek", value]);
      },
      snapshot: () => state,
    },
  };
  page.onLoad();
  page.visible = true;
  page.swipeHeight = 460;
  page.motion = new TrackTransition(
    (frame, done) => page.renderMotion(frame, done),
    clock,
  );
  page.renderPlayer(state);
  return { page, clock, state, songs, calls, patches };
}
const flick = (page, up = true) => {
  page.swipeStart(touch(200));
  page.swipeMove(touch(up ? 100 : 300, 100));
  page.swipeEnd(touch(up ? 100 : 300, 200, true));
};

test("only content follows the finger, old content exits before one next call and new loading content enters without waiting for audio", () => {
  const { page, clock, state, calls, patches } = setup();
  page.setData({
    lyricLines: [{ time_ms: 0, text: "旧歌词" }],
    lyricStatus: "synced",
    previewLine: "旧歌词",
  });
  page.swipeStart(touch(200));
  page.swipeMove(touch(100, 100));
  assert.equal(page.data.transitionY, -65);
  assert.equal(page.data.title, "歌曲 1");
  assert.equal(calls.length, 0);
  const delta = patches.at(-1);
  assert.ok(Object.keys(delta).every((key) => key.startsWith("transition")));
  page.swipeEnd(touch(100, 200, true));
  assert.equal(page.data.transitionPhase, "leaving");
  assert.equal(page.data.title, "歌曲 1");
  page.swipeStart(touch(200));
  page.swipeEnd(touch(100, 200, true));
  clock.tick(out);
  assert.deepEqual(calls, [1]);
  assert.equal(state.current.id, 2);
  assert.equal(page.data.title, "歌曲 2");
  assert.equal(page.data.transitionPhase, "entering");
  assert.equal(page.data.transitionY, 460);
  assert.deepEqual(page.data.lyricLines, []);
  assert.notEqual(page.data.previewLine, "旧歌词");
  assert.equal(state.loading, true);
  clock.tick(inside);
  assert.equal(page.data.transitionPhase, "idle");
  assert.equal(page.data.transitionY, 0);
  assert.equal(state.playing, false);
  assert.deepEqual(calls, [1]);
});

test("short, cancelled and single-song swipes rebound without playback or personal statistics", () => {
  const { page, clock, calls, songs } = setup();
  page.swipeStart(touch(200));
  page.swipeMove(touch(230, 100));
  page.swipeEnd(touch(230, 200, true));
  assert.equal(page.data.transitionPhase, "settling");
  clock.tick(1000);
  assert.deepEqual(calls, []);
  page.swipeStart(touch(200));
  page.swipeMove(touch(100, 100));
  page.swipeCancel();
  clock.tick(1000);
  assert.equal(page.data.transitionPhase, "idle");
  assert.deepEqual(calls, []);
  songs.splice(1);
  flick(page);
  clock.tick(1000);
  assert.match(toasts.at(-1), /只有一首/);
  assert.deepEqual(calls, []);
});

test("hide, unload, back-equivalent cancel, queue opening, layout resize and view switching invalidate a pending exit", () => {
  for (const cancel of [
    (page) => page.onHide(),
    (page) => page.onUnload(),
    (page) => page.cancelSwipe(),
    (page) => page.openQueue(),
    (page) => page.onResize(),
    (page) => page.toggleLyrics(),
  ]) {
    const { page, clock, calls } = setup();
    flick(page);
    const late = [...clock.tasks.values()].map((x) => x.fn);
    cancel(page);
    for (const callback of late) callback();
    clock.tick(1000);
    assert.deepEqual(calls, []);
    assert.equal(page.data.transitionPhase, "idle");
    assert.equal(clock.tasks.size, 0);
  }
});

test("new audio loading, automatic next and headset next snapshots cancel an older planned switch", () => {
  for (const external of [
    (state) => {
      state.loading = true;
    },
    (state) => {
      state.current = track(3);
      state.sessionId = "three";
    },
    (state) => {
      state.sessionId = "replay";
    },
  ]) {
    const { page, clock, state, calls } = setup();
    flick(page);
    external(state);
    page.renderPlayer(state);
    clock.tick(1000);
    assert.deepEqual(calls, []);
    assert.equal(page.data.transitionPhase, "idle");
  }
});

test("live queue validation refuses a removed target instead of silently playing a different song", () => {
  const { page, clock, songs, calls, state } = setup();
  flick(page);
  songs.splice(1, 1);
  clock.tick(1000);
  assert.deepEqual(calls, []);
  assert.equal(state.current.id, 1);
  assert.equal(page.data.transitionPhase, "idle");
});

test("pause and progress controls remain functional and cancel an uncommitted transition", () => {
  for (const action of [
    (page) => page.toggle(),
    (page) => page.seek({ detail: { value: 20 } }),
  ]) {
    const { page, clock, calls } = setup();
    flick(page);
    action(page);
    clock.tick(1000);
    assert.equal(calls.length, 1);
    assert.ok(calls[0] === "toggle" || Array.isArray(calls[0]));
    assert.equal(page.data.transitionPhase, "idle");
  }
});

test("a failed new source restores the new song normally, and incoming animation never pretends that audio started", () => {
  const { page, clock, state, calls } = setup();
  flick(page);
  clock.tick(out);
  state.loading = false;
  state.failed = true;
  state.playing = false;
  state.message = "直连播放失败";
  page.renderPlayer(state);
  clock.tick(1000);
  assert.equal(page.data.title, "歌曲 2");
  assert.equal(page.data.failed, true);
  assert.equal(page.data.playing, false);
  assert.equal(page.data.transitionPhase, "idle");
  assert.deepEqual(calls, [1]);
});

test("late layout callbacks cannot restore geometry after hide and missing measurements cause a safe rebound", () => {
  const { page, clock, calls } = setup();
  let callback;
  global.wx.createSelectorQuery = () => {
    const q = {
      in: () => q,
      select: () => q,
      boundingClientRect: () => q,
      exec: (fn) => {
        callback = fn;
      },
    };
    return q;
  };
  try {
    page.swipeHeight = 0;
    page.measureSwipeHeight();
    const late = callback;
    page.onHide();
    late([{ height: 999 }]);
    assert.equal(page.swipeHeight, 0);
    page.visible = true;
    flick(page);
    clock.tick(1000);
    assert.deepEqual(calls, []);
    assert.equal(page.data.transitionPhase, "idle");
  } finally {
    delete global.wx.createSelectorQuery;
  }
});

test("lyric measurements pause for movement and resume at the current line only after the layout settles", () => {
  const { page, clock } = setup();
  let measures = 0;
  global.wx.createSelectorQuery = () => {
    const q = {
      in: () => q,
      select: () => q,
      boundingClientRect: () => q,
      scrollOffset: () => q,
      exec: (fn) => {
        measures++;
        fn([
          { height: 460, top: 0 },
          { scrollTop: 0 },
          { top: 100, height: 30 },
        ]);
      },
    };
    return q;
  };
  try {
    page.data.lyricsVisible = true;
    page.data.activeIndex = 0;
    page.swipeStart(touch(200));
    page.swipeMove(touch(230, 100));
    const before = measures;
    page.centerLine(0);
    assert.equal(measures, before);
    page.swipeEnd(touch(230, 200, true));
    clock.tick(timing.settle + timing.eventGrace);
    assert.ok(measures > before);
    assert.equal(page.data.transitionPhase, "idle");
  } finally {
    delete global.wx.createSelectorQuery;
  }
});

test("only the song-content wrapper has animation; full header, personal actions and bottom controls stay outside it", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/pages/player/index.wxml"),
    "utf8",
  );
  const start = source.indexOf('id="song-motion"'),
    end = source.indexOf('<view class="full-controls">');
  assert.ok(start > source.indexOf('class="full-header"'));
  assert.ok(end > start);
  const moving = source.slice(start, end);
  assert.ok(
    moving.includes('class="listening-stage"') &&
      moving.includes('class="track-info"'),
  );
  assert.ok(
    !moving.includes('class="personal-actions"') &&
      !moving.includes('class="full-buttons"'),
  );
  assert.ok(source.includes('bindtransitionend="transitionFinished"'));
});

test("real NativePlayer creates no session for a rebound and exactly one session after exit; only native onPlay counts playback", async () => {
  const { page, clock, songs } = setup();
  const { NativePlayer } = require("../dist/services/player.js");
  class Audio {
    src = "";
    duration = 180;
    currentTime = 0;
    paused = false;
    handlers = {};
    play() {
      this.paused = false;
      this.handlers.Play?.();
    }
    pause() {
      this.paused = true;
      this.handlers.Pause?.();
    }
    stop() {
      this.paused = true;
      this.handlers.Stop?.();
    }
    seek() {}
  }
  for (const name of [
    "Play",
    "Pause",
    "Stop",
    "Ended",
    "Error",
    "TimeUpdate",
    "Canplay",
    "Waiting",
    "Next",
    "Prev",
  ])
    Audio.prototype["on" + name] = function (callback) {
      this.handlers[name] = callback;
    };
  const audio = new Audio(),
    requests = [],
    history = [];
  let nextRequestId = 0,
    resolveSecond;
  const session = (id) => ({
    id: "session-" + id,
    song_id: id,
    transport: "direct",
    state: "ready",
    audio_url: "https://audio.example/" + id,
    audio_kind: "full",
    link_version: 1,
    refresh_count: 0,
    play_source: "soda",
    play_source_track_id: String(id),
    play_source_name: "汽水音乐",
    audio_duration: 180,
    expires_at: "2099-01-01",
    error: null,
  });
  const api = {
    get: async () => ({ items: [] }),
    post: async (path, data) => {
      requests.push([path, data]);
      if (path.endsWith("/started")) return { ok: true };
      if (path.includes("/1/")) return session(1);
      return new Promise((resolve) => {
        resolveSecond = resolve;
      });
    },
  };
  const native = new NativePlayer(
    api,
    audio,
    async () => "request-" + ++nextRequestId,
    (song, id) => history.push([song.id, id]),
  );
  app.player = native;
  const unsubscribe = native.subscribe((state) => page.renderPlayer(state));
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await native.play(songs[0], songs);
    audio.play();
    await flush();
    const baseline = requests.length;
    page.swipeStart(touch(200));
    page.swipeMove(touch(230, 100));
    page.swipeEnd(touch(230, 200, true));
    clock.tick(1000);
    assert.equal(requests.length, baseline);
    flick(page);
    assert.equal(requests.length, baseline);
    clock.tick(out);
    await flush();
    assert.equal(
      requests.filter(([url]) => url.includes("/2/playbacks")).length,
      1,
    );
    assert.equal(page.data.transitionPhase, "entering");
    assert.equal(native.state.loading, true);
    clock.tick(inside);
    assert.equal(page.data.transitionPhase, "idle");
    assert.equal(
      requests.filter(([url]) => url.endsWith("/started")).length,
      1,
    );
    resolveSecond(session(2));
    await flush();
    assert.equal(native.state.playing, false);
    assert.equal(history.length, 1);
    audio.play();
    await flush();
    audio.pause();
    audio.play();
    await flush();
    assert.equal(
      requests.filter(([url]) => url.endsWith("/started")).length,
      2,
    );
    assert.deepEqual(
      history.map(([id]) => id),
      [1, 2],
    );
  } finally {
    unsubscribe();
    page.onUnload();
    native.destroy();
  }
});

test("only the wrapper transform event can finish exit; child and opacity events cannot create sessions", () => {
  const { page, clock, calls } = setup();
  flick(page);
  clock.tick(timing.leave);
  const event = {
    target: { id: "song-motion" },
    currentTarget: {
      id: "song-motion",
      dataset: { revision: page.data.transitionRevision },
    },
    detail: { propertyName: "transform" },
  };
  page.transitionFinished({ ...event, target: { id: "child" } });
  page.transitionFinished({ ...event, detail: { propertyName: "opacity" } });
  page.transitionFinished({ ...event, detail: {} });
  assert.deepEqual(calls, []);
  page.transitionFinished(event);
  assert.deepEqual(calls, [1]);
  page.transitionFinished(event);
  clock.tick(1000);
  assert.deepEqual(calls, [1]);
});

test("hiding after a committed switch cancels presentation without stopping or changing the new playback", () => {
  const { page, clock, state, calls } = setup();
  flick(page);
  clock.tick(out);
  assert.equal(state.current.id, 2);
  assert.equal(page.data.transitionPhase, "entering");
  page.onHide();
  clock.tick(1000);
  assert.equal(state.current.id, 2);
  assert.equal(state.loading, true);
  assert.deepEqual(calls, [1]);
  assert.equal(page.data.transitionPhase, "idle");
  assert.equal(page.data.transitionY, 0);
});
