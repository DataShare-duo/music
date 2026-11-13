export type Source = "soda" | "netease" | "kuwo";
export interface Song {
  id: number;
  source: Source;
  source_track_id: string;
  title: string;
  artist: string;
  album: string;
  cover_url: string;
  duration: number;
  audio_kind: string;
  play_source?: Source | null;
  play_source_name?: string | null;
}
export interface SongList {
  items: Song[];
  count: number;
  refreshing: boolean;
  stale: boolean;
  message: string | null;
  page: number;
  has_more: boolean;
  verification_pending: number;
}
export interface Playback {
  id: string;
  song_id: number;
  transport: "direct";
  state: string;
  audio_url: string | null;
  audio_kind: "full";
  link_version: number;
  refresh_count: number;
  expires_at: string;
  play_source_name: string | null;
  play_source?: Source | null;
  play_source_track_id?: string | null;
  audio_duration: number | null;
  error: { code: string; message: string } | null;
}
export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, data?: object): Promise<T>;
}
export const sourceNames: Record<Source, string> = {
  soda: "汽水音乐",
  netease: "网易云音乐",
  kuwo: "酷我音乐",
};
export function time(value: number): string {
  const seconds = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

export interface LyricLine {
  time_ms: number;
  text: string;
}
export interface LyricsView {
  status: "synced" | "plain" | "unavailable" | "instrumental" | "error";
  source: string;
  source_name: string;
  source_track_id: string;
  lines: LyricLine[];
  plain_text: string;
  fetched_at: string;
  retry_after: number;
  message: string;
}
