const { test } = require("node:test");
const assert = require("node:assert/strict");
global.wx = {
  cloud: { callContainer: async () => ({ statusCode: 200, data: {} }) },
};
const { NativePlayer } = require("../dist/services/player.js");
const { ApiError } = require("../dist/services/api.js");
const song = (id) => ({
  id,
  source: "soda",
  source_track_id: String(id),
  title: "歌 " + id,
  artist: "歌手",
  album: "",
  cover_url: "",
  duration: 90,
  audio_kind: "full",
});
class Audio {
  src = "";
  duration = 90;
  currentTime = 0;
  paused = true;
  listeners = {};
  emit(name, payload) {
    this.listeners[name]?.(payload);
  }
  play() {
    this.paused = false;
    this.emit("Play");
  }
  pause() {
    this.paused = true;
    this.emit("Pause");
  }
  stop() {
    this.paused = true;
    this.emit("Stop");
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
  Audio.prototype["on" + name] = function (cb) {
    this.listeners[name] = cb;
  };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const ticks = async (n = 4) => {
  for (let i = 0; i < n; i++) await flush();
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function make(t) {
  const audio = new Audio(),
    calls = [],
    history = [];
  let serial = 0;
  const api = {
    get: async (path) => {
      calls.push(["get", path]);
      return { items: [], retry_after: 3, refreshing: true };
    },
    post: async (path, data) => {
      calls.push(["post", path, data]);
      if (path.endsWith("/started")) return { ok: true };
      const id = ++serial;
      return {
        id: "session-" + id,
        song_id: Number(path.split("/")[4]),
        transport: "direct",
        state: "ready",
        audio_url: "https://audio.example/" + id,
        audio_kind: "full",
        link_version: 1,
        refresh_count: 0,
        play_source_name: "汽水音乐",
        play_source: "soda",
        play_source_track_id: "actual",
        expires_at: "2099-01-01",
        error: null,
      };
    },
  };
  const player = new NativePlayer(
    api,
    audio,
    async () => "request-" + (serial + 1),
    (...args) => history.push(args),
  );
  t.after(() => player.destroy());
  return { audio, api, player, calls, history };
}

test("healthy empty home waits and polls until collection produces audio, including while backgrounded", async (t) => {
  const { audio, api, player, calls, history } = make(t);
  let home = 0;
  api.get = async (path) => {
    calls.push(["get", path]);
    return ++home === 1 ? { items: [], retry_after: 3 } : { items: [song(2)] };
  };
  await player.play(song(1), [song(1)]);
  audio.emit("Ended");
  await ticks();
  assert.equal(home, 1);
  assert.equal(player.state.continuing, true);
  assert.equal(player.state.failed, false);
  assert.ok(player.autoTimer);
  assert.equal(history.length, 0);
  player.lifecycle(false);
  assert.equal(player.state.continuing, true);
  player.clearAutoDelay();
  await ticks();
  assert.equal(player.state.current.id, 2);
  assert.equal(player.state.failed, false);
  const created = calls.filter(
    (c) => c[0] === "post" && c[1].endsWith("/playbacks"),
  );
  assert.equal(created.length, 2);
  assert.equal(created[1][2].defer_click, true);
  assert.equal(history.length, 0);
  audio.emit("Play");
  audio.emit("Play");
  await ticks();
  assert.equal(history.length, 1);
  assert.equal(history[0][0].id, 2);
  assert.equal(calls.filter((c) => c[1].endsWith("/started")).length, 1);
});

test("user pause or headset stop cancels automatic collection wait without a late restart", async (t) => {
  for (const control of ["toggle", "Pause", "Stop"]) {
    const { audio, player, calls } = make(t);
    await player.play(song(1), [song(1)]);
    audio.emit("Ended");
    await ticks();
    assert.ok(player.autoTimer);
    if (control === "toggle") await player.toggle();
    else audio.emit(control);
    await ticks();
    assert.equal(player.state.continuing, false);
    assert.equal(player.state.loading, false);
    assert.equal(player.autoTimer, undefined);
    const count = calls.length;
    audio.emit("Play");
    audio.emit("Ended");
    await ticks();
    assert.equal(calls.length, count);
  }
});

test("late home response cannot override an explicit fast song change", async (t) => {
  const { audio, api, player } = make(t),
    pending = deferred();
  api.get = () => pending.promise;
  await player.play(song(1), [song(1)]);
  audio.emit("Ended");
  await ticks();
  await player.play(song(3), [song(3)]);
  pending.resolve({ items: [song(2)] });
  await ticks();
  assert.equal(player.state.current.id, 3);
  assert.equal(player.state.failed, false);
});

test("network failure stops automatic retries with an error; explicit play resumes home continuation", async (t) => {
  const { audio, api, player } = make(t);
  let requests = 0;
  api.get = async () => {
    requests++;
    throw new ApiError("cloud_call_failed", "网络失败");
  };
  await player.play(song(1), [song(1)]);
  audio.emit("Ended");
  await ticks();
  assert.equal(player.state.failed, true);
  assert.equal(player.state.continuing, false);
  assert.equal(player.autoTimer, undefined);
  assert.equal(requests, 1);
  assert.match(player.state.message, /网络失败/);
  api.get = async () => ({ items: [song(2)] });
  await player.toggle();
  await ticks();
  assert.equal(player.state.current.id, 2);
});

test("rate limiting backs off rather than stopping or submitting duplicate playback requests", async (t) => {
  const { audio, api, player } = make(t);
  let requests = 0;
  api.get = async () => {
    if (++requests === 1) throw new ApiError("rate_limited", "频繁");
    return { items: [song(2)] };
  };
  await player.play(song(1), [song(1)]);
  audio.emit("Ended");
  await ticks();
  assert.equal(player.state.continuing, true);
  assert.ok(player.autoTimer);
  player.clearAutoDelay();
  await ticks();
  assert.equal(player.state.current.id, 2);
  assert.equal(requests, 2);
});

test("pause after an automatic link is assigned suppresses late play and can resume normally", async (t) => {
  const { audio, api, player, history } = make(t);
  api.get = async () => ({ items: [song(2)] });
  await player.play(song(1), [song(1)]);
  audio.emit("Ended");
  await ticks();
  assert.equal(player.state.current.id, 2);
  assert.equal(player.state.continuing, true);
  await player.toggle();
  audio.emit("Play");
  await ticks();
  assert.equal(history.length, 0);
  assert.equal(player.state.playing, false);
  await player.toggle();
  audio.emit("Play");
  await ticks();
  assert.equal(player.state.playing, true);
  assert.equal(history.length, 1);
});

test("manual selection wins even when an observer changes the song during the ended event", async (t) => {
  const { audio, api, player, calls } = make(t);
  let replaced = false;
  await player.play(song(1), [song(1)]);
  const unsubscribe = player.subscribe((state) => {
    if (!replaced && state.events[0]?.includes("播放结束")) {
      replaced = true;
      void player.play(song(3), [song(3)]);
    }
  });
  audio.emit("Ended");
  await ticks();
  unsubscribe();
  assert.equal(player.state.current.id, 3);
  assert.equal(calls.filter((call) => call[0] === "get").length, 0);
});

test("an automatic recommendation rejected by the native decoder is skipped before playback without global hiding", async (t) => {
  const { audio, api, player, history } = make(t);
  api.get = async () => ({ items: [song(2), song(3)] });
  const random = Math.random;
  Math.random = () => 0;
  try {
    await player.play(song(1), [song(1)]);
    audio.emit("Ended");
    await ticks();
    assert.equal(player.state.current.id, 2);
    assert.equal(history.length, 0);
    audio.emit("Error", { errCode: 10004 });
    await ticks();
    assert.equal(player.state.current.id, 3);
    assert.equal(player.state.failed, false);
    assert.equal(player.acceptAvailable([song(2)], 0).length, 1);
    assert.equal(history.length, 0);
  } finally {
    Math.random = random;
  }
});
