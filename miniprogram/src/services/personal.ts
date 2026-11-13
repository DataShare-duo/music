import { Song } from "../types";
import { config } from "../config";
import { newRequestId } from "./api";
export type SavedSong = Pick<
  Song,
  | "source"
  | "source_track_id"
  | "title"
  | "artist"
  | "album"
  | "cover_url"
  | "duration"
>;
export type HistoryKind = "search" | "recent";
export type MarkKind = "favorite" | "like";
export interface Entry {
  key: string;
  at: number;
  song?: SavedSong;
  query?: string;
  sourceName?: string;
}
interface Operation {
  id: string;
  type: "put" | "remove" | "clear";
  at: number;
  key?: string;
  song?: SavedSong;
  query?: string;
  sourceName?: string;
}
interface History {
  epoch: number;
  items: Entry[];
  pending: Operation[];
}
interface CloudView {
  revision: number;
  active: boolean;
  userKey: string;
  avatar: string;
  favorite: Entry[];
  like: Entry[];
  search: { epoch: number; items: Entry[] } | null;
  recent: { epoch: number; items: Entry[] } | null;
  conflict?: boolean;
}
export interface PersonalData {
  version: 1;
  revision: number;
  active: boolean;
  userKey: string;
  avatar: string;
  favorite: Entry[];
  like: Entry[];
  search: History;
  recent: History;
  error: string;
}
export const songKey = (song: SavedSong) =>
  song.source + ":" + song.source_track_id;
