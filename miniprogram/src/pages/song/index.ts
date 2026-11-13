import { MusicApp } from "../../app";
import { Song } from "../../types";
import { SavedSong } from "../../services/personal";
import {
  readShared,
  shareCard,
  shareQuery,
  restoreSong,
  sameSong,
} from "../../services/songs";
import { openPlayer, openHome } from "../../routes";
Page({
  data: {
    title: "分享的歌曲",
    artist: "",
    cover: "",
    message: "",
    loading: false,
    limited: false,
    ready: false,
  },
  saved: null as SavedSong | null,
  song: null as Song | null,
  generation: 0,
  visible: false,
  attempted: false,
  onLoad(options: Record<string, string>) {
    this.saved = readShared(options);
    if (!this.saved) {
      this.setData({ message: "分享参数无效，请重新分享" });
      return;
    }
    this.setData({ title: this.saved.title, artist: this.saved.artist });
    let limited = false;
    try {
      limited = wx.getLaunchOptionsSync().scene === 1154;
    } catch {}
    this.setData({ limited });
    wx.showShareMenu({ menus: ["shareAppMessage", "shareTimeline"] });
  },
  onShow() {
    this.visible = true;
    if (this.saved && !this.data.limited && !this.song) void this.load();
  },
  onHide() {
    this.visible = false;
    ++this.generation;
    this.setData({ loading: false });
  },
  onUnload() {
    this.onHide();
  },
  async load() {
    if (!this.saved || this.data.loading) return;
    const gen = ++this.generation;
    this.setData({ loading: true, message: "正在验证分享歌曲…" });
    try {
      const song = await restoreSong(
        this.saved,
        () => !this.visible || gen !== this.generation,
      );
      if (!this.visible || gen !== this.generation) return;
      this.song = song;
      this.setData({
        title: song.title,
        artist: song.artist,
        cover: song.cover_url,
        ready: true,
        message: "",
      });
      const player = getApp<MusicApp>().player;
      if (!this.attempted) {
        this.attempted = true;
        if (sameSong(player?.state.current, song)) {
          this.setData({ message: "这首歌已在播放器中" });
        } else if (player?.state.playing || player?.state.loading) {
          this.setData({ message: "已保留当前播放，点击可切换到分享歌曲" });
        } else await this.play(true);
      }
    } catch (e) {
      if (this.visible && gen === this.generation)
        this.setData({
          message: e instanceof Error ? e.message : "歌曲暂不可播放",
        });
    } finally {
      if (gen === this.generation) this.setData({ loading: false });
    }
  },
  async play(automatic: unknown = false) {
    if (!this.song) {
      await this.load();
      return;
    }
    const player = getApp<MusicApp>().player;
    if (!player) {
      this.setData({ message: "播放器不可用，请进入完整小程序后播放" });
      return;
    }
    if (!sameSong(player.state.current, this.song))
      await player.play(this.song, [this.song], automatic === true);
    else if (!player.state.playing) await player.toggle();
    this.setData({
      message: player.state.failed
        ? player.state.message
        : "如果未自动开始，请点击播放",
    });
    if (!player.state.failed) openPlayer();
  },
  home() {
    openHome();
  },
  onShareAppMessage() {
    return shareCard(this.saved);
  },
  onShareTimeline() {
    return {
      title: this.saved
        ? this.saved.title + " · " + this.saved.artist
        : "听见音乐",
      query: this.saved ? shareQuery(this.saved) : "",
    };
  },
});
