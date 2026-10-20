-- Lift Ledger data model (SQLite)
-- Weeks run Monday to Sunday. Weights are stored in kg.
-- Load with:  sqlite3 liftledger.db < schema.sql

PRAGMA foreign_keys = ON;

-- ============================================================ reference data

CREATE TABLE muscle_group (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  region TEXT NOT NULL CHECK (region IN ('upper', 'lower', 'core'))
);

CREATE TABLE exercise (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  equipment TEXT NOT NULL CHECK (equipment IN
              ('barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'other')),
  is_custom INTEGER NOT NULL DEFAULT 0 CHECK (is_custom IN (0, 1))
);

-- Which muscles an exercise trains.
-- A primary muscle counts 1 set per working set, a secondary muscle counts 0.5.
CREATE TABLE exercise_muscle (
  exercise_id     INTEGER NOT NULL REFERENCES exercise (id) ON DELETE CASCADE,
  muscle_group_id INTEGER NOT NULL REFERENCES muscle_group (id),
  role            TEXT NOT NULL CHECK (role IN ('primary', 'secondary')),
  PRIMARY KEY (exercise_id, muscle_group_id)
);

-- Weekly range of effective sets per muscle. Starting points, edit freely.
CREATE TABLE volume_target (
  muscle_group_id INTEGER PRIMARY KEY REFERENCES muscle_group (id),
  min_sets        REAL NOT NULL CHECK (min_sets >= 0),
  max_sets        REAL NOT NULL,
  CHECK (max_sets >= min_sets)
);

-- ============================================================ user data

CREATE TABLE workout (
  id           INTEGER PRIMARY KEY,
  performed_at TEXT NOT NULL,          -- ISO 8601, e.g. '2026-10-14T18:30:00'
  name         TEXT,                   -- 'Push', 'Legs', ...
  notes        TEXT
);
CREATE INDEX idx_workout_performed_at ON workout (performed_at);

CREATE TABLE workout_set (
  id          INTEGER PRIMARY KEY,
  workout_id  INTEGER NOT NULL REFERENCES workout (id) ON DELETE CASCADE,
  exercise_id INTEGER NOT NULL REFERENCES exercise (id),
  position    INTEGER NOT NULL,        -- order of the set within the workout
  reps        INTEGER NOT NULL CHECK (reps > 0),
  weight_kg   REAL NOT NULL DEFAULT 0 CHECK (weight_kg >= 0),   -- 0 = bodyweight
  rpe         REAL CHECK (rpe BETWEEN 1 AND 10),
  is_warmup   INTEGER NOT NULL DEFAULT 0 CHECK (is_warmup IN (0, 1)),
  UNIQUE (workout_id, position)
);
CREATE INDEX idx_set_workout  ON workout_set (workout_id);
CREATE INDEX idx_set_exercise ON workout_set (exercise_id);

-- Weekly photos. The image file stays on the device, the row stores its path.
CREATE TABLE progress_photo (
  id            INTEGER PRIMARY KEY,
  taken_on      TEXT NOT NULL,         -- 'YYYY-MM-DD'
  pose          TEXT NOT NULL CHECK (pose IN ('front', 'side', 'back')),
  file_path     TEXT NOT NULL,
  bodyweight_kg REAL CHECK (bodyweight_kg > 0),
  UNIQUE (taken_on, pose)
);

-- Later: pose-estimation output per photo, e.g. shoulder-to-waist ratio.
CREATE TABLE photo_measurement (
  photo_id INTEGER NOT NULL REFERENCES progress_photo (id) ON DELETE CASCADE,
  metric   TEXT NOT NULL,              -- 'shoulder_waist_ratio', ...
  value    REAL NOT NULL,
  PRIMARY KEY (photo_id, metric)
);

-- ============================================================ views

-- Working sets only (warm-ups excluded), tagged with the Monday that starts their week.
-- 'weekday 0' moves to the coming Sunday (or stays on it), then -6 days lands on Monday.
CREATE VIEW v_working_set AS
SELECT s.id AS set_id,
       s.exercise_id,
       s.reps,
       s.weight_kg,
       s.rpe,
       w.id AS workout_id,
       w.performed_at,
       date(w.performed_at, 'weekday 0', '-6 days') AS week_start
FROM workout_set s
JOIN workout w ON w.id = s.workout_id
WHERE s.is_warmup = 0;

-- Sets per muscle per week. Rows exist only where the muscle was trained.
CREATE VIEW v_weekly_muscle_volume AS
SELECT ws.week_start,
       mg.id   AS muscle_group_id,
       mg.name AS muscle_group,
       SUM(em.role = 'primary')   AS direct_sets,
       SUM(em.role = 'secondary') AS indirect_sets,
       SUM(CASE em.role WHEN 'primary' THEN 1.0 ELSE 0.5 END) AS effective_sets
FROM v_working_set ws
JOIN exercise_muscle em ON em.exercise_id = ws.exercise_id
JOIN muscle_group mg    ON mg.id = em.muscle_group_id
GROUP BY ws.week_start, mg.id;

-- Every muscle for every week that has training, including zeros, with a status
-- against the target range: 'under', 'in_range' or 'over'.
CREATE VIEW v_weekly_status AS
WITH weeks AS (SELECT DISTINCT week_start FROM v_working_set)
SELECT wk.week_start,
       mg.name AS muscle_group,
       COALESCE(v.direct_sets, 0)    AS direct_sets,
       COALESCE(v.indirect_sets, 0)  AS indirect_sets,
       COALESCE(v.effective_sets, 0) AS effective_sets,
       t.min_sets,
       t.max_sets,
       CASE
         WHEN COALESCE(v.effective_sets, 0) < t.min_sets THEN 'under'
         WHEN COALESCE(v.effective_sets, 0) > t.max_sets THEN 'over'
         ELSE 'in_range'
       END AS status
FROM weeks wk
CROSS JOIN muscle_group mg
JOIN volume_target t ON t.muscle_group_id = mg.id
LEFT JOIN v_weekly_muscle_volume v
       ON v.week_start = wk.week_start AND v.muscle_group_id = mg.id;

-- Candidate exercises for every muscle that is under target.
-- The app ranks them by sets_short (largest first), then done_this_week (0 first).
CREATE VIEW v_suggestion AS
SELECT st.week_start,
       st.muscle_group,
       st.min_sets - st.effective_sets AS sets_short,
       e.name      AS exercise,
       e.equipment,
       EXISTS (SELECT 1
               FROM v_working_set ws
               WHERE ws.week_start = st.week_start
                 AND ws.exercise_id = e.id) AS done_this_week
FROM v_weekly_status st
JOIN muscle_group mg     ON mg.name = st.muscle_group
JOIN exercise_muscle em  ON em.muscle_group_id = mg.id AND em.role = 'primary'
JOIN exercise e          ON e.id = em.exercise_id
WHERE st.status = 'under';

-- ============================================================ seed data

INSERT INTO muscle_group (name, region) VALUES
  ('Chest',      'upper'),
  ('Back',       'upper'),
  ('Shoulders',  'upper'),
  ('Biceps',     'upper'),
  ('Triceps',    'upper'),
  ('Quads',      'lower'),
  ('Hamstrings', 'lower'),
  ('Glutes',     'lower'),
  ('Calves',     'lower'),
  ('Abs',        'core');

WITH t(name, min_sets, max_sets) AS (VALUES
  ('Chest',      10, 20),
  ('Back',       10, 20),
  ('Shoulders',   8, 16),
  ('Biceps',      6, 14),
  ('Triceps',     6, 14),
  ('Quads',      10, 20),
  ('Hamstrings',  8, 16),
  ('Glutes',      6, 16),
  ('Calves',      6, 14),
  ('Abs',         6, 14)
)
INSERT INTO volume_target (muscle_group_id, min_sets, max_sets)
SELECT mg.id, t.min_sets, t.max_sets
FROM muscle_group mg
JOIN t ON t.name = mg.name;

INSERT INTO exercise (name, equipment) VALUES
  ('Barbell Bench Press',         'barbell'),
  ('Incline Dumbbell Press',      'dumbbell'),
  ('Cable Fly',                   'cable'),
  ('Push-Up',                     'bodyweight'),
  ('Dips',                        'bodyweight'),
  ('Pull-Up',                     'bodyweight'),
  ('Barbell Row',                 'barbell'),
  ('Lat Pulldown',                'cable'),
  ('Seated Cable Row',            'cable'),
  ('Dumbbell Row',                'dumbbell'),
  ('Deadlift',                    'barbell'),
  ('Overhead Press',              'barbell'),
  ('Dumbbell Shoulder Press',     'dumbbell'),
  ('Dumbbell Lateral Raise',      'dumbbell'),
  ('Face Pull',                   'cable'),
  ('Barbell Curl',                'barbell'),
  ('Dumbbell Curl',               'dumbbell'),
  ('Hammer Curl',                 'dumbbell'),
  ('Triceps Pushdown',            'cable'),
  ('Overhead Triceps Extension',  'dumbbell'),
  ('Skull Crusher',               'barbell'),
  ('Barbell Back Squat',          'barbell'),
  ('Leg Press',                   'machine'),
  ('Leg Extension',               'machine'),
  ('Bulgarian Split Squat',       'dumbbell'),
  ('Walking Lunge',               'dumbbell'),
  ('Romanian Deadlift',           'barbell'),
  ('Lying Leg Curl',              'machine'),
  ('Hip Thrust',                  'barbell'),
  ('Standing Calf Raise',         'machine'),
  ('Seated Calf Raise',           'machine'),
  ('Hanging Leg Raise',           'bodyweight'),
  ('Cable Crunch',                'cable'),
  ('Ab Wheel Rollout',            'other');

-- Exercise to muscle mapping, written by name and resolved to ids below.
CREATE TEMP TABLE seed_em (exercise TEXT, muscle TEXT, role TEXT);
INSERT INTO seed_em VALUES
  ('Barbell Bench Press',        'Chest',      'primary'),
  ('Barbell Bench Press',        'Triceps',    'secondary'),
  ('Barbell Bench Press',        'Shoulders',  'secondary'),
  ('Incline Dumbbell Press',     'Chest',      'primary'),
  ('Incline Dumbbell Press',     'Shoulders',  'secondary'),
  ('Incline Dumbbell Press',     'Triceps',    'secondary'),
  ('Cable Fly',                  'Chest',      'primary'),
  ('Push-Up',                    'Chest',      'primary'),
  ('Push-Up',                    'Triceps',    'secondary'),
  ('Push-Up',                    'Shoulders',  'secondary'),
  ('Dips',                       'Chest',      'primary'),
  ('Dips',                       'Triceps',    'primary'),
  ('Dips',                       'Shoulders',  'secondary'),
  ('Pull-Up',                    'Back',       'primary'),
  ('Pull-Up',                    'Biceps',     'secondary'),
  ('Barbell Row',                'Back',       'primary'),
  ('Barbell Row',                'Biceps',     'secondary'),
  ('Lat Pulldown',               'Back',       'primary'),
  ('Lat Pulldown',               'Biceps',     'secondary'),
  ('Seated Cable Row',           'Back',       'primary'),
  ('Seated Cable Row',           'Biceps',     'secondary'),
  ('Dumbbell Row',               'Back',       'primary'),
  ('Dumbbell Row',               'Biceps',     'secondary'),
  ('Deadlift',                   'Back',       'primary'),
  ('Deadlift',                   'Glutes',     'primary'),
  ('Deadlift',                   'Hamstrings', 'secondary'),
  ('Deadlift',                   'Quads',      'secondary'),
  ('Overhead Press',             'Shoulders',  'primary'),
  ('Overhead Press',             'Triceps',    'secondary'),
  ('Dumbbell Shoulder Press',    'Shoulders',  'primary'),
  ('Dumbbell Shoulder Press',    'Triceps',    'secondary'),
  ('Dumbbell Lateral Raise',     'Shoulders',  'primary'),
  ('Face Pull',                  'Shoulders',  'primary'),
  ('Face Pull',                  'Back',       'secondary'),
  ('Barbell Curl',               'Biceps',     'primary'),
  ('Dumbbell Curl',              'Biceps',     'primary'),
  ('Hammer Curl',                'Biceps',     'primary'),
  ('Triceps Pushdown',           'Triceps',    'primary'),
  ('Overhead Triceps Extension', 'Triceps',    'primary'),
  ('Skull Crusher',              'Triceps',    'primary'),
  ('Barbell Back Squat',         'Quads',      'primary'),
  ('Barbell Back Squat',         'Glutes',     'secondary'),
  ('Leg Press',                  'Quads',      'primary'),
  ('Leg Press',                  'Glutes',     'secondary'),
  ('Leg Extension',              'Quads',      'primary'),
  ('Bulgarian Split Squat',      'Quads',      'primary'),
  ('Bulgarian Split Squat',      'Glutes',     'secondary'),
  ('Walking Lunge',              'Quads',      'primary'),
  ('Walking Lunge',              'Glutes',     'secondary'),
  ('Walking Lunge',              'Hamstrings', 'secondary'),
  ('Romanian Deadlift',          'Hamstrings', 'primary'),
  ('Romanian Deadlift',          'Glutes',     'primary'),
  ('Romanian Deadlift',          'Back',       'secondary'),
  ('Lying Leg Curl',             'Hamstrings', 'primary'),
  ('Hip Thrust',                 'Glutes',     'primary'),
  ('Hip Thrust',                 'Hamstrings', 'secondary'),
  ('Standing Calf Raise',        'Calves',     'primary'),
  ('Seated Calf Raise',          'Calves',     'primary'),
  ('Hanging Leg Raise',          'Abs',        'primary'),
  ('Cable Crunch',               'Abs',        'primary'),
  ('Ab Wheel Rollout',           'Abs',        'primary');

INSERT INTO exercise_muscle (exercise_id, muscle_group_id, role)
SELECT e.id, m.id, s.role
FROM seed_em s
JOIN exercise e     ON e.name = s.exercise
JOIN muscle_group m ON m.name = s.muscle;

DROP TABLE seed_em;
