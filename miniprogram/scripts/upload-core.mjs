import fs from "node:fs/promises";
import path from "node:path";
import { createPrivateKey } from "node:crypto";
import { isIP } from "node:net";

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
    app.entryPagePath !== "pages/home/index" ||
    app.pages[0] !== app.entryPagePath ||
    !app.pages.includes("page/index/index")
  )
    throw new UploadError(
      "entry_invalid",
      "默认首页或旧体验版兼容路径未声明，停止上传",
    );
  for (const page of app.pages) {
    if (!/^(?:pages|page)\/[A-Za-z0-9_/-]+$/.test(page))
      throw new UploadError("entry_invalid", "页面路径无效");
    try {
      await fs.access(path.join(dist, page + ".js"));
      await fs.access(path.join(dist, page + ".wxml"));
    } catch {
      throw new UploadError("entry_invalid", "声明的页面未构建完成，停止上传");
    }
  }
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
  if (/\b(?:invalid ip|ip not allowed)\b|white.?list|白名单/i.test(message)) {
    // Only report an IP explicitly present in the WeChat error; never query a
    // third-party IP echo service or output the rest of the platform response
    const candidate = message.match(
      /(?:\bip\b|出口\s*IP|IP地址)\s*[:=]?\s*["']?([0-9.]{7,15})/i,
    )?.[1];
    const hint =
      candidate && isIP(candidate) === 4
        ? "（微信返回的出口 IP：" + candidate + "）"
        : "";
    return (
      "upload_ip_denied: 请将当前本机公网出口 IP 加入小程序代码上传白名单后重试" +
      hint
    );
  }
  if (/timeout|network|ENOTFOUND|ECONN|ETIMEDOUT/i.test(message))
    return "upload_network_failed: 微信上传网络连接失败，请检查网络后手动重试";
  if (/\b(?:private key|invalid key|signature)\b|签名/i.test(message))
    return "upload_key_rejected: 上传密钥或签名被拒绝，请核对 AppID 和上传密钥";
  if (/wxml|wxss|compile|编译|syntax/i.test(message)) {
    const source = message.match(
      /(?:\.\/)?((?:pages|components)\/[A-Za-z0-9_./-]+\.(?:wxml|wxss|js|json)):(\d+):(\d+):\s*([^\r\n]+)/,
    );
    const detail = source
      ? " " +
        source[1] +
        ":" +
        source[2] +
        ":" +
        source[3] +
        " " +
        source[4]
          .replace(/-----BEGIN[\s\S]*/g, "[redacted]")
          .replace(/https?:\/\/[^\s"']+/g, "[url]")
          .replace(/[A-Za-z0-9+/=_-]{40,}/g, "[token]")
          .slice(0, 180)
      : "";
    return (
      "upload_compile_failed: 微信官方模板校验未通过，请检查 WXML/WXSS" + detail
    );
  }
  const parsedCode = message.match(
    /(?:errcode|errCode|code)[\s\"':=]+(-?\d{1,8})/,
  );
  const code = String(
    error?.errCode ?? error?.code ?? parsedCode?.[1] ?? "unknown",
  )
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
    desc: "DataShare 听见原生全屏歌词开发版 · " + config.commit,
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
    stage: "native-lyrics",
    entryPagePath: "pages/home/index",
    devicePlaybackVerified: false,
    reviewSubmitted: false,
    published: false,
  };
}