export function savedSong(song: SavedSong): SavedSong {
  return {
    source: song.source,
    source_track_id: song.source_track_id,
    title: song.title.slice(0, 200),
    artist: song.artist.slice(0, 200),
    album: (song.album || "").slice(0, 200),
    cover_url: (song.cover_url || "").slice(0, 1024),
    duration: song.duration || 0,
  };
}
const fresh = (): PersonalData => ({
  version: 1,
  revision: 0,
  active: false,
  userKey: "",
  avatar: "",
  favorite: [],
  like: [],
  search: { epoch: 0, items: [], pending: [] },
  recent: { epoch: 0, items: [], pending: [] },
  error: "",
});
export class PersonalError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function callPersonal(
  action: string,
  data: object = {},
): Promise<CloudView> {
  let response;
  try {
    response = await wx.cloud.callFunction({
      name: "personal",
      config: { env: config.env },
      data: { action, data },
    });
  } catch {
    throw new PersonalError(
      "personal_unavailable",
      "个人服务暂不可用，请检查云函数部署，听歌不受影响",
    );
  }
  const result = response.result as {
    ok: boolean;
    data: CloudView;
    error?: { code: string; message: string };
  };
  if (!result?.ok)
    throw new PersonalError(
      result?.error?.code || "personal_unavailable",
      result?.error?.message || "个人服务返回异常",
    );
  return result.data;
}
export class PersonalStore {
  data: PersonalData = fresh();
  private listeners = new Set<(s: PersonalData) => void>();
  private syncing: Promise<void> | null = null;
  private syncRequested = false;
  private enabling: Promise<boolean> | null = null;
  private markBusy = new Set<string>();
  private markedSession = "";
  private operationChain: Promise<void> = Promise.resolve();
  constructor(
    private call = callPersonal,
    private id = newRequestId,
    private storage = {
      read: () => wx.getStorageSync("music.personal.v1"),
      write: (x: PersonalData) => wx.setStorageSync("music.personal.v1", x),
    },
  ) {
    try {
      const x = storage.read();
      if (
        x?.version === 1 &&
        typeof x.active === "boolean" &&
        typeof x.userKey === "string" &&
        typeof x.avatar === "string" &&
        [x.search, x.recent].every(
          (h) =>
            Number.isSafeInteger(h?.epoch) &&
            h.epoch >= 0 &&
            Array.isArray(h.items) &&
            Array.isArray(h.pending),
        ) &&
        Array.isArray(x.favorite) &&
        Array.isArray(x.like)
      ) {
        this.data = x;
        this.data.error = "";
        this.data.favorite = x.favorite.slice(0, 200);
        this.data.like = x.like.slice(0, 200);
        this.data.search.items = x.search.items.slice(0, 20);
        this.data.recent.items = x.recent.items.slice(0, 100);
        for (const kind of ["search", "recent"] as HistoryKind[])
          this.data[kind].pending = x[kind].pending.slice(-120);
      }
    } catch {}
  }
  subscribe(fn: (s: PersonalData) => void): () => void {
    this.listeners.add(fn);
    fn(this.data);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    try {
      this.storage.write(this.data);
    } catch {
      this.data.error = "本机缓存保存失败";
    }
    for (const fn of this.listeners) fn(this.data);
  }
  private error(e: unknown) {
    this.data.error = e instanceof Error ? e.message : "个人同步失败";
    this.emit();
  }
  private profile(view: CloudView) {
    if (this.data.userKey && this.data.userKey !== view.userKey) {
      this.data = fresh();
    }
    if (view.active && view.revision < this.data.revision) return;
    this.data.revision = view.revision;
    this.data.active = view.active;
    this.data.userKey = view.userKey;
    this.data.avatar = view.avatar;
    this.data.favorite = view.favorite;
    this.data.like = view.like;
  }
  async enable(): Promise<boolean> {
    if (this.data.active) return true;
    if (this.enabling) return this.enabling;
    this.enabling = (async () => {
      const answer = await wx.showModal({
        title: "启用个人空间",
        content:
          "使用当前微信身份保存收藏、喜欢和历史，不需要手机号，头像可自愿设置",
        confirmText: "启用",
      });
      if (!answer.confirm) return false;
      try {
        const view = await this.call("profile.enable");
        this.profile(view);
        this.data.error = "";
        this.emit();
        await this.sync();
        return true;
      } catch (e) {
        this.error(e);
        return false;
      }
    })().finally(() => {
      this.enabling = null;
    });
    return this.enabling;
  }
  async sync(): Promise<void> {
    if (!this.data.active) return;
    if (this.syncing) {
      this.syncRequested = true;
      return this.syncing;
    }
    this.syncing = this.flush().finally(() => {
      this.syncing = null;
      if (this.syncRequested) {
        this.syncRequested = false;
        void this.sync();
      }
    });
    return this.syncing;
  }
  private async flush() {
    try {
      const profile = await this.call("profile.get");
      this.profile(profile);
      if (!profile.active)
        throw new PersonalError(
          "profile_required",
          "云端个人空间不存在，请重新启用",
        );
      this.data.error = "";
      for (const kind of ["search", "recent"] as HistoryKind[]) {
        // Do not rebase stale puts onto a cloud epoch changed by delete/clear.
        const local = this.data[kind],
          remote = profile[kind]!;
        if (local.epoch !== remote.epoch) {
          local.epoch = remote.epoch;
          local.items = remote.items;
          local.pending = local.pending.filter((x) => x.type !== "put");
          this.apply(kind, local.pending);
          this.data.error = "历史已按云端最新清理状态更新";
        }
        const pending = local.pending.slice(0, 120),
          ids = new Set(pending.map((x) => x.id));
        const view = await this.call("history.sync", {
          kind,
          epoch: local.epoch,
          ops: pending,
        });
        const state = view[kind]!;
        if (view.conflict) {
          local.pending = local.pending.filter((x) => x.type !== "put");
          local.items = state.items;
          this.apply(kind, local.pending);
          this.syncRequested ||= local.pending.length > 0;
        } else {
          local.pending = local.pending.filter((x) => !ids.has(x.id));
          local.items = state.items;
          this.apply(kind, local.pending);
        }
        local.epoch = state.epoch;
      }
      this.emit();
    } catch (e) {
      this.error(e);
    }
  }
  private apply(kind: HistoryKind, ops: Operation[]) {
    const h = this.data[kind];
    for (const op of ops) {
      if (op.type === "clear") {
        h.items = [];
        continue;
      }
      const key = op.key || (op.song ? songKey(op.song) : op.query!);
      h.items = h.items.filter((x) => x.key !== key);
      if (op.type === "put")
        h.items.unshift({
          key,
          at: op.at,
          ...(op.song
            ? { song: op.song, sourceName: op.sourceName }
            : { query: op.query }),
        });
    }
    h.items.sort((a, b) => b.at - a.at);
    h.items = h.items.slice(0, kind === "search" ? 20 : 100);
  }
  private queue(kind: HistoryKind, op: Omit<Operation, "id">): Promise<void> {
    const task = this.operationChain.then(() => this.enqueue(kind, op));
    this.operationChain = task.catch(() => {});
    return task;
  }
  private async enqueue(kind: HistoryKind, op: Omit<Operation, "id">) {
    const id = await this.id(),
      h = this.data[kind];
    const event = { ...op, id };
    const keyOfOperation = (x: Omit<Operation, "id">) =>
      x.key || (x.song ? songKey(x.song) : x.query);
    let pending =
      op.type === "clear"
        ? []
        : h.pending.filter(
            (x) =>
              x.type === "clear" || keyOfOperation(x) !== keyOfOperation(op),
          );
    pending.push(event);
    // Never silently evict a delete/clear barrier from a full offline queue.
    while (pending.length > 120) {
      const index = pending.findIndex((x) => x.type === "put");
      if (index < 0) throw new Error("离线清理队列已满，请联网同步后重试");
      if (pending[index].id === event.id)
        throw new Error("本机待同步队列已满，请联网后重试");
      pending.splice(index, 1);
    }
    h.pending = pending;
    this.apply(kind, [event]);
    this.emit();
    void this.sync();
  }
  recordSearch(query: string) {
    query = query.trim();
    if (!query || query.length > 100) return;
    void this.queue("search", { type: "put", query, at: Date.now() }).catch(
      (e) => this.error(e),
    );
  }
  recordPlayed(song: SavedSong, sessionId: string, sourceName: string) {
    if (!sessionId || sessionId === this.markedSession) return;
    this.markedSession = sessionId;
    void this.queue("recent", {
      type: "put",
      song: savedSong(song),
      sourceName,
      at: Date.now(),
    }).catch((e) => this.error(e));
  }
  async remove(kind: HistoryKind, key: string) {
    try {
      await this.queue(kind, { type: "remove", key, at: Date.now() });
      await this.sync();
    } catch (e) {
      this.error(e);
    }
  }
  async clear(kind: HistoryKind) {
    const result = await wx.showModal({
      title: "清空记录",
      content: "将清空本机及云端记录，此操作不可恢复",
      confirmText: "清空",
    });
    if (result.confirm) {
      try {
        await this.queue(kind, { type: "clear", at: Date.now() });
        await this.sync();
      } catch (e) {
        this.error(e);
      }
    }
  }
  has(kind: MarkKind, song: SavedSong) {
    return this.data[kind].some((x) => x.key === songKey(song));
  }
  async mark(kind: MarkKind, song: SavedSong, value: boolean): Promise<void> {
    const copy = savedSong(song),
      key = kind + ":" + songKey(copy);
    if (this.markBusy.has(key)) return;
    this.markBusy.add(key);
    try {
      if (!(await this.enable())) return;
      const view = await this.call("mark.set", {
        kind,
        song: copy,
        value,
        opId: await this.id(),
      });
      this.profile(view);
      this.data.error = "";
      this.emit();
    } catch (e) {
      this.error(e);
      throw e;
    } finally {
      this.markBusy.delete(key);
    }
  }
  async setAvatar(path: string) {
    if (!(await this.enable())) return;
    let fileID = "";
    try {
      const info = await new Promise<{ size: number }>((resolve, reject) =>
        wx
          .getFileSystemManager()
          .getFileInfo({ filePath: path, success: resolve, fail: reject }),
      );
      if (info.size > 2 * 1024 * 1024) throw new Error("头像不能超过2 MiB");
      const upload = await wx.cloud.uploadFile({
        cloudPath:
          "avatars/" + this.data.userKey + "/" + (await this.id()) + ".jpg",
        filePath: path,
      });
      fileID = upload.fileID;
      const view = await this.call("avatar.set", { fileID });
      this.profile(view);
      this.data.error = "";
      this.emit();
    } catch (e) {
      // A lost response may mean the new avatar was committed: never delete it blindly.
      if (
        fileID &&
        e instanceof PersonalError &&
        [
          "invalid_avatar",
          "rate_limited",
          "profile_required",
          "invalid_input",
          "invalid_identity",
          "unauthenticated",
        ].includes(e.code)
      )
        void wx.cloud.deleteFile({ fileList: [fileID] }).catch(() => {});
      this.error(e);
      throw e;
    }
  }
}
