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

test("search entry is a whole-card button, pagination stays a row and empty text is stacked", async () => {
  const read = (file) =>
    fs.readFile(path.resolve(__dirname, "../src/", file), "utf8");
  const home = await read("pages/home/index.wxml");
  const search = await read("pages/search/index.wxml");
  const css = await read("app.wxss");
  assert.match(home, /<button class="search-entry"[^>]*bindtap="openSearch"/);
  assert.ok(home.includes('class="search-entry-title">搜索歌曲'));
  assert.ok(home.includes('class="search-entry-hint"'));
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
  assert.match(rule(".pagination"), /display: flex/);
  assert.match(rule(".pagination"), /flex-direction: row/);
  assert.match(rule(".pagination .page-button"), /min-height: 80rpx/);
  assert.match(rule(".pagination .page-button[disabled]"), /opacity: 1/);
  assert.match(rule(".music-page .empty"), /flex-direction: column/);
  assert.match(rule(".empty-title"), /display: block/);
  assert.match(rule(".empty .muted"), /display: block/);
});
