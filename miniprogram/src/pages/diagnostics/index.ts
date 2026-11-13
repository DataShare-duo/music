import { MusicApp } from "../../app";
import { time } from "../../types";
import { api } from "../../services/api";
import { openHome } from "../../routes";

Page({
  data: {
    healthLoading: false,
    cloudStatus: "尚未检查云服务",
    events: [] as string[],
    song: "尚未选择歌曲",
    source: "",
    playing: false,
    position: "0:00",
    duration: "0:00",
    session: "",
    message: "",
  },
  unsubscribe: null as (() => void) | null,
  onShow() {
    this.unsubscribe?.();
    this.unsubscribe =
      getApp<MusicApp>().player?.subscribe((state) =>
        this.setData({
          events: state.events,
          song: state.current?.title || "尚未选择歌曲",
          source: state.sourceName,
          playing: state.playing,
          position: time(state.position),
          duration: time(state.duration),
          session: state.sessionId,
          message: state.message,
        }),
      ) || null;
  },
  onHide() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  },
  onUnload() {
    this.unsubscribe?.();
  },
  toggle() {
    void getApp<MusicApp>().player?.toggle();
  },
  async checkHealth() {
    this.setData({ healthLoading: true, cloudStatus: "通过云调用检查…" });
    try {
      const result = await api.get<{ status: string; database: string }>(
        "/api/health",
      );
      this.setData({
        cloudStatus:
          result.status === "ok" && result.database === "ok"
            ? "云调用与数据库正常"
            : "健康检查未通过",
      });
    } catch (e) {
      this.setData({
        cloudStatus: e instanceof Error ? e.message : "云调用失败",
      });
    } finally {
      this.setData({ healthLoading: false });
    }
  },
  back() {
    wx.navigateBack({
      fail() {
        openHome();
      },
    });
  },
});
