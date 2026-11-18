const { test } = require("node:test");
const assert = require("node:assert/strict");
const { TrackSwipe } = require("../dist/shared/player-gestures.js");
const point = (x, y, identifier = 1) => ({
  identifier,
  clientX: x,
  clientY: y,
});
const flick = (end, elapsed = 200) => {
  const gesture = new TrackSwipe();
  gesture.start([point(100, 200)], 10);
  return gesture.end([end], 0, 10 + elapsed);
};
test("vertical flicks map upwards to next and downwards to previous, one result per gesture", () => {
  assert.equal(flick(point(110, 100)), 1);
  assert.equal(flick(point(95, 300)), -1);
  const gesture = new TrackSwipe();
  gesture.start([point(100, 200)], 1);
  assert.equal(gesture.end([point(100, 100)], 0, 201), 1);
  assert.equal(gesture.end([point(100, 100)], 0, 202), 0);
});
test("taps, short/diagonal/horizontal moves, long presses and invalid points never skip", () => {
  for (const p of [
    point(100, 200),
    point(100, 150),
    point(200, 100),
    point(240, 200),
    point(NaN, 10),
    point(100, Infinity),
  ])
    assert.equal(flick(p), 0);
  assert.equal(flick(point(100, 100), 1000), 0);
  assert.equal(flick(point(100, 100), -1), 0);
  assert.equal(flick(point(100, 100, 2)), 0);
});
test("cancel, multi-touch and horizontal-first gestures cannot turn into a late skip", () => {
  const gesture = new TrackSwipe();
  for (const interrupt of [
    () => gesture.cancel(),
    () => gesture.move([point(100, 200), point(110, 210, 2)]),
    () => gesture.move([point(160, 205)]),
    () => gesture.start([point(100, 200), point(100, 200, 2)], 10),
  ]) {
    gesture.start([point(100, 200)], 10);
    interrupt();
    assert.equal(gesture.end([point(100, 50)], 0, 200), 0);
  }
  gesture.start([point(100, 200)], 10);
  assert.equal(gesture.end([point(100, 50)], 1, 200), 0);
});
