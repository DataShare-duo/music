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
