const test = require('node:test');
const assert = require('node:assert');
const L = require('./Code.gs');

const MIN = 60000;
const H = 60 * MIN;
// Paris wall clock -> instant
const at = (y, mo, d, h, mi) => L.localToMs(y, mo, d, h, mi);

test('Paris offset and DST changes (2026: 29 Mar, 25 Oct)', () => {
  assert.equal(L.parisOffsetMin(Date.UTC(2026, 0, 15, 12)), 60);
  assert.equal(L.parisOffsetMin(Date.UTC(2026, 6, 15, 12)), 120);
  // spring forward at 01:00 UTC 29 Mar
  assert.equal(L.parisOffsetMin(Date.UTC(2026, 2, 29, 0, 59)), 60);
  assert.equal(L.parisOffsetMin(Date.UTC(2026, 2, 29, 1, 0)), 120);
  // fall back at 01:00 UTC 25 Oct
  assert.equal(L.parisOffsetMin(Date.UTC(2026, 9, 25, 0, 59)), 120);
  assert.equal(L.parisOffsetMin(Date.UTC(2026, 9, 25, 1, 0)), 60);
});

test('localToMs / localParts round trip across DST', () => {
  for (const [y, mo, d, h, mi] of [[2026, 1, 10, 9, 0], [2026, 7, 10, 22, 30], [2026, 3, 30, 7, 0], [2026, 10, 26, 7, 0], [2026, 10, 24, 23, 0]]) {
    const p = L.localParts(at(y, mo, d, h, mi));
    assert.deepEqual([p.y, p.mo, p.d, p.h, p.mi], [y, mo, d, h, mi]);
  }
});

test('profile ladders: priorities and delays', () => {
  const h = (s) => L.priorityFor('h', s), n = (s) => L.priorityFor('n', s);
  assert.deepEqual([0, 1, 2, 9].map(h), [4, 5, 5, 5]);
  assert.deepEqual([0, 1, 2, 9].map(n), [3, 4, 4, 4]);
  assert.deepEqual([0, 1, 2].map((s) => L.delayAfterMin('h', s)), [10, 15, 15]);
  assert.deepEqual([0, 1, 2].map((s) => L.delayAfterMin('n', s)), [20, 30, 30]);
});

test('step and nextAt progression, high profile, daytime', () => {
  const due = at(2026, 6, 10, 10, 0);
  let r = L.newRecord('h', 'e1', due, due, 'fp');
  assert.ok(L.isDue(r, due));
  assert.ok(!L.isDue(r, due - 1));
  r = L.advance(r, due);
  assert.equal(r.step, 1);
  assert.equal(r.nextAt, due + 10 * MIN);
  r = L.advance(r, due + 10 * MIN);
  assert.equal(r.step, 2);
  assert.equal(r.nextAt, due + 25 * MIN);
  r = L.advance(r, due + 25 * MIN);
  assert.equal(r.nextAt, due + 40 * MIN);   // repeats never end
  assert.equal(r.step, 3);
});

test('step and nextAt progression, normal profile', () => {
  const due = at(2026, 6, 10, 10, 0);
  let r = L.newRecord('n', 'e1', due, due, 'fp');
  r = L.advance(r, due);
  assert.equal(r.nextAt, due + 20 * MIN);
  r = L.advance(r, due + 20 * MIN);
  assert.equal(r.nextAt, due + 50 * MIN);
  r = L.advance(r, due + 50 * MIN);
  assert.equal(r.nextAt, due + 80 * MIN);
});

test('already overdue event: first reminder is immediate', () => {
  const due = at(2026, 6, 10, 10, 0);
  const r = L.newRecord('h', 'e1', due, due, 'fp');
  assert.ok(L.isDue(r, due + 5 * H));
});

test('quiet hours window', () => {
  assert.ok(L.inQuiet(at(2026, 6, 10, 22, 0)));
  assert.ok(L.inQuiet(at(2026, 6, 10, 23, 59)));
  assert.ok(L.inQuiet(at(2026, 6, 10, 0, 0)));
  assert.ok(L.inQuiet(at(2026, 6, 10, 6, 59)));
  assert.ok(!L.inQuiet(at(2026, 6, 10, 7, 0)));
  assert.ok(!L.inQuiet(at(2026, 6, 10, 21, 59)));
  assert.equal(L.quietEndFrom(at(2026, 6, 10, 23, 0)), at(2026, 6, 11, 7, 0));
  assert.equal(L.quietEndFrom(at(2026, 6, 10, 3, 0)), at(2026, 6, 10, 7, 0));
  assert.equal(L.quietEndFrom(at(2026, 6, 10, 12, 0)), at(2026, 6, 10, 12, 0));
});

test('first reminder is never held; follow-ups wait until quiet end', () => {
  const due = at(2026, 6, 10, 23, 0);          // set inside quiet hours
  let r = L.newRecord('h', 'e1', due, due, 'fp');
  assert.ok(L.isDue(r, due));                  // first rings at its time
  r = L.advance(r, due);
  assert.equal(r.nextAt, at(2026, 6, 11, 7, 0)); // second held to 07:00
  const r2 = L.advance(r, at(2026, 6, 11, 7, 0));
  assert.equal(r2.nextAt, at(2026, 6, 11, 7, 15));
});

test('repeat landing in quiet hours is held', () => {
  const sent = at(2026, 6, 10, 21, 50);
  const r = Object.assign(L.newRecord('n', 'e', sent, sent, 'fp'), { step: 3 });
  assert.equal(L.advance(r, sent).nextAt, at(2026, 6, 11, 7, 0)); // 22:20 -> 07:00
});

