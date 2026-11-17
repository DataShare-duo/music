const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const USER = "a".repeat(64), OTHER = "b".repeat(64);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03]);
const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const webp = Buffer.from("RIFF0000WEBP0000");
const uri = (bytes, mime) => "data:" + mime + ";base64," + bytes.toString("base64");
const writes = [], removed = [];
let image = jpeg, writeError = false;
const files = new Map();
global.wx = {
  env: { USER_DATA_PATH: "wxfile://usr" },
  showModal: async () => ({ confirm: true }),
  base64ToArrayBuffer: (text) => {
    const bytes = Buffer.from(text,"base64");
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
  getFileSystemManager: () => ({
    getFileInfo: ({success}) => success({size:image.length}),
    readFile: ({success}) => success({data:image.toString("base64")}),
    writeFile: (options) => {
      writes.push(options);
      if (writeError) options.fail();
      else { files.set(options.filePath, options.data); options.success(); }
    },
    unlink: ({filePath, success}) => { removed.push(filePath); files.delete(filePath); success(); },
  }),
};
const { avatarMime, avatarFile, removeAvatarFile } = require("../dist/services/avatar.js");
const { PersonalStore } = require("../dist/services/personal.js");
function view(avatar = "", userKey = USER) {
  return {revision:1, active:true, userKey, avatar, favorite:[], like:[],
    search:{epoch:0,items:[]}, recent:{epoch:0,items:[]}};
}
function store(call, cache) {
  const instance = new PersonalStore(call, async()=>"event-id", {
    read:()=>cache, write:()=>{},
  });
  instance.data.active=true;
  instance.data.userKey=USER;
  return instance;
}
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {resolve = r;});
  return {promise,resolve};
};

test("native avatar entry requires an explicit choice; no deprecated automatic profile extraction or cloud storage", () => {
  const source = fs.readFileSync(path.resolve(__dirname,"../src/services/personal.ts"),"utf8");
  const mine = fs.readFileSync(path.resolve(__dirname,"../src/pages/mine/index.wxml"),"utf8");
  assert.ok(source.includes('this.call("avatar.set"'));
  assert.ok(source.includes("base64: file.data"));
  assert.ok(source.includes("mime: avatarMime(file.data)"));
  assert.ok(!source.includes("wx.cloud.uploadFile") && !source.includes("wx.cloud.deleteFile"));
  assert.ok(!source.includes("getUserProfile") && !source.includes("getUserInfo"));
  assert.ok(mine.includes('open-type="chooseAvatar"'));
  assert.ok(mine.includes("选择一次头像，下次自动显示"));
});

test("avatar header detection supports JPEG, PNG and WebP rather than sending every upload as JPEG", () => {
  assert.equal(avatarMime(jpeg.toString("base64")), "image/jpeg");
  assert.equal(avatarMime(png.toString("base64")), "image/png");
  assert.equal(avatarMime(webp.toString("base64")), "image/webp");
  assert.throws(()=>avatarMime(Buffer.from("not an image").toString("base64")), /JPEG/);
});

test("saved avatar is loaded into a user-isolated local image file and survives metadata-only profile sync", async () => {
  const s=store(async(action)=>view(action==="avatar.get"?uri(png,"image/png"):""));
  await s.loadAvatar();
  const previous=s.data.avatar;
  assert.match(previous, /^wxfile:\/\/usr\/music-avatar-a{64}-\d+-\d+\.png$/);
  assert.equal(files.get(previous),png.toString("base64"));
  assert.ok(!s.data.avatar.startsWith("data:"));
  await s.sync();
  assert.equal(s.data.avatar,previous);
  await s.loadAvatar();
  assert.notEqual(s.data.avatar,previous);
  assert.ok(removed.includes(previous));
});

