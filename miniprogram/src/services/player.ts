import { Api, Playback, Song } from "../types";
import { ApiError } from "./api";

export interface NativeAudio {
  src: string;
  title: string;
  singer: string;
  epname: string;
  coverImgUrl: string;
  duration: number;
  currentTime: number;
  paused: boolean;
  play(): void;
  pause(): void;
  stop(): void;
  seek(value: number): void;
  onPlay(cb: () => void): void;
  onPause(cb: () => void): void;
  onStop(cb: () => void): void;
  onEnded(cb: () => void): void;
  onError(cb: (error: { errCode?: number; errMsg?: string }) => void): void;
  onTimeUpdate(cb: () => void): void;
  onCanplay(cb: () => void): void;
  onWaiting(cb: () => void): void;
  onNext(cb: () => void): void;
  onPrev(cb: () => void): void;
}
export interface PlayerState {
  current: Song | null;
  playing: boolean;
  loading: boolean;
  failed: boolean;
  position: number;
  duration: number;
  sourceName: string;
  message: string;
  sessionId: string;
  linkVersion: number;
  events: string[];
}

export class NativePlayer {
  state: PlayerState = {
    current: null,
    playing: false,
    loading: false,
    failed: false,
    position: 0,
    duration: 0,
    sourceName: "",
    message: "选择已验证歌曲，开始真机链路测试",
    sessionId: "",
    linkVersion: 0,
    events: [],
  };
  private observers = new Set<(state: PlayerState) => void>();
  private handlers: Record<
    string,
    ((error?: { errCode?: number }) => void) | undefined
  > = {};
  private generation = 0;
  private session: Playback | null = null;
  private recovering = false;
  private counting = new Set<string>();
  private counted = new Set<string>();
  private countRetry = 0;
  private queue: Song[] = [];
  availabilityRevision = 0;
  private hidden = new Map<number, number>();
  constructor(
    private api: Api,
    private audio: NativeAudio,
    private id: () => Promise<string>,
  ) {
    // BackgroundAudioManager has on* but no off* API: register exactly once,
    // dispatch only to the current generation, never add listeners per song
    audio.onPlay(() => this.handlers.play?.());
    audio.onPause(() => this.handlers.pause?.());
    audio.onStop(() => this.handlers.stop?.());
    audio.onEnded(() => this.handlers.ended?.());
    audio.onTimeUpdate(() => this.handlers.update?.());
    audio.onCanplay(() => this.handlers.canplay?.());
    audio.onWaiting(() => this.handlers.waiting?.());
    audio.onError((error) => this.handlers.error?.(error));
    audio.onNext(() => this.handlers.next?.());
    audio.onPrev(() => this.handlers.prev?.());
  }

