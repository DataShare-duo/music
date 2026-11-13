const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { generateKeyPairSync } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const core = () =>
  import(
    pathToFileURL(path.resolve(__dirname, "../scripts/upload-core.mjs")).href
  );
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "music-native-upload-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectDir = path.join(root, "repo", "miniprogram");
  await fs.mkdir(path.join(projectDir, "dist"), { recursive: true });
  const config = {
    appid: "wxe1af0ed55ed257b7",
    miniprogramRoot: "dist/",
    compileType: "miniprogram",
  };
  await fs.writeFile(
    path.join(projectDir, "project.config.json"),
    JSON.stringify(config),
  );
  await fs.writeFile(
    path.join(projectDir, "dist/app.json"),
    JSON.stringify({
      pages: ["pages/verify/index"],
      requiredBackgroundModes: ["audio"],
    }),
  );
  const keyPath = path.join(root, "outside.key");
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await fs.writeFile(keyPath, pair.privateKey);
  return {
    projectDir,
    keyPath,
    version: "0.1.0-12345678",
    commit: "12345678",
    robot: 1,
  };
}
test("preflight rejects missing/in-repository/private wrong keys and incomplete builds", async (t) => {
  const { validateUpload } = await core();
  const options = await fixture(t);
  await assert.rejects(validateUpload({ ...options, keyPath: undefined }), {
    code: "key_missing",
  });
  await assert.rejects(
    validateUpload({ ...options, keyPath: "relative.key" }),
    { code: "key_path" },
  );
  await fs.copyFile(
    options.keyPath,
    path.join(options.projectDir, "inside.key"),
  );
  await assert.rejects(
    validateUpload({
      ...options,
      keyPath: path.join(options.projectDir, "inside.key"),
    }),
    { code: "key_in_repo" },
  );
  const invalid = path.join(path.dirname(options.keyPath), "invalid.key");
  await fs.writeFile(invalid, "not a key");
  await assert.rejects(validateUpload({ ...options, keyPath: invalid }), {
    code: "key_invalid",
  });
  await fs.rm(path.join(options.projectDir, "dist/app.json"));
  await assert.rejects(validateUpload(options), { code: "build_missing" });
});
test("preflight enforces correct app, version and refuses secrets in build", async (t) => {
  const { validateUpload } = await core();
  const options = await fixture(t);
  await assert.rejects(validateUpload({ ...options, version: "other" }), {
    code: "version_invalid",
  });
  await assert.rejects(validateUpload({ ...options, robot: 31 }), {
    code: "robot_invalid",
  });
  await fs.writeFile(
    path.join(options.projectDir, "dist/secret.pem"),
    "private",
  );
  await assert.rejects(validateUpload(options), { code: "unsafe_build" });
  await fs.rm(path.join(options.projectDir, "dist/secret.pem"));
  await fs.writeFile(
    path.join(options.projectDir, "project.config.json"),
    JSON.stringify({ appid: "wrong" }),
  );
  await assert.rejects(validateUpload(options), { code: "project_config" });
});
test("upload only writes development build and never submits review or publish", async (t) => {
  const { validateUpload, uploadValidated } = await core();
  const options = await fixture(t);
  const config = await validateUpload(options);
  const seen = [];
  const ci = {
    Project: class {
      constructor(p) {
        seen.push(p);
      }
    },
    upload: async (p) => seen.push(p),
    submitAudit: () => assert.fail("review forbidden"),
    release: () => assert.fail("publish forbidden"),
  };
  const result = await uploadValidated(ci, config);
  assert.equal(result.status, "uploaded");
  assert.equal(result.devicePlaybackVerified, false);
  assert.equal(result.reviewSubmitted, false);
  assert.equal(result.published, false);
  assert.equal(seen[0].appid, "wxe1af0ed55ed257b7");
  assert.equal(seen[1].robot, 1);
  const failed = {
    ...ci,
    upload: async () => {
      throw new Error("private-secret");
    },
  };
  await assert.rejects(uploadValidated(failed, config));
});
test("errors are classified without exposing keys, raw error messages or identifiers", async () => {
  const { safeFailure, UploadError } = await core();
  assert.match(
    safeFailure(new Error("IP not in whitelist with sensitive key")),
    /upload_ip_denied/,
  );
  assert.match(
    safeFailure(new Error("ETIMEDOUT sensitive")),
    /upload_network_failed/,
  );
  assert.ok(
    !safeFailure(new Error("raw-sensitive-secret")).includes(
      "raw-sensitive-secret",
    ),
  );
  assert.match(
    safeFailure(new Error("miniprogram-ci script unexpected failure")),
    /upload_failed/,
  );
  assert.match(
    safeFailure(new Error("wxml compile failed")),
    /upload_compile_failed/,
  );
  assert.match(
    safeFailure(new UploadError("key_missing", "请设置路径")),
    /key_missing/,
  );
});
