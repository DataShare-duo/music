const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  TrackTransition,
  transitionTiming: timing,
} = require("../dist/shared/player-transition.js");
const { TestClock } = require("./helpers/clock.cjs");
const setup = (render = true) => {
  const clock = new TestClock(),
    frames = [],
    callbacks = [];
  const motion = new TrackTransition((frame, rendered) => {
    frames.push(frame);
    if (rendered) {
      callbacks.push(rendered);
      if (render) rendered();
    }
  }, clock);
  return { motion, clock, frames, callbacks };
};
const leaveEnd = timing.leave + timing.eventGrace;
const enterEnd = timing.frame + timing.enter + timing.eventGrace;

test("drag frames use 65% resistance, clamp to 96px and coalesce latest updates every 32ms", () => {
  const { motion, clock, frames } = setup();
  assert.equal(motion.start(), true);
  assert.equal(motion.start(), false);
  motion.drag(-100);
  assert.equal(motion.frame.offset, -65);
  const count = frames.length;
  for (let n = 0; n < 20; n++) {
    clock.tick(1);
    motion.drag(-120 - n);
  }
  assert.equal(frames.length, count);
  clock.tick(12);
  assert.equal(motion.frame.offset, -139 * 0.65);
  clock.tick(32);
  motion.drag(900);
  assert.equal(motion.frame.offset, 96);
  assert.ok(
    frames.every((frame) => frame.phase === "dragging" && frame.duration === 0),
  );
  motion.cancel();
  assert.equal(clock.tasks.size, 0);
});

test("upward release exits upwards, commits once, then enters below without awaiting audio", () => {
  const { motion, clock } = setup();
  let commits = 0;
  motion.start();
  motion.drag(-70);
  motion.leave(1, 480, () => {
    commits++;
    assert.equal(motion.phase, "entering");
    return true;
  });
  const outgoing = motion.frame.revision;
  assert.equal(motion.frame.offset, -480);
  assert.equal(motion.frame.duration, 140);
  clock.tick(139);
  motion.complete(outgoing);
  assert.equal(commits, 1); // A native end event within its final 8ms can finish the phase.
  assert.equal(motion.frame.offset, 480);
  assert.equal(motion.frame.duration, 0);
  motion.complete(outgoing);
  clock.tick(timing.frame);
  assert.equal(motion.frame.offset, 0);
  assert.equal(motion.frame.duration, 220);
  clock.tick(timing.enter + timing.eventGrace);
  assert.equal(motion.phase, "idle");
  assert.equal(commits, 1);
  assert.equal(clock.tasks.size, 0);
});

test("downward release mirrors the direction and timer fallback finishes without CSS events", () => {
  const { motion, clock } = setup();
  let commits = 0;
  motion.start();
  motion.drag(100);
  motion.leave(-1, 390, () => {
    commits++;
    return true;
  });
  assert.equal(motion.frame.offset, 390);
  clock.tick(leaveEnd);
  assert.equal(motion.frame.offset, -390);
  clock.tick(enterEnd);
  assert.equal(motion.phase, "idle");
  assert.equal(commits, 1);
});

test("short gestures rebound for 180ms without committing and queued drag frames cannot override the rebound", () => {
  const { motion, clock } = setup();
  motion.start();
  motion.drag(30);
  motion.drag(40);
  motion.settle();
  assert.equal(motion.frame.duration, 180);
  assert.equal(motion.frame.offset, 0);
  assert.equal(motion.phase, "settling");
  clock.tick(timing.settle + timing.eventGrace);
  assert.equal(motion.phase, "idle");
  assert.equal(clock.tasks.size, 0);
  motion.start();
  motion.settle();
  assert.equal(motion.phase, "idle");
});

test("cancel clears every phase and captured stale timers never commit or move a newer gesture", () => {
  for (const stage of ["dragging", "leaving", "entering", "settling"]) {
    const { motion, clock } = setup();
    let commits = 0;
    motion.start();
    motion.drag(-100);
    motion.drag(-110);
    if (stage === "settling") motion.settle();
    if (["leaving", "entering"].includes(stage))
      motion.leave(1, 400, () => {
        commits++;
        return true;
      });
    if (stage === "entering") clock.tick(leaveEnd);
    const stale = [...clock.tasks.values()].map((x) => x.fn);
    motion.cancel();
    const expected = commits;
    motion.start();
    for (const callback of stale) callback();
    clock.tick(1000);
    assert.equal(motion.phase, "dragging");
    assert.equal(motion.frame.offset, 0);
    assert.equal(commits, expected);
    motion.cancel();
    assert.equal(clock.tasks.size, 0);
  }
});

test("early/stale CSS events cannot finish a phase and event plus timeout never commits twice", () => {
  const { motion, clock } = setup();
  let commits = 0;
  motion.start();
  motion.drag(-80);
  motion.leave(1, 400, () => {
    commits++;
    return true;
  });
  const revision = motion.frame.revision;
  motion.complete(revision);
  motion.complete(revision - 1);
  assert.equal(commits, 0);
  clock.tick(timing.leave);
  motion.complete(revision);
  motion.complete(revision);
  clock.tick(1000);
  assert.equal(commits, 1);
  assert.equal(motion.phase, "idle");
});

test("failed live-queue validation, missing geometry and a throwing commit leave no locked page", () => {
  for (const commit of [
    () => false,
    () => {
      throw new Error("changed player");
    },
  ]) {
    const { motion, clock } = setup();
    motion.start();
    motion.drag(-70);
    motion.leave(1, 400, commit);
    clock.tick(leaveEnd);
    assert.equal(motion.phase, "idle");
    assert.equal(clock.tasks.size, 0);
  }
  for (const height of [0, NaN, -1]) {
    const { motion, clock } = setup();
    let commits = 0;
    motion.start();
    motion.drag(-70);
    motion.leave(1, height, () => {
      commits++;
      return true;
    });
    clock.tick(1000);
    assert.equal(commits, 0);
    assert.equal(motion.phase, "idle");
  }
});

test("missing native setData callbacks time out safely and their later callbacks cannot move another song", () => {
  const { motion, clock, callbacks } = setup(false);
  motion.start();
  motion.drag(-70);
  motion.leave(1, 400, () => true);
  clock.tick(leaveEnd);
  assert.equal(motion.phase, "entering");
  clock.tick(timing.renderTimeout);
  assert.equal(motion.phase, "idle");
  motion.start();
  callbacks[0]();
  clock.tick(1000);
  assert.equal(motion.phase, "dragging");
  assert.equal(motion.frame.offset, 0);
  motion.cancel();
});

test("a synchronous external cancellation during commit cannot schedule an old entrance", () => {
  const { motion, clock } = setup();
  motion.start();
  motion.drag(-70);
  motion.leave(1, 400, () => {
    motion.cancel();
    return true;
  });
  clock.tick(1000);
  assert.equal(motion.phase, "idle");
  assert.equal(clock.tasks.size, 0);
});
