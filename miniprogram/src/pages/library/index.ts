import { MusicApp } from "../../app";
import { PersonalStore, Entry, MarkKind } from "../../services/personal";
import { restoreSong } from "../../services/songs";
import { openPlayer } from "../../routes";
const labels = { favorite: "我的收藏", like: "我喜欢的", recent: "最近播放" };
Page({
  data: {
    kind: "favorite",
    title: "我的收藏",
    items: [] as (Entry & { timeText: string; availability: string })[],
    page: 1,
    hasMore: false,
    total: 0,
    error: "",
    message: "",
    loading: false,
  },
  store: null as PersonalStore | null,
  unsubscribe: null as (() => void) | null,
  all: [] as Entry[],
  generation: 0,
  visible: false,
  rowStatus: {} as Record<string, string>,
  onLoad(options: Record<string, string>) {
    const kind = ["favorite", "like", "recent"].includes(options.kind)
      ? options.kind
      : "favorite";
    this.setData({ kind, title: labels[kind as keyof typeof labels] });
    wx.setNavigationBarTitle({ title: labels[kind as keyof typeof labels] });
  },
  onShow() {
    this.visible = true;
    this.store = getApp<MusicApp>().personal;
    this.unsubscribe?.();
    this.unsubscribe =
      this.store?.subscribe((s) => {
        this.all =
          this.data.kind === "recent"
            ? s.recent.items
            : s[this.data.kind as MarkKind];
        this.setData({ error: s.error });
        this.render();
      }) || null;
    void this.store?.sync();
  },
  onHide() {
    this.visible = false;
    ++this.generation;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.setData({ loading: false });
  },
  onUnload() {
    this.onHide();
  },
  render() {
    const page = Math.min(
      this.data.page,
      Math.max(1, Math.ceil(this.all.length / 20)),
    );
    this.setData({
      page,
      total: this.all.length,
      hasMore: page * 20 < this.all.length,
      items: this.all
        .slice((page - 1) * 20, page * 20)
        .map((x) => ({
          ...x,
          timeText: new Date(x.at).toLocaleString(),
          availability: this.rowStatus[x.key] || "播放时重新验证当前音源",
        })),
    });
  },
  previous() {
    if (this.data.page > 1) {
      this.setData({ page: this.data.page - 1 });
      this.render();
    }
  },
  next() {
    if (this.data.hasMore) {
      this.setData({ page: this.data.page + 1 });
      this.render();
    }
  },
  async play(event: WechatMiniprogram.TouchEvent) {
    const row = this.all.find((x) => x.key === event.currentTarget.dataset.key);
    if (!row?.song) return;
    const gen = ++this.generation;
    this.setData({ loading: true, message: "正在重新验证歌曲…" });
    try {
      const song = await restoreSong(
        row.song,
        () => !this.visible || gen !== this.generation,
        (m) => this.setData({ message: m }),
      );
      if (!this.visible || gen !== this.generation) return;
      delete this.rowStatus[row.key];
      this.render();
      await getApp<MusicApp>().player?.play(song, [song]);
      openPlayer();
    } catch (e) {
      if (this.visible && gen === this.generation) {
        this.rowStatus[row.key] = "暂未能播放 · 点击重试";
        this.render();
        this.setData({
          message:
            e instanceof Error ? e.message : "歌曲暂不可播放，记录仍保留",
        });
      }
    } finally {
      if (gen === this.generation) this.setData({ loading: false });
    }
  },
  async remove(event: WechatMiniprogram.TouchEvent) {
    const row = this.all.find((x) => x.key === event.currentTarget.dataset.key);
    if (!row) return;
    try {
      if (this.data.kind === "recent")
        await this.store?.remove("recent", row.key);
      else if (row.song)
        await this.store?.mark(this.data.kind as MarkKind, row.song, false);
    } catch {}
  },
  clearRecent() {
    void this.store?.clear("recent");
  },
  retry() {
    void this.store?.sync();
  },
});
