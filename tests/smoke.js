// Runs the real app files in jsdom with an in-memory IndexedDB.
// Setup once: npm install --no-save jsdom fake-indexeddb   Run: node tests/smoke.js
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const assert = require('assert');
const fdb = require('fake-indexeddb');

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const sharedIDB = new fdb.IDBFactory();   // survives "page loads", like a real browser profile
const errors = [];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, what, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (cond()) return; } catch (e) { /* keep waiting */ }
    await sleep(15);
  }
  throw new Error('timed out waiting for: ' + what);
}

async function load() {
  const html = fs.readFileSync(ROOT + '/index.html', 'utf8').replace(/<script src=[^>]*><\/script>/g, '');
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented: navigation/.test(e.message)) errors.push('jsdomError: ' + e.message); });
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.indexedDB = sharedIDB;
  w.scrollTo = () => {};
  w.URL.createObjectURL = f => { w.__lastBlob = f; return 'blob:fake'; };
  w.URL.revokeObjectURL = () => {};
  for (const f of ['config.js', 'logic.js', 'storage.js', 'app.js']) w.eval(fs.readFileSync(ROOT + '/' + f, 'utf8'));
  const $ = id => w.document.getElementById(id);
  await waitFor(() => !$('sessionList').textContent.includes('Loading'), 'app to finish loading');
  return w;
}
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const change = (w, el) => el.dispatchEvent(new w.Event('change', { bubbles: true }));
const submit = (w, el) => el.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
function readFile(w, file) {
  return new Promise(res => { const fr = new w.FileReader(); fr.onload = () => res(fr.result); fr.readAsText(file); });
}
let steps = 0;
const ok = msg => { steps++; console.log('ok -', msg); };

