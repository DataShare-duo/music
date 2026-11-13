const { test } = require("node:test");
const assert = require("node:assert/strict");
let definition;
const observers = new Set();
const actions = [];
const state = {
  current: {
    title: "歌曲",
    artist: "歌手",
    cover_url: "https://cover.example/a.jpg",
  },
  sourceName: "网易云音乐",
  playing: true,
  loading: false,
  failed: false,
  message: "",
  position: 60,
  duration: 180,
};
global.Component = (options) => {
  definition = options;
};
global.getApp = () => ({
  player: {
    subscribe: (fn) => {
      observers.add(fn);
      fn(state);
      return () => observers.delete(fn);
    },
    toggle: () => actions.push("toggle"),
    next: (value) => actions.push(value),
    seek: (value) => actions.push(value),
  },
});
function instance(options) {
  return {
    data: structuredClone(options.data),
    setData(values) {
      Object.assign(this.data, values);
    },
  };
}
test("cover component uses HTTPS only and resets fallback after cover changes", () => {
  require("../dist/components/cover-art/index.js");
  const c = instance(definition);
  definition.observers.url.call(c, "http://unsafe.example/cover");
  assert.equal(c.data.safeUrl, "");
  definition.observers.url.call(c, "https://cover.example/a.jpg");
  assert.equal(c.data.safeUrl, "https://cover.example/a.jpg");
  definition.methods.failed.call(c);
  assert.equal(c.data.broken, true);
  definition.observers.url.call(c, "https://cover.example/b.jpg");
  assert.equal(c.data.broken, false);
});
test("player bar shares existing player and cleans subscriptions on page hide and detach", () => {
  require("../dist/components/player-bar/index.js");
  const options = definition;
  const c = instance(options);
  options.lifetimes.attached.call(c);
  assert.equal(observers.size, 1);
  assert.equal(c.data.source, "网易云音乐");
  assert.equal(c.data.positionText, "1:00");
  options.pageLifetimes.show.call(c);
  assert.equal(observers.size, 1);
  options.methods.toggle.call(c);
  options.methods.previous.call(c);
  options.methods.next.call(c);
  options.methods.seek.call(c, { detail: { value: 45 } });
  assert.deepEqual(actions, ["toggle", -1, 1, 45]);
  options.pageLifetimes.hide.call(c);
  assert.equal(observers.size, 0);
  options.pageLifetimes.show.call(c);
  assert.equal(observers.size, 1);
  options.lifetimes.detached.call(c);
  assert.equal(observers.size, 0);
});
