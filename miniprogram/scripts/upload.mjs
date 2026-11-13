import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  UploadError,
  validateUpload,
  uploadValidated,
  safeFailure,
} from "./upload-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const metadata = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = git("rev-parse", "--short=8", "HEAD");
  if (git("status", "--porcelain", "--untracked-files=normal"))
    throw new UploadError(
      "uncommitted_changes",
      "请先提交源码并通过测试后上传，确保版本对应可追踪提交",
    );
  const config = await validateUpload({
    projectDir: root,
    keyPath: process.env.WECHAT_UPLOAD_KEY_PATH,
    version: metadata.version + "-" + commit,
    commit,
    robot: Number(process.env.WECHAT_UPLOAD_ROBOT || "1"),
  });
  console.log(
    "Uploading native verification build, AppID " +
      config.appId +
      ", version " +
      config.version,
  );
  const require = createRequire(import.meta.url);
  // The SDK can log platform responses; do not relay raw errors or credentials
  const originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
  };
  let result;
  try {
    console.log = console.error = console.warn = console.info = () => {};
    result = await uploadValidated(require("miniprogram-ci"), config);
  } finally {
    Object.assign(console, originalConsole);
  }
  await fs.mkdir(path.join(root, ".local"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".local", "last-upload.json"),
    JSON.stringify({ ...result, time: new Date().toISOString() }, null, 2) +
      "\n",
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(safeFailure(error));
  // SDK worker pools may survive a rejected upload; terminate this helper only
  process.stderr.write("", () => process.exit(1));
}
