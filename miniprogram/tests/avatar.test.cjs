const { test } = require("node:test");
const assert = require("node:assert/strict");
const source = require("node:fs").readFileSync(
  require("node:path").resolve(__dirname, "../src/services/personal.ts"),
  "utf8",
);
test("avatar storage uses FastAPI data upload and does not use cloud storage", () => {
  assert.ok(source.includes('this.call("avatar.set"'));
  assert.ok(source.includes("base64: file.data"));
  assert.ok(!source.includes("wx.cloud.uploadFile"));
  assert.ok(!source.includes("wx.cloud.deleteFile"));
});
