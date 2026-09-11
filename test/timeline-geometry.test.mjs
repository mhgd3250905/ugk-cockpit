import assert from 'node:assert/strict';
import test from 'node:test';
import {
  timelineCurveGeometry,
  timelineCurveSourceY,
  timelineRailEndY,
  timelineRailSegments,
} from '../web/src/timeline-geometry.mjs';

test('closed work line ends at its close row instead of the latest time', () => {
  assert.deepEqual(timelineRailSegments({ endY: 500, status: 'closed', transitions: [
    { kind: 'work_line_closed', y: 160 },
  ] }), [[160, 500]]);
});

test('reopened work lines leave inactive intervals disconnected', () => {
  assert.deepEqual(timelineRailSegments({ endY: 500, status: 'open', transitions: [
    { kind: 'work_line_reopened', y: 80 },
    { kind: 'work_line_closed', y: 180 },
    { kind: 'work_line_reopened', y: 260 },
    { kind: 'work_line_closed', y: 340 },
  ] }), [[3, 80], [180, 260], [340, 500]]);
});

test('closed lanes without a known close row do not invent an active rail', () => {
  assert.deepEqual(timelineRailSegments({ endY: 500, status: 'closed' }), []);
  assert.deepEqual(timelineRailSegments({ endY: 500 }), [[3, 500]]);
});

test('rail uses event state when no persisted line state was supplied', () => {
  assert.deepEqual(timelineRailSegments({ endY: 500, transitions: [
    { kind: 'work_line_closed', y: 70 },
    { kind: 'work_line_reopened', y: 120 },
    { kind: 'work_line_closed', y: 180 },
  ] }), [[70, 120], [180, 500]]);
});

function assertMetroGeometry(curve) {
  const minX = Math.min(curve.start.x, curve.end.x);
  const maxX = Math.max(curve.start.x, curve.end.x);
  assert.ok(curve.radius > 0);
  assert.ok(curve.radius <= 8);
  assert.ok(curve.sourceArcEnd.x > minX && curve.sourceArcEnd.x < maxX);
  assert.ok(curve.targetArcStart.x > minX && curve.targetArcStart.x < maxX);
  assert.equal(curve.sourceVerticalEnd.x, curve.start.x);
  assert.equal(curve.targetVerticalStart.x, curve.end.x);
  assert.equal(curve.sourceArcEnd.y, curve.middleY);
  assert.equal(curve.targetArcStart.y, curve.middleY);
  assert.equal(curve.sourceVerticalEnd.y, curve.middleY + curve.radius);
  assert.equal(curve.targetVerticalStart.y, curve.middleY - curve.radius);
  assert.equal(curve.start.y - curve.sourceVerticalEnd.y, curve.lead);
  assert.equal(curve.targetVerticalStart.y - curve.end.y, curve.lead);
  assert.equal(
    Math.abs(curve.sourceArcEnd.x - curve.start.x),
    curve.radius,
  );
  assert.equal(
    Math.abs(curve.end.x - curve.targetArcStart.x),
    curve.radius,
  );
}

test('timeline curves use equal-radius turns tangent to both vertical rails', () => {
  const branch = timelineCurveGeometry({
    sourceX: 12,
    targetX: 82,
    sourceY: 148,
    targetY: 120,
  });
  const returnPath = timelineCurveGeometry({
    sourceX: 82,
    targetX: 12,
    sourceY: 148,
    targetY: 120,
  });

  assertMetroGeometry(branch);
  assertMetroGeometry(returnPath);
  assert.ok(branch.start.y > branch.end.y);
  assert.ok(returnPath.start.y > returnPath.end.y);
  assert.equal(branch.start.x, 12);
  assert.equal(branch.end.x, 82);
  assert.equal(returnPath.start.x, 82);
  assert.equal(returnPath.end.x, 12);
});

test('timeline curve radius is constrained by narrow rail span and short vertical room', () => {
  const narrow = timelineCurveGeometry({
    sourceX: 40,
    targetX: 52,
    sourceY: 160,
    targetY: 120,
  });
  assert.ok(narrow);
  assert.equal(narrow.radius, 6);
  assert.equal(narrow.sourceArcEnd.x, 46);
  assert.equal(narrow.targetArcStart.x, 46);

  assert.equal(
    timelineCurveGeometry({
      sourceX: 40,
      targetX: 80,
      sourceY: 128,
      targetY: 120,
    }),
    null,
  );
});

test('timeline rail ends at a known development-space origin', () => {
  assert.equal(
    timelineRailEndY({ laneRole: 'development_space', originY: 240, historyHeight: 900 }),
    240,
  );
  assert.equal(
    timelineRailEndY({ laneRole: 'development_space', originY: 980, historyHeight: 900 }),
    897,
  );
  assert.equal(
    timelineRailEndY({ laneRole: 'unknown', originY: 240, historyHeight: 900 }),
    897,
  );
});

test('timeline curve source endpoint stays on the available older rail segment', () => {
  assert.equal(timelineCurveSourceY(120, 180), 148);
  assert.equal(timelineCurveSourceY(120, 180, 14), 134);
  assert.equal(timelineCurveSourceY(120, 126, 14), 126);
  assert.equal(timelineCurveSourceY(120, 120, 14), null);
});
