import fs from "node:fs/promises";
import path from "node:path";
import { createPrivateKey } from "node:crypto";

export const APP_ID = "wxe1af0ed55ed257b7";
export class UploadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const isInside = (parent, file) => {
  const relative = path.relative(parent, file);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};

export async function validateUpload({
  projectDir,
  keyPath,
  version,
  commit,
  robot = 1,
}) {
  if (!keyPath)
    throw new UploadError(
      "key_missing",
      "请设置 WECHAT_UPLOAD_KEY_PATH 为仓库外的上传私钥路径，不要使用 AppSecret",
    );
  if (!path.isAbsolute(keyPath))
    throw new UploadError("key_path", "上传私钥必须使用绝对路径");
  const project = JSON.parse(
    await fs.readFile(path.join(projectDir, "project.config.json"), "utf8"),
  );
  if (
    project.appid !== APP_ID ||
    project.miniprogramRoot !== "dist/" ||
    project.compileType !== "miniprogram"
  )
    throw new UploadError(
      "project_config",
      "AppID 或原生构建目录与预期不符，停止上传",
    );
  const dist = path.join(projectDir, "dist");
  let app;
  try {
    app = JSON.parse(await fs.readFile(path.join(dist, "app.json"), "utf8"));
  } catch {
    throw new UploadError(
      "build_missing",
      "原生构建缺失或无效，请先运行 npm test",
    );
  }
  if (!app.requiredBackgroundModes?.includes("audio") || !app.pages?.length)
    throw new UploadError("build_invalid", "构建未声明后台音频或原生页面");
  if (
    !/^[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{7,12}$/.test(version) ||
    !version.endsWith(commit)
  )
    throw new UploadError(
      "version_invalid",
      "上传版本必须对应已提交的 Git 版本",
    );
  if (!Number.isInteger(robot) || robot < 1 || robot > 30)
    throw new UploadError("robot_invalid", "上传机器人编号必须为 1～30");
  let realKey;
  try {
    realKey = await fs.realpath(keyPath);
  } catch {
    throw new UploadError("key_missing", "上传私钥文件不存在或不可读");
  }
  const repo = await fs.realpath(path.resolve(projectDir, ".."));
  if (isInside(repo, realKey))
    throw new UploadError("key_in_repo", "上传私钥必须放在仓库外");
  try {
    const key = createPrivateKey(await fs.readFile(realKey));
    if (key.asymmetricKeyType !== "rsa") throw new Error("not RSA");
  } catch {
    throw new UploadError(
      "key_invalid",
      "文件不是可用的 RSA 上传私钥，不输出私钥内容",
    );
  }
  let files = 0;
  async function inspect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new UploadError("unsafe_build", "构建目录不允许符号链接");
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else {
        files++;
        if (/\.(key|pem|env|map)$/i.test(file))
          throw new UploadError("unsafe_build", "构建目录含私有或调试文件");
        if (/\.(js|json|wxml|wxss)$/i.test(file)) {
          const text = await fs.readFile(file, "utf8");
          if (
            /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) ||
            /<web-view\b/i.test(text)
          )
            throw new UploadError(
              "unsafe_build",
              "构建含私钥或 web-view，停止上传",
            );
        }
      }
    }
  }
  await inspect(dist);
  return {
    appId: APP_ID,
    projectDir,
    keyPath: realKey,
    version,
    commit,
    robot,
    files,
  };
}

export function safeFailure(error) {
  if (error instanceof UploadError) return error.code + ": " + error.message;
  const message = typeof error?.message === "string" ? error.message : "";
  if (/ip|whitelist|白名单/i.test(message))
    return "upload_ip_denied: 请将当前本机公网出口 IP 加入小程序代码上传白名单后重试";
  if (/timeout|network|ENOTFOUND|ECONN|ETIMEDOUT/i.test(message))
    return "upload_network_failed: 微信上传网络连接失败，请检查网络后手动重试";
  if (/key|signature|签名/i.test(message))
    return "upload_key_rejected: 上传密钥或签名被拒绝，请核对 AppID 和上传密钥";
  const code = String(error?.errCode ?? error?.code ?? "unknown")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 40);
  return (
    "upload_failed (" +
    code +
    "): 微信上传未成功，未提交审核或发布，不输出原始异常以保护密钥"
  );
}

export async function uploadValidated(ci, config) {
  const project = new ci.Project({
    appid: config.appId,
    type: "miniProgram",
    projectPath: config.projectDir,
    privateKeyPath: config.keyPath,
    ignores: [
      "node_modules/**/*",
      "src/**/*",
      "tests/**/*",
      "scripts/**/*",
      ".local/**/*",
      "**/*.key",
      "**/*.pem",
    ],
  });
  await ci.upload({
    project,
    version: config.version,
    desc: "DataShare 原生直连/后台播放验证版 · " + config.commit,
    robot: config.robot,
    setting: { es6: true, minify: true },
    onProgressUpdate: () => {},
  });
  return {
    status: "uploaded",
    appId: config.appId,
    version: config.version,
    commit: config.commit,
    robot: config.robot,
    stage: "verification",
    devicePlaybackVerified: false,
    reviewSubmitted: false,
    published: false,
  };
}
