const crypto = require("node:crypto");
const APP_ID = "wxe1af0ed55ed257b7";
class UserError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new UserError(code, message);
};
const text = (x, max) => {
  if (typeof x !== "string" || !x.trim() || x.length > max)
    fail("invalid_input", "提交内容无效");
  return x.trim();
};
const keyOf = (s) => s.source + ":" + s.source_track_id;
function snapshot(value) {
  if (
    !value ||
    typeof value.source_track_id !== "string" ||
    !["soda", "netease", "kuwo"].includes(value.source) ||
    !/^[\w-]{1,100}$/.test(value.source_track_id)
  )
    fail("invalid_song", "歌曲标识无效");
  const optional = (x, n) => (typeof x === "string" ? x.slice(0, n) : "");
  return {
    source: value.source,
    source_track_id: value.source_track_id,
    title: text(value.title, 200),
    artist: text(value.artist, 200),
    album: optional(value.album, 200),
    cover_url: /^https:\/\//.test(value.cover_url || "")
      ? optional(value.cover_url, 1024)
      : "",
    duration: Math.max(0, Math.min(86400, Number(value.duration) || 0)),
  };
}
function initial() {
  return {
    version: 1,
    revision: 0,
    active: true,
    avatar: "",
    favorite: [],
    like: [],
    search: { epoch: 0, items: [], seen: [] },
    recent: { epoch: 0, items: [], seen: [] },
    marksSeen: [],
    rate: { minute: 0, count: 0 },
  };
}
function history(doc, kind, body, now) {
  const h = doc[kind];
  if (body.epoch !== h.epoch) return { conflict: true };
  if (!Array.isArray(body.ops) || body.ops.length > 120)
    fail("invalid_input", "同步批次过大");
  let cleared = false;
  for (const op of body.ops) {
    const id = text(op.id, 100);
    if (h.seen.includes(id)) continue;
    if (!["put", "remove", "clear"].includes(op.type))
      fail("invalid_input", "历史操作无效");
    if (op.type === "clear") {
      h.items = [];
      cleared = true;
    } else if (op.type === "remove") {
      const key = text(op.key, 210);
      h.items = h.items.filter((x) => x.key !== key);
      cleared = true;
    } else {
      const song = kind === "recent" ? snapshot(op.song) : null;
      const query = kind === "search" ? text(op.query, 100) : null;
      const key = song ? keyOf(song) : query;
      const at = Math.max(0, Math.min(now, Number(op.at) || now));
      const old = h.items.find((x) => x.key === key);
      if (!old || old.at <= at) {
        h.items = h.items.filter((x) => x.key !== key);
        h.items.push({
          key,
          at,
          ...(song
            ? {
                song,
                sourceName:
                  typeof op.sourceName === "string"
                    ? op.sourceName.slice(0, 40)
                    : "",
              }
            : { query }),
        });
      }
    }
    h.seen.push(id);
  }
  if (cleared) h.epoch++;
  h.seen = h.seen.slice(-512);
  h.items.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  h.items = h.items.slice(0, kind === "search" ? 20 : 100);
  return { conflict: false };
}
function view(doc, owner, extra = {}) {
  return {
    revision: doc?.revision || 0,
    active: !!doc,
    userKey: owner,
    avatar: doc?.avatar || "",
    favorite: doc?.favorite || [],
    like: doc?.like || [],
    search: doc ? { epoch: doc.search.epoch, items: doc.search.items } : null,
    recent: doc ? { epoch: doc.recent.epoch, items: doc.recent.items } : null,
    ...extra,
  };
}
function createPersonal({ store, storage, clock = Date.now }) {
  return async function handle(event, context) {
    try {
      if (
        context.APPID !== APP_ID ||
        !context.OPENID ||
        context.SOURCE !== "wx_client"
      )
        fail("unauthenticated", "无法确认微信身份，请在当前小程序内重试");
      if (event?.openid || event?.userId || event?.userKey)
        fail("invalid_identity", "不能指定其他用户身份");
      const owner = crypto
        .createHash("sha256")
        .update(APP_ID + ":" + context.OPENID)
        .digest("hex");
      const action = text(event?.action, 40),
        body = event?.data || {};
      if (body.openid || body.userId || body.userKey)
        fail("invalid_identity", "不能指定其他用户身份");
      if (
        ![
          "profile.get",
          "profile.enable",
          "avatar.set",
          "mark.set",
          "history.sync",
        ].includes(action)
      )
        fail("invalid_action", "不支持的个人操作");
      let avatar = "";
      if (action === "avatar.set") {
        avatar = text(body.fileID, 500);
        if (
          !avatar.startsWith("cloud://") ||
          !avatar.includes("/avatars/" + owner + "/") ||
          !new RegExp(
            "/avatars/" + owner + "/[a-zA-Z0-9_-]{8,100}\\.(jpg|png|webp)$",
          ).test(avatar)
        )
          fail("invalid_avatar", "头像文件不属于当前用户");
        await store.transact(owner, async (original) => {
          if (!original) fail("profile_required", "请先启用个人空间");
          const doc = structuredClone(original),
            minute = Math.floor(clock() / 60000);
          doc.avatarRate =
            doc.avatarRate?.minute === minute
              ? doc.avatarRate
              : { minute, count: 0 };
          if (++doc.avatarRate.count > 5)
            fail("rate_limited", "头像操作过于频繁，请稍后重试");
          return { doc, result: true };
        });
        try {
          await storage.validate(avatar);
        } catch {
          fail(
            "invalid_avatar",
            "头像必须为不超过2 MiB的JPEG、PNG或WebP图片，且文件可访问",
          );
        }
      }
      const result = await store.transact(owner, async (original) => {
        let doc = original ? structuredClone(original) : null;
        if (!doc && action === "profile.get")
          return { doc: null, result: view(null, owner) };
        if (!doc && action !== "profile.enable")
          fail("profile_required", "请先启用个人空间");
        doc = doc || initial();
        const now = clock(),
          minute = Math.floor(now / 60000);
        doc.rate =
          doc.rate?.minute === minute ? doc.rate : { minute, count: 0 };
        if (++doc.rate.count > 120)
          fail("rate_limited", "操作过于频繁，请稍后重试");
        let extra = {};
        if (action === "mark.set") {
          const kind = body.kind;
          if (
            !["favorite", "like"].includes(kind) ||
            typeof body.value !== "boolean"
          )
            fail("invalid_input", "标记操作无效");
          const song = snapshot(body.song),
            key = keyOf(song),
            id = text(body.opId, 100);
          if (!doc.marksSeen.includes(id)) {
            if (
              body.value &&
              !doc[kind].some((x) => x.key === key) &&
              doc[kind].length >= 200
            )
              fail("collection_limit", "每个列表最多保存200首歌曲，请先整理");
            doc[kind] = doc[kind].filter((x) => x.key !== key);
            if (body.value) doc[kind].unshift({ key, song, at: now });
            doc.marksSeen.push(id);
            doc.marksSeen = doc.marksSeen.slice(-512);
          }
        }
        if (action === "history.sync") {
          const kind = body.kind;
          if (!["recent", "search"].includes(kind))
            fail("invalid_input", "历史类型无效");
          extra = { kind, ...history(doc, kind, body, now) };
        }
        doc.revision = (doc.revision || 0) + 1;
        const oldAvatar = doc.avatar;
        if (action === "avatar.set") doc.avatar = avatar;
        if (Buffer.byteLength(JSON.stringify(doc)) > 700 * 1024)
          fail("collection_limit", "个人数据空间已满，请先整理记录");
        return {
          doc,
          result: view(doc, owner, {
            ...extra,
            ...(action === "avatar.set" ? { oldAvatar } : {}),
          }),
        };
      });
      if (result.oldAvatar && result.oldAvatar !== avatar) {
        await storage.remove(result.oldAvatar).catch(() => {});
      }
      delete result.oldAvatar;
      return { ok: true, data: result };
    } catch (error) {
      return {
        ok: false,
        error: {
          code:
            error instanceof UserError ? error.code : "personal_unavailable",
          message:
            error instanceof UserError
              ? error.message
              : "个人服务暂不可用，请检查云函数、数据库及存储部署",
        },
      };
    }
  };
}
module.exports = { createPersonal, snapshot, keyOf, initial, APP_ID };
