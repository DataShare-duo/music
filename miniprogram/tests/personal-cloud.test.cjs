const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const source = fs.readFileSync(
  path.resolve(__dirname, "../src/services/personal.ts"),
  "utf8",
);
test("personal data uses the FastAPI container endpoint", () => {
  assert.ok(source.includes('"/api/miniprogram/personal"'));
  assert.ok(source.includes("api.post"));
  assert.ok(!source.includes("wx.cloud.callFunction"));
});

test("cloud initialization propagates the WeChat identity context", () => {
  const app = fs.readFileSync(
    path.resolve(__dirname, "../src/app.ts"),
    "utf8",
  );
  assert.ok(app.includes("traceUser: true"));
  assert.ok(!app.includes("traceUser: false"));
});