  subscribe(observer: (state: PlayerState) => void): () => void {
    this.observers.add(observer);
    observer(this.snapshot());
    return () => {
      this.observers.delete(observer);
    };
  }
  snapshot(): PlayerState {
    return { ...this.state, events: [...this.state.events] };
  }
  private emit(): void {
    for (const observer of this.observers) observer(this.snapshot());
  }
  private event(message: string): void {
    this.state.events = [
      new Date().toLocaleTimeString() + " " + message,
      ...this.state.events,
    ].slice(0, 40);
    this.emit();
  }
  lifecycle(visible: boolean): void {
    this.event(visible ? "小程序回到前台" : "小程序进入后台（播放器不停止）");
    if (visible && this.state.playing) void this.count();
  }
  acceptAvailable(songs: Song[], revision: number): Song[] {
    for (const song of songs)
      if ((this.hidden.get(song.id) ?? Infinity) <= revision)
        this.hidden.delete(song.id);
    return songs.filter((song) => !this.hidden.has(song.id));
  }
  private hide(id: number): void {
    this.hidden.set(id, ++this.availabilityRevision);
    this.queue = this.queue.filter((song) => song.id !== id);
  }
  private unbind(): void {
    this.handlers = {};
  }
  private valid(token: number, session: Playback): boolean {
    return (
      token === this.generation &&
      this.session?.id === session.id &&
      this.audio.src === session.audio_url
    );
  }
  private bind(token: number, session: Playback, resumeAt = 0): void {
    this.unbind();
    const guard = (callback: () => void) => () => {
      if (this.valid(token, session)) callback();
    };
    const play = guard(() => {
      this.state.playing = true;
      this.state.loading = false;
      this.state.message = "";
      this.event("收到实际 onPlay");
      void this.count();
    });
    const pause = guard(() => {
      this.state.playing = false;
      this.event("暂停");
    });
    const stop = guard(() => {
      this.state.playing = false;
      this.state.loading = false;
      this.event("停止");
    });
    const ended = guard(() => {
      this.state.playing = false;
      this.event("播放结束");
      void this.next(1, true);
    });
    const update = guard(() => {
      this.state.position = Number.isFinite(this.audio.currentTime)
        ? this.audio.currentTime
        : 0;
      this.state.duration = Number.isFinite(this.audio.duration)
        ? this.audio.duration
        : 0;
      this.emit();
      if (this.state.playing) void this.count();
    });
    let sought = false;
    const canplay = guard(() => {
      update();
      if (resumeAt > 0 && !sought && this.state.duration > 0) {
        sought = true;
        this.audio.seek(
          Math.min(resumeAt, Math.max(0, this.state.duration - 0.1)),
        );
      }
      this.event("音频可以播放");
    });
    const waiting = guard(() => {
      this.state.loading = true;
      this.state.message = "音频缓冲中";
      this.emit();
    });
    const error = (e: { errCode?: number }) => {
      if (!this.valid(token, session)) return;
      this.event("音频错误码 " + String(e.errCode ?? "unknown"));
      if (e.errCode === 10004) {
        this.fail(
          new ApiError(
            "audio_format_unsupported",
            "微信无法解码该音源，Web 可用性不受影响",
          ),
        );
        return;
      }
      void this.recover(token);
    };
    const next = guard(() => {
      void this.next(1);
    });
    const prev = guard(() => {
      void this.next(-1);
    });
    this.handlers = {
      play,
      pause,
      stop,
      ended,
      update,
      canplay,
      waiting,
      error: (e) => error(e || {}),
      next,
      prev,
    };
  }
  private assign(pb: Playback, token: number, resumeAt = 0): void {
    if (
      !pb.audio_url?.startsWith("https://") ||
      pb.transport !== "direct" ||
      pb.audio_kind !== "full"
    )
      throw new ApiError(
        "invalid_audio",
        "后端没有返回已验证的 HTTPS 直连完整版",
      );
    this.session = pb;
    this.state.sessionId = pb.id;
    this.state.linkVersion = pb.link_version;
    this.state.sourceName = pb.play_source_name || "";
    this.bind(token, pb, resumeAt);
    this.audio.title = this.state.current?.title || "听见音乐";
    this.audio.singer = this.state.current?.artist || "";
    this.audio.epname = this.state.current?.album || "";
    const cover = this.state.current?.cover_url || "";
    this.audio.coverImgUrl = cover.startsWith("https://") ? cover : "";
    this.audio.src = pb.audio_url; // Setting src starts native background playback
    this.event("已设置直连音源，等待实际 onPlay");
  }
  async play(song: Song, songs?: Song[]): Promise<void> {
    const token = ++this.generation;
    this.unbind();
    this.audio.stop();
    this.session = null;
    this.recovering = false;
    if (songs) this.queue = [...songs];
    Object.assign(this.state, {
      current: song,
      playing: false,
      loading: true,
      failed: false,
      position: 0,
      duration: 0,
      sourceName: "",
      sessionId: "",
      linkVersion: 0,
      message: "实时解析并检查直连完整版…",
    });
    this.emit();
    try {
      const requestId = await this.id();
      if (token !== this.generation) return;
      const path = "/api/miniprogram/songs/" + song.id + "/playbacks";
      let pb: Playback;
      try {
        pb = await this.api.post<Playback>(path, {
          client_request_id: requestId,
        });
      } catch (e) {
        if (token !== this.generation) return;
        if (!(e instanceof ApiError) || e.code !== "cloud_call_failed") throw e;
        pb = await this.api.post<Playback>(path, {
          client_request_id: requestId,
        });
      }
      if (token !== this.generation) return;
      this.assign(pb, token);
    } catch (e) {
      if (token === this.generation) this.fail(e);
    }
  }
  private fail(error: unknown): void {
    this.unbind();
    this.audio.pause();
    if (
      error instanceof ApiError &&
      error.code === "full_audio_unavailable" &&
      error.songId
    )
      this.hide(error.songId);
    this.state.failed = true;
    this.state.loading = false;
    this.state.playing = false;
    this.state.message =
      error instanceof Error
        ? error.message
        : "原生播放失败，请查看云托管日志和微信后台能力";
    this.event("播放未通过：" + this.state.message);
  }
  private async count(): Promise<void> {
    const session = this.session;
    if (
      !session ||
      !this.state.playing ||
      this.counting.has(session.id) ||
      this.counted.has(session.id) ||
      Date.now() < this.countRetry
    )
      return;
    this.counting.add(session.id);
    try {
      await this.api.post(
        "/api/miniprogram/playbacks/" + session.id + "/started",
      );
      this.counted.add(session.id);
      if (this.counted.size > 64)
        this.counted.delete(this.counted.values().next().value as string);
    } catch {
      this.countRetry = Date.now() + 5000;
      this.event("有效播放上报暂未成功，稍后重试");
    } finally {
      this.counting.delete(session.id);
    }
  }
  private async recover(token: number): Promise<void> {
    if (!this.session || this.recovering || this.state.failed) return;
    this.recovering = true;
    this.state.loading = true;
    this.state.playing = false;
    this.state.message = "正在检查当前音源，最多刷新一次…";
    this.emit();
    const previous = this.session;
    const resume = this.state.position;
    try {
      let pb = await this.api.get<Playback>(
        "/api/miniprogram/playbacks/" + previous.id,
      );
      if (token !== this.generation) return;
      if (pb.error)
        throw new ApiError(
          pb.error.code,
          pb.error.message,
          pb.song_id,
          pb.error.code === "full_audio_unavailable",
        );
      if (pb.link_version === previous.link_version) {
        if (pb.refresh_count >= 1)
          throw new ApiError(
            "refresh_exhausted",
            "本次播放刷新额度已用完，请重新选择歌曲",
          );
        pb = await this.api.post<Playback>(
          "/api/miniprogram/playbacks/" + previous.id + "/refresh",
          { expected_version: pb.link_version },
        );
      }
      if (token === this.generation) this.assign(pb, token, resume);
    } catch (e) {
      if (token === this.generation) this.fail(e);
    } finally {
      if (token === this.generation) this.recovering = false;
    }
  }
  async toggle(): Promise<void> {
    if (!this.state.current) return;
    if (
      this.state.failed ||
      !this.session ||
      this.audio.src !== this.session.audio_url
    ) {
      await this.play(this.state.current);
      return;
    }
    if (this.state.playing) this.audio.pause();
    else this.audio.play();
  }
  async next(direction: number, automatic = false): Promise<void> {
    if (!this.state.current || !this.queue.length) return;
    const index = this.queue.findIndex(
      (song) => song.id === this.state.current?.id,
    );
    if (automatic && index + direction >= this.queue.length) return;
    const target = (index + direction + this.queue.length) % this.queue.length;
    await this.play(this.queue[target]);
  }
  seek(position: number): void {
    if (!this.state.duration || !Number.isFinite(position)) return;
    this.audio.seek(
      Math.min(Math.max(position, 0), Math.max(0, this.state.duration - 0.1)),
    );
  }
  destroy(): void {
    ++this.generation;
    this.unbind();
    this.audio.stop();
    this.observers.clear();
  }
}
