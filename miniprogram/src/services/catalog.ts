import { Api, SongList, Source } from "../types";

export interface CatalogState {
  result: SongList | null;
  loading: boolean;
  error: string;
  revision: number;
}
export class Catalog {
  state: CatalogState = {
    result: null,
    loading: false,
    error: "",
    revision: 0,
  };
  mode: "home" | "search" = "home";
  query = "";
  source: Source = "soda";
  page = 1;
  private active = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private api: Api,
    private changed: (state: CatalogState) => void,
    private revision: () => number = () => 0,
  ) {}
  private clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private emit(): void {
    this.changed({ ...this.state });
  }
  resume(): void {
    this.active = true;
    void this.load();
  }
  pause(): void {
    this.active = false;
    ++this.generation;
    this.clear();
  }
  change(
    mode: "home" | "search",
    query = "",
    source: Source = "soda",
    page = 1,
  ): void {
    this.mode = mode;
    this.query = query.trim();
    this.source = source;
    this.page = page;
    this.state.result = null;
    if (this.active) void this.load(true);
  }
  async load(shuffle = false): Promise<void> {
    this.clear();
    const token = ++this.generation;
    this.state.revision = this.revision();
    this.state.loading = true;
    this.state.error = "";
    this.emit();
    if (this.mode === "search" && !this.query) {
      this.state.loading = false;
      this.state.error = "请输入歌名或歌手";
      this.emit();
      return;
    }
    let path = "/api/home";
    if (this.mode === "search")
      path =
        "/api/search?q=" +
        encodeURIComponent(this.query) +
        "&source=" +
        this.source +
        "&page=" +
        this.page;
    else if (!shuffle && this.state.result?.items.length)
      path +=
        "?ids=" + this.state.result.items.map((song) => song.id).join(",");
    try {
      const result = await this.api.get<SongList>(path);
      if (token !== this.generation || !this.active) return;
      this.state.result = result;
    } catch (e) {
      if (token !== this.generation || !this.active) return;
      this.state.error = e instanceof Error ? e.message : "获取歌曲失败";
    }
    if (token !== this.generation || !this.active) return;
    this.state.loading = false;
    this.emit();
    this.timer = setTimeout(
      () => {
        void this.load();
      },
      this.state.result?.refreshing ? 3000 : 60000,
    );
  }
}
