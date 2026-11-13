const https = require("node:https");
function boundedImage(url) {
  let deadline;
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error("invalid image"));
      return;
    }
    // URLs are issued by the server SDK for an owner-scoped cloud file, never supplied HTTP URLs.
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      reject(new Error("invalid image"));
      return;
    }
    const req = https.get(parsed, { timeout: 8000 }, (res) => {
      if (
        res.statusCode !== 200 ||
        Number(res.headers["content-length"] || 0) > 2 * 1024 * 1024
      ) {
        res.destroy();
        reject(new Error("image too large or inaccessible"));
        return;
      }
      let size = 0;
      const chunks = [];
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          res.destroy(new Error("image too large"));
        } else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("image interrupted")));
      res.on("end", () => {
        const b = Buffer.concat(chunks);
        const jpeg = b[0] === 255 && b[1] === 216 && b[2] === 255;
        const png = b
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const webp =
          b.toString("ascii", 0, 4) === "RIFF" &&
          b.toString("ascii", 8, 12) === "WEBP";
        if (!jpeg && !png && !webp) reject(new Error("image format"));
        else resolve();
      });
    });
    deadline = setTimeout(() => req.destroy(new Error("image timeout")), 8000);
    req.on("timeout", () => req.destroy(new Error("image timeout")));
    req.on("error", reject);
  }).finally(() => clearTimeout(deadline));
}
module.exports = { boundedImage };