(async () => {
  /* ---- first run: empty state ---- */
  let w = await load();
  let $ = id => w.document.getElementById(id);
  const LL = w.LL;
  const today = LL.todayIso(), mon = LL.mondayOf(today);
  assert.ok($('sessionList').textContent.includes('No sets logged for this day'));
  assert.strictEqual($('view-log').classList.contains('is-active'), true);
  click(w, $('nav-week'));
  assert.strictEqual($('view-week').classList.contains('is-active'), true);
  assert.strictEqual($('nav-week').getAttribute('aria-current'), 'page');
  assert.ok($('recs').textContent.includes('Nothing logged yet'));
  assert.strictEqual($('muscleList').children.length, 10);
  ok('first run shows the empty state and ten muscle rows');

  /* ---- example data ---- */
  click(w, $('recs').querySelector('button[data-act="loadEx"]'));
  await waitFor(() => $('banners').textContent.includes('Example sessions'), 'example banner');
  const expected = LL.weekData(LL.exampleDays(today), mon);
  const rows = Array.from($('muscleList').children);
  LL.MUSCLES.forEach((m, i) => {
    const txt = rows[i].textContent;
    assert.ok(txt.includes(m), m + ' row present');
    assert.ok(txt.includes(LL.fmt(expected.per[m].eff) + ' effective'), m + ' shows ' + LL.fmt(expected.per[m].eff) + ' effective, got: ' + txt);
  });
  const picks = $('recs').querySelectorAll('button[data-ex]');
  assert.ok(picks.length >= 3, 'has suggestion buttons');
  ok('example sessions load and the bars match the logic (' + expected.work + ' working sets this week)');

  /* ---- suggestion button jumps to the log with the exercise selected ---- */
  const first = picks[0].dataset.ex;
  click(w, picks[0]);
  assert.strictEqual($('view-log').classList.contains('is-active'), true);
  assert.strictEqual($('exercise').value, first);
  ok('tapping a suggested exercise opens the log with it selected (' + first + ')');

  /* ---- clear examples ---- */
  click(w, $('banners').querySelector('button[data-act="clearEx"]'));
  await waitFor(() => !$('banners').textContent.includes('Example sessions'), 'examples cleared');
  click(w, $('nav-week'));
  assert.ok($('recs').textContent.includes('Nothing logged yet'));
  ok('clearing examples leaves an empty log');

  /* ---- add sets ---- */
  click(w, $('nav-log'));
  $('exercise').value = 'Barbell Row'; change(w, $('exercise'));
  $('kg').value = '60'; $('reps').value = '8'; $('rpe').value = '8';
  submit(w, $('setForm'));
  await waitFor(() => $('status').textContent.includes('Set 1 of Barbell Row added.'), 'first set added');
  submit(w, $('setForm'));
  await waitFor(() => $('status').textContent.includes('Set 2 of Barbell Row added.'), 'second set added');
  $('warm').checked = true; $('kg').value = '40'; $('reps').value = '10';
  submit(w, $('setForm'));
  await waitFor(() => $('status').textContent.includes('Warm-up added'), 'warm-up added');
  assert.strictEqual($('warm').checked, false);
  const stats = $('sessionStats').textContent;
  assert.ok(stats.includes('2') && stats.includes('960'), 'session stats show 2 working sets and 960 kg: ' + stats);
  ok('adding working sets and a warm-up updates the session (2 working sets, 960 kg)');

  /* ---- invalid input ---- */
  $('kg').value = ''; $('reps').value = '';
  submit(w, $('setForm'));
  await waitFor(() => $('status').textContent.includes('Enter a weight'), 'validation message');
  ok('empty weight and reps are rejected with a message');

  /* ---- remove and undo ---- */
  const rm = $('sessionList').querySelector('button[data-rm="0"]');
  click(w, rm);
  await waitFor(() => $('status').textContent.includes('Removed a set of Barbell Row'), 'removal');
  assert.ok($('sessionStats').textContent.includes('480'), 'volume drops to 480');
  click(w, $('status').querySelector('button'));
  await waitFor(() => $('status').textContent.includes('Set restored'), 'undo');
  assert.ok($('sessionStats').textContent.includes('960'));
  ok('removing a set and undoing it restores the session');

  /* ---- week view reflects the new sets ---- */
  click(w, $('nav-week'));
  const back = Array.from($('muscleList').children).find(li => li.textContent.includes('Back'));
  const biceps = Array.from($('muscleList').children).find(li => li.textContent.includes('Biceps'));
  assert.ok(back.textContent.includes('2 effective') && back.textContent.includes('8 short'), back.textContent);
  assert.ok(biceps.textContent.includes('1 effective'), biceps.textContent);
  assert.ok($('weekStats').textContent.includes('960'));
  ok('week view: back 2 effective (8 short), biceps 1 effective, volume 960 kg');

  /* ---- week navigation ---- */
  assert.strictEqual($('nextWeek').disabled, true);
  click(w, $('prevWeek'));
  assert.strictEqual($('nextWeek').disabled, false);
  assert.ok($('weekSub').textContent.includes('Last week'));
  assert.ok($('recs').textContent.includes('Fell short that week') || $('recs').textContent.includes('No sets logged'));
  click(w, $('nextWeek'));
  assert.ok($('weekSub').textContent.includes('This week'));
  ok('week navigation moves back one week and cannot go into the future');

  /* ---- targets ---- */
  click(w, $('nav-more'));
  $('tmin-Back').value = '14'; change(w, $('tmin-Back'));
  click(w, $('nav-week'));
  assert.ok(Array.from($('muscleList').children).find(li => li.textContent.includes('Back')).textContent.includes('target 14–20'));
  $('tmax-Back').value = '10'; change(w, $('tmax-Back'));
  assert.strictEqual($('tmax-Back').value, '14', 'max is raised to min');
  $('tmax-Back').value = '20'; change(w, $('tmax-Back'));
  await sleep(600);   // targets are saved after a short pause
  ok('editing targets changes the bars and keeps max at or above min');

  /* ---- reload: data persists ---- */
  w.close();
  w = await load(); $ = id => w.document.getElementById(id);
  assert.ok($('sessionList').textContent.includes('Barbell Row'));
  assert.ok($('sessionStats').textContent.includes('960'));
  click(w, $('nav-week'));
  assert.ok(Array.from($('muscleList').children).find(li => li.textContent.includes('Back')).textContent.includes('target 14–20'));
  ok('after a reload the sets and the edited target are still there');

  /* ---- backup ---- */
  click(w, $('nav-more'));
  assert.ok($('lastBackup').textContent.includes('No backup yet'));
  click(w, $('exportBtn'));
  await waitFor(() => $('backupStatus').textContent.includes('Backup saved'), 'backup saved');
  assert.ok($('lastBackup').textContent.includes('Last backup'));
  assert.ok(/lift-ledger-backup-\d{4}-\d{2}-\d{2}\.json/.test(w.__lastBlob.name));
  const text = await readFile(w, w.__lastBlob);
  const backup = JSON.parse(text);
  assert.strictEqual(backup.app, 'lift-ledger');
  assert.strictEqual(backup.version, 1);
  assert.strictEqual(backup.days[today].sets.length, 3);
  assert.deepStrictEqual(backup.targets.Back, [14, 20]);
  assert.deepStrictEqual(backup.photos, []);
  ok('backup file has the sessions and targets (' + w.__lastBlob.name + ')');

  /* ---- wipe, then restore ---- */
  click(w, $('aboutCard').querySelector('button[data-act="wipe"]'));
  assert.ok($('aboutCard').textContent.includes('cannot be undone'));
  click(w, $('aboutCard').querySelector('button[data-act="cancelWipe"]'));
  assert.ok(!$('aboutCard').textContent.includes('cannot be undone'));
  click(w, $('aboutCard').querySelector('button[data-act="wipe"]'));
  click(w, $('aboutCard').querySelector('button[data-act="doWipe"]'));
  await waitFor(() => $('backupStatus').textContent.includes('All data deleted'), 'wipe');
  click(w, $('nav-log'));
  assert.ok($('sessionList').textContent.includes('No sets logged'));
  click(w, $('nav-more'));

  const bad = new w.File(['{"hello":1}'], 'x.json', { type: 'application/json' });
  Object.defineProperty($('importIn'), 'files', { value: [bad], configurable: true });
  change(w, $('importIn'));
  await waitFor(() => $('backupStatus').textContent.includes('not a Lift Ledger backup'), 'bad file rejected');

  const good = new w.File([text], 'backup.json', { type: 'application/json' });
  Object.defineProperty($('importIn'), 'files', { value: [good], configurable: true });
  change(w, $('importIn'));
  await waitFor(() => $('restorePrompt').textContent.includes('3 sets'), 'restore prompt');
  click(w, $('restorePrompt').querySelector('button[data-act="doRestore"]'));
  await waitFor(() => $('backupStatus').textContent.includes('Backup restored'), 'restore');
  click(w, $('nav-log'));
  assert.ok($('sessionList').textContent.includes('Barbell Row'));
  assert.ok($('sessionStats').textContent.includes('960'));
  assert.strictEqual($('tmin-Back').value, '14');
  ok('wipe asks first; a bad file is rejected; restoring brings back sessions and targets');

  /* ---- photos: slots and compare, using stored records ---- */
  const prev = LL.addDays(mon, -7);
  const rec = (week, pose) => ({ key: week + ':' + pose, weekStart: week, pose, takenOn: week, blob: new Blob(['x'], { type: 'image/jpeg' }) });
  w.close();
  // write photo records through a fresh page so the store holds them, then reload
  w = await load(); $ = id => w.document.getElementById(id);
  for (const r of [rec(mon, 'front'), rec(prev, 'front'), rec(prev, 'side')]) await w.LLStore.putPhoto(r);
  w.close();
  w = await load(); $ = id => w.document.getElementById(id);
  click(w, $('nav-photos'));
  assert.ok($('shot-front').querySelector('img'), 'front photo shown for this week');
  assert.ok(!$('shot-side').querySelector('img'), 'no side photo this week');
  assert.strictEqual($('add-front').textContent, 'Retake');
  assert.strictEqual($('add-side').textContent, 'Add');
  assert.strictEqual($('del-front').hidden, false);
  assert.strictEqual($('del-side').hidden, true);
  assert.strictEqual($('cmpPickers').hidden, false);
  assert.strictEqual($('cmpView').querySelectorAll('img').length, 2, 'compare shows two front photos');
  click(w, w.document.querySelector('.seg button[data-pose="side"]'));
  assert.strictEqual($('cmpView').querySelectorAll('img').length, 1, 'only last week has a side photo');
  assert.ok($('cmpView').textContent.includes('No side photo'));
  ok('photo slots and week comparison render from stored photos');

  click(w, $('del-front'));
  assert.ok($('del-front').textContent.includes('Tap again'));
  click(w, $('del-front'));
  await waitFor(() => $('photoStatus').textContent.includes('Front photo deleted'), 'photo deleted');
  assert.ok(!$('shot-front').querySelector('img'));
  ok('deleting a photo needs a second tap');

  /* ---- no errors from the page ---- */
  assert.deepStrictEqual(errors, [], 'page errors: ' + errors.join(' | '));
  ok('no console or script errors during the run');

  console.log('\n' + steps + ' checks passed');
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message); if (errors.length) console.error('page errors:', errors); process.exit(1); });
