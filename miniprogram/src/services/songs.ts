import { api } from "./api";
import { SavedSong } from "./personal";
import { Song, Source } from "../types";
export interface RestoreResult {
  status: "available" | "pending" | "unavailable";
  song: Song | null;
  message: string;
}
export const sameSong = (
  a: SavedSong | null | undefined,
  b: SavedSong | null | undefined,
) =>
  !!a &&
  !!b &&
  a.source === b.source &&
  a.source_track_id === b.source_track_id;
export async function restoreSong(
  song: SavedSong,
  cancelled = () => false,
  progress?: (message: string) => void,
): Promise<Song> {
  for (let attempt = 0; attempt < 12; attempt++) {
    if (cancelled()) throw new Error("请求已取消");
    const view = await api.post<RestoreResult>(
      "/api/miniprogram/songs/restore",
      {
        source: song.source,
        source_track_id: song.source_track_id,
        query_hint: song.title.slice(0, 100),
      },
    );
    if (cancelled()) throw new Error("请求已取消");
    if (view.status === "available" && view.song && sameSong(view.song, song))
      return view.song;
    if (view.status !== "pending")
      throw new Error(view.message || "歌曲暂不可播放，记录仍保留");
    progress?.(view.message);
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("完整版仍在验证，请稍后重试，记录仍保留");
}
const decode = (x = "") => {
  try {
    return decodeURIComponent(x);
  } catch {
    return x;
  }
};
export function readShared(
  options: Record<string, string | undefined>,
): SavedSong | null {
  const source = options.s as Source,
    id = decode(options.t);
  const title = decode(options.q).trim().slice(0, 100),
    artist = decode(options.a).trim().slice(0, 200) || "未知歌手";
  if (
    !["soda", "netease", "kuwo"].includes(source) ||
    !/^[-\w]{1,100}$/.test(id) ||
    !title
  )
    return null;
  return {
    source,
    source_track_id: id,
    title,
    artist,
    cover_url: "",
    album: "",
    duration: 0,
  };
}
export function shareQuery(song: SavedSong): string {
  return (
    "s=" +
    encodeURIComponent(song.source) +
    "&t=" +
    encodeURIComponent(song.source_track_id) +
    "&q=" +
    encodeURIComponent(song.title.slice(0, 100)) +
    "&a=" +
    encodeURIComponent(song.artist.slice(0, 200))
  );
}
export function shareCard(song: SavedSong | null) {
  return song
    ? {
        title: (song.title + " · " + song.artist).slice(0, 100),
        path: "/pages/song/index?" + shareQuery(song),
        ...(song.cover_url.startsWith("https://")
          ? { imageUrl: song.cover_url }
          : {}),
      }
    : { title: "听见 · 音乐空间", path: "/pages/home/index" };
}
