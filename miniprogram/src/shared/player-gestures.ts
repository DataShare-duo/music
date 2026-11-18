export interface TouchPoint {
  identifier: number;
  clientX: number;
  clientY: number;
}

/** Single-finger vertical flicks only; taps, scrolling and cancelled gestures do nothing. */
export class TrackSwipe {
  private origin: TouchPoint | null = null;
  private startedAt = 0;

  start(touches: readonly TouchPoint[], at: number): boolean {
    this.cancel();
    if (touches.length !== 1 || !Number.isFinite(at)) return false;
    const point = touches[0];
    if (!Number.isFinite(point.clientX) || !Number.isFinite(point.clientY))
      return false;
    this.origin = { ...point };
    this.startedAt = at;
    return true;
  }

  move(touches: readonly TouchPoint[], at?: number): number | null {
    if (!this.origin) return null;
    const point = touches[0];
    if (
      touches.length !== 1 ||
      point.identifier !== this.origin.identifier ||
      !Number.isFinite(point.clientX) ||
      !Number.isFinite(point.clientY) ||
      (at !== undefined &&
        (!Number.isFinite(at) ||
          at - this.startedAt > 900 ||
          at < this.startedAt))
    ) {
      this.cancel();
      return null;
    }
    const x = Math.abs(point.clientX - this.origin.clientX);
    const dy = point.clientY - this.origin.clientY;
    const y = Math.abs(dy);
    if (x > 36 && x > y * 1.2) {
      this.cancel();
      return null;
    }
    return y >= 6 && y >= x * 1.5 ? dy : 0;
  }

  end(
    changed: readonly TouchPoint[],
    remaining: number,
    at: number,
  ): -1 | 0 | 1 {
    const origin = this.origin;
    const elapsed = at - this.startedAt;
    this.cancel();
    if (
      !origin ||
      remaining ||
      changed.length !== 1 ||
      !Number.isFinite(elapsed) ||
      elapsed < 0 ||
      elapsed > 900
    )
      return 0;
    const point = changed[0];
    if (point.identifier !== origin.identifier) return 0;
    const x = point.clientX - origin.clientX;
    const y = point.clientY - origin.clientY;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      Math.abs(y) < 56 ||
      Math.abs(y) < Math.abs(x) * 1.5
    )
      return 0;
    return y < 0 ? 1 : -1;
  }

  cancel(): void {
    this.origin = null;
  }
}
