import type { SavedSong } from "./personal";
import { shareQuery } from "./songs";

export function enableSharing(): void {
  wx.showShareMenu?.({ menus: ["shareAppMessage"] });
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
export function isTimelinePreview(): boolean {
  try {
    return wx.getLaunchOptionsSync?.().scene === 1154;
  } catch {
    return false;
  }
}
