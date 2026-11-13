const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Catalog } = require("../dist/services/catalog.js");
const result = (label) => ({
  items: [],
  count: 0,
  message: label,
  refreshing: false,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const flush = () => new Promise((r) => setImmediate(r));

test("keyword/source/page transitions ignore old request responses", async () => {
  const pending = [];
  const api = {
    get: (path) => {
      const d = deferred();
      pending.push({ path, ...d });
      return d.promise;
    },
  };
  const catalog = new Catalog(
    api,
    () => {},
    () => 7,
  );
  catalog.resume();
  catalog.change("search", "陈奕迅", "netease", 2);
  assert.match(pending[1].path, /source=netease&page=2/);
  pending[1].resolve(result("new"));
  await flush();
  pending[0].resolve(result("old"));
  await flush();
  assert.equal(catalog.state.result.message, "new");
  assert.equal(catalog.state.revision, 7);
  catalog.pause();
});
test("background pauses polling and ignores late results; foreground refreshes", async () => {
  const pending = [];
  const api = {
    get: () => {
      const d = deferred();
      pending.push(d);
      return d.promise;
    },
  };
  const catalog = new Catalog(api, () => {});
  catalog.resume();
  catalog.pause();
  pending[0].resolve(result("late"));
  await flush();
  assert.equal(catalog.state.result, null);
  assert.equal(catalog.timer, undefined);
  catalog.resume();
  pending[1].resolve(result("restored"));
  await flush();
  assert.equal(catalog.state.result.message, "restored");
  catalog.pause();
});
test("verification and idle polling intervals differ and errors are visible", async () => {
  const original = global.setTimeout;
  const scheduled = [];
  global.setTimeout = (fn, ms) => {
    scheduled.push(ms);
    return original(fn, 600000);
  };
  try {
    let refreshing = true;
    const catalog = new Catalog(
      { get: async () => ({ ...result("ok"), refreshing }) },
      () => {},
    );
    catalog.resume();
    await flush();
    assert.equal(scheduled.at(-1), 3000);
    refreshing = false;
    await catalog.load();
    assert.equal(scheduled.at(-1), 60000);
    catalog.api.get = async () => {
      throw new Error("网络失败");
    };
    await catalog.load();
    assert.equal(catalog.state.error, "网络失败");
    catalog.pause();
  } finally {
    global.setTimeout = original;
  }
});

test("resume is idempotent while visible and never duplicates submitted search", async () => {
  let calls = 0;
  const catalog = new Catalog(
    {
      get: async () => {
        calls++;
        return result("ok");
      },
    },
    () => {},
  );
  catalog.resume();
  await flush();
  catalog.resume();
  await flush();
  assert.equal(calls, 1);
  catalog.change("search", "one", "kuwo", 1);
  catalog.resume();
  await flush();
  assert.equal(calls, 2);
  catalog.pause();
});
