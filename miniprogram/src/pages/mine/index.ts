import type { MusicApp } from "../../app";
import { PersonalStore } from "../../services/personal";
import { routes } from "../../routes";
import { PersonalLibrary, emptyLibrary } from "../../shared/personal-library";
Page({
  data: {
    ...emptyLibrary(),
    active: false,
    avatar: "",
    avatarBroken: false,
    error: "",
    favoriteCount: 0,
    likeCount: 0,
    recentCount: 0,
    busy: false,
  },
  unsubscribe: null as (() => void) | null,
  store: null as PersonalStore | null,
  library: null as PersonalLibrary | null,
  onLoad(options: Record<string, string>) {
    this.library = new PersonalLibrary((view) => this.setData(view));
    this.library.select(options.kind || "favorite");
  },
  onShow() {
    this.unsubscribe?.();
    this.store = getApp<MusicApp>().personal;
    this.library ||= new PersonalLibrary((view) => this.setData(view));
    this.unsubscribe = this.store?.subscribe((s) => {
      this.setData({
        active: s.active, avatar: s.avatar,
        avatarBroken: s.avatar === this.data.avatar ? this.data.avatarBroken : false,
        error: s.error, favoriteCount: s.favorite.length,
        likeCount: s.like.length, recentCount: s.recent.items.length,
      });
    }) || null;
    this.library.show(this.store);
    if (this.store && !this.store.data.active) void this.enable();
    else {
      void this.store?.sync().then(() => this.store?.loadAvatar());
    }
  },
  onHide() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.library?.hide();
    this.setData({ loading: false });
  },
  onUnload() { this.onHide(); },
  async enable() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      await this.store?.enable();
    } finally { this.setData({ busy: false }); }
  },
  async chooseAvatar(event: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>) {
    const path = event.detail.avatarUrl;
    if (this.data.busy || !path) return;
    this.setData({ busy: true });
    try {
      await this.store?.setAvatar(path);
    } catch {
      // PersonalStore exposes the failure without interrupting background music.
    } finally { this.setData({ busy: false }); }
  },
  avatarFailed() {
    this.setData({ avatarBroken: true });
  },
  changeTab(event: WechatMiniprogram.TouchEvent) {
    this.library?.select(String(event.currentTarget.dataset.kind));
  },
  play(event: WechatMiniprogram.TouchEvent) {
    void this.library?.play(String(event.currentTarget.dataset.key));
  },
  remove(event: WechatMiniprogram.TouchEvent) {
    void this.library?.remove(String(event.currentTarget.dataset.key));
  },
  previous() { this.library?.previous(); },
  next() { this.library?.next(); },
  clearRecent() { this.library?.clearRecent(); },
  retry() {
    if (!this.store || this.data.busy) return;
    if (!this.store.data.active) { void this.enable(); return; }
    void this.store.sync();
    void this.store.loadAvatar();
  },
  about() {
    wx.showModal({
      title: "关于听见",
      content: "DataShare · 仅供个人非商业使用\n仅展示已验证完整版，个人资料与音乐服务独立保存",
      showCancel: false,
    });
  },
  diagnostics() {
    wx.navigateTo({ url: "/" + routes.diagnostics });
  },
});
