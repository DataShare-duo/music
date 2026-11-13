// Stable native routes; the singular path is retained for existing experience QR codes
export const routes = Object.freeze({
  home: "pages/home/index",
  mine: "pages/mine/index",
  library: "pages/library/index",
  song: "pages/song/index",
  search: "pages/search/index",
  diagnostics: "pages/diagnostics/index",
  player: "pages/player/index",
  legacyExperience: "page/index/index",
});
export function openHome(): void {
  wx.reLaunch({ url: "/" + routes.home });
}

let openingPlayer = false;
export function openPlayer(): void {
  const app = getApp<{ player: { state: { current: unknown } } | null }>();
  if (!app.player?.state.current) {
    wx.showToast({ title: "请先选择歌曲", icon: "none" });
    return;
  }
  const pages = getCurrentPages();
  if (openingPlayer || pages[pages.length - 1]?.route === routes.player) return;
  openingPlayer = true;
  wx.navigateTo({
    url: "/" + routes.player,
    fail() {
      wx.showToast({ title: "页面打开失败，请返回后重试", icon: "none" });
    },
    complete() {
      openingPlayer = false;
    },
  });
}
