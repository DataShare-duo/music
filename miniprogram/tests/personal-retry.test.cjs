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
    loadAvatar: async () => {},
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

test("mine defaults to recent, honors explicit old deep links, and visiting as a guest never auto-enables", async () => {
  let calls=[]; const listeners=new Set();
  const data={active:false,avatar:"",error:"",favorite:[],like:[],recent:{items:[]}};
  const store={data,subscribe(fn){listeners.add(fn);fn(data);return()=>listeners.delete(fn);},
    enable:async()=>{calls.push("enable");return true;},
    sync:async()=>calls.push("sync"),loadAvatar:async()=>calls.push("avatar")};
  const old=global.getApp;global.getApp=()=>({personal:store});
  try {
    const page=make(mine);page.onLoad({});page.onShow();
    assert.equal(page.data.kind,"recent");assert.deepEqual(calls,[]);
    page.onHide();assert.equal(listeners.size,0);
    for(const kind of ["favorite","like","recent","invalid"]) {
      const other=make(mine);other.onLoad({kind});other.onShow();
      assert.equal(other.data.kind,kind==="invalid"?"recent":kind);
      other.onHide();
    }
    data.active=true;page.onShow();await flush();
    assert.deepEqual(calls,["sync","avatar"]);page.onHide();
  } finally {global.getApp=old;}
});

test("primary activation accepts only a confirmed native avatar event, avoids duplicate submits and keeps skip optional", async () => {
  const page=make(mine),calls=[];let finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  page.store={setAvatar:async(...args)=>{calls.push(args);await pending;}};
  await page.activateWithAvatar({detail:{avatarUrl:""}});
  assert.equal(calls.length,0);
  const first=page.activateWithAvatar({detail:{avatarUrl:"wxfile://tmp/chosen"}});
  assert.equal(page.data.busy,true);
  await page.activateWithAvatar({detail:{avatarUrl:"wxfile://tmp/duplicate"}});
  assert.deepEqual(calls,[["wxfile://tmp/chosen",true]]);
  finish();await first;assert.equal(page.data.busy,false);
  page.store={setAvatar:async(...args)=>calls.push(args)};
  await page.chooseAvatar({detail:{avatarUrl:"wxfile://tmp/replacement"}});
  assert.deepEqual(calls.at(-1),["wxfile://tmp/replacement",false]);
});
