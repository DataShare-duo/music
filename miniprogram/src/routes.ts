// Stable native routes; the singular path is retained for existing experience QR codes
export const routes = Object.freeze({
  home: "pages/home/index",
  search: "pages/search/index",
  diagnostics: "pages/diagnostics/index",
  legacyExperience: "page/index/index",
});
export function openHome(): void {
  wx.reLaunch({ url: "/" + routes.home });
}
