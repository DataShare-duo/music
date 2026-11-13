import { Api, LyricsView, LyricLine } from "../types";
import { PlayerState } from "./player";
import { ApiError } from "./api";

export function activeLine(lines: LyricLine[], position: number): number {
  if (!Number.isFinite(position) || position < 0) return -1;
  let left = 0,
    right = lines.length - 1,
    result = -1;
  while (left <= right) {
    const mid = (left + right) >> 1;
    if (lines[mid].time_ms <= position * 1000) {
      result = mid;
      left = mid + 1;
    } else right = mid - 1;
  }
  return result;
}
export interface LyricState {
  status: "idle" | "loading" | LyricsView["status"];
  lines: LyricLine[];
  plainText: string;
  activeIndex: number;
  following: boolean;
  scrollRevision: number;
  message: string;
  sourceName: string;
  retryAfter: number;
}
export class LyricController {
  state: LyricState = {
    status: "idle",
    lines: [],
    plainText: "",
    activeIndex: -1,
    following: true,
    scrollRevision: 0,
    message: "尚未选择歌曲",
    sourceName: "",
    retryAfter: 0,
  };
  private visible = false;
  private generation = 0;
  private identity = "";
  private current: PlayerState | null = null;
  private followTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryUntil = 0;
  private cache = new Map<string, { view: LyricsView; expires: number }>();
  constructor(
    private api: Api,
    private changed: (state: LyricState) => void,
  ) {}
  private emit(): void {
    if (this.visible) this.changed({ ...this.state });
  }
  private key(snapshot: PlayerState): string {
    return snapshot.source + ":" + snapshot.sourceTrackId;
  }
  private clearTimers(): void {
    if (this.followTimer !== undefined) clearTimeout(this.followTimer);
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.followTimer = this.retryTimer = undefined;
  }
  resume(snapshot: PlayerState): void {
    this.visible = true;
    this.identity = "";
    this.update(snapshot);
  }
  pause(): void {
    this.visible = false;
    ++this.generation;
    this.clearTimers();
  }
  update(snapshot: PlayerState): void {
    this.current = snapshot;
    if (!this.visible) return;
    const identity =
      snapshot.sessionId +
      ":" +
      this.key(snapshot) +
      ":" +
      snapshot.linkVersion;
    if (identity !== this.identity) {
      this.identity = identity;
      ++this.generation;
      this.clearTimers();
      this.retryUntil = 0;
      Object.assign(this.state, {
        status: "idle",
        lines: [],
        plainText: "",
        activeIndex: -1,
        following: true,
        message: "",
        sourceName: "",
        retryAfter: 0,
      });
      if (!snapshot.sessionId) {
        this.state.message = snapshot.current
          ? "正在取得播放会话…"
          : "请先选择歌曲";
        this.emit();
        return;
      }
      if (!snapshot.source || !snapshot.sourceTrackId) {
        this.state.message = "请更新后端以获取实际音源歌词信息";
        this.emit();
        return;
      }
      const cached = this.cache.get(this.key(snapshot));
      if (cached && cached.expires > Date.now())
        this.apply({
          ...cached.view,
          retry_after:
            cached.view.status === "error"
              ? Math.max(1, Math.ceil((cached.expires - Date.now()) / 1000))
              : 0,
        });
      else void this.load();
    } else this.syncPosition();
  }
  private syncPosition(): void {
    const index =
      this.state.status === "synced"
        ? activeLine(this.state.lines, this.current?.position || 0)
        : -1;
    if (index === this.state.activeIndex) return;
    this.state.activeIndex = index;
    if (this.state.following) this.state.scrollRevision++;
    this.emit();
  }
  private apply(view: LyricsView): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryUntil = 0;
    this.state.status = view.status;
    this.state.lines = view.lines;
    this.state.plainText = view.plain_text;
    this.state.sourceName = view.source_name;
    this.state.message = view.message;
    this.state.retryAfter = view.retry_after;
    if (view.status === "error") {
      this.retryUntil = Date.now() + view.retry_after * 1000;
      this.retryTimer = setTimeout(
        () => {
          this.state.retryAfter = 0;
          this.retryUntil = 0;
          this.emit();
        },
        Math.max(0, view.retry_after * 1000),
      );
    }
    this.state.activeIndex = activeLine(
      view.lines,
      this.current?.position || 0,
    );
    this.state.scrollRevision++;
    this.emit();
  }
  private async load(): Promise<void> {
    const snapshot = this.current;
    if (
      !snapshot?.sessionId ||
      !this.visible ||
      !snapshot.source ||
      !snapshot.sourceTrackId
    )
      return;
    const token = ++this.generation,
      key = this.key(snapshot);
    this.state.status = "loading";
    this.state.message = "正在获取实际音源歌词…";
    this.emit();
    try {
      const view = await this.api.get<LyricsView>(
        "/api/miniprogram/playbacks/" + snapshot.sessionId + "/lyrics",
      );
      if (!this.visible || token !== this.generation) return;
      if (
        view.source !== snapshot.source ||
        view.source_track_id !== snapshot.sourceTrackId
      )
        throw new ApiError(
          "lyrics_identity_mismatch",
          "歌词音源信息不一致，未展示该结果",
        );
      const ttl =
        view.status === "error"
          ? view.retry_after * 1000
          : view.status === "synced" || view.status === "plain"
            ? 86400000
            : 21600000;
      this.cache.delete(key);
      this.cache.set(key, { view, expires: Date.now() + ttl });
      if (this.cache.size > 8)
        this.cache.delete(this.cache.keys().next().value as string);
      this.apply(view);
    } catch (error) {
      if (!this.visible || token !== this.generation) return;
      const message =
        error instanceof ApiError && error.code === "playback_expired"
          ? "播放会话已过期，请重新选择歌曲获取歌词"
          : error instanceof ApiError &&
              error.code === "lyrics_identity_mismatch"
            ? error.message
            : "歌词暂时获取失败，不影响音乐播放";
      const view: LyricsView = {
        status: "error",
        source: snapshot.source,
        source_name: snapshot.sourceName,
        source_track_id: snapshot.sourceTrackId,
        lines: [],
        plain_text: "",
        fetched_at: "",
        retry_after: 60,
        message,
      };
      this.cache.delete(key);
      this.cache.set(key, { view, expires: Date.now() + 60000 });
      if (this.cache.size > 8)
        this.cache.delete(this.cache.keys().next().value as string);
      this.apply(view);
    }
  }
  retry(): void {
    if (
      !this.visible ||
      this.state.status === "loading" ||
      Date.now() < this.retryUntil
    )
      return;
    void this.load();
  }
  manualStart(): void {
    if (this.state.status !== "synced") return;
    if (this.followTimer !== undefined) clearTimeout(this.followTimer);
    this.state.following = false;
    this.emit();
  }
  manualEnd(): void {
    if (this.state.following || !this.visible) return;
    if (this.followTimer !== undefined) clearTimeout(this.followTimer);
    this.followTimer = setTimeout(() => this.follow(), 3000);
  }
  manualScroll(): void {
    if (!this.state.following) this.manualEnd();
  }
  follow(): void {
    if (this.followTimer !== undefined) clearTimeout(this.followTimer);
    this.state.following = true;
    this.state.scrollRevision++;
    this.emit();
  }
}
