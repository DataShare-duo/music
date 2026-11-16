const { test } = require("node:test");
const assert = require("node:assert/strict");
const source = require("node:fs").readFileSync(
  require("node:path").resolve(__dirname, "../src/services/personal.ts"),
  "utf8",
);
test("personal data uses the FastAPI container endpoint", () => {
  assert.ok(source.includes('"/api/miniprogram/personal"'));
  assert.ok(source.includes("api.post"));
  assert.ok(!source.includes("wx.cloud.callFunction"));
});
