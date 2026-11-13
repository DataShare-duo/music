import { MusicApp } from "../../app";
import { time } from "../../types";
const subscriptions = new WeakMap<object, () => void>();
function bind(component: WechatMiniprogram.Component.TrivialInstance): void {
  subscriptions.get(component)?.();
  const unsubscribe = getApp<MusicApp>().player?.subscribe((state) =>
    component.setData({
      hasSong: !!state.current,
      title: state.current?.title || "让好音乐，陪你一会儿",
      artist: state.current?.artist || "选择一首歌曲，开始聆听",
      cover: state.current?.cover_url || "",
      source: state.sourceName,
      playing: state.playing,
      loading: state.loading,
      failed: state.failed,
      message: state.message,
      position: state.position,
      duration: state.duration,
      positionText: time(state.position),
      durationText: time(state.duration),
    }),
  );
  if (unsubscribe) subscriptions.set(component, unsubscribe);
}
function unbind(component: object): void {
  subscriptions.get(component)?.();
  subscriptions.delete(component);
}
Component({
  data: {
    hasSong: false,
    title: "让好音乐，陪你一会儿",
    artist: "选择一首歌曲，开始聆听",
    cover: "",
    source: "",
    playing: false,
    loading: false,
    failed: false,
    message: "",
    position: 0,
    duration: 0,
    positionText: "0:00",
    durationText: "0:00",
  },
  lifetimes: {
    attached() {
      bind(this);
    },
    detached() {
      unbind(this);
    },
  },
  pageLifetimes: {
    show() {
      bind(this);
    },
    hide() {
      unbind(this);
    },
  },
  methods: {
    toggle() {
      void getApp<MusicApp>().player?.toggle();
    },
    previous() {
      void getApp<MusicApp>().player?.next(-1);
    },
    next() {
      void getApp<MusicApp>().player?.next(1);
    },
    seek(event: WechatMiniprogram.SliderChange) {
      getApp<MusicApp>().player?.seek(event.detail.value);
    },
  },
});
