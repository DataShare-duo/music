import { MusicApp } from "../../app";
import { time } from "../../types";

Page({
  data: {
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
  back() {
    wx.navigateBack();
  },
});
