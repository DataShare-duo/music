export type TransitionPhase =
  "idle" | "dragging" | "leaving" | "entering" | "settling";
export interface TransitionFrame {
  phase: TransitionPhase;
  offset: number;
  opacity: number;
  duration: number;
  revision: number;
}
export interface TransitionClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export const transitionTiming = {
  frame: 32,
  leave: 140,
  enter: 220,
  settle: 180,
  eventGrace: 48,
  renderTimeout: 96,
} as const;
const defaultClock: TransitionClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** Only animates presentation: the page validates a live queue before committing once. */
export class TrackTransition {
  frame: TransitionFrame = {
    phase: "idle",
    offset: 0,
    opacity: 1,
    duration: 0,
    revision: 0,
  };
  private generation = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private dragTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingOffset = 0;
  private lastDragPaint = -Infinity;
  private startedAt = 0;
  private finishAction: (() => void) | null = null;

  constructor(
    private changed: (frame: TransitionFrame, rendered?: () => void) => void,
    private clock: TransitionClock = defaultClock,
  ) {}

  get phase(): TransitionPhase {
    return this.frame.phase;
  }

  private later(
    ms: number,
    callback: () => void,
  ): ReturnType<typeof setTimeout> {
    const token = this.generation;
    const timer = this.clock.setTimeout(() => {
      this.timers.delete(timer);
      if (token === this.generation) callback();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  private clearTimers(): void {
    for (const timer of this.timers) this.clock.clearTimeout(timer);
    this.timers.clear();
    this.dragTimer = undefined;
  }

  private paint(
    phase: TransitionPhase,
    offset: number,
    opacity: number,
    duration: number,
    rendered?: () => void,
  ): void {
    this.frame = {
      phase,
      offset,
      opacity,
      duration,
      revision: this.frame.revision + 1,
    };
    this.startedAt = this.clock.now();
    this.changed({ ...this.frame }, rendered);
  }

  start(): boolean {
    if (this.phase !== "idle") return false;
    ++this.generation;
    this.pendingOffset = 0;
    this.lastDragPaint = -Infinity;
    this.paint("dragging", 0, 1, 0);
    return true;
  }

  drag(distance: number): void {
    if (this.phase !== "dragging") return;
    if (!Number.isFinite(distance)) {
      this.settle();
      return;
    }
    this.pendingOffset = Math.max(-96, Math.min(96, distance * 0.65));
    const elapsed = this.clock.now() - this.lastDragPaint;
    if (elapsed >= transitionTiming.frame) {
      if (this.dragTimer !== undefined) {
        this.clock.clearTimeout(this.dragTimer);
        this.timers.delete(this.dragTimer);
        this.dragTimer = undefined;
      }
      this.flushDrag();
    } else if (this.dragTimer === undefined) {
      this.dragTimer = this.later(transitionTiming.frame - elapsed, () => {
        this.dragTimer = undefined;
        this.flushDrag();
      });
    }
  }

  private flushDrag(): void {
    if (this.phase !== "dragging") return;
    this.lastDragPaint = this.clock.now();
    if (this.pendingOffset !== this.frame.offset)
      this.paint("dragging", this.pendingOffset, 1, 0);
  }

  settle(): void {
    if (this.phase !== "dragging") return;
    this.clearTimers();
    if (!this.frame.offset) {
      this.cancel();
      return;
    }
    this.paint("settling", 0, 1, transitionTiming.settle);
    this.armEnd(() => this.cancel());
  }

  leave(direction: -1 | 1, height: number, commit: () => boolean): void {
    if (this.phase !== "dragging") return;
    if (!Number.isFinite(height) || height <= 0) {
      this.settle();
      return;
    }
    this.clearTimers();
    this.paint("leaving", -direction * height, 0, transitionTiming.leave);
    this.armEnd(() => {
      // Commit can synchronously emit a loading snapshot: mark entering first.
      this.frame = { ...this.frame, phase: "entering" };
      const token = this.generation;
      let committed = false;
      try {
        committed = commit();
      } catch {
        /* Reset safely if the player was torn down. */
      }
      if (token !== this.generation) return;
      if (!committed) {
        this.cancel();
        return;
      }
      let ready = false;
      const watchdog = this.later(transitionTiming.renderTimeout, () =>
        this.cancel(),
      );
      this.paint("entering", direction * height, 0, 0, () => {
        if (ready || token !== this.generation || this.phase !== "entering")
          return;
        ready = true;
        this.clock.clearTimeout(watchdog);
        this.timers.delete(watchdog);
        this.later(transitionTiming.frame, () => {
          this.paint("entering", 0, 1, transitionTiming.enter);
          this.armEnd(() => this.cancel());
        });
      });
    });
  }

  private armEnd(action: () => void): void {
    this.finishAction = action;
    this.later(this.frame.duration + transitionTiming.eventGrace, () =>
      this.finish(),
    );
  }

  /** Native CSS events are optional; a bounded timer always completes the phase. */
  complete(revision: number): void {
    if (
      revision !== this.frame.revision ||
      !this.frame.duration ||
      this.clock.now() - this.startedAt < this.frame.duration - 8
    )
      return;
    this.finish();
  }

  private finish(): void {
    const action = this.finishAction;
    this.finishAction = null;
    this.clearTimers();
    action?.();
  }

  cancel(): void {
    ++this.generation;
    this.clearTimers();
    this.finishAction = null;
    if (this.phase !== "idle") this.paint("idle", 0, 1, 0);
  }
}