test("concurrent avatar fetches coalesce and an older response cannot replace the latest saved avatar", async () => {
  const old=deferred(); let gets=0;
  const s=store(async()=>{gets++;return gets===1?old.promise:view(uri(webp,"image/webp"));});
  const first=s.loadAvatar();
  const duplicate=s.loadAvatar();
  assert.equal(gets,1);
  await s.loadAvatar(true);
  const latest=s.data.avatar;
  old.resolve(view(uri(jpeg,"image/jpeg")));
  await Promise.all([first,duplicate]);
  assert.equal(s.data.avatar,latest);
  assert.ok(latest.endsWith(".webp"));
});

test("new avatar is uploaded with detected MIME and loaded from MySQL afterwards", async () => {
  for (const [bytes,mime] of [[jpeg,"image/jpeg"],[png,"image/png"],[webp,"image/webp"]]) {
    image=bytes; const calls=[];
    const s=store(async(action,data)=>{calls.push({action,data});return view(action==="avatar.get"?uri(bytes,mime):"");});
    await s.setAvatar("wxfile://tmp/chosen-avatar");
    const upload=calls.find((x)=>x.action==="avatar.set");
    assert.equal(upload.data.mime,mime);
    assert.equal(upload.data.base64,bytes.toString("base64"));
    assert.ok(calls.some((x)=>x.action==="avatar.get"));
    assert.ok(s.data.avatar.startsWith("wxfile://usr/"));
  }
});

test("oversize and invalid uploads stop before the API; storage failure never publishes a broken avatar", async () => {
  let calls=0;
  const s=store(async()=>{calls++; return view(uri(png,"image/png"));});
  image=Buffer.alloc(2*1024*1024+1);
  await assert.rejects(s.setAvatar("wxfile://tmp/large"),/2 MiB/);
  image=Buffer.from("not an image");
  await assert.rejects(s.setAvatar("wxfile://tmp/invalid"),/JPEG/);
  assert.equal(calls,0);
  writeError=true;
  await s.loadAvatar();
  writeError=false;
  assert.equal(s.data.avatar,"");
  assert.match(s.data.error,/存储/);
});

test("avatar reads cannot leak across users and cleanup never deletes arbitrary user files", async () => {
  const pending=deferred();
  const s=store(async()=>pending.promise);
  const task=s.loadAvatar(); s.data.userKey=OTHER;
  pending.resolve(view(uri(png,"image/png")));
  await task;
  assert.equal(s.data.avatar,"");
  const before=writes.length;
  const mismatch=store(async()=>view(uri(png,"image/png"),OTHER));
  await mismatch.loadAvatar();
  assert.equal(writes.length,before);
  assert.match(mismatch.data.error,/身份不匹配/);
  await assert.rejects(avatarFile(uri(png,"image/jpeg"),USER),/格式/);
  await assert.rejects(avatarFile(uri(png,"image/png"),"../other"),/身份/);
  const deleted=removed.length;
  for (const p of ["wxfile://usr/other-file.jpg","wxfile://tmp/chosen-avatar","wxfile://usr/../private.jpg"])
    await removeAvatarFile(p);
  assert.equal(removed.length,deleted);
});

test("legacy base64 caches are not exposed to page data and enabling reloads a previously saved avatar", async () => {
  const cache={version:1,revision:0,active:true,userKey:USER,avatar:uri(png,"image/png"),
    favorite:[],like:[],search:{epoch:0,items:[],pending:[]},recent:{epoch:0,items:[],pending:[]}};
  const s=store(async(action)=>view(action==="avatar.get"?uri(png,"image/png"):""),cache);
  assert.equal(s.data.avatar,"");
  s.data.active=false;
  await s.enable();
  assert.ok(s.data.avatar.startsWith("wxfile://usr/"));
  const previous=s.data.avatar;
  const other=store(async()=>view("",OTHER));
  other.data.avatar=previous;
  await other.sync();
  assert.ok(removed.includes(previous));
  assert.equal(other.data.avatar,"");
});
