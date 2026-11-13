import { shareCard, shareQuery, readShared } from "../../services/songs";
import { routes } from "../../routes";
import { MusicApp } from "../../app";
import { api } from "../../services/api";
import { LyricController, LyricState } from "../../services/lyrics";
import { LyricLine, time } from "../../types";
import { PlayerState } from "../../services/player";
import { openHome } from "../../routes";

Page({
  data: {
    title: "听见",
    favorite: false,
    liked: false,
    markLoading: false,
    personalError: "",
    artist: "",
    sourceName: "",
    coverUrl: "",
    coverBroken: false,
    hasSong: false,
    playing: false,
    loading: false,
    failed: false,
    queueEnded: false,
    message: "",
    position: 0,
    duration: 0,
    positionText: "0:00",
    durationText: "0:00",
    statusTop: 24,
    headerRight: 100,
    lyricStatus: "idle",
    lyricLines: [] as LyricLine[],
    plainText: "",
    lyricMessage: "",
    lyricSource: "",
    activeIndex: -1,
    following: true,
    retryAfter: 0,
    lyricScrollTop: 0,
  },
  lyrics: null as LyricController | null,
  unsubscribe: null as (() => void) | null,
  visible: false,
  personalUnsubscribe: null as (() => void) | null,
  lastLines: null as LyricLine[] | null,
  scrollRevision: -1,
  scrollGeneration: 0,
  onLoad(options: Record<string, string | undefined> = {}) {
    const shared = readShared(options);
    if (shared) {
      wx.redirectTo({ url: "/" + routes.song + "?" + shareQuery(shared) });
      return;
    }
    wx.showShareMenu?.({ menus: ["shareAppMessage", "shareTimeline"] });
    try {
      const info = wx.getWindowInfo
        ? wx.getWindowInfo()
        : wx.getSystemInfoSync();
      const menu = wx.getMenuButtonBoundingClientRect();
      this.setData({
        statusTop: info.statusBarHeight || 24,
        headerRight: Math.max(100, info.windowWidth - menu.left + 12),
      });
    } catch {
      /* safe default for unusual devices */
    }
    this.lyrics = new LyricController(api, (state) => this.renderLyrics(state));
  },
  onShow() {
    this.visible = true;
    this.personalUnsubscribe?.();
    const personal = getApp<MusicApp>().personal;
    this.personalUnsubscribe =
      personal?.subscribe((state) => {
        const current = getApp<MusicApp>().player?.state.current;
        this.setData({
          favorite: current ? personal.has("favorite", current) : false,
          liked: current ? personal.has("like", current) : false,
          personalError: state.error,
        });
      }) || null;
    void personal?.sync();
    const player = getApp<MusicApp>().player;
    if (!player) {
      this.setData({
        lyricMessage: getApp<MusicApp>().startupError || "播放器尚未初始化",
      });
      return;
    }
    this.renderPlayer(player.snapshot());
    this.lyrics?.resume(player.snapshot());
    this.unsubscribe?.();
    this.unsubscribe = player.subscribe((state) => {
      this.renderPlayer(state);
      this.lyrics?.update(state);
    });
  },
  onHide() {
    this.visible = false;
    this.personalUnsubscribe?.();
    this.personalUnsubscribe = null;
    ++this.scrollGeneration;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lyrics?.pause();
  },
  onUnload() {
    this.visible = false;
    ++this.scrollGeneration;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lyrics?.pause();
  },
  renderPlayer(state: PlayerState) {
    const personal = getApp<MusicApp>().personal;
    this.setData({
      favorite: state.current
        ? !!personal?.has("favorite", state.current)
        : false,
      liked: state.current ? !!personal?.has("like", state.current) : false,
    });
    const cover = state.current?.cover_url || "";
    const coverUrl = cover.startsWith("https://") ? cover : "";
    this.setData({
      title: state.current?.title || "听见",
      artist: state.current?.artist || "",
      sourceName: state.sourceName,
      hasSong: !!state.current,
      playing: state.playing,
      loading: state.loading,
      failed: state.failed,
      queueEnded: state.queueEnded,
      message: state.message,
      position: state.position,
      duration: state.duration,
      positionText: time(state.position),
      durationText: time(state.duration),
      ...(coverUrl !== this.data.coverUrl
        ? { coverUrl, coverBroken: false }
        : {}),
    });
  },
  renderLyrics(state: LyricState) {
    const newLines = this.lastLines !== state.lines;
    this.lastLines = state.lines;
    const move =
      state.following && state.scrollRevision !== this.scrollRevision;
    this.scrollRevision = state.scrollRevision;
    this.setData(
      {
        lyricStatus: state.status,
        plainText: state.plainText,
        lyricMessage: state.message,
        lyricSource: state.sourceName,
        activeIndex: state.activeIndex,
        following: state.following,
        retryAfter: state.retryAfter,
        ...(newLines ? { lyricLines: state.lines } : {}),
      },
      () => {
        if (move) this.centerLine(state.activeIndex);
      },
    );
  },
  centerLine(index: number) {
    if (index < 0 || !this.visible) return;
    const token = ++this.scrollGeneration;
    wx.nextTick(() => {
      if (
        !this.visible ||
        token !== this.scrollGeneration ||
        !this.data.following ||
        this.data.activeIndex !== index
      )
        return;
      const query = wx.createSelectorQuery().in(this);
      query.select(".lyric-scroll").boundingClientRect();
      query.select(".lyric-scroll").scrollOffset();
      query.select("#lyric-line-" + index).boundingClientRect();
      query.exec((results) => {
        if (
          !this.visible ||
          token !== this.scrollGeneration ||
          !this.data.following ||
          this.data.activeIndex !== index
        )
          return;
        const box =
          results[0] as WechatMiniprogram.BoundingClientRectCallbackResult | null;
        const offset = results[1] as { scrollTop: number } | null;
        const row =
          results[2] as WechatMiniprogram.BoundingClientRectCallbackResult | null;
        if (box && offset && row)
          this.setData({
            lyricScrollTop: Math.max(
              0,
              offset.scrollTop +
                row.top -
                box.top -
                (box.height - row.height) / 2,
            ),
          });
      });
    });
  },
  back() {
    wx.navigateBack({
      fail() {
        openHome();
      },
    });
  },
  coverFailed() {
    this.setData({ coverBroken: true });
  },
  toggle() {
    void getApp<MusicApp>().player?.toggle();
  },
  previous() {
    void getApp<MusicApp>().player?.next(-1);
  },
  next() {
    void getApp<MusicApp>().player?.next(1);
  },
  seek(event: WechatMiniprogram.SliderChange) {
    getApp<MusicApp>().player?.seek(event.detail.value);
  },
  retryLyrics() {
    this.lyrics?.retry();
  },
  manualStart() {
    ++this.scrollGeneration;
    this.lyrics?.manualStart();
  },
  manualEnd() {
    this.lyrics?.manualEnd();
  },
  manualScroll() {
    this.lyrics?.manualScroll();
  },
  followLyrics() {
    this.lyrics?.follow();
  },
  async toggleMark(event: WechatMiniprogram.TouchEvent) {
    const kind = event.currentTarget.dataset.kind as "favorite" | "like";
    if (!["favorite", "like"].includes(kind) || this.data.markLoading) return;
    const app = getApp<MusicApp>(),
      song = app.player?.state.current,
      personal = app.personal;
    if (!song || !personal) return;
    this.setData({ markLoading: true });
    try {
      await personal.mark(kind, song, !personal.has(kind, song));
    } catch (e) {
      this.setData({
        personalError: e instanceof Error ? e.message : "保存失败",
      });
    } finally {
      this.setData({ markLoading: false });
    }
  },
  onShareAppMessage() {
    return shareCard(getApp<MusicApp>().player?.state.current || null);
  },
  onShareTimeline() {
    const song = getApp<MusicApp>().player?.state.current;
    return {
      title: song ? song.title + " · " + song.artist : "听见音乐",
      query: song ? shareQuery(song) : "",
      ...(song?.cover_url?.startsWith("https://")
        ? { imageUrl: song.cover_url }
        : {}),
    };
  },
});
