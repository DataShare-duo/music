import { config } from "./config";
import { api, newRequestId } from "./services/api";
import { NativePlayer } from "./services/player";

export interface MusicApp {
  player: NativePlayer | null;
  startupError: string;
}

App({
  player: null as NativePlayer | null,
  startupError: "",
  onLaunch() {
    if (!wx.cloud || !wx.getBackgroundAudioManager) {
      this.startupError = "当前微信缺少云调用或后台音频能力，请更新微信";
      return;
    }
    try {
      wx.cloud.init({ env: config.env, traceUser: false });
      this.player = new NativePlayer(
        api,
        wx.getBackgroundAudioManager(),
        newRequestId,
      );
    } catch {
      this.startupError =
        "背景播放器或云能力初始化失败，请核实当前账号的类目与后台音频权限";
    }
  },
  onShow() {
    this.player?.lifecycle(true);
  },
  onHide() {
    this.player?.lifecycle(false);
  },
});
