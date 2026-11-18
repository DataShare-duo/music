import type { SavedSong } from "../../services/personal";
import {
  enableSharing,
  timelineCard,
  isTimelinePreview,
} from "../../services/sharing";
import { shareCard, shareQuery, readShared } from "../../services/songs";
import { routes } from "../../routes";
import { MusicApp } from "../../app";
import { api } from "../../services/api";
import { LyricController, LyricState } from "../../services/lyrics";
import { LyricLine, Song, sourceNames, time } from "../../types";
import { TrackSwipe } from "../../shared/player-gestures";
import {
  TrackTransition,
  TransitionFrame,
} from "../../shared/player-transition";
import { PlayerState } from "../../services/player";
import { openHome } from "../../routes";

const trackKey = (song: Song | null) =>
  song ? song.source + ":" + song.source_track_id : "";
const playbackKey = (state: PlayerState) =>
  trackKey(state.current) + ":" + state.sessionId;

Page({
  data: {
    title: "听见",
    transitionPhase: "idle" as TransitionFrame["phase"],
    transitionY: 0,
    transitionOpacity: 1,
    transitionDuration: 0,
    transitionRevision: 0,
    lyricsVisible: false,
    previewLine: "让好音乐，陪你一会儿",
    previewNext: "",
    queueOpen: false,
    queueCount: 0,
    queueItems: [] as {
      key: string;
      title: string;
      artist: string;
      sourceName: string;
      active: boolean;
    }[],
    queueActiveId: "",
    limitedShare: false,
    sharedTitle: "分享的歌曲",
    sharedArtist: "",
    favorite: false,
    liked: false,
    personalError: "",
    artist: "",
    sourceName: "",
    coverUrl: "",
    coverBroken: false,
    hasSong: false,
    playing: false,
    loading: false,
    failed: false,
    queueEnded: false,
    continuing: false,
    message: "",
    position: 0,
    duration: 0,
    positionText: "0:00",
    durationText: "0:00",
    statusTop: 24,
    headerRight: 100,
    lyricStatus: "idle",
    lyricLines: [] as LyricLine[],
    plainText: "",
    lyricMessage: "",
    lyricSource: "",
    activeIndex: -1,
    following: true,
    retryAfter: 0,
    lyricScrollTop: 0,
  },
  motion: null as TrackTransition | null,
  swipeHeight: 0,
  swipeTarget: "",
  displayedSongKey: "",
  measurementRevision: 0,
  gesture: null as TrackSwipe | null,
  gestureIdentity: "",
  queueRevision: "",
  sharedSong: null as SavedSong | null,
  lyrics: null as LyricController | null,
  unsubscribe: null as (() => void) | null,
  visible: false,
  personalUnsubscribe: null as (() => void) | null,
  lastLines: null as LyricLine[] | null,
  scrollRevision: -1,
  scrollGeneration: 0,
  onLoad(options: Record<string, string | undefined> = {}) {
    const shared = readShared(options);
    if (isTimelinePreview()) {
      this.sharedSong = shared;
      this.setData({
        limitedShare: true,
        sharedTitle: shared?.title || "听见音乐",
        sharedArtist: shared?.artist || "",
      });
      return;
    }
    if (shared) {
      wx.redirectTo({ url: "/" + routes.song + "?" + shareQuery(shared) });
      return;
    }
    enableSharing();
    this.gesture = new TrackSwipe();
    this.motion = new TrackTransition((frame, rendered) =>
      this.renderMotion(frame, rendered),
    );
    try {
      const info = wx.getWindowInfo
        ? wx.getWindowInfo()
        : wx.getSystemInfoSync();
      const menu = wx.getMenuButtonBoundingClientRect();
      this.setData({
        statusTop: info.statusBarHeight || 24,
        headerRight: Math.max(100, info.windowWidth - menu.left + 12),
      });
    } catch {
      /* safe default for unusual devices */
    }
    this.lyrics = new LyricController(api, (state) => this.renderLyrics(state));
  },
  onShow() {
    if (this.data.limitedShare) return;
    this.visible = true;
    this.measureSwipeHeight();
    this.personalUnsubscribe?.();
    const personal = getApp<MusicApp>().personal;
    this.personalUnsubscribe =
      personal?.subscribe((state) => {
        const current = getApp<MusicApp>().player?.state.current;
        this.setData({
          favorite: current ? personal.has("favorite", current) : false,
          liked: current ? personal.has("like", current) : false,
          personalError: state.error,
        });
      }) || null;
    void personal?.sync();
    const player = getApp<MusicApp>().player;
    if (!player) {
      this.setData({
        lyricMessage: getApp<MusicApp>().startupError || "播放器尚未初始化",
      });
      return;
    }
    this.renderPlayer(player.snapshot());
    this.lyrics?.resume(player.snapshot());
    this.unsubscribe?.();
    this.unsubscribe = player.subscribe((state) => {
      this.renderPlayer(state);
      this.lyrics?.update(state);
    });
  },
  onHide() {
    this.visible = false;
    this.cancelSwipe();
    this.closeQueue();
    this.personalUnsubscribe?.();
    this.personalUnsubscribe = null;
    ++this.scrollGeneration;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lyrics?.pause();
  },
  onUnload() {
    this.visible = false;
    this.cancelSwipe();
    this.personalUnsubscribe?.();
    this.personalUnsubscribe = null;
    ++this.scrollGeneration;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lyrics?.pause();
  },
  renderPlayer(state: PlayerState) {
    if (this.motion && this.motion.phase !== "idle") {
      const ownEntry =
        this.motion.phase === "entering" &&
        trackKey(state.current) === this.swipeTarget &&
        !state.failed;
      if (
        !ownEntry &&
        (!state.current ||
          state.loading ||
          playbackKey(state) !== this.gestureIdentity)
      )
        this.cancelSwipe();
    }
    const key = trackKey(state.current);
    if (key !== this.displayedSongKey) {
      this.displayedSongKey = key;
      ++this.scrollGeneration;
      this.lastLines = null;
      this.scrollRevision = -1;
      this.setData({
        lyricStatus: state.current ? "loading" : "idle",
        lyricLines: [],
        plainText: "",
        lyricMessage: "正在取得播放会话…",
        lyricSource: "",
        activeIndex: -1,
        previewLine: state.current
          ? "正在寻找这首歌的歌词…"
          : "让好音乐，陪你一会儿",
        previewNext: "",
        lyricScrollTop: 0,
        following: true,
      });
    }
    const personal = getApp<MusicApp>().personal;
    this.setData({
      favorite: state.current
        ? !!personal?.has("favorite", state.current)
        : false,
      liked: state.current ? !!personal?.has("like", state.current) : false,
    });
    const cover = state.current?.cover_url || "";
    const coverUrl = cover.startsWith("https://") ? cover : "";
    this.setData({
      title: state.current?.title || "听见",
      artist: state.current?.artist || "",
      sourceName: state.sourceName,
      hasSong: !!state.current,
      playing: state.playing,
      loading: state.loading,
      failed: state.failed,
      queueEnded: state.queueEnded,
      continuing: !!state.continuing,
      message: state.message,
      position: state.position,
      duration: state.duration,
      positionText: time(state.position),
      durationText: time(state.duration),
      ...(coverUrl !== this.data.coverUrl
        ? { coverUrl, coverBroken: false }
        : {}),
    });
    this.renderQueue(state.current);
  },
  renderLyrics(state: LyricState) {
    const newLines = this.lastLines !== state.lines;
    this.lastLines = state.lines;
    const move =
      state.following && state.scrollRevision !== this.scrollRevision;
    this.scrollRevision = state.scrollRevision;
    const index = Math.max(0, state.activeIndex);
    const previewLine =
      state.status === "synced"
        ? state.lines[index]?.text || "让旋律慢慢流淌"
        : state.status === "plain"
          ? state.plainText.split(/\r?\n/).find((line) => line.trim()) ||
            "静静听，这一刻的旋律"
          : state.status === "loading"
            ? "正在寻找这首歌的歌词…"
            : state.status === "instrumental"
              ? "此刻，只听旋律"
              : "静静听，让旋律陪你一会儿";
    this.setData(
      {
        previewLine,
        previewNext:
          state.status === "synced" ? state.lines[index + 1]?.text || "" : "",
        lyricStatus: state.status,
        plainText: state.plainText,
        lyricMessage: state.message,
        lyricSource: state.sourceName,
        activeIndex: state.activeIndex,
        following: state.following,
        retryAfter: state.retryAfter,
        ...(newLines ? { lyricLines: state.lines } : {}),
      },
      () => {
        if (move) this.centerLine(state.activeIndex);
      },
    );
  },
  centerLine(index: number) {
    if (
      index < 0 ||
      !this.visible ||
      !this.data.lyricsVisible ||
      (this.motion && this.motion.phase !== "idle")
    )
      return;
    const token = ++this.scrollGeneration;
    wx.nextTick(() => {
      if (
        !this.visible ||
        !this.data.lyricsVisible ||
        (this.motion && this.motion.phase !== "idle") ||
        token !== this.scrollGeneration ||
        !this.data.following ||
        this.data.activeIndex !== index
      )
        return;
      const query = wx.createSelectorQuery().in(this);
      query.select(".lyric-scroll").boundingClientRect();
      query.select(".lyric-scroll").scrollOffset();
      query.select("#lyric-line-" + index).boundingClientRect();
      query.exec((results) => {
        if (
          !this.visible ||
          !this.data.lyricsVisible ||
          (this.motion && this.motion.phase !== "idle") ||
          token !== this.scrollGeneration ||
          !this.data.following ||
          this.data.activeIndex !== index
        )
          return;
        const box =
          results[0] as WechatMiniprogram.BoundingClientRectCallbackResult | null;
        const offset = results[1] as { scrollTop: number } | null;
        const row =
          results[2] as WechatMiniprogram.BoundingClientRectCallbackResult | null;
        if (box && offset && row)
          this.setData({
            lyricScrollTop: Math.max(
              0,
              offset.scrollTop +
                row.top -
                box.top -
                (box.height - row.height) / 2,
            ),
          });
      });
    });
  },
  back() {
    this.cancelSwipe();
    wx.navigateBack({
      fail() {
        openHome();
      },
    });
  },
  coverFailed() {
    this.setData({ coverBroken: true });
  },
  toggle() {
    this.cancelSwipe();
    void getApp<MusicApp>().player?.toggle();
  },
  measureSwipeHeight() {
    const token = ++this.measurementRevision;
    try {
      const query = wx.createSelectorQuery().in(this);
      query.select(".song-viewport").boundingClientRect();
      query.exec((results) => {
        if (!this.visible || token !== this.measurementRevision) return;
        const box =
          results[0] as WechatMiniprogram.BoundingClientRectCallbackResult | null;
        if (box && Number.isFinite(box.height) && box.height > 0)
          this.swipeHeight = box.height;
      });
    } catch {
      /* A missing layout measurement only cancels this swipe, never playback. */
    }
  },
  renderMotion(frame: TransitionFrame, rendered?: () => void) {
    if (frame.phase === "idle") {
      this.gestureIdentity = "";
      this.swipeTarget = "";
    }
    this.setData(
      {
        transitionPhase: frame.phase,
        transitionY: frame.offset,
        transitionOpacity: frame.opacity,
        transitionDuration: frame.duration,
        transitionRevision: frame.revision,
      },
      () => {
        rendered?.();
        if (
          this.visible &&
          frame.phase === "idle" &&
          this.motion?.frame.revision === frame.revision &&
          this.data.following
        )
          this.centerLine(this.data.activeIndex);
      },
    );
  },
  transitionFinished(
    event: WechatMiniprogram.CustomEvent<{ propertyName?: string }>,
  ) {
    if (
      event.target.id !== event.currentTarget.id ||
      event.detail?.propertyName !== "transform"
    )
      return;
    this.motion?.complete(Number(event.currentTarget.dataset.revision));
  },
  swipeCandidate(direction: -1 | 1): Song | null {
    const player = getApp<MusicApp>().player;
    const current = player?.state.current;
    const queue = player?.queueSnapshot?.() || [];
    const index = queue.findIndex(
      (song) => trackKey(song) === trackKey(current || null),
    );
    if (index < 0 || new Set(queue.map(trackKey)).size < 2) return null;
    const target = queue[(index + direction + queue.length) % queue.length];
    return trackKey(target) !== trackKey(current || null) ? target : null;
  },
  swipeStart(event: WechatMiniprogram.TouchEvent) {
    if (this.motion?.phase === "dragging" && event.touches.length !== 1) {
      this.gesture?.cancel();
      this.motion.settle();
      return;
    }
    const state = getApp<MusicApp>().player?.state;
    if (
      !this.visible ||
      !state?.current ||
      state.loading ||
      this.data.queueOpen ||
      this.motion?.phase !== "idle"
    )
      return;
    if (!this.gesture?.start(event.touches, event.timeStamp)) return;
    this.gestureIdentity = playbackKey(state);
    ++this.scrollGeneration;
    this.measureSwipeHeight();
    this.motion.start();
  },
  swipeMove(event: WechatMiniprogram.TouchEvent) {
    if (this.motion?.phase !== "dragging") return;
    const offset = this.gesture?.move(event.touches, event.timeStamp);
    if (offset === null || offset === undefined) this.motion.settle();
    else this.motion.drag(offset);
  },
  swipeEnd(event: WechatMiniprogram.TouchEvent) {
    if (this.motion?.phase !== "dragging") return;
    const identity = this.gestureIdentity;
    const direction = this.gesture?.end(
      event.changedTouches,
      event.touches.length,
      event.timeStamp,
    );
    const state = getApp<MusicApp>().player?.state;
    if (
      !this.visible ||
      !state?.current ||
      state.loading ||
      this.data.queueOpen ||
      identity !== playbackKey(state)
    ) {
      this.cancelSwipe();
      return;
    }
    if (!direction) {
      this.motion.settle();
      return;
    }
    const target = this.swipeCandidate(direction);
    if (!target) {
      this.motion.settle();
      wx.showToast({ title: "当前只有一首歌", icon: "none" });
      return;
    }
    const targetKey = trackKey(target);
    this.swipeTarget = targetKey;
    this.motion.leave(direction, this.swipeHeight, () => {
      const player = getApp<MusicApp>().player;
      if (
        !this.visible ||
        !player?.state.current ||
        player.state.loading ||
        this.data.queueOpen ||
        playbackKey(player.state) !== identity ||
        trackKey(this.swipeCandidate(direction)) !== targetKey
      )
        return false;
      void player.next(direction);
      return trackKey(player.state.current) === targetKey;
    });
  },
  swipeCancel() {
    this.gesture?.cancel();
    this.motion?.settle();
  },
  onResize() {
    this.cancelSwipe();
    this.swipeHeight = 0;
    if (this.visible) this.measureSwipeHeight();
  },
  cancelSwipe() {
    this.gesture?.cancel();
    this.gestureIdentity = "";
    this.swipeTarget = "";
    ++this.measurementRevision;
    ++this.scrollGeneration;
    this.motion?.cancel();
  },
  toggleLyrics() {
    this.cancelSwipe();
    ++this.scrollGeneration;
    this.setData({ lyricsVisible: !this.data.lyricsVisible }, () => {
      if (this.data.lyricsVisible) this.lyrics?.follow();
    });
  },
  renderQueue(current: Song | null) {
    const songs = getApp<MusicApp>().player?.queueSnapshot?.() || [];
    const queueCount = songs.length;
    if (queueCount !== this.data.queueCount) this.setData({ queueCount });
    if (!this.data.queueOpen) return;
    const items = songs.map((song) => {
      const active =
        !!current &&
        song.source === current.source &&
        song.source_track_id === current.source_track_id;
      return {
        key: song.source + ":" + song.source_track_id,
        title: song.title,
        artist: song.artist,
        sourceName:
          active && this.data.sourceName
            ? this.data.sourceName
            : song.play_source_name ||
              (song.play_source ? sourceNames[song.play_source] : "") ||
              sourceNames[song.source] ||
              "",
        active,
      };
    });
    const revision = JSON.stringify(items);
    if (revision === this.queueRevision) return;
    this.queueRevision = revision;
    const activeIndex = items.findIndex((item) => item.active);
    this.setData({
      queueItems: items,
      queueActiveId: activeIndex >= 0 ? "queue-row-" + activeIndex : "",
    });
  },
  openQueue() {
    this.cancelSwipe();
    this.queueRevision = "";
    this.setData({ queueOpen: true });
    this.renderQueue(getApp<MusicApp>().player?.state.current || null);
  },
  closeQueue() {
    if (this.data.queueOpen) this.setData({ queueOpen: false });
  },
  swallowTouch() {},
  selectQueueSong(event: WechatMiniprogram.TouchEvent) {
    const player = getApp<MusicApp>().player;
    const song = player
      ?.queueSnapshot()
      .find(
        (item) =>
          item.source + ":" + item.source_track_id ===
          event.currentTarget.dataset.key,
      );
    this.closeQueue();
    if (!song || !player) {
      wx.showToast({ title: "该歌曲已从当前队列移除", icon: "none" });
      return;
    }
    const current = player.state.current;
    if (
      current?.source === song.source &&
      current.source_track_id === song.source_track_id
    )
      return;
    void player.play(song);
  },
  seek(event: WechatMiniprogram.SliderChange) {
    this.cancelSwipe();
    getApp<MusicApp>().player?.seek(event.detail.value);
  },
  retryLyrics() {
    this.lyrics?.retry();
  },
  manualStart() {
    this.cancelSwipe();
    ++this.scrollGeneration;
    this.lyrics?.manualStart();
  },
  manualEnd() {
    this.lyrics?.manualEnd();
  },
  manualScroll() {
    this.lyrics?.manualScroll();
  },
  followLyrics() {
    this.lyrics?.follow();
  },
  async toggleMark(event: WechatMiniprogram.TouchEvent) {
    const kind = event.currentTarget.dataset.kind as "favorite" | "like";
    if (!["favorite", "like"].includes(kind)) return;
    const app = getApp<MusicApp>(),
      song = app.player?.state.current,
      personal = app.personal;
    if (!song || !personal) return;
    try {
      // PersonalStore deduplicates per song and mark without disabling both buttons.
      await personal.mark(kind, song, !personal.has(kind, song));
    } catch (e) {
      this.setData({
        personalError: e instanceof Error ? e.message : "保存失败",
      });
    }
  },
  onShareAppMessage() {
    return shareCard(
      this.sharedSong || getApp<MusicApp>().player?.state.current || null,
    );
  },
  onShareTimeline() {
    return timelineCard(
      this.sharedSong || getApp<MusicApp>().player?.state.current || null,
    );
  },
});
