import { MusicApp } from "../../app";
import { api } from "../../services/api";
import { Catalog } from "../../services/catalog";
import { Song, Source, time, sourceNames } from "../../types";

Page({
  data: {
    phase: "第一阶段 · 真机直连验证版",
    cloudStatus: "尚未检查云服务",
    healthLoading: false,
    mode: "home",
    query: "",
    source: "soda" as Source,
    sourceIndex: 0,
    sourceNames: ["汽水音乐", "网易云音乐", "酷我音乐"],
    page: 1,
    items: [] as Array<Song & { durationText: string; sourceText: string }>,
    loading: false,
    error: "",
    message: "",
    refreshing: false,
    hasMore: false,
    stale: false,
    pending: 0,
    player: {
      title: "选择歌曲开始验证",
      artist: "",
      source: "",
      playing: false,
      loading: false,
      failed: false,
      message: "",
      position: 0,
      duration: 0,
      positionText: "0:00",
      durationText: "0:00",
    },
  },
  catalog: null as Catalog | null,
  unsubscribe: null as (() => void) | null,
  alive: false,
  healthGeneration: 0,
  onLoad() {
    this.alive = true;
    const app = getApp<MusicApp>();
    if (app.startupError) this.setData({ error: app.startupError });
    this.catalog = new Catalog(
      api,
      (state) => {
        const items =
          app.player?.acceptAvailable(
            state.result?.items || [],
            state.revision,
          ) || [];
        this.setData({
          items: items.map((song) => ({
            ...song,
            durationText: time(song.duration),
            sourceText: song.play_source_name || sourceNames[song.source],
          })),
          loading: state.loading,
          error: state.error,
          message: state.result?.message || "",
          refreshing: !!state.result?.refreshing,
          stale: !!state.result?.stale,
          hasMore: !!state.result?.has_more,
          pending: state.result?.verification_pending || 0,
        });
      },
      () => app.player?.availabilityRevision || 0,
    );
    this.unsubscribe =
      app.player?.subscribe((state) => {
        this.setData({
          player: {
            title: state.current?.title || "选择歌曲开始验证",
            artist: state.current?.artist || "",
            source: state.sourceName,
            playing: state.playing,
            loading: state.loading,
            failed: state.failed,
            message: state.message,
            position: state.position,
            duration: state.duration,
            positionText: time(state.position),
            durationText: time(state.duration),
          },
        });
        const items = this.data.items.filter(
          (song) => app.player?.acceptAvailable([song], -1).length,
        );
        if (items.length !== this.data.items.length) this.setData({ items });
      }) || null;
  },
  onShow() {
    this.catalog?.resume();
  },
  onHide() {
    this.catalog?.pause();
  },
  onUnload() {
    this.alive = false;
    ++this.healthGeneration;
    this.catalog?.pause();
    this.unsubscribe?.();
  },
  async checkHealth() {
    const token = ++this.healthGeneration;
    this.setData({
      healthLoading: true,
      cloudStatus: "通过 callContainer 检查…",
    });
    try {
      const health = await api.get<{ status: string; database: string }>(
        "/api/health",
      );
      if (!this.alive || token !== this.healthGeneration) return;
      this.setData({
        cloudStatus:
          health.status === "ok" && health.database === "ok"
            ? "云调用与数据库正常（不依赖公网）"
            : "健康检查未通过",
      });
    } catch (e) {
      if (this.alive && token === this.healthGeneration)
        this.setData({
          cloudStatus: e instanceof Error ? e.message : "云调用失败",
        });
    } finally {
      if (this.alive && token === this.healthGeneration)
        this.setData({ healthLoading: false });
    }
  },
  input(event: WechatMiniprogram.Input) {
    this.setData({ query: event.detail.value });
  },
  sourceChange(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.detail.value);
    const source = (["soda", "netease", "kuwo"] as Source[])[index];
    if (!source) return;
    this.setData({ source, sourceIndex: index, page: 1 });
    if (this.data.mode === "search" && this.data.query.trim()) this.search();
  },
  search() {
    this.setData({ mode: "search", page: 1 });
    this.catalog?.change("search", this.data.query, this.data.source, 1);
  },
  discover() {
    this.setData({ mode: "home", page: 1 });
    this.catalog?.change("home");
  },
  nextPage() {
    if (!this.data.hasMore || this.data.loading) return;
    const page = this.data.page + 1;
    this.setData({ page });
    this.catalog?.change("search", this.data.query, this.data.source, page);
  },
  previousPage() {
    if (this.data.page <= 1 || this.data.loading) return;
    const page = this.data.page - 1;
    this.setData({ page });
    this.catalog?.change("search", this.data.query, this.data.source, page);
  },
  shuffle() {
    void this.catalog?.load(true);
  },
  playSong(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    const song = this.data.items.find((item) => item.id === id);
    if (song) void getApp<MusicApp>().player?.play(song, this.data.items);
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
  diagnostics() {
    wx.navigateTo({ url: "/pages/diagnostics/index" });
  },
});
