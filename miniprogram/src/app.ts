import { PersonalStore } from "./services/personal";
import { config } from "./config";
import { openHome } from "./routes";
import { api, newRequestId } from "./services/api";
import { NativePlayer } from "./services/player";

export interface MusicApp {
  personal: PersonalStore | null;
  player: NativePlayer | null;
  startupError: string;
}

App({
  personal: null as PersonalStore | null,
  personalTimer: null as ReturnType<typeof setInterval> | null,
  player: null as NativePlayer | null,
  startupError: "",
  onLaunch() {
    if (!wx.cloud || !wx.getBackgroundAudioManager) {
      this.startupError = "当前微信缺少云调用或后台音频能力，请更新微信";
      return;
    }
    try {
      wx.cloud.init({ env: config.env, traceUser: false });
      this.personal = new PersonalStore();
      this.player = new NativePlayer(
        api,
        wx.getBackgroundAudioManager(),
        newRequestId,
        (song, session, source) =>
          this.personal?.recordPlayed(song, session, source),
      );
    } catch {
      this.startupError =
        "背景播放器或云能力初始化失败，请核实当前账号的类目与后台音频权限";
    }
  },
  onPageNotFound() {
    openHome();
  },
  onShow() {
    void this.personal?.sync();
    if (this.personalTimer) clearInterval(this.personalTimer);
    this.personalTimer = setInterval(() => {
      void this.personal?.sync();
    }, 60000);
    this.player?.lifecycle(true);
  },
  onHide() {
    if (this.personalTimer) clearInterval(this.personalTimer);
    this.personalTimer = null;
    this.player?.lifecycle(false);
  },
});
