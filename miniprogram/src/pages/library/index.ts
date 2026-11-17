import type { MusicApp } from "../../app";
import { PersonalStore } from "../../services/personal";
import { PersonalLibrary, emptyLibrary, libraryLabels } from "../../shared/personal-library";
Page({
  data: { ...emptyLibrary(), title: "我的收藏", error: "" },
  store: null as PersonalStore | null,
  library: null as PersonalLibrary | null,
  unsubscribe: null as (() => void) | null,
  onLoad(options: Record<string, string>) {
    this.library = new PersonalLibrary((view) => this.setData(view));
    this.library.select(options.kind || "favorite");
    const title = "我的音乐 · " + libraryLabels[this.data.kind];
    this.setData({ title });
    wx.setNavigationBarTitle({ title });
  },
  onShow() {
    this.store = getApp<MusicApp>().personal;
    this.library ||= new PersonalLibrary((view) => this.setData(view));
    this.library.show(this.store);
    this.unsubscribe?.();
    this.unsubscribe = this.store?.subscribe((s) => this.setData({ error: s.error })) || null;
    void this.store?.sync();
  },
  onHide() {
    this.library?.hide();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.setData({ loading: false });
  },
  onUnload() { this.onHide(); },
  previous() { this.library?.previous(); },
  next() { this.library?.next(); },
  play(event: WechatMiniprogram.TouchEvent) {
    void this.library?.play(String(event.currentTarget.dataset.key));
  },
  remove(event: WechatMiniprogram.TouchEvent) {
    void this.library?.remove(String(event.currentTarget.dataset.key));
  },
  clearRecent() { this.library?.clearRecent(); },
  retry() { void this.store?.sync(); },
});
