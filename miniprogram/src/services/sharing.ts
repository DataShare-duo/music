import type { SavedSong } from "./personal";
import { shareQuery } from "./songs";

export function enableSharing(): void {
  wx.showShareMenu?.({ menus: ["shareAppMessage", "shareTimeline"] });
}
export function timelineCard(song: SavedSong | null) {
  return {
    title: song
      ? song.title + " · " + song.artist
      : "听见 · 给生活留一点音乐的时间",
    query: song ? shareQuery(song) : "",
    ...(song?.cover_url?.startsWith("https://")
      ? { imageUrl: song.cover_url }
      : {}),
  };
}
export function shareToTimeline(): void {
  enableSharing();
  wx.showModal({
    title: "分享到朋友圈",
    content:
      "请点击右上角「···」，选择「分享到朋友圈」\n将分享当前歌曲，不包含个人资料或临时音频链接",
    showCancel: false,
    confirmText: "知道了",
  });
}

export function isTimelinePreview(): boolean {
  try {
    return wx.getLaunchOptionsSync?.().scene === 1154;
  } catch {
    return false;
  }
}
