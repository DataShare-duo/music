const { test } = require("node:test");
const assert = require("node:assert/strict");
let definition;
global.Page = (value) => { definition = value; };
global.wx = { cloud: { callContainer: async () => ({ statusCode: 200, data: {} }) } };
const { api } = require("../dist/services/api.js");
const { callPersonal, PersonalError } = require("../dist/services/personal.js");
const { ApiError } = require("../dist/services/api.js");
require("../dist/pages/mine/index.js");
const mine = definition;
function make(definition) {
  return {
    ...definition,
    data: structuredClone(definition.data),
    setData(value) { Object.assign(this.data, value); },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("inactive personal space retries enabling, active space retries syncing and busy taps do nothing", async () => {
  const page = make(mine);
  let enabled = 0, synced = 0;
  page.store = {
    data: { active: false },
    enable: async () => { enabled++; return true; },
    sync: async () => { synced++; },
  };
  page.retry();
  await flush();
  assert.equal(enabled, 1);
  assert.equal(synced, 0);
  assert.equal(page.data.busy, false);
  page.store.data.active = true;
  page.retry();
  await flush();
  assert.equal(synced, 1);
  page.data.busy = true;
  page.retry();
  await flush();
  assert.equal(synced, 1);
  assert.equal(enabled, 1);
});

test("personal calls preserve the backend identity error code and message without reading client identity", async () => {
  const original = api.post;
  api.post = async () => {
    throw new ApiError("wechat_appid_mismatch", "小程序身份与后端配置不匹配");
  };
  try {
    await assert.rejects(callPersonal("profile.enable"), (error) => {
      assert.ok(error instanceof PersonalError);
      assert.equal(error.code, "wechat_appid_mismatch");
      assert.equal(error.message, "小程序身份与后端配置不匹配");
      return true;
    });
  } finally {
    api.post = original;
  }
});

require("../dist/pages/diagnostics/index.js");
const diagnostics = definition;
test("identity diagnostics check only the cloud identity and do not mutate a profile or music playback", async () => {
  const page = make(diagnostics);
  const original = api.get;
  let calls = 0;
  api.get = async (path) => {
    calls++;
    assert.equal(path, "/api/miniprogram/identity");
    return { status: "ok" };
  };
  try {
    await page.checkIdentity();
    assert.equal(page.data.identityStatus, "微信身份校验通过");
    assert.equal(page.data.identityLoading, false);
    page.data.identityLoading = true;
    await page.checkIdentity();
    assert.equal(calls, 1);
    page.data.identityLoading = false;
    api.get = async () => { throw new ApiError("wechat_openid_missing", "未收到微信用户身份"); };
    await page.checkIdentity();
    assert.equal(page.data.identityStatus, "未收到微信用户身份");
    assert.equal(page.data.identityLoading, false);
    assert.equal(page.data.cloudStatus, "尚未检查云服务");
  } finally {
    api.get = original;
  }
});
