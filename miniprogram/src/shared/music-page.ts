import { MusicApp } from "../app";
import { api } from "../services/api";
import { Catalog, CatalogState } from "../services/catalog";
import { Song, Source, sourceNames, time } from "../types";
import { PersonalData } from "../services/personal";
import { routes } from "../routes";

export function presentSongs(songs: Song[]) {
  return songs.map((song, index) => ({
    ...song,
    number: String(index + 1).padStart(2, "0"),
    durationText: time(song.duration),
    sourceText: song.play_source_name || sourceNames[song.source],
  }));
}

// Decode only the navigation boundary, not typed queries or API parameters.
function decodeSearchQuery(value = ""): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed external route must not prevent the search page from loading.
    return value;
  }
}

export function registerMusicPage(mode: "home" | "search"): void {
  Page({
    data: {
      mode,
      query: "",
      searched: "",
      source: "soda" as Source,
      sourceIndex: 0,
      sourceNames: ["汽水音乐", "网易云音乐", "酷我音乐"],
      items: [] as ReturnType<typeof presentSongs>,
      featured: [] as ReturnType<typeof presentSongs>,
      loading: false,
      error: "",
      message: "",
      refreshing: false,
      stale: false,
      pending: 0,
      page: 1,
      hasMore: false,
      currentId: 0,
      playing: false,
      aboutOpen: false,
      searchHistory: [] as { key: string; query?: string }[],
      personalError: "",
      avatar: "",
      moods: [
        { title: "华语流行", label: "熟悉的心动", symbol: "♫", tone: "green" },
        { title: "抖音热歌", label: "正在循环", symbol: "✦", tone: "orange" },
        { title: "民谣", label: "慢一点也好", symbol: "♬", tone: "brown" },
        { title: "治愈", label: "温柔的陪伴", symbol: "☀", tone: "pink" },
        { title: "轻音乐", label: "留一点空白", symbol: "♪", tone: "blue" },
        { title: "经典华语", label: "记忆的旋律", symbol: "◎", tone: "sand" },
      ],
    },
    catalog: null as Catalog | null,
    unsubscribe: null as (() => void) | null,
    startupError: "",
    availabilityRevision: -1,
    personalUnsubscribe: null as (() => void) | null,
    onLoad(options: Record<string, string>) {
      const app = getApp<MusicApp>();
      this.startupError = app.startupError;
      const query = decodeSearchQuery(options.q);
      const requested = options.source;
      const source: Source =
        requested === "netease" || requested === "kuwo" ? requested : "soda";
      this.setData({
        query,
        searched: query,
        source,
        sourceIndex: ["soda", "netease", "kuwo"].indexOf(source),
      });
      this.catalog = new Catalog(
        api,
        (state) => this.renderResult(state),
        () => app.player?.availabilityRevision || 0,
      );
      if (mode === "search") {
        this.catalog.change("search", query, source);
        if (query) app.personal?.recordSearch(query);
      }
    },
    onShow() {
      this.unsubscribe?.();
      this.personalUnsubscribe?.();
      const app = getApp<MusicApp>();
      this.personalUnsubscribe =
        app.personal?.subscribe((state: PersonalData) =>
          this.setData({
            searchHistory: state.search.items,
            personalError: state.error,
            avatar: state.avatar,
          }),
        ) || null;
      void app.personal?.sync();
      this.unsubscribe =
        app.player?.subscribe((state) => {
          const currentId = state.current?.id || 0;
          if (
            this.data.currentId !== currentId ||
            this.data.playing !== state.playing
          )
            this.setData({ currentId, playing: state.playing });
          const revision = app.player?.availabilityRevision || 0;
          if (
            this.availabilityRevision !== revision &&
            this.catalog?.state.result
          )
            this.renderResult(this.catalog.state);
        }) || null;
      if (mode === "home" || this.data.searched) this.catalog?.resume();
      else if (this.startupError) this.setData({ error: this.startupError });
    },
    onHide() {
      this.catalog?.pause();
      this.personalUnsubscribe?.();
      this.personalUnsubscribe = null;
      this.unsubscribe?.();
      this.unsubscribe = null;
    },
    onUnload() {
      this.catalog?.pause();
      this.personalUnsubscribe?.();
      this.personalUnsubscribe = null;
      this.unsubscribe?.();
      this.unsubscribe = null;
    },
    renderResult(state: CatalogState) {
      const player = getApp<MusicApp>().player;
      this.availabilityRevision = player?.availabilityRevision || 0;
      const available =
        player?.acceptAvailable(state.result?.items || [], state.revision) ||
        [];
      const items = presentSongs(available);
      this.setData({
        items,
        featured: items.slice(0, 4),
        loading: state.loading,
        error: this.startupError || state.error,
        message: state.result?.message || "",
        refreshing: !!state.result?.refreshing,
        stale: !!state.result?.stale,
        hasMore: !!state.result?.has_more,
        pending: state.result?.verification_pending || 0,
      });
    },
    input(event: WechatMiniprogram.Input) {
      this.setData({ query: event.detail.value });
    },
    clear() {
      this.setData({ query: "" });
    },
    search() {
      const query = this.data.query.trim();
      if (!query) {
        this.setData({ error: "请输入歌名或歌手" });
        return;
      }
      if (mode === "home") {
        this.openSearch(query);
        return;
      }
      getApp<MusicApp>().personal?.recordSearch(query);
      this.setData({ query, searched: query, page: 1, error: "" });
      this.catalog?.change("search", query, this.data.source, 1);
      // A search page starts inactive until the first submitted keyword
      this.catalog?.resume();
    },
    openSearch(query = "") {
      if (typeof query !== "string") query = "";
      wx.navigateTo({
        url:
          "/" +
          routes.search +
          (query ? "?q=" + encodeURIComponent(query) : ""),
      });
    },
    mood(event: WechatMiniprogram.TouchEvent) {
      const query = String(event.currentTarget.dataset.query || "");
      if (mode === "home") {
        this.openSearch(query);
        return;
      }
      this.setData({ query });
      this.search();
    },
    sourceChange(event: WechatMiniprogram.PickerChange) {
      const index = Number(event.detail.value);
      const source = (["soda", "netease", "kuwo"] as Source[])[index];
      if (!source) return;
      this.setData({ source, sourceIndex: index, page: 1 });
      if (this.data.searched) {
        this.catalog?.change("search", this.data.searched, source, 1);
        this.catalog?.resume();
      }
    },
    nextPage() {
      if (!this.data.hasMore || this.data.loading) return;
      const page = this.data.page + 1;
      this.setData({ page });
      this.catalog?.change(
        "search",
        this.data.searched,
        this.data.source,
        page,
      );
    },
    previousPage() {
      if (this.data.page <= 1 || this.data.loading) return;
      const page = this.data.page - 1;
      this.setData({ page });
      this.catalog?.change(
        "search",
        this.data.searched,
        this.data.source,
        page,
      );
    },
    shuffle() {
      if (!this.data.loading) void this.catalog?.load(true);
    },
    retry() {
      if (mode === "home" || this.data.searched) void this.catalog?.load();
    },
    playSong(event: WechatMiniprogram.TouchEvent) {
      const id = Number(event.currentTarget.dataset.id);
      const song = this.data.items.find((item) => item.id === id);
      if (!song) return;
      const player = getApp<MusicApp>().player;
      if (player?.state.current?.id === id) {
        void player.toggle();
        return;
      }
      void player?.play(song, this.data.items);
    },
    randomPlay() {
      const items = this.data.items;
      if (items.length)
        void getApp<MusicApp>().player?.play(
          items[Math.floor(Math.random() * items.length)],
          items,
        );
    },
    mine() {
      wx.navigateTo({ url: "/" + routes.mine });
    },
    historySearch(event: WechatMiniprogram.TouchEvent) {
      this.setData({ query: String(event.currentTarget.dataset.query || "") });
      this.search();
    },
    removeSearch(event: WechatMiniprogram.TouchEvent) {
      void getApp<MusicApp>().personal?.remove(
        "search",
        String(event.currentTarget.dataset.key),
      );
    },
    clearSearchHistory() {
      void getApp<MusicApp>().personal?.clear("search");
    },
    about() {
      this.setData({ aboutOpen: true });
    },
    closeAbout() {
      this.setData({ aboutOpen: false });
    },
    noop() {},
    diagnostics() {
      this.setData({ aboutOpen: false });
      wx.navigateTo({ url: "/" + routes.diagnostics });
    },
    onShareAppMessage() {
      return {
        title: "听见 · 给生活留一点音乐的时间",
        path: "/" + routes.home,
      };
    },
  });
}