test('snooze keeps step, extends pausedMs, respects quiet hours', () => {
  const now = at(2026, 6, 10, 12, 0);
  let r = Object.assign(L.newRecord('h', 'e', now, now, 'fp'), { step: 2 });
  r = L.applySnooze(r, now, 30);
  assert.equal(r.step, 2);
  assert.equal(r.nextAt, now + 30 * MIN);
  assert.equal(r.pausedMs, 30 * MIN);
  r = L.applySnooze(r, now, 120);
  assert.equal(r.pausedMs, 150 * MIN);
  // snooze ending inside quiet hours
  const late = at(2026, 6, 10, 21, 30);
  const s = L.applySnooze(L.newRecord('h', 'e', late, late, 'fp'), late, 120);
  assert.equal(s.snoozeUntil, late + 120 * MIN);
  assert.equal(s.nextAt, at(2026, 6, 11, 7, 0));
});

test('all-day events are due at 09:00 Paris, summer and winter', () => {
  assert.equal(L.dueMsFor(at(2026, 7, 10, 0, 0), true), at(2026, 7, 10, 9, 0));
  assert.equal(L.dueMsFor(at(2026, 1, 10, 0, 0), true), at(2026, 1, 10, 9, 0));
  assert.equal(L.dueMsFor(at(2026, 3, 29, 0, 0), true), at(2026, 3, 29, 9, 0)); // DST day
  const t = at(2026, 7, 10, 17, 30);
  assert.equal(L.dueMsFor(t, false), t);
});

test('quietOverlapMs', () => {
  assert.equal(L.quietOverlapMs(at(2026, 6, 10, 10, 0), at(2026, 6, 10, 20, 0)), 0);
  assert.equal(L.quietOverlapMs(at(2026, 6, 10, 21, 0), at(2026, 6, 11, 8, 0)), 9 * H);
  assert.equal(L.quietOverlapMs(at(2026, 6, 10, 6, 0), at(2026, 6, 10, 8, 0)), 1 * H);
  assert.equal(L.quietOverlapMs(at(2026, 6, 10, 12, 0), at(2026, 6, 12, 12, 0)), 18 * H);
});

test('quiet overlap on DST days uses real elapsed time', () => {
  // night of 28->29 Mar 2026: 22:00 -> 07:00 is 8 real hours
  assert.equal(L.quietOverlapMs(at(2026, 3, 28, 22, 0), at(2026, 3, 29, 7, 0)), 8 * H);
  // night of 24->25 Oct 2026: 10 real hours
  assert.equal(L.quietOverlapMs(at(2026, 10, 24, 22, 0), at(2026, 10, 25, 7, 0)), 10 * H);
});

test('email timer excludes snoozed time and quiet hours', () => {
  const due = at(2026, 6, 10, 10, 0);
  const rec = L.newRecord('h', 'e', due, due, 'fp');
  assert.ok(!L.shouldEmailUnanswered(rec, due + 119 * MIN));
  assert.ok(L.shouldEmailUnanswered(rec, due + 120 * MIN));
  // snoozed 60 min -> needs 180 min
  const sn = Object.assign({}, rec, { pausedMs: 60 * MIN });
  assert.ok(!L.shouldEmailUnanswered(sn, due + 179 * MIN));
  assert.ok(L.shouldEmailUnanswered(sn, due + 180 * MIN));
  // due 21:00: 60 min active, then quiet until 07:00, then 60 more -> 08:00
  const d2 = at(2026, 6, 10, 21, 0);
  const night = L.newRecord('h', 'e', d2, d2, 'fp');
  assert.ok(!L.shouldEmailUnanswered(night, at(2026, 6, 11, 7, 59)));
  assert.ok(L.shouldEmailUnanswered(night, at(2026, 6, 11, 8, 0)));
  // already emailed: never again
  assert.ok(!L.shouldEmailUnanswered(Object.assign({}, rec, { emailed: true }), due + 500 * MIN));
});

test('drop warning at 13 days', () => {
  const due = at(2026, 6, 1, 10, 0);
  const rec = L.newRecord('n', 'e', due, due, 'fp');
  assert.ok(!L.shouldWarnDrop(rec, due + 13 * 86400000 - 1));
  assert.ok(L.shouldWarnDrop(rec, due + 13 * 86400000));
  assert.ok(!L.shouldWarnDrop(Object.assign({}, rec, { dropWarned: true }), due + 13.5 * 86400000));
});

test('fingerprint, record key, working minute', () => {
  assert.notEqual(L.fingerprint('a', 1), L.fingerprint('b', 1));
  assert.notEqual(L.fingerprint('a', 1), L.fingerprint('a', 2));
  assert.equal(L.recordKey('x@google.com', 5), L.recordKey('x@google.com', 5));
  assert.notEqual(L.recordKey('x@google.com', 5), L.recordKey('x@google.com', 6)); // recurring occurrences
  assert.ok(L.recordKey('x', 1).startsWith('e_'));
  assert.ok(L.isWorkingMinute(0));
  assert.ok(!L.isWorkingMinute(MIN));
  assert.ok(L.isWorkingMinute(2 * MIN + 30000));
});

test('formatLocalHM', () => {
  assert.equal(L.formatLocalHM(at(2026, 6, 10, 17, 30)), '17:30');
  assert.equal(L.formatLocalHM(at(2026, 6, 10, 7, 5)), '07:05');
});
