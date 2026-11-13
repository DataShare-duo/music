const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const https = require("node:https");
const { boundedImage } = require("../cloudfunctions/personal/image");
test("avatar reader bounds bytes, rejects redirects and invalid formats without following user URLs", async () => {
  const original = https.get;
  let status = 200,
    length = 8,
    body = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  https.get = (url, options, cb) => {
    const req = new EventEmitter();
    req.destroy = (e) => req.emit("error", e);
    queueMicrotask(() => {
      const res = new EventEmitter();
      res.statusCode = status;
      res.headers = { "content-length": String(length) };
      let closed = false;
      res.destroy = (e) => {
        closed = true;
        if (e) res.emit("error", e);
      };
      cb(res);
      if (!closed) {
        res.emit("data", body);
        if (!closed) res.emit("end");
      }
    });
    return req;
  };
  try {
    await boundedImage("https://storage.example/file");
    status = 302;
    await assert.rejects(boundedImage("https://storage.example/file"));
    status = 200;
    length = 3 * 1024 * 1024;
    await assert.rejects(boundedImage("https://storage.example/file"));
    length = 0;
    body = Buffer.alloc(2 * 1024 * 1024 + 1);
    await assert.rejects(boundedImage("https://storage.example/file"));
    body = Buffer.from("<html>not image</html>");
    await assert.rejects(boundedImage("https://storage.example/file"));
    await assert.rejects(boundedImage("http://private/file"));
  } finally {
    https.get = original;
  }
});
