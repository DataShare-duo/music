import type { MusicApp } from "../app";
import { openPlayer } from "../routes";
import { sourceNames } from "../types";
import type { Song } from "../types";
import type { Entry, PersonalStore, SavedSong } from "../services/personal";
import { restoreSong, sameSong } from "../services/songs";

export type LibraryKind = "favorite" | "like" | "recent";
export const libraryLabels = { favorite: "收藏", like: "喜欢", recent: "最近播放" };
export interface LibraryRow extends Entry {
  song: SavedSong;
  timeText: string;
  sourceLabel: string;
  availability: string;
}
export const emptyLibrary = () => ({
  kind: "favorite" as LibraryKind,
  items: [] as LibraryRow[],
  page: 1,
  pages: 1,
  hasMore: false,
  total: 0,
  message: "",
  loading: false,
});
export type LibraryView = ReturnType<typeof emptyLibrary>;
interface Player {
  state: { current: Song | null };
  play(song: Song, queue: Song[]): Promise<void>;
  toggle(): Promise<void>;
}

// Shared by the inline personal tabs and the retained legacy library route.
export class PersonalLibrary {
  state = emptyLibrary();
  private store: PersonalStore | null = null;
  private unsubscribe: (() => void) | null = null;
  private visible = false;
  private generation = 0;
  private pendingKey = "";
  private rowStatus: Record<string, string> = {};
  private pages: Record<LibraryKind, number> = { favorite: 1, like: 1, recent: 1 };
  constructor(
    private update: (view: LibraryView) => void,
    private restore = restoreSong,
    private player: () => Player | null = () => getApp<MusicApp>().player,
    private open = openPlayer,
  ) {}
  show(store: PersonalStore | null) {
    this.unsubscribe?.();
    this.store = store;
    this.visible = true;
    this.unsubscribe = store?.subscribe(() => this.render()) || null;
    this.render();
  }
  hide() {
    this.visible = false;
    ++this.generation;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.state.loading = false;
    this.state.message = "";
  }
  select(kind: string) {
    if (!["favorite", "like", "recent"].includes(kind) || this.state.kind === kind) return;
    ++this.generation;
    this.state.kind = kind as LibraryKind;
    this.state.loading = false;
    this.state.message = "";
    this.render();
  }
  private entries(): Entry[] {
    const s = this.store?.data;
    return (s ? (this.state.kind === "recent" ? s.recent.items : s[this.state.kind]) : [])
      .filter((row) => !!row?.song);
  }
  private render() {
    const all = this.entries(), kind = this.state.kind;
    if (this.state.loading && this.pendingKey && !all.some((row) => row.key === this.pendingKey)) {
      ++this.generation;
      this.pendingKey = "";
      this.state.loading = false;
      this.state.message = "";
    }
    const pages = Math.max(1, Math.ceil(all.length / 20));
    const page = Math.min(this.pages[kind], pages);
    this.pages[kind] = page;
    Object.assign(this.state, {
      page, pages, total: all.length, hasMore: page < pages,
      items: all.slice((page - 1) * 20, page * 20).map((row) => ({
        ...row, song: row.song!,
        timeText: Number.isFinite(row.at) ? new Date(row.at).toLocaleString() : "",
        sourceLabel: (kind === "recent" ? row.sourceName : "") || sourceNames[row.song!.source],
        availability: this.rowStatus[row.key] || "",
      })),
    });
    this.update({ ...this.state });
  }
  previous() {
    if (this.state.page <= 1) return;
    ++this.generation;
    this.state.loading = false;
    this.state.message = "";
    this.pages[this.state.kind] = this.state.page - 1;
    this.render();
  }
  next() {
    if (!this.state.hasMore) return;
    ++this.generation;
    this.state.loading = false;
    this.state.message = "";
    this.pages[this.state.kind] = this.state.page + 1;
    this.render();
  }
  async play(key: string) {
    const row = this.entries().find((item) => item.key === key);
    const player = this.player();
    if (!this.visible || !row?.song || !player) return;
    const generation = ++this.generation;
    const current = () => this.visible && generation === this.generation &&
      this.entries().some((item) => item.key === row.key);
    this.pendingKey = row.key;
    this.state.loading = true;
    this.state.message = "正在重新验证歌曲…";
    this.render();
    try {
      if (sameSong(row.song, player.state.current)) {
        await player.toggle();
      } else {
        const song = await this.restore(row.song, () => !current(), (message) => {
          if (!current()) return;
          this.state.message = message;
          this.render();
        });
        if (!current()) return;
        delete this.rowStatus[row.key];
        await player.play(song, [song]);
      }
      if (current()) {
        this.state.message = "";
        this.open();
      }
    } catch (e) {
      if (current()) {
        this.rowStatus[row.key] = "暂不可播放，记录已保留 · 点击重试";
        this.state.message = e instanceof Error ? e.message : "歌曲暂不可播放，记录仍保留";
      }
    } finally {
      if (current()) {
        this.state.loading = false;
        this.render();
      }
    }
  }
  async remove(key: string) {
    const kind = this.state.kind;
    const row = this.entries().find((item) => item.key === key);
    if (!row?.song) return;
    try {
      if (kind === "recent") await this.store?.remove("recent", key);
      else await this.store?.mark(kind, row.song, false);
    } catch {}
  }
  clearRecent() {
    if (this.state.kind === "recent") void this.store?.clear("recent");
  }
}
