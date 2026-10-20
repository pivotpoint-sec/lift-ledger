// Run with: node tests/logic.test.js
const assert = require('assert');
const LL = require('../logic.js');

let n = 0;
function test(name, fn) { fn(); n++; console.log('ok -', name); }

test('weeks start on Monday, including Sundays and the late-October clock change', () => {
  assert.strictEqual(LL.mondayOf('2026-10-12'), '2026-10-12');
  assert.strictEqual(LL.mondayOf('2026-10-14'), '2026-10-12');
  assert.strictEqual(LL.mondayOf('2026-10-18'), '2026-10-12');
  assert.strictEqual(LL.mondayOf('2026-10-25'), '2026-10-19');
  assert.strictEqual(LL.addDays('2026-10-24', 2), '2026-10-26');
  assert.strictEqual(LL.daysBetween('2026-10-24', '2026-10-26'), 2);
});

test('effective sets: primary 1, secondary 0.5, warm-ups excluded', () => {
  const days = { '2026-10-12': { date: '2026-10-12', sets: [
    { ex: 'Barbell Bench Press', kg: 60, reps: 10, rpe: null, warm: true },
    { ex: 'Barbell Bench Press', kg: 80, reps: 8, rpe: 8, warm: false },
    { ex: 'Barbell Bench Press', kg: 80, reps: 8, rpe: 8, warm: false }
  ] } };
  const d = LL.weekData(days, '2026-10-12');
  assert.strictEqual(d.per.Chest.eff, 2);
  assert.strictEqual(d.per.Triceps.eff, 1);
  assert.strictEqual(d.per.Shoulders.eff, 1);
  assert.strictEqual(d.per.Back.eff, 0);
  assert.strictEqual(d.work, 2);
  assert.strictEqual(d.volume, 80 * 8 * 2);
  assert.strictEqual(d.sessions, 1);
});

