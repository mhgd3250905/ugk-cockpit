import assert from 'node:assert/strict';
import test from 'node:test';
import {
  timelineConnectorEnd,
  timelineCurveGeometry,
  timelineCurveSourceY,
  timelineEntryNodeOffset,
  timelineRailEndY,
} from '../web/src/timeline-geometry.mjs';

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

test('timeline connectors never run backwards from the rightmost rail', () => {
  assert.equal(timelineConnectorEnd(121, 132), 128);
  assert.equal(timelineConnectorEnd(125, 132), 132);
  assert.ok(timelineConnectorEnd(125, 132) >= 125 + 7);
});

test('timeline continuation origins share the source-node geometry', () => {
  assert.equal(timelineEntryNodeOffset('origin'), 15);
  assert.equal(timelineEntryNodeOffset('origin-continuation'), 15);
  assert.equal(timelineEntryNodeOffset('event'), 21);
});
