import { MusicApp } from "../../app";
import { PersonalStore } from "../../services/personal";
import { routes } from "../../routes";
Page({
  data: {
    active: false,
    avatar: "",
    error: "",
    favoriteCount: 0,
    likeCount: 0,
    recentCount: 0,
    busy: false,
  },
  unsubscribe: null as (() => void) | null,
  store: null as PersonalStore | null,
  onShow() {
    this.unsubscribe?.();
    this.store = getApp<MusicApp>().personal;
    this.unsubscribe =
      this.store?.subscribe((s) =>
        this.setData({
          active: s.active,
          avatar: s.avatar,
          error: s.error,
          favoriteCount: s.favorite.length,
          likeCount: s.like.length,
          recentCount: s.recent.items.length,
        }),
      ) || null;
    if (this.store && !this.store.data.active) void this.enable();
    else void this.store?.sync();
  },
  onHide() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  },
  onUnload() {
    this.onHide();
  },
  async enable() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    await this.store?.enable();
    this.setData({ busy: false });
  },
  async chooseAvatar(
    event: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>,
  ) {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      await this.store?.setAvatar(event.detail.avatarUrl);
    } catch {
    } finally {
      this.setData({ busy: false });
    }
  },
  async openList(event: WechatMiniprogram.TouchEvent) {
    const kind = String(event.currentTarget.dataset.kind);
    if (!["favorite", "like", "recent"].includes(kind)) return;
    if (!this.store) return;
    if (!(await this.store.enable())) return;
    wx.navigateTo({ url: "/" + routes.library + "?kind=" + kind });
  },
  retry() {
    void this.store?.sync();
  },
  about() {
    wx.showModal({
      title: "关于听见",
      content:
        "DataShare · 仅供个人非商业使用\n仅展示已验证完整版，个人资料与音乐服务独立保存",
      showCancel: false,
    });
  },
  diagnostics() {
    wx.navigateTo({ url: "/" + routes.diagnostics });
  },
});
