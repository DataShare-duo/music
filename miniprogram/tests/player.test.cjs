const { test } = require("node:test");
const assert = require("node:assert/strict");
global.wx = {
  cloud: { callContainer: async () => ({ statusCode: 200, data: {} }) },
};
const { NativePlayer } = require("../dist/services/player.js");
const { ApiError } = require("../dist/services/api.js");
const song = (id = 1) => ({
  id,
  title: "歌曲 " + id,
  artist: "歌手",
  album: "专辑",
  cover_url: "",
  source: "soda",
  source_track_id: String(id),
  duration: 180,
  audio_kind: "full",
});
const session = (id = "one", version = 1) => ({
  id,
  song_id: id === "two" ? 2 : 1,
  transport: "direct",
  state: "ready",
  audio_url: "https://audio.example/" + id + "/" + version,
  link_version: version,
  refresh_count: version - 1,
  audio_kind: "full",
  play_source_name: "网易云音乐",
  audio_duration: 180,
  expires_at: "2099-01-01",
  error: null,
});
class Audio {
  src = "";
  title = "";
  singer = "";
  epname = "";
  coverImgUrl = "";
  duration = 180;
  currentTime = 0;
  paused = true;
  listeners = {};
  registrations = {};
  seeks = [];
  emit(event, payload) {
    this.listeners[event]?.(payload);
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
  seek(value) {
    this.seeks.push(value);
  }
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
    this.registrations[name] = (this.registrations[name] || 0) + 1;
    this.listeners[name] = callback;
  };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const flush = () => new Promise((r) => setImmediate(r));
function setup(played) {
  const audio = new Audio();
  const calls = [];
  const api = {
    get: async (path) => {
      calls.push(["GET", path]);
      return session();
    },
    post: async (path, data) => {
      calls.push(["POST", path, data]);
      return path.endsWith("/started") ? { ok: true } : session();
    },
  };
  return {
    audio,
    api,
    calls,
    player: new NativePlayer(
      api,
      audio,
      async () => "secure-request-id",
      played,
    ),
  };
}

test("single background player counts only actual playback once and survives page/background transitions", async () => {
  const { audio, player, calls } = setup();
  await player.play(song(), [song(), song(2)]);
  assert.equal(player.state.sourceName, "网易云音乐");
  assert.equal(calls.length, 1);
  audio.emit("Play");
  audio.emit("Play");
  await flush();
  assert.equal(calls.filter((c) => c[1].endsWith("/started")).length, 1);
  player.lifecycle(false);
  player.lifecycle(true);
  assert.equal(audio.src, session().audio_url);
  await player.toggle();
  await player.toggle();
  audio.currentTime = 22;
  audio.emit("TimeUpdate");
  player.seek(999);
  assert.equal(audio.seeks.at(-1), 179.9);
  assert.equal(calls.filter((c) => c[1].endsWith("/playbacks")).length, 1);
  assert.ok(Object.values(audio.registrations).every((value) => value === 1));
  player.destroy();
});
test("fast switching ignores late resolution and captured old-generation event handlers", async () => {
  const { audio, player, api } = setup();
  const old = deferred();
  api.post = async (path) =>
    path.includes("/1/") ? old.promise : session("two");
  const first = player.play(song());
  await flush();
  await player.play(song(2));
  old.resolve(session());
  await first;
  assert.equal(player.state.current.id, 2);
  assert.equal(audio.src, session("two").audio_url);
  const oldCallback = player.handlers.play;
  await player.play(song(3));
  oldCallback();
  assert.equal(player.state.playing, false);
  assert.ok(Object.values(audio.registrations).every((value) => value === 1));
  player.destroy();
});
test("lost create response retries with identical request ID instead of double click", async () => {
  const { player, api } = setup();
  const ids = [];
  api.post = async (path, data) => {
    ids.push(data.client_request_id);
    if (ids.length === 1) throw new ApiError("cloud_call_failed", "offline");
    return session();
  };
  await player.play(song());
  assert.deepEqual(ids, ["secure-request-id", "secure-request-id"]);
  player.destroy();
});
test("network recovery refreshes same session once and restores progress after metadata", async () => {
  const { player, audio, api, calls } = setup();
  await player.play(song());
  audio.currentTime = 40;
  audio.emit("TimeUpdate");
  api.get = async () => session();
  api.post = async (path, data) => {
    calls.push(["POST", path, data]);
    return path.endsWith("/refresh") ? session("one", 2) : { ok: true };
  };
  audio.emit("Error", { errCode: 10002 });
  await flush();
  await flush();
  assert.equal(audio.src, session("one", 2).audio_url);
  audio.emit("Canplay");
  assert.equal(audio.seeks.at(-1), 40);
  api.get = async () => session("one", 2);
  audio.emit("Error", { errCode: 10002 });
  await flush();
  assert.equal(calls.filter((c) => c[1].endsWith("/refresh")).length, 1);
  assert.equal(player.state.failed, true);
  assert.match(player.state.message, /额度/);
  player.destroy();
});
test("already refreshed backend version is reused; decode failure does not burn refresh or hide song", async () => {
  const { player, audio, api, calls } = setup();
  await player.play(song());
  api.get = async () => session("one", 2);
  audio.emit("Error", { errCode: 10002 });
  await flush();
  assert.equal(audio.src, session("one", 2).audio_url);
  assert.equal(calls.filter((c) => c[1].endsWith("/refresh")).length, 0);
  audio.emit("Error", { errCode: 10004 });
  assert.equal(player.state.failed, true);
  assert.equal(player.acceptAvailable([song()], -1).length, 1);
  player.destroy();
});
test("only true unavailable hides locally, drops queue and permits later revalidation", async () => {
  const { player, api } = setup();
  api.post = async () => {
    throw new ApiError("full_audio_unavailable", "暂时不可用", 1, true);
  };
  await player.play(song(), [song(), song(2)]);
  assert.equal(player.acceptAvailable([song()], 0).length, 0);
  assert.equal(player.queue.length, 1);
  assert.equal(
    player.acceptAvailable([song()], player.availabilityRevision).length,
    1,
  );
  api.post = async () => {
    throw new ApiError("direct_audio_unsupported", "直连不兼容");
  };
  await player.play(song());
  assert.equal(player.acceptAvailable([song()], -1).length, 1);
  player.destroy();
});
test("headset next/previous use current queue; stale events after teardown do nothing", async () => {
  const { player, audio, api } = setup();
  api.post = async (path) =>
    path.includes("/2/") ? session("two") : session();
  await player.play(song(), [song(), song(2)]);
  audio.emit("Next");
  await flush();
  assert.equal(player.state.current.id, 2);
  audio.emit("Prev");
  await flush();
  assert.equal(player.state.current.id, 1);
  player.destroy();
  audio.emit("Play");
  assert.equal(player.state.playing, false);
});

test("natural end advances exactly once to the next song using the current queue", async () => {
  const { player, audio, api, calls } = setup();
  const pending = deferred();
  api.post = async (path, data) => {
    calls.push(["POST", path, data]);
    return path.includes("/2/") ? pending.promise : session();
  };
  await player.play(song(), [song(), song(2)]);
  audio.emit("Play");
  await flush();
  audio.emit("Ended");
  audio.emit("Ended");
  await flush();
  assert.equal(calls.filter((c) => c[1].includes("/2/")).length, 1);
  pending.resolve(session("two"));
  await flush();
  assert.equal(player.state.current.id, 2);
  assert.equal(audio.src, session("two").audio_url);
  assert.ok(
    player.state.events.some((event) => event.includes("自动播放下一首")),
  );
  player.destroy();
});
test("automatic end of final or single song stops without looping or creating another click", async () => {
  const { player, audio, api, calls } = setup();
  api.post = async (path, data) => {
    calls.push(["POST", path, data]);
    return session("two");
  };
  await player.play(song(2), [song(), song(2)]);
  audio.currentTime = 179;
  audio.emit("TimeUpdate");
  audio.emit("Waiting");
  const before = calls.length;
  audio.emit("Ended");
  await flush();
  assert.equal(calls.length, before);
  assert.equal(player.state.playing, false);
  assert.equal(player.state.loading, false);
  assert.equal(player.state.position, 180);
  assert.match(player.state.message, /列表已播放完/);
  await player.play(song(2), [song(2)]);
  const single = calls.length;
  audio.emit("Ended");
  await flush();
  assert.equal(calls.length, single);
  player.destroy();
});
test("natural end does not skip an incompatible next song or silently change source", async () => {
  const { player, audio, api } = setup();
  api.post = async (path) => {
    if (path.includes("/2/"))
      throw new ApiError("direct_audio_unsupported", "HTTPS不兼容");
    return session();
  };
  await player.play(song(), [song(), song(2), song(3)]);
  audio.emit("Ended");
  await flush();
  assert.equal(player.state.current.id, 2);
  assert.equal(player.state.failed, true);
  assert.equal(player.queue.length, 3);
  player.destroy();
});

test("personal history is emitted only for actual current-session play, once across pause, seek, lifecycle and refresh", async () => {
  const recent = [];
  const { player, audio, api } = setup((song, session, source) =>
    recent.push({ song, session, source }),
  );
  await player.play(song());
  assert.equal(recent.length, 0);
  audio.emit("Canplay");
  assert.equal(recent.length, 0);
  audio.emit("Play");
  audio.emit("Play");
  await flush();
  player.lifecycle(false);
  player.lifecycle(true);
  player.seek(15);
  audio.emit("Pause");
  audio.emit("Play");
  assert.equal(recent.length, 1);
  assert.equal(recent[0].session, "one");
  assert.equal(recent[0].source, "网易云音乐");
  const old = player.handlers.play;
  api.post = async (path) => (path.endsWith("/started") ? {} : session("two"));
  await player.play(song(2));
  old();
  assert.equal(recent.length, 1);
  audio.emit("Play");
  assert.equal(recent.length, 2);
  player.destroy();
});
test("personal history failure never stops audio or prevents original started statistics", async () => {
  const { player, audio, calls } = setup(() => {
    throw new Error("storage full");
  });
  await player.play(song());
  audio.emit("Play");
  await flush();
  assert.equal(player.state.playing, true);
  assert.equal(player.state.failed, false);
  assert.equal(calls.filter((x) => x[1].endsWith("/started")).length, 1);
  player.destroy();
});

test("shared autoplay passes the deferred-click flag without changing manual playback", async () => {
  const { player, api, calls } = setup();
  await player.play(song(), [song()], true);
  assert.equal(calls[0][2].defer_click, true);
  await player.play(song(2), [song(2)]);
  assert.equal(calls[1][2].defer_click, undefined);
  player.destroy();
});
