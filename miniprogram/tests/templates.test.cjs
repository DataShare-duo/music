const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const checker = () =>
  import(
    pathToFileURL(path.resolve(__dirname, "../scripts/template-check.mjs")).href
  );

test("WXML attributes use real operators rather than HTML entity expressions", async () => {
  const { checkTemplate } = await checker();
  const source = await fs.readFile(
    path.resolve(__dirname, "../src/pages/verify/index.wxml"),
    "utf8",
  );
  assert.doesNotThrow(() => checkTemplate(source, "verify"));
  assert.ok(source.includes("{{page <= 1 || loading}}"));
  assert.ok(
    source.includes("{{!player.title || (player.loading && !player.failed)}}"),
  );
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
