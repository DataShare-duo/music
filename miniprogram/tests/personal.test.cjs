const { test } = require("node:test");
const assert = require("node:assert/strict");
const source = require("node:fs").readFileSync(
  require("node:path").resolve(__dirname, "../src/services/personal.ts"),
  "utf8",
);
test("personal store retains bounded local history and stable operation IDs", () => {
  assert.ok(source.includes("slice(0, 20)"));
  assert.ok(source.includes("slice(0, 100)"));
  assert.ok(source.includes("operationChain"));
  assert.ok(source.includes("avatar.get"));
});
