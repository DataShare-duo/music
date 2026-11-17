const MAX_AVATAR = 2 * 1024 * 1024;
let sequence = 0;

export function avatarMime(base64: string): string {
  const bytes = new Uint8Array(wx.base64ToArrayBuffer(base64.slice(0, 32)));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n))
    return "image/png";
  if ([82, 73, 70, 70].every((n, i) => bytes[i] === n) &&
      [87, 69, 66, 80].every((n, i) => bytes[i + 8] === n))
    return "image/webp";
  throw new Error("头像必须是 JPEG、PNG 或 WebP 图片");
}

export async function avatarFile(dataUrl: string, userKey: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(userKey)) throw new Error("头像用户身份无效");
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  const size = match ? match[2].length / 4 * 3 -
    (match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0) : 0;
  if (!match || size > MAX_AVATAR || match[2].length > Math.ceil(MAX_AVATAR / 3) * 4 ||
      match[2].length % 4 || avatarMime(match[2]) !== match[1])
    throw new Error("云端头像格式无效，请重新选择头像");
  const extension = match[1].split("/")[1];
  const filePath = `${wx.env.USER_DATA_PATH}/music-avatar-${userKey}-${Date.now()}-${++sequence}.${extension}`;
  try {
    await new Promise<void>((resolve, reject) => wx.getFileSystemManager().writeFile({
      filePath, data: match[2], encoding: "base64",
      success: () => resolve(), fail: () => reject(new Error("头像缓存保存失败，请检查手机存储后重试")),
    }));
  } catch (error) {
    await removeAvatarFile(filePath);
    throw error;
  }
  return filePath;
}

export async function removeAvatarFile(filePath: string): Promise<void> {
  const root = wx.env?.USER_DATA_PATH;
  if (!root || !filePath.startsWith(root + "/")) return;
  const filename = filePath.slice(root.length + 1);
  if (!/^music-avatar-[a-f0-9]{64}-\d+-\d+\.(?:jpeg|png|webp)$/.test(filename)) return;
  await new Promise<void>((resolve) => wx.getFileSystemManager().unlink({
    filePath, success: () => resolve(), fail: () => resolve(),
  }));
}
