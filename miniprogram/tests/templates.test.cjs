const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const checker = () =>
  import(
    pathToFileURL(path.resolve(__dirname, "../scripts/template-check.mjs")).href
  );

test("native search and player attributes use real operators, brand text does not show HTML entities", async () => {
  const { checkTemplate } = await checker();
  const source = await fs.readFile(
    path.resolve(__dirname, "../src/pages/search/index.wxml"),
    "utf8",
  );
  const player = await fs.readFile(
    path.resolve(__dirname, "../src/components/player-bar/index.wxml"),
    "utf8",
  );
  const home = await fs.readFile(
    path.resolve(__dirname, "../src/pages/home/index.wxml"),
    "utf8",
  );
  for (const [name, text] of [
    ["search", source],
    ["player", player],
    ["home", home],
  ])
    assert.doesNotThrow(() => checkTemplate(text, name));
  assert.ok(source.includes("{{page <= 1 || loading}}"));
  assert.ok(player.includes("{{!hasSong || (loading && !failed)}}"));
  assert.ok(home.includes("LISTEN & FEEL") && !home.includes("&amp;"));
  assert.ok(!home.includes("第一阶段") && !home.includes("真机直连验证版"));
});
test("build rejects escaped expression operators but permits entities in plain text", async () => {
  const { checkTemplate } = await checker();
  for (const entity of ["&lt;", "&amp;", "&gt;", "&#38;", "&#x26;"]) {
    assert.throws(
      () =>
        checkTemplate('<button disabled="{{a ' + entity + ' b}}"/>', "fixture"),
      /HTML entities/,
    );
  }
  assert.doesNotThrow(() =>
    checkTemplate(
      '<text>LISTEN &amp; FEEL</text><button disabled="{{page <= 1 || (loading && !failed)}}"/>',
      "fixture",
    ),
  );
});

test("search entry is a compact single-row button, pagination stays a row and empty text is stacked", async () => {
  const read = (file) =>
    fs.readFile(path.resolve(__dirname, "../src/", file), "utf8");
  const home = await read("pages/home/index.wxml");
  const search = await read("pages/search/index.wxml");
  const css = await read("app.wxss");
  assert.match(home, /<button class="search-entry"[^>]*bindtap="openSearch"/);
  assert.ok(home.includes('class="search-entry-title">搜索歌曲、歌手'));
  assert.ok(home.includes('class="search-entry-action">搜索'));
  assert.ok(!home.includes('class="search-entry-hint"'));
  assert.ok(!home.includes('class="search-entry-icon"'));
  assert.ok(!home.includes('class="navigation"'));
  assert.ok(
    search.includes('class="page-indicator"') &&
      search.includes('class="page-current"'),
  );
  assert.ok(search.includes('disabled="{{!hasMore || loading}}"'));
  assert.ok(search.includes('disabled="{{page <= 1 || loading}}"'));
  const rule = (selector) => {
    const marker = selector + " {";
    const index = css.indexOf(marker);
    assert.notEqual(index, -1, "missing " + selector);
    return css.slice(index + marker.length, css.indexOf("}", index));
  };
  assert.match(rule(".search-entry"), /display: flex/);
  assert.match(rule(".search-entry"), /min-height: 100rpx/);
  assert.match(rule(".search-entry"), /border-radius: 999rpx/);
  assert.match(rule(".search-entry-title"), /white-space: nowrap/);
  assert.match(rule(".search-entry-action"), /flex-shrink: 0/);
  assert.match(rule(".pagination"), /display: flex/);
  assert.match(rule(".pagination"), /flex-direction: row/);
  assert.match(rule(".pagination .page-button"), /min-height: 80rpx/);
  assert.match(rule(".pagination .page-button[disabled]"), /opacity: 1/);
  assert.match(rule(".music-page .empty"), /flex-direction: column/);
  assert.match(rule(".empty-title"), /display: block/);
  assert.match(rule(".empty .muted"), /display: block/);
});

test("fullscreen controls use geometric icons with state, accessibility and touch targets preserved", async () => {
  const root = path.resolve(__dirname, "../src/pages/player/");
  const markup = await fs.readFile(path.join(root, "index.wxml"), "utf8");
  const css = await fs.readFile(path.join(root, "index.wxss"), "utf8");
  const { checkTemplate } = await checker();
  assert.doesNotThrow(() => checkTemplate(markup, "full-player"));
  assert.match(markup, /aria-label="返回音乐页面" bindtap="back"/);
  assert.ok(markup.includes('class="collapse-chevron"'));
  assert.ok(markup.includes('wx:if="{{loading}}" class="control-spinner"'));
  assert.ok(markup.includes('wx:elif="{{playing}}" class="control-pause"'));
  assert.ok(markup.includes('wx:else class="control-play"'));
  assert.ok(
    markup.includes(
      "aria-label=\"{{loading ? '正在加载' : (playing ? '暂停' : '播放')}}\"",
    ),
  );
  assert.ok(markup.includes('class="control-skip control-skip-next"'));
  const controls = markup.slice(markup.indexOf('<view class="full-buttons">'));
  assert.equal((controls.match(/class="control-button/g) || []).length, 3);
  for (const action of ["previous", "toggle", "next"]) {
    assert.ok(controls.includes('bindtap="' + action + '"'));
  }
  assert.ok(
    controls.includes('disabled="{{!hasSong || (loading && !failed)}}"'),
  );
  assert.equal(
    controls.split('disabled="{{!hasSong || loading}}"').length - 1,
    2,
  );
  assert.ok(!/[⌄◀▶Ⅱ]/u.test(markup));
  assert.match(css, /width: 80rpx;[\s\S]*height: 80rpx/);
  assert.match(css, /width: 96rpx;[\s\S]*height: 96rpx/);
  assert.match(css, /width: 124rpx;[\s\S]*height: 124rpx/);
  assert.ok(css.includes("background: currentColor"));
  assert.ok(css.includes("safe-area-inset-bottom"));
});

test("fullscreen back is a small left chevron without a circle and keeps the transparent touch target", async () => {
  const css = await fs.readFile(
    path.resolve(__dirname, "../src/pages/player/index.wxss"),
    "utf8",
  );
  const rule = (name) => {
    const start = css.indexOf(name + " {");
    assert.notEqual(start, -1);
    return css.slice(start, css.indexOf("}", start));
  };
  const button = rule(".collapse");
  assert.match(button, /width: 80rpx/);
  assert.match(button, /height: 80rpx/);
  assert.match(button, /border: 0/);
  assert.match(button, /border-radius: 0/);
  assert.match(button, /background: transparent/);
  const chevron = rule(".collapse-chevron");
  assert.match(chevron, /width: 18rpx/);
  assert.match(chevron, /height: 18rpx/);
  assert.match(chevron, /border-left: 3rpx solid/);
  assert.match(chevron, /border-bottom: 3rpx solid/);
  assert.match(chevron, /rotate\(45deg\)/);
  assert.ok(!chevron.includes("border-right"));
  assert.ok(!rule(".collapse-pressed").includes("background"));
});
