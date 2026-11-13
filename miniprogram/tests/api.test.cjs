const { test } = require("node:test");
const assert = require("node:assert/strict");
global.wx = {
  cloud: { callContainer: async () => ({ statusCode: 200, data: {} }) },
};
const { createApi, ApiError, uuid } = require("../dist/services/api.js");
const { config } = require("../dist/config.js");

test("all metadata calls use cloud container with correct routing and no public URL", async () => {
  const seen = [];
  const api = createApi(async (options) => {
    seen.push(options);
    return { statusCode: 200, data: '{"ok":true}' };
  });
  assert.deepEqual(await api.get("/api/health"), { ok: true });
  await api.post("/api/miniprogram/songs/1/playbacks", {
    client_request_id: "id",
  });
  assert.equal(seen[0].config.env, config.env);
  assert.equal(seen[0].header["X-WX-SERVICE"], "music");
  assert.equal(seen[1].method, "POST");
  assert.equal(seen[1].timeout, 60000);
  await assert.rejects(api.get("https://arbitrary.example/api"), {
    code: "invalid_path",
  });
});
test("error contract preserves hidden state but network errors never leak platform details", async () => {
  const api = createApi(async () => ({
    statusCode: 409,
    data: {
      error: {
        code: "full_audio_unavailable",
        message: "稍后复检",
        song_id: 3,
        hidden: true,
      },
    },
  }));
  await assert.rejects(
    api.get("/api/home"),
    (e) => e instanceof ApiError && e.songId === 3 && e.hidden,
  );
  const offline = createApi(async () => {
    throw new Error("sensitive platform error");
  });
  await assert.rejects(
    offline.get("/api/home"),
    (e) => e.code === "cloud_call_failed" && !e.message.includes("sensitive"),
  );
  await assert.rejects(
    createApi(async () => ({ statusCode: 200, data: "html" })).get("/api/home"),
    { code: "invalid_response" },
  );
});
test("UUID v4 uses supplied secure random bytes", () => {
  assert.match(
    uuid(new Uint8Array(16).buffer),
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  assert.throws(() => uuid(new Uint8Array(3).buffer));
});
