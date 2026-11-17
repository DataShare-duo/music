const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const menus = [],
  modals = [];
global.wx = {
  showShareMenu: (options) => menus.push(options),
  showModal: (options) => modals.push(options),
};
const {
  enableSharing,
  timelineCard,
  shareToTimeline,
} = require("../dist/services/sharing.js");
const song = {
  source: "netease",
  source_track_id: "123",
  title: "分享给你的歌",
  artist: "歌手",
  cover_url: "https://cover.example/1.jpg",
  album: "",
  duration: 90,
};
test("timeline guide enables the real WeChat menu and never claims an unsupported direct-share API exists", () => {
  shareToTimeline();
  assert.deepEqual(menus.at(-1).menus, ["shareAppMessage", "shareTimeline"]);
  assert.match(modals.at(-1).content, /右上角/);
  assert.match(modals.at(-1).content, /分享到朋友圈/);
  const source = fs.readFileSync(
    path.resolve(__dirname, "../src/services/sharing.ts"),
    "utf8",
  );
  assert.ok(
    !source.includes("wx.shareToTimeline") && !source.includes("uploadFile"),
  );
});
test("timeline card contains only stable song identity and supports the existing safe landing route", () => {
  const card = timelineCard(song);
  assert.match(card.query, /s=netease/);
  assert.match(card.query, /t=123/);
  assert.equal(card.imageUrl, song.cover_url);
  for (const secret of ["openid", "audio_url", "session", "song_id"])
    assert.ok(!card.query.includes(secret));
  const player = fs.readFileSync(
    path.resolve(__dirname, "../src/pages/player/index.wxml"),
    "utf8",
  );
  assert.ok(player.includes('bindtap="shareTimeline"'));
  assert.ok(player.includes("朋友圈"));
  const page = fs.readFileSync(
    path.resolve(__dirname, "../src/pages/player/index.ts"),
    "utf8",
  );
  assert.ok(page.includes("readShared(options)"));
  assert.ok(page.includes("routes.song"));
});
test("search no longer contains a music-source picker, while result source badges remain truthful", () => {
  const search = fs.readFileSync(
    path.resolve(__dirname, "../src/pages/search/index.wxml"),
    "utf8",
  );
  assert.ok(
    !search.includes("<picker") &&
      !search.includes("音乐来源") &&
      !search.includes("sourceIndex"),
  );
  assert.ok(search.includes("item.sourceText"));
});

test("full-player timeline landing shows stable song text without redirect, cloud identity or playback", () => {
  let definition;
  const oldPage = global.Page,
    oldApp = global.getApp,
    oldCurrent = global.getCurrentPages;
  let forbidden = 0;
  global.Page = (value) => {
    definition = value;
  };
  global.wx.getLaunchOptionsSync = () => ({ scene: 1154 });
  global.wx.cloud = {
    callContainer: async () => {
      forbidden++;
      throw new Error("forbidden");
    },
  };
  global.wx.redirectTo = () => {
    forbidden++;
  };
  global.getApp = () => {
    forbidden++;
    throw new Error("no login context in preview");
  };
  try {
    require("../dist/pages/player/index.js");
    const { shareQuery } = require("../dist/services/songs.js");
    const options = Object.fromEntries(
      shareQuery(song)
        .split("&")
        .map((row) => {
          const index = row.indexOf("=");
          return [row.slice(0, index), row.slice(index + 1)];
        }),
    );
    const page = {
      ...definition,
      data: structuredClone(definition.data),
      setData(values) {
        Object.assign(this.data, values);
      },
    };
    page.onLoad(options);
    page.onShow();
    assert.equal(page.data.limitedShare, true);
    assert.equal(page.data.sharedTitle, song.title);
    assert.equal(page.data.sharedArtist, song.artist);
    assert.equal(forbidden, 0);
    assert.match(page.onShareTimeline().query, /s=netease/);
    assert.equal(forbidden, 0);
  } finally {
    global.Page = oldPage;
    global.getApp = oldApp;
    global.getCurrentPages = oldCurrent;
    global.wx.getLaunchOptionsSync = () => ({ scene: 1001 });
  }
});

test("timeline single-page app initialization never starts personal sync, cloud init or the background player", () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(
    path.resolve(__dirname, "../dist/app.js"),
    "utf8",
  );
  let definition,
    forbidden = 0;
  const context = {
    exports: {},
    App: (value) => {
      definition = value;
    },
    wx: {
      cloud: { init: () => forbidden++ },
      getBackgroundAudioManager: () => {
        forbidden++;
      },
    },
    setInterval: () => {
      forbidden++;
    },
    clearInterval: () => {},
    require: (name) => {
      if (name === "./services/sharing")
        return { isTimelinePreview: () => true };
      if (name === "./services/personal")
        return {
          PersonalStore: class {
            constructor() {
              forbidden++;
            }
          },
        };
      if (name === "./services/player")
        return {
          NativePlayer: class {
            constructor() {
              forbidden++;
            }
          },
        };
      return {};
    },
  };
  vm.runInNewContext(source, context);
  definition.onLaunch();
  definition.onShow();
  assert.equal(forbidden, 0);
  assert.equal(definition.player, null);
  assert.equal(definition.personal, null);
});
