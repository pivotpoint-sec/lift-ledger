/* Lift Ledger: pure logic. No DOM and no storage, so it runs in the browser and in Node tests.
 *
 * Data shape used everywhere:
 *   days = { 'YYYY-MM-DD': { date, sets: [{ ex, kg, reps, rpe, warm, example? }] } }
 * `ex` is an exercise name from EXERCISES (kept in step with docs/schema.sql).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LL = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MUSCLES = ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Quads', 'Hamstrings', 'Glutes', 'Calves', 'Abs'];
  const POSES = ['front', 'side', 'back'];

  // Weekly effective-set ranges. Starting points, editable in the app.
  const DEFAULT_TARGETS = {
    Chest: [10, 20], Back: [10, 20], Shoulders: [8, 16], Biceps: [6, 14], Triceps: [6, 14],
    Quads: [10, 20], Hamstrings: [8, 16], Glutes: [6, 16], Calves: [6, 14], Abs: [6, 14]
  };

  // name, equipment, primary muscles (1 set each), secondary muscles (0.5 set each)
  const EXERCISES = [
    ['Barbell Bench Press', 'barbell', ['Chest'], ['Triceps', 'Shoulders']],
    ['Incline Dumbbell Press', 'dumbbell', ['Chest'], ['Shoulders', 'Triceps']],
    ['Cable Fly', 'cable', ['Chest'], []],
    ['Push-Up', 'bodyweight', ['Chest'], ['Triceps', 'Shoulders']],
    ['Dips', 'bodyweight', ['Chest', 'Triceps'], ['Shoulders']],
    ['Pull-Up', 'bodyweight', ['Back'], ['Biceps']],
    ['Barbell Row', 'barbell', ['Back'], ['Biceps']],
    ['Lat Pulldown', 'cable', ['Back'], ['Biceps']],
    ['Seated Cable Row', 'cable', ['Back'], ['Biceps']],
    ['Dumbbell Row', 'dumbbell', ['Back'], ['Biceps']],
    ['Deadlift', 'barbell', ['Back', 'Glutes'], ['Hamstrings', 'Quads']],
    ['Overhead Press', 'barbell', ['Shoulders'], ['Triceps']],
    ['Dumbbell Shoulder Press', 'dumbbell', ['Shoulders'], ['Triceps']],
    ['Dumbbell Lateral Raise', 'dumbbell', ['Shoulders'], []],
    ['Face Pull', 'cable', ['Shoulders'], ['Back']],
    ['Barbell Curl', 'barbell', ['Biceps'], []],
    ['Dumbbell Curl', 'dumbbell', ['Biceps'], []],
    ['Hammer Curl', 'dumbbell', ['Biceps'], []],
    ['Triceps Pushdown', 'cable', ['Triceps'], []],
    ['Overhead Triceps Extension', 'dumbbell', ['Triceps'], []],
    ['Skull Crusher', 'barbell', ['Triceps'], []],
    ['Barbell Back Squat', 'barbell', ['Quads'], ['Glutes']],
    ['Leg Press', 'machine', ['Quads'], ['Glutes']],
    ['Leg Extension', 'machine', ['Quads'], []],
    ['Bulgarian Split Squat', 'dumbbell', ['Quads'], ['Glutes']],
    ['Walking Lunge', 'dumbbell', ['Quads'], ['Glutes', 'Hamstrings']],
    ['Romanian Deadlift', 'barbell', ['Hamstrings', 'Glutes'], ['Back']],
    ['Lying Leg Curl', 'machine', ['Hamstrings'], []],
    ['Hip Thrust', 'barbell', ['Glutes'], ['Hamstrings']],
    ['Standing Calf Raise', 'machine', ['Calves'], []],
    ['Seated Calf Raise', 'machine', ['Calves'], []],
    ['Hanging Leg Raise', 'bodyweight', ['Abs'], []],
    ['Cable Crunch', 'cable', ['Abs'], []],
    ['Ab Wheel Rollout', 'other', ['Abs'], []]
  ].map(function (e) { return { name: e[0], equipment: e[1], primary: e[2], secondary: e[3] }; });
  const BY_NAME = new Map(EXERCISES.map(function (e) { return [e.name, e]; }));

  /* ---------- dates (local time, 'YYYY-MM-DD' strings) ---------- */
  const pad = function (n) { return String(n).padStart(2, '0'); };
  const iso = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const parse = function (s) { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  const addDays = function (s, n) { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const mondayOf = function (s) { const d = parse(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
  const todayIso = function () { return iso(new Date()); };
  const daysBetween = function (a, b) { return Math.round((parse(b) - parse(a)) / 864e5); };
  function isDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    return iso(parse(s)) === s;
  }
  const fmt = function (n) { return Number.isInteger(n) ? String(n) : n.toFixed(1); };

  /* ---------- targets ---------- */
  const cloneTargets = function (t) {
    const out = {};
    MUSCLES.forEach(function (m) { out[m] = [t[m][0], t[m][1]]; });
    return out;
  };
  function mergeTargets(values) {
    const out = cloneTargets(DEFAULT_TARGETS);
    MUSCLES.forEach(function (m) {
      const v = values && values[m];
      if (Array.isArray(v) && v.length === 2 && v.every(function (x) { return typeof x === 'number' && x >= 0 && isFinite(x); })) {
        out[m] = [v[0], Math.max(v[0], v[1])];
      }
    });
    return out;
  }

  /* ---------- weekly volume ---------- */
  function weekData(days, ws) {
    const per = {};
    MUSCLES.forEach(function (m) { per[m] = { direct: 0, indirect: 0, eff: 0 }; });
    let work = 0, volume = 0;
    const sessions = new Set(), done = new Set();
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i), day = days[d];
      if (!day || !Array.isArray(day.sets)) continue;
      day.sets.forEach(function (s) {
        if (s.warm) return;
        const ex = BY_NAME.get(s.ex);
        if (!ex) return;
        work++; volume += s.kg * s.reps; sessions.add(d); done.add(ex.name);
        ex.primary.forEach(function (m) { per[m].direct++; });
        ex.secondary.forEach(function (m) { per[m].indirect++; });
      });
    }
    MUSCLES.forEach(function (m) { per[m].eff = per[m].direct + per[m].indirect * 0.5; });
    return { per: per, work: work, volume: volume, sessions: sessions.size, done: done };
  }
  function statusOf(eff, t) { return eff < t[0] ? 'under' : eff > t[1] ? 'over' : 'ok'; }

  // Up to n primary movers for a muscle: not yet done this week first, different equipment first.
  function pickExercises(muscle, done, n) {
    const cands = EXERCISES.filter(function (e) { return e.primary.includes(muscle); });
    cands.sort(function (a, b) { return (done.has(a.name) ? 1 : 0) - (done.has(b.name) ? 1 : 0); });
    const out = [], eq = new Set();
    cands.forEach(function (e) { if (out.length < n && !eq.has(e.equipment)) { out.push(e); eq.add(e.equipment); } });
    cands.forEach(function (e) { if (out.length < n && !out.includes(e)) out.push(e); });
    return out;
  }
  function suggestions(days, targets, ws, limit) {
    const data = weekData(days, ws);
    const gaps = MUSCLES
      .map(function (m) { return { muscle: m, short: targets[m][0] - data.per[m].eff }; })
      .filter(function (g) { return g.short > 0; })
      .sort(function (a, b) { return b.short - a.short; });
    const top = gaps.slice(0, limit || 3).map(function (g) {
      return { muscle: g.muscle, short: g.short, exercises: pickExercises(g.muscle, data.done, 3) };
    });
    return { data: data, gaps: gaps, top: top };
  }
  function lastSetFor(days, name) {
    const dates = Object.keys(days).sort().reverse();
    for (let k = 0; k < dates.length; k++) {
      const sets = (days[dates[k]] && days[dates[k]].sets) || [];
      for (let i = sets.length - 1; i >= 0; i--) {
        if (sets[i].ex === name && !sets[i].warm) return { date: dates[k], kg: sets[i].kg, reps: sets[i].reps };
      }
    }
    return null;
  }

  /* ---------- cleaning data that comes from storage or a backup file ---------- */
  function sanitizeSet(s) {
    if (!s || typeof s.ex !== 'string' || !s.ex || s.ex.length > 80) return null;
    const kg = Number(s.kg), reps = Number(s.reps);
    if (!isFinite(kg) || kg < 0 || kg > 2000) return null;
    if (!Number.isInteger(reps) || reps < 1 || reps > 1000) return null;
    let rpe = null;
    if (s.rpe !== null && s.rpe !== undefined) {
      const r = Number(s.rpe);
      if (r >= 1 && r <= 10) rpe = r;
    }
    const out = { ex: s.ex, kg: kg, reps: reps, rpe: rpe, warm: !!s.warm };
    if (s.example) out.example = true;
    return out;
  }
  function sanitizeDay(date, day) {
    if (!isDate(date)) return null;
    const raw = day && Array.isArray(day.sets) ? day.sets : [];
    const sets = raw.map(sanitizeSet).filter(Boolean);
    return sets.length ? { date: date, sets: sets } : null;
  }
  // Checks a parsed backup file and returns clean data, or an error message.
  function parseBackup(obj) {
    if (!obj || obj.app !== 'lift-ledger' || typeof obj.version !== 'number') {
      return { ok: false, error: 'That file is not a Lift Ledger backup.' };
    }
    if (obj.version > 1) return { ok: false, error: 'That backup comes from a newer version of the app.' };
    const days = {};
    let sets = 0;
    Object.keys(obj.days || {}).forEach(function (d) {
      const c = sanitizeDay(d, obj.days[d]);
      if (c) { days[d] = c; sets += c.sets.length; }
    });
    const targets = obj.targets ? mergeTargets(obj.targets) : null;
    const photos = (Array.isArray(obj.photos) ? obj.photos : []).filter(function (p) {
      return p && typeof p.data === 'string' && p.data.indexOf('data:image/') === 0 && isDate(p.weekStart) && POSES.includes(p.pose);
    }).map(function (p) {
      return { weekStart: p.weekStart, pose: p.pose, takenOn: isDate(p.takenOn) ? p.takenOn : p.weekStart, data: p.data };
    });
    return {
      ok: true, days: days, targets: targets, photos: photos,
      counts: { days: Object.keys(days).length, sets: sets, photos: photos.length },
      exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt.slice(0, 10) : null
    };
  }

  /* ---------- backup reminder ---------- */
  // True when there is real (non-example) data and no recent backup.
  function needsBackup(days, lastBackup, today) {
    const dates = Object.keys(days).filter(function (d) {
      return days[d].sets.some(function (s) { return !s.example; });
    }).sort();
    if (!dates.length) return false;
    if (lastBackup) return daysBetween(lastBackup, today) >= 14;
    return daysBetween(dates[0], today) >= 7;
  }

  /* ---------- example sessions, so a new user can see the bars straight away ---------- */
  const W = 'w';
  const PROGRAMS = {
    Push: [
      ['Barbell Bench Press', [[60, 10, W], [80, 8, 8], [80, 8, 8], [80, 7, 9]]],
      ['Incline Dumbbell Press', [[28, 10, 7.5], [28, 10, 8], [28, 9, 9]]],
      ['Overhead Press', [[45, 8, 8], [45, 8, 8.5], [45, 7, 9]]],
      ['Dumbbell Lateral Raise', [[10, 15, 8], [10, 14, 9], [10, 12, 9.5]]],
      ['Triceps Pushdown', [[30, 12, 8], [30, 12, 8.5], [30, 10, 9]]]
    ],
    Pull: [
      ['Barbell Row', [[50, 10, W], [60, 8, 8], [60, 8, 8], [60, 8, 9]]],
      ['Lat Pulldown', [[55, 10, 8], [55, 10, 8.5], [55, 9, 9]]],
      ['Seated Cable Row', [[50, 10, 8], [50, 10, 8.5], [50, 10, 9]]],
      ['Face Pull', [[20, 15, 7], [20, 15, 8], [20, 14, 8.5]]],
      ['Dumbbell Curl', [[14, 10, 8], [14, 10, 8.5], [14, 9, 9]]],
      ['Hammer Curl', [[14, 10, 8], [14, 9, 9]]]
    ],
    Legs: [
      ['Barbell Back Squat', [[60, 8, W], [100, 6, 8], [100, 6, 8.5], [100, 6, 9], [100, 5, 9.5]]],
      ['Romanian Deadlift', [[80, 8, 8], [80, 8, 8.5], [80, 8, 9]]],
      ['Lying Leg Curl', [[40, 10, 8], [40, 10, 8.5], [40, 9, 9]]],
      ['Standing Calf Raise', [[60, 12, 8], [60, 12, 8.5], [60, 11, 9], [60, 10, 9.5]]],
      ['Hanging Leg Raise', [[0, 10, 8], [0, 9, 9], [0, 8, 9.5]]]
    ]
  };
  // Last week: Push Mon, Pull Tue, Legs Thu, Push Fri. This week: Push Mon, Legs Tue (only days already past).
  function exampleDays(today) {
    const mon = mondayOf(today);
    const plan = [[-7, 'Push'], [-6, 'Pull'], [-4, 'Legs'], [-3, 'Push'], [0, 'Push'], [1, 'Legs']];
    const out = {};
    plan.forEach(function (p) {
      const date = addDays(mon, p[0]);
      if (date >= today) return;
      const sets = [];
      PROGRAMS[p[1]].forEach(function (ex) {
        ex[1].forEach(function (r) {
          sets.push({ ex: ex[0], kg: r[0], reps: r[1], rpe: r[2] === W ? null : r[2], warm: r[2] === W, example: true });
        });
      });
      out[date] = { date: date, sets: sets };
    });
    return out;
  }

  return {
    MUSCLES: MUSCLES, POSES: POSES, DEFAULT_TARGETS: DEFAULT_TARGETS, EXERCISES: EXERCISES, BY_NAME: BY_NAME,
    iso: iso, parse: parse, addDays: addDays, mondayOf: mondayOf, todayIso: todayIso, daysBetween: daysBetween, isDate: isDate, fmt: fmt,
    cloneTargets: cloneTargets, mergeTargets: mergeTargets,
    weekData: weekData, statusOf: statusOf, pickExercises: pickExercises, suggestions: suggestions, lastSetFor: lastSetFor,
    sanitizeSet: sanitizeSet, sanitizeDay: sanitizeDay, parseBackup: parseBackup, needsBackup: needsBackup, exampleDays: exampleDays
  };
});
