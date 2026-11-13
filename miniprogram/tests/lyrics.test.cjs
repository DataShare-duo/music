const { test } = require("node:test");
const assert = require("node:assert/strict");
const { LyricController, activeLine } = require("../dist/services/lyrics.js");
const { ApiError } = require("../dist/services/api.js");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const pending = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const snapshot = (id = "one", position = 0) => ({
  current: {
    id: id === "one" ? 1 : 2,
    source: "soda",
    source_track_id: "original",
  },
  sessionId: id,
  source: "netease",
  sourceTrackId: id,
  sourceName: "网易云音乐",
  linkVersion: 1,
  playing: true,
  position,
  duration: 90,
});
const view = (id = "one", status = "synced") => ({
  status,
  source: "netease",
  source_track_id: id,
  source_name: "网易云音乐",
  lines:
    status === "synced"
      ? [
          { time_ms: 0, text: "测试甲" },
          { time_ms: 1000, text: "测试乙" },
          { time_ms: 2000, text: "测试丙" },
        ]
      : [],
  plain_text: status === "plain" ? "静态测试" : "",
  retry_after: status === "error" ? 2 : 0,
  message: status === "error" ? "暂时失败" : "",
  fetched_at: "2026-01-01",
});

test("binary lyric lookup follows actual time with safe prelude/seek boundaries", () => {
  const lines = view().lines;
  assert.equal(activeLine(lines, 0), 0);
  assert.equal(activeLine(lines, 0.999), 0);
  assert.equal(activeLine(lines, 1), 1);
  assert.equal(activeLine(lines, 100), 2);
  assert.equal(activeLine(lines, -1), -1);
  assert.equal(activeLine(lines, NaN), -1);
  assert.equal(activeLine([{ time_ms: 5000, text: "intro" }], 0), -1);
  assert.equal(activeLine([], 10), -1);
});
test("lyrics use native session endpoint, never resolve or post audio, and local cache avoids repeat fetch", async () => {
  const calls = [],
    states = [];
  const api = {
    get: async (path) => {
      calls.push(path);
      return view();
    },
    post: () => assert.fail("lyrics must not post"),
  };
  const controller = new LyricController(api, (state) => states.push(state));
  const current = snapshot("one", 1.5);
  controller.resume(current);
  await flush();
  assert.deepEqual(calls, ["/api/miniprogram/playbacks/one/lyrics"]);
  assert.equal(controller.state.status, "synced");
  assert.equal(controller.state.activeIndex, 1);
  const updates = states.length;
  controller.update(snapshot("one", 1.6));
  assert.equal(states.length, updates);
  controller.update(snapshot("one", 2.1));
  assert.equal(controller.state.activeIndex, 2);
  controller.pause();
  controller.resume(snapshot("one", 0.5));
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(controller.state.activeIndex, 0);
  controller.pause();
});
test("rapid song changes and actual-source mismatches cannot show stale lyrics", async () => {
  const requests = [];
  const api = {
    get: (path) => {
      const task = pending();
      requests.push({ path, ...task });
      return task.promise;
    },
  };
  const controller = new LyricController(api, () => {});
  controller.resume(snapshot());
  controller.update(snapshot("two"));
  requests[1].resolve(view("two"));
  await flush();
  requests[0].resolve(view());
  await flush();
  assert.equal(controller.state.lines[0].text, "测试甲");
  assert.equal(controller.current.sourceTrackId, "two");
  assert.equal(controller.cache.has("netease:one"), false);
  controller.update(snapshot("three"));
  requests[2].resolve({ ...view("three"), source: "kuwo" });
  await flush();
  assert.equal(controller.state.status, "error");
  assert.equal(controller.state.lines.length, 0);
  assert.match(controller.state.message, /不一致/);
  controller.pause();
});
test("hidden page ignores pending results; foreground restores current line without audio changes", async () => {
  const task = pending();
  let changed = 0;
  const controller = new LyricController(
    { get: () => task.promise },
    () => changed++,
  );
  controller.resume(snapshot());
  controller.pause();
  const before = changed;
  task.resolve(view());
  await flush();
  assert.equal(changed, before);
  controller.api.get = async () => view();
  controller.resume(snapshot("one", 2));
  await flush();
  assert.equal(controller.state.activeIndex, 2);
  assert.equal(controller.current.playing, true);
  controller.pause();
});
test("manual lyric browsing suspends follow and resumes after three seconds or explicit button", async () => {
  const controller = new LyricController({ get: async () => view() }, () => {});
  controller.resume(snapshot());
  await flush();
  controller.manualStart();
  const revision = controller.state.scrollRevision;
  controller.update(snapshot("one", 2));
  assert.equal(controller.state.activeIndex, 2);
  assert.equal(controller.state.following, false);
  assert.equal(controller.state.scrollRevision, revision);
  const original = global.setTimeout;
  const delays = [];
  global.setTimeout = (fn, delay) => {
    delays.push(delay);
    return original(fn, 600000);
  };
  try {
    controller.manualEnd();
    assert.equal(delays[0], 3000);
    controller.manualScroll();
    assert.equal(delays.at(-1), 3000);
  } finally {
    global.setTimeout = original;
  }
  controller.follow();
  assert.equal(controller.state.following, true);
  assert.ok(controller.state.scrollRevision > revision);
  controller.pause();
});
test("missing, instrumental, plain and expired lyrics remain independent of playback", async () => {
  const controller = new LyricController(
    { get: async () => view("one", "plain") },
    () => {},
  );
  const current = snapshot();
  controller.resume(current);
  await flush();
  assert.equal(controller.state.status, "plain");
  assert.equal(controller.state.activeIndex, -1);
  for (const status of ["unavailable", "instrumental"]) {
    controller.api.get = async () => view(status, status);
    controller.update(snapshot(status));
    await flush();
    assert.equal(controller.state.status, status);
  }
  controller.api.get = async () => {
    throw new ApiError("playback_expired", "expired");
  };
  controller.update(snapshot("expired"));
  await flush();
  assert.match(controller.state.message, /会话已过期/);
  assert.equal(current.playing, true);
  controller.pause();
});
test("retry cooldown is respected and reopening does not reset the error cache deadline", async () => {
  const realNow = Date.now;
  let clock = 10000,
    calls = 0;
  Date.now = () => clock;
  const controller = new LyricController(
    {
      get: async () => {
        calls++;
        return view("one", "error");
      },
    },
    () => {},
  );
  try {
    controller.resume(snapshot());
    await flush();
    controller.retry();
    assert.equal(calls, 1);
    clock += 1000;
    controller.pause();
    controller.resume(snapshot());
    await flush();
    assert.equal(controller.state.retryAfter, 1);
    assert.equal(calls, 1);
    clock += 1100;
    controller.api.get = async () => {
      calls++;
      return view();
    };
    controller.retry();
    await flush();
    assert.equal(calls, 2);
    assert.equal(controller.state.status, "synced");
  } finally {
    controller.pause();
    Date.now = realNow;
  }
});
