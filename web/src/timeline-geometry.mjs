const TIMELINE_CURVE_MAX_RADIUS = 8;
const TIMELINE_CURVE_MIN_LEAD = 4;

/**
 * Return the compact orthogonal geometry for a rail connection.
 *
 * Both endpoints sit on real vertical rails. The short vertical lead at each
 * end lets the two rounded turns meet those rails tangentially, while the
 * middle segment stays horizontal. Radius and lead are constrained by the
 * measured rail span and vertical separation, so narrow layouts do not
 * overshoot a neighbouring lane or a card row.
 */
export function timelineCurveGeometry({ sourceX, targetX, sourceY, targetY }) {
  const deltaX = targetX - sourceX;
  const span = Math.abs(deltaX);
  const deltaY = sourceY - targetY;
  if (
    !Number.isFinite(sourceX)
    || !Number.isFinite(targetX)
    || !Number.isFinite(sourceY)
    || !Number.isFinite(targetY)
    || span === 0
    || deltaY <= TIMELINE_CURVE_MIN_LEAD * 2
  ) {
    return null;
  }

  const direction = deltaX > 0 ? 1 : -1;
  const radius = Math.min(
    TIMELINE_CURVE_MAX_RADIUS,
    span / 2,
    (deltaY / 2) - TIMELINE_CURVE_MIN_LEAD,
  );
  if (radius <= 0) return null;

  const lead = (deltaY / 2) - radius;
  const middleY = targetY + deltaY / 2;
  const sourceArcEndX = sourceX + direction * radius;
  const targetArcStartX = targetX - direction * radius;

  return {
    start: { x: sourceX, y: sourceY },
    end: { x: targetX, y: targetY },
    direction,
    radius,
    lead,
    middleY,
    sourceVerticalEnd: { x: sourceX, y: middleY + radius },
    sourceArcEnd: { x: sourceArcEndX, y: middleY },
    targetArcStart: { x: targetArcStartX, y: middleY },
    targetVerticalStart: { x: targetX, y: middleY - radius },
  };
}

export function timelineCurvePath(options) {
  const curve = timelineCurveGeometry(options);
  if (!curve) return null;
  const sourceSweep = curve.direction > 0 ? 1 : 0;
  const targetSweep = curve.direction > 0 ? 0 : 1;
  return [
    `M ${curve.start.x} ${curve.start.y}`,
    `V ${curve.sourceVerticalEnd.y}`,
    `A ${curve.radius} ${curve.radius} 0 0 ${sourceSweep} ${curve.sourceArcEnd.x} ${curve.sourceArcEnd.y}`,
    `H ${curve.targetArcStart.x}`,
    `A ${curve.radius} ${curve.radius} 0 0 ${targetSweep} ${curve.targetVerticalStart.x} ${curve.targetVerticalStart.y}`,
    `V ${curve.end.y}`,
  ].join(' ');
}

export function timelineRailEndY({ laneRole, originY, historyHeight }) {
  const fullEnd = Math.max(3, historyHeight - 3);
  if (laneRole !== 'development_space' || !Number.isFinite(originY)) return fullEnd;
  return Math.min(fullEnd, Math.max(3, originY));
}

export function timelineCurveSourceY(targetY, railEndY, preferredDrop = 28) {
  if (!Number.isFinite(targetY) || !Number.isFinite(railEndY)) return null;
  const availableDrop = railEndY - targetY;
  if (availableDrop <= 0) return null;
  return targetY + Math.min(preferredDrop, availableDrop);
}