test('example sessions give the expected week for Wed 2026-10-14', () => {
  const ex = LL.exampleDays('2026-10-14');
  assert.deepStrictEqual(Object.keys(ex).sort(), ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13']);
  const d = LL.weekData(ex, '2026-10-12');
  const eff = {};
  LL.MUSCLES.forEach(m => { eff[m] = d.per[m].eff; });
  assert.deepStrictEqual(eff, { Chest: 6, Back: 1.5, Shoulders: 9, Biceps: 0, Triceps: 7.5, Quads: 4, Hamstrings: 6, Glutes: 5, Calves: 4, Abs: 3 });
  const s = LL.suggestions(ex, LL.DEFAULT_TARGETS, '2026-10-12', 3);
  assert.deepStrictEqual(s.top.map(t => t.muscle), ['Back', 'Biceps', 'Quads']);
  s.top.forEach(t => t.exercises.forEach(e => assert.ok(e.primary.includes(t.muscle))));
  const prev = LL.weekData(ex, '2026-10-05');
  assert.strictEqual(LL.statusOf(prev.per.Shoulders.eff, LL.DEFAULT_TARGETS.Shoulders), 'over');
  assert.strictEqual(LL.statusOf(prev.per.Chest.eff, LL.DEFAULT_TARGETS.Chest), 'ok');
});

test('examples only include days that have already passed', () => {
  assert.deepStrictEqual(Object.keys(LL.exampleDays('2026-10-12')).sort(), ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09']);
  assert.strictEqual(Object.keys(LL.exampleDays('2026-10-18')).length, 6);
});

test('suggestions prefer exercises not yet done this week and mixed equipment', () => {
  const days = { '2026-10-12': { date: '2026-10-12', sets: [{ ex: 'Barbell Row', kg: 60, reps: 8, rpe: null, warm: false }] } };
  const picks = LL.pickExercises('Back', new Set(['Barbell Row']), 3).map(e => e.name);
  assert.ok(!picks.includes('Barbell Row'));
  assert.strictEqual(picks.length, 3);
});

test('last set lookup ignores warm-ups and finds the newest date', () => {
  const days = {
    '2026-10-05': { date: '2026-10-05', sets: [{ ex: 'Deadlift', kg: 120, reps: 5, rpe: null, warm: false }] },
    '2026-10-12': { date: '2026-10-12', sets: [
      { ex: 'Deadlift', kg: 130, reps: 5, rpe: null, warm: false },
      { ex: 'Deadlift', kg: 60, reps: 8, rpe: null, warm: true }
    ] }
  };
  assert.deepStrictEqual(LL.lastSetFor(days, 'Deadlift'), { date: '2026-10-12', kg: 130, reps: 5 });
  assert.strictEqual(LL.lastSetFor(days, 'Leg Press'), null);
});

test('targets: bad values fall back to defaults and max never drops below min', () => {
  const t = LL.mergeTargets({ Chest: [12, 8], Back: ['x', 3], Abs: [4, 10] });
  assert.deepStrictEqual(t.Chest, [12, 12]);
  assert.deepStrictEqual(t.Back, LL.DEFAULT_TARGETS.Back);
  assert.deepStrictEqual(t.Abs, [4, 10]);
  assert.deepStrictEqual(LL.mergeTargets(null), LL.DEFAULT_TARGETS);
});

test('set and day cleaning drops invalid data', () => {
  assert.strictEqual(LL.sanitizeSet({ ex: 'Deadlift', kg: -5, reps: 5 }), null);
  assert.strictEqual(LL.sanitizeSet({ ex: 'Deadlift', kg: 100, reps: 0 }), null);
  assert.strictEqual(LL.sanitizeSet({ ex: 'Deadlift', kg: 100, reps: 2.5 }), null);
  assert.strictEqual(LL.sanitizeSet({ ex: '', kg: 100, reps: 5 }), null);
  assert.strictEqual(LL.sanitizeSet(null), null);
  assert.deepStrictEqual(LL.sanitizeSet({ ex: 'Deadlift', kg: '100', reps: '5', rpe: 11, warm: 0 }), { ex: 'Deadlift', kg: 100, reps: 5, rpe: null, warm: false });
  assert.strictEqual(LL.sanitizeDay('2026-02-30', { sets: [{ ex: 'Deadlift', kg: 1, reps: 1 }] }), null);
  assert.strictEqual(LL.sanitizeDay('2026-10-12', { sets: [{ ex: 'x', kg: -1, reps: 1 }] }), null);
});

test('backup parsing validates the file and counts what it holds', () => {
  assert.strictEqual(LL.parseBackup({ app: 'something-else', version: 1 }).ok, false);
  assert.strictEqual(LL.parseBackup({ app: 'lift-ledger', version: 2 }).ok, false);
  assert.strictEqual(LL.parseBackup(null).ok, false);
  const p = LL.parseBackup({
    app: 'lift-ledger', version: 1, exportedAt: '2026-10-14T19:00:00.000Z',
    days: {
      '2026-10-12': { date: '2026-10-12', sets: [{ ex: 'Deadlift', kg: 100, reps: 5, rpe: 8, warm: false }, { ex: 'Bad', kg: -1, reps: 5 }] },
      'not-a-date': { sets: [{ ex: 'Deadlift', kg: 100, reps: 5 }] }
    },
    targets: { Chest: [12, 18] },
    photos: [
      { weekStart: '2026-10-12', pose: 'front', takenOn: '2026-10-14', data: 'data:image/jpeg;base64,AAAA' },
      { weekStart: '2026-10-12', pose: 'sideways', data: 'data:image/jpeg;base64,AAAA' },
      { weekStart: '2026-10-12', pose: 'back', data: 'javascript:alert(1)' }
    ]
  });
  assert.strictEqual(p.ok, true);
  assert.deepStrictEqual(p.counts, { days: 1, sets: 1, photos: 1 });
  assert.deepStrictEqual(p.targets.Chest, [12, 18]);
  assert.strictEqual(p.exportedAt, '2026-10-14');
});

test('backup reminder: needs real data, then a week without a backup, then every two weeks', () => {
  const real = { '2026-10-01': { date: '2026-10-01', sets: [{ ex: 'Deadlift', kg: 1, reps: 1, rpe: null, warm: false }] } };
  const examples = LL.exampleDays('2026-10-14');
  assert.strictEqual(LL.needsBackup({}, null, '2026-10-14'), false);
  assert.strictEqual(LL.needsBackup(examples, null, '2026-10-14'), false);
  assert.strictEqual(LL.needsBackup(real, null, '2026-10-05'), false);
  assert.strictEqual(LL.needsBackup(real, null, '2026-10-08'), true);
  assert.strictEqual(LL.needsBackup(real, '2026-10-10', '2026-10-20'), false);
  assert.strictEqual(LL.needsBackup(real, '2026-10-01', '2026-10-15'), true);
});

console.log('\n' + n + ' tests passed');
