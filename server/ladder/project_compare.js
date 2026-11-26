'use strict';

function same(a, b, tolerance) {
  return a === b || Object.is(a, b) ||
    (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance);
}

function difference(kind, time, key, baseline, candidate, tolerance) {
  if (!same(baseline, candidate, tolerance)) return { kind, time, key, baseline, candidate };
}

function firstSnapshotDifference(kind, time, a, b, tolerance) {
  for (const key of Object.keys(a)) {
    const found = difference(kind, time, key, a[key], b[key], tolerance);
    if (found) return found;
  }
}

function firstScanDifference(a, b, tolerance) {
  // Both timelines contain only changes, ordered by scan. Apply all changes from
  // both versions in a scan before comparing their sampled states.
  const left = new Map(Object.entries(a.initial));
  const right = new Map(Object.entries(b.initial));
  const scanMs = b.scanMs;
  const commonEnd = Math.min(a.time, b.time);
  let i = 0, j = 0;
  while (i < a.timeline.length || j < b.timeline.length) {
    const t = Math.min(a.timeline[i]?.t ?? Infinity, b.timeline[j]?.t ?? Infinity);
    if (t >= commonEnd) break;
    const keys = new Set();
    while (a.timeline[i]?.t === t) {
      const { key, to } = a.timeline[i++];
      left.set(key, to);
      keys.add(key);
    }
    while (b.timeline[j]?.t === t) {
      const { key, to } = b.timeline[j++];
      right.set(key, to);
      keys.add(key);
    }
    const time = t + scanMs;
    for (const key of keys) {
      const found = difference('scan', time, key, left.get(key), right.get(key), tolerance);
      if (found) return { ...found, scan: (t / scanMs) + 1 };
    }
  }
}

// Assertion values follow the same BOOL/zero convention as watched samples.
const actual = value => typeof value === 'boolean' ? Number(value) : value === undefined ? 0 : value;

function firstAssertionDifference(a, b, tolerance) {
  for (const [i, left] of a.expects.entries()) {
    const right = b.expects[i];
    const time = Math.min(left.t, right.t);
    const assertion = { kind: 'assertion', time, key: left.key, step: left.step };
    if (left.t !== right.t) return { ...assertion, field: 'time', baseline: left.t, candidate: right.t };
    const from = actual(left.actual);
    const to = actual(right.actual);
    if (!same(from, to, tolerance)) {
      return { ...assertion, field: 'actual', baseline: from, candidate: to };
    }
    if (left.ok !== right.ok) return { ...assertion, field: 'verdict', baseline: left.ok, candidate: right.ok };
  }
}

function compareCase(baseline, candidate, tolerance) {
  const { name } = candidate;
  const statuses = { name, baselineStatus: baseline.status, candidateStatus: candidate.status };
  const a = baseline.result;
  const b = candidate.result;
  if (!a || !b) {
    return {
      ...statuses,
      status: 'error',
      ...(baseline.message && { baselineMessage: baseline.message }),
      ...(candidate.message && { candidateMessage: candidate.message }),
    };
  }

  const initial = firstSnapshotDifference('initial', 0, a.initial, b.initial, tolerance);
  const scan = initial ? undefined : firstScanDifference(a, b, tolerance);
  const assertion = initial ? undefined : firstAssertionDifference(a, b, tolerance);
  const end = a.time === b.time
    ? firstSnapshotDifference('final', b.time, a.final, b.final, tolerance)
    : difference('duration', Math.min(a.time, b.time), 'time', a.time, b.time, 0);
  // A time tie keeps the earlier phase in the order below.
  let firstDifference;
  for (const found of [initial, scan, assertion, end]) {
    if (found && (!firstDifference || found.time < firstDifference.time)) firstDifference = found;
  }
  return firstDifference ? { ...statuses, status: 'different', firstDifference } : { ...statuses, status: 'matched' };
}

function formatDifference(delta) {
  const values = JSON.stringify(delta.baseline) + ' -> ' + JSON.stringify(delta.candidate);
  if (delta.kind === 'duration') return 'Simulated duration changed: ' + values + ' ms';
  const at = delta.kind === 'scan' ? 'scan ' + delta.scan :
    delta.kind === 'assertion' ? 'step ' + delta.step + ' assertion ' + delta.field : delta.kind + ' state';
  return at + ' @' + delta.time + 'ms ' + delta.key + ': baseline -> candidate ' + values;
}

module.exports = { compareCase, formatDifference };
