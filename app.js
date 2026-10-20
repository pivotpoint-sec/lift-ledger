/* Lift Ledger: screens and interactions. Pure logic lives in logic.js, storage in storage.js. */
(function () {
  'use strict';

  const LL = window.LL;
  const Store = window.LLStore;
  const CFG = window.LL_CONFIG || {};
  const APP_VERSION = '0.1.0';

  const $ = function (id) { return document.getElementById(id); };
  const esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  const MUSCLES = LL.MUSCLES, EXERCISES = LL.EXERCISES, BY_NAME = LL.BY_NAME, POSES = LL.POSES;
  const fmt = LL.fmt, parse = LL.parse, addDays = LL.addDays, mondayOf = LL.mondayOf, todayIso = LL.todayIso;
  const DAY_SHORT = { weekday: 'short', day: 'numeric', month: 'short' };
  const fmtDay = function (s, o) { return parse(s).toLocaleDateString('en-GB', o || DAY_SHORT); };
  const cap = function (s) { return s.charAt(0).toUpperCase() + s.slice(1); };
  const CAMERA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';

  let days = {};
  let targets = LL.cloneTargets(LL.DEFAULT_TARGETS);
  let photos = new Map();
  let meta = { lastBackup: null, installHintDismissed: false };
  let persistent = true;
  let persisted = false;
  let ready = false;
  let tab = 'log';
  let viewWeek = mondayOf(todayIso());
  let selectedDate = todayIso();
  let chain = Promise.resolve();
  let tTimer = null;
  let deferredInstall = null;
  let pendingRestore = null;
  let armedDelete = null;
  let armTimer = null;
  const cmp = { a: null, b: null, pose: 'front' };
  const urls = new Map();   // photo key -> { blob, url }

  const TABS = ['log', 'week', 'photos', 'more'];
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = function () {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  };

  /* ===================== navigation ===================== */
  function setTab(name) {
    if (!TABS.includes(name)) name = 'log';
    tab = name;
    TABS.forEach(function (t) {
      $('view-' + t).classList.toggle('is-active', t === name);
      const b = $('nav-' + t);
      if (t === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    try { if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name); } catch (e) { /* ignore */ }
    window.scrollTo(0, 0);
    if (name === 'photos') renderPhotos();
    if (name === 'more') renderMore();
  }

  function say(id, msg, undo) {
    const el = $(id);
    el.textContent = msg || '';
    if (undo) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'link'; b.textContent = 'Undo';
      b.addEventListener('click', undo);
      el.append(' ', b);
    }
  }

  /* ===================== data changes ===================== */
  // Apply fn to a copy of one day's sets, then store it. One write at a time.
  function mutateDay(date, fn) {
    const job = async function () {
      const cur = (days[date] && days[date].sets) || [];
      const next = fn(cur.slice());
      if (next.length) {
        const day = { date: date, sets: next };
        await Store.putDay(day);
        days[date] = day;
      } else {
        await Store.deleteDay(date);
        delete days[date];
      }
      Store.requestPersist().then(function () { return Store.isPersisted(); }).then(function (p) { persisted = p; });
    };
    const p = chain.then(job);
    chain = p.catch(function () {});
    return p;
  }
  function writeError(id, err) {
    const name = err && err.name;
    if (name === 'QuotaExceededError') say(id, 'This device is out of storage, so that could not be saved.');
    else say(id, 'Could not save that. Please try again.');
  }
  const hasExamples = function () {
    return Object.keys(days).some(function (d) { return days[d].sets.some(function (s) { return s.example; }); });
  };

  /* ===================== log ===================== */
  function buildSelect() {
    let html = '';
    MUSCLES.forEach(function (m) {
      const list = EXERCISES.filter(function (e) { return e.primary[0] === m; });
      if (!list.length) return;
      html += '<optgroup label="' + m + '">' + list.map(function (e) { return '<option value="' + esc(e.name) + '">' + esc(e.name) + '</option>'; }).join('') + '</optgroup>';
    });
    $('exercise').innerHTML = html;
  }
  function weightText(ex, kg) { return (kg === 0 && ex && ex.equipment === 'bodyweight') ? 'Bodyweight' : fmt(kg) + ' kg'; }
  function weightHtml(ex, kg) { return (kg === 0 && ex && ex.equipment === 'bodyweight') ? '<b>Bodyweight</b>' : '<b>' + fmt(kg) + '</b> kg'; }

  function updateHints(prefill) {
    const ex = BY_NAME.get($('exercise').value);
    if (!ex) return;
    $('muscleHint').innerHTML =
      ex.primary.map(function (m) { return '<span class="chip p" title="Primary: counts 1 set">' + m + '</span>'; }).join('') +
      ex.secondary.map(function (m) { return '<span class="chip" title="Secondary: counts half a set">' + m + '</span>'; }).join('');
    const last = LL.lastSetFor(days, ex.name);
    $('lastHint').textContent = last
      ? 'Last time: ' + weightText(ex, last.kg) + ' × ' + last.reps + ' on ' + fmtDay(last.date)
      : (ready ? 'No sets logged for this exercise yet.' : '');
    if (prefill || (!$('kg').value && !$('reps').value)) {
      if (last) { $('kg').value = last.kg; $('reps').value = last.reps; }
      else { $('kg').value = ex.equipment === 'bodyweight' ? 0 : ''; $('reps').value = ''; }
    }
  }

  function renderSession() {
    const day = days[selectedDate];
    const sets = (day && day.sets) || [];
    $('sessionTitle').textContent = selectedDate === todayIso() ? 'Today, ' + fmtDay(selectedDate) : fmtDay(selectedDate);
    const groups = new Map();
    sets.forEach(function (s, i) {
      if (!groups.has(s.ex)) groups.set(s.ex, []);
      groups.get(s.ex).push({ s: s, i: i });
    });
    let work = 0, volume = 0;
    sets.forEach(function (s) { if (!s.warm) { work++; volume += s.kg * s.reps; } });
    $('sessionStats').innerHTML =
      '<div class="stat"><span class="k">Exercises</span><span class="v">' + groups.size + '</span></div>' +
      '<div class="stat"><span class="k">Working sets</span><span class="v">' + work + '</span></div>' +
      '<div class="stat"><span class="k">Volume</span><span class="v">' + Math.round(volume).toLocaleString('en-GB') + '<span class="u">kg</span></span></div>';
    const list = $('sessionList');
    if (!ready) { list.innerHTML = '<p class="empty">Loading your log…</p>'; return; }
    if (!sets.length) {
      list.innerHTML = '<p class="empty">No sets logged for this day. Pick an exercise above, enter weight and reps, and tap Add set. Your weekly bars update straight away.</p>';
      return;
    }
    let html = '';
    groups.forEach(function (items, name) {
      const ex = BY_NAME.get(name);
      let n = 0;
      html += '<article class="ex"><div class="ex-head"><h3>' + esc(name) + '</h3><div class="chips">' +
        (ex ? ex.primary.map(function (m) { return '<span class="chip p">' + m + '</span>'; }).join('') : '') + '</div></div><ol class="sets">';
      items.forEach(function (it) {
        const s = it.s;
        if (!s.warm) n++;
        html += '<li><span class="sn' + (s.warm ? ' w' : '') + '" title="' + (s.warm ? 'Warm-up' : 'Working set') + '">' + (s.warm ? 'W' : n) + '</span>' +
          '<span class="sv">' + weightHtml(ex, s.kg) + ' × <b>' + s.reps + '</b></span>' +
          '<span class="rp">' + (s.rpe ? 'RPE ' + s.rpe : '') + '</span>' +
          '<button type="button" class="link" data-rm="' + it.i + '" aria-label="Remove this set of ' + esc(name) + '">Remove</button></li>';
      });
      html += '</ol></article>';
    });
    list.innerHTML = html;
  }

  async function onSubmit(e) {
    e.preventDefault();
    const kg = parseFloat($('kg').value), reps = parseInt($('reps').value, 10);
    const name = $('exercise').value;
    const date = $('date').value || todayIso();
    if (!(kg >= 0) || !(reps > 0)) { say('status', 'Enter a weight (0 for bodyweight) and at least 1 rep.'); return; }
    const rpeRaw = $('rpe').value;
    const warm = $('warm').checked;
    const set = { ex: name, kg: kg, reps: reps, rpe: rpeRaw ? parseFloat(rpeRaw) : null, warm: warm };
    const before = ((days[date] && days[date].sets) || []).filter(function (s) { return s.ex === name && !s.warm; }).length;
    const btn = $('addBtn');
    btn.disabled = true;
    try {
      await mutateDay(date, function (sets) { sets.push(set); return sets; });
      selectedDate = date;
      $('warm').checked = false;
      renderAll();
      say('status', warm ? 'Warm-up added to ' + name + '.' : 'Set ' + (before + 1) + ' of ' + name + ' added.');
      $('reps').focus();
    } catch (err) {
      writeError('status', err);
    } finally {
      btn.disabled = false;
    }
  }

  async function removeSet(i) {
    const date = selectedDate;
    const s = ((days[date] && days[date].sets) || [])[i];
    if (!s) return;
    try {
      await mutateDay(date, function (sets) { sets.splice(i, 1); return sets; });
      renderAll();
      say('status', 'Removed a set of ' + s.ex + '.', async function () {
        try {
          await mutateDay(date, function (sets) { sets.splice(Math.min(i, sets.length), 0, s); return sets; });
          renderAll();
          say('status', 'Set restored.');
        } catch (err) { writeError('status', err); }
      });
    } catch (err) { writeError('status', err); }
  }

  /* ===================== week ===================== */
  function renderWeek() {
    const cur = mondayOf(todayIso());
    const ws = viewWeek, we = addDays(ws, 6);
    $('weekTitle').textContent = fmtDay(ws, { day: 'numeric', month: 'short' }) + ' – ' + fmtDay(we, { day: 'numeric', month: 'short', year: 'numeric' });
    const wk = Math.round((parse(cur) - parse(ws)) / 6048e5);
    $('weekSub').textContent = wk === 0 ? 'This week' : wk === 1 ? 'Last week' : wk + ' weeks ago';
    $('nextWeek').disabled = ws >= cur;
    if (!ready) {
      $('weekStats').innerHTML = '';
      $('muscleList').innerHTML = '<li class="empty">Loading your log…</li>';
      $('recs').innerHTML = '';
      return;
    }
    const sg = LL.suggestions(days, targets, ws, 3);
    const d = sg.data;
    $('weekStats').innerHTML =
      '<div class="stat"><span class="k">Sessions</span><span class="v">' + d.sessions + '</span></div>' +
      '<div class="stat"><span class="k">Working sets</span><span class="v">' + d.work + '</span></div>' +
      '<div class="stat"><span class="k">Volume</span><span class="v">' + Math.round(d.volume).toLocaleString('en-GB') + '<span class="u">kg</span></span></div>';

    const maxEff = Math.max.apply(null, MUSCLES.map(function (m) { return d.per[m].eff; }));
    const maxT = Math.max.apply(null, MUSCLES.map(function (m) { return targets[m][1]; }));
    const scale = Math.max(24, Math.ceil(maxT) + 4, Math.ceil(maxEff) + 2);
    const over = [];
    let rows = '';
    MUSCLES.forEach(function (m) {
      const p = d.per[m], t = targets[m], st = LL.statusOf(p.eff, t);
      if (st === 'over') over.push(m);
      const label = st === 'under' ? fmt(t[0] - p.eff) + ' short' : st === 'over' ? fmt(p.eff - t[1]) + ' over' : 'On target';
      rows += '<li class="mrow" data-status="' + st + '">' +
        '<div class="mhead"><span class="mname">' + m + '</span><span class="pill ' + st + '">' + label + '</span></div>' +
        '<div class="bar" role="img" aria-label="' + m + ': ' + fmt(p.eff) + ' effective sets, target ' + t[0] + ' to ' + t[1] + ', ' + label + '">' +
          '<span class="band" style="left:' + (t[0] / scale * 100) + '%;width:' + ((t[1] - t[0]) / scale * 100) + '%"></span>' +
          '<span class="fill" style="width:' + (p.eff / scale * 100) + '%"></span></div>' +
        '<div class="mmeta"><span><span class="eff">' + fmt(p.eff) + '</span> effective</span><span>' + p.direct + ' direct</span><span>' + p.indirect + ' indirect</span>' +
        '<span class="t">target ' + t[0] + '–' + t[1] + '</span></div></li>';
    });
    $('muscleList').innerHTML = rows;

    let rec = '';
    if (!Object.keys(days).length) {
      rec = '<h3>Nothing logged yet</h3><p class="note">Log a set on the Log tab, or load example sessions to see how the bars and suggestions work.</p>' +
        '<div class="btnrow" style="margin-top:12px"><button type="button" class="btn-quiet" data-act="loadEx">Load example sessions</button></div>';
    } else {
      if (d.work === 0) rec += '<p class="note">No sets logged this week yet. Add one on the Log tab and the bars fill in.</p>';
      if (!sg.gaps.length) {
        rec += '<h3>On track</h3><p class="note">Every muscle group has reached its weekly minimum.</p>';
      } else {
        rec += '<h3>' + (wk === 0 ? 'Still short this week' : 'Fell short that week') + '</h3>';
        sg.top.forEach(function (t) {
          const n = Math.ceil(t.short);
          rec += '<div class="rec"><div class="rhead"><strong>' + t.muscle + '</strong><span>' + n + (n === 1 ? ' set' : ' sets') + ' short</span></div><div class="picks">' +
            t.exercises.map(function (e) { return '<button type="button" class="pick" data-ex="' + esc(e.name) + '">' + esc(e.name) + ' <small>' + e.equipment + '</small></button>'; }).join('') +
            '</div></div>';
        });
      }
      if (over.length) rec += '<p class="note" style="margin-top:12px">Above range: ' + over.join(', ') + '. That is fine while you recover well. If progress stalls, trimming sets is worth trying.</p>';
    }
    $('recs').innerHTML = rec;
  }

  function pickExercise(name) {
    $('exercise').value = name;
    updateHints(true);
    setTab('log');
    $('kg').focus();
  }

  /* ===================== photos ===================== */
  function urlFor(rec) {
    const cached = urls.get(rec.key);
    if (cached && cached.blob === rec.blob) return cached.url;
    if (cached) URL.revokeObjectURL(cached.url);
    const url = URL.createObjectURL(rec.blob);
    urls.set(rec.key, { blob: rec.blob, url: url });
    return url;
  }
  function forgetUrl(key) {
    const cached = urls.get(key);
    if (cached) { URL.revokeObjectURL(cached.url); urls.delete(key); }
  }

  function renderPhotos() {
    const wk = mondayOf(todayIso());
    $('ciWeek').textContent = 'Week of ' + fmtDay(wk, DAY_SHORT);
    POSES.forEach(function (p) {
      const rec = photos.get(wk + ':' + p);
      $('shot-' + p).innerHTML = rec ? '<img src="' + urlFor(rec) + '" alt="' + cap(p) + ' photo for this week">' : CAMERA;
      $('add-' + p).textContent = rec ? 'Retake' : 'Add';
      $('del-' + p).hidden = !rec;
      $('del-' + p).textContent = armedDelete === p ? 'Tap again to delete' : 'Delete';
    });
    renderComparePickers();
  }
  function photoWeeks() {
    return Array.from(new Set(Array.from(photos.values()).map(function (p) { return p.weekStart; }))).sort();
  }
  function renderComparePickers() {
    const weeks = photoWeeks();
    $('cmpPickers').hidden = weeks.length < 2;
    document.querySelector('.seg').hidden = weeks.length < 2;
    if (weeks.length < 2) {
      $('cmpView').innerHTML = '<p class="empty">' + (weeks.length === 1
        ? 'You have photos from one week so far. Add photos next week and the two weeks appear here side by side.'
        : 'Take photos in two different weeks and they appear here side by side.') + '</p>';
      return;
    }
    if (!weeks.includes(cmp.a)) cmp.a = weeks[0];
    if (!weeks.includes(cmp.b)) cmp.b = weeks[weeks.length - 1];
    const opts = function (sel) {
      return weeks.map(function (w) {
        return '<option value="' + w + '"' + (w === sel ? ' selected' : '') + '>' + esc(fmtDay(w, { day: 'numeric', month: 'short' })) + '</option>';
      }).join('');
    };
    $('cmpA').innerHTML = opts(cmp.a);
    $('cmpB').innerHTML = opts(cmp.b);
    renderCompareView();
  }
  function renderCompareView() {
    document.querySelectorAll('.seg button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.pose === cmp.pose));
    });
    const figure = function (w) {
      const rec = photos.get(w + ':' + cmp.pose);
      const label = 'Week of ' + fmtDay(w, { day: 'numeric', month: 'short' });
      return '<figure><div class="shot">' +
        (rec ? '<img src="' + urlFor(rec) + '" alt="' + cap(cmp.pose) + ' photo, ' + esc(label) + '">' : '<span class="muted small">No ' + cmp.pose + ' photo</span>') +
        '</div><figcaption>' + esc(label) + '</figcaption></figure>';
    };
    $('cmpView').innerHTML = '<div class="cmp">' + figure(cmp.a) + figure(cmp.b) + '</div>';
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('load')); };
      img.src = url;
    });
  }
  // Shrinks a photo to at most 1280px on its long side, as JPEG, so a few months of photos stay small.
  async function processPhoto(file) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { bmp = await loadImage(file); }
    const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    return new Promise(function (resolve, reject) {
      c.toBlob(function (b) { b ? resolve(b) : reject(new Error('encode')); }, 'image/jpeg', 0.85);
    });
  }
  async function handlePhoto(pose, file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { say('photoStatus', 'That file is not an image.'); return; }
    say('photoStatus', 'Saving…');
    try {
      const blob = await processPhoto(file);
      const wk = mondayOf(todayIso());
      const rec = { key: wk + ':' + pose, weekStart: wk, pose: pose, takenOn: todayIso(), blob: blob };
      await Store.putPhoto(rec);
      photos.set(rec.key, rec);
      Store.requestPersist();
      say('photoStatus', cap(pose) + ' photo saved.');
      renderPhotos();
    } catch (err) {
      say('photoStatus', err && err.name === 'QuotaExceededError'
        ? 'This device is out of storage, so the photo could not be saved.'
        : 'Could not save that photo. Please try a different one.');
    }
  }
  async function deletePhoto(pose) {
    const wk = mondayOf(todayIso()), key = wk + ':' + pose;
    if (armedDelete !== pose) {
      armedDelete = pose;
      clearTimeout(armTimer);
      armTimer = setTimeout(function () { armedDelete = null; renderPhotos(); }, 4000);
      renderPhotos();
      return;
    }
    clearTimeout(armTimer);
    armedDelete = null;
    try {
      await Store.deletePhoto(key);
      photos.delete(key);
      forgetUrl(key);
      say('photoStatus', cap(pose) + ' photo deleted.');
    } catch (err) { say('photoStatus', 'Could not delete that photo.'); }
    renderPhotos();
  }

  /* ===================== more: backup, targets, install ===================== */
  function renderTargets() {
    let html = '<div class="tgrid"><span class="h">Muscle</span><span class="h">Min</span><span class="h">Max</span>';
    MUSCLES.forEach(function (m) {
      html += '<span>' + m + '</span>' +
        '<input type="number" min="0" max="60" step="1" inputmode="numeric" id="tmin-' + m + '" data-m="' + m + '" aria-label="' + m + ' minimum sets" value="' + targets[m][0] + '">' +
        '<input type="number" min="0" max="60" step="1" inputmode="numeric" id="tmax-' + m + '" data-m="' + m + '" aria-label="' + m + ' maximum sets" value="' + targets[m][1] + '">';
    });
    html += '</div><div class="tfoot"><span class="note">Effective sets per week.</span><button type="button" class="btn-quiet" id="resetT">Reset to defaults</button></div>';
    $('targets').innerHTML = html;
  }
  function onTargetChange(e) {
    const m = e.target.dataset && e.target.dataset.m;
    if (!m) return;
    let lo = parseFloat($('tmin-' + m).value), hi = parseFloat($('tmax-' + m).value);
    if (!(lo >= 0)) lo = LL.DEFAULT_TARGETS[m][0];
    if (!(hi >= 0)) hi = LL.DEFAULT_TARGETS[m][1];
    if (hi < lo) hi = lo;
    targets[m] = [lo, hi];
    $('tmin-' + m).value = lo; $('tmax-' + m).value = hi;
    renderWeek();
    saveTargets();
  }
  function saveTargets() {
    clearTimeout(tTimer);
    tTimer = setTimeout(function () { Store.setMeta('targets', targets).catch(function () {}); }, 400);
  }

  function renderMore() {
    $('lastBackup').textContent = meta.lastBackup
      ? 'Last backup: ' + fmtDay(meta.lastBackup, { day: 'numeric', month: 'short', year: 'numeric' }) + '.'
      : 'No backup yet.';

    let install = '<h3>Install on your phone</h3>';
    if (isStandalone()) install += '<p class="note">Installed. You are using the app from your home screen.</p>';
    else if (deferredInstall) install += '<p class="note">Install Lift Ledger so it opens full screen and works without a signal.</p><div class="btnrow"><button type="button" class="btn" data-act="install">Install app</button></div>';
    else if (isIos) install += '<p class="note">Open this page in Safari, tap the Share button, then choose Add to Home Screen. It then opens full screen and works without a signal.</p>';
    else install += '<p class="note">Use your browser menu and choose Install app or Add to Home screen. It then opens full screen and works without a signal.</p>';
    $('installCard').innerHTML = install;

    let about = '<h3>About</h3>';
    about += '<p class="note">' + (persistent
      ? (persisted ? 'Your data is stored on this device and protected from automatic clean-up.' : 'Your data is stored on this device. Back it up regularly, because the browser may clear it if space runs low.')
      : 'This browser is not keeping data, so entries will be lost when you close the page.') + '</p>';
    about += '<p class="note">Nothing you log or photograph is sent anywhere.</p>';
    if (/^https:\/\//.test(CFG.feedbackUrl || '')) {
      about += '<div class="btnrow"><a class="btn-quiet" style="display:inline-flex;align-items:center;justify-content:center;text-decoration:none" href="' + esc(CFG.feedbackUrl) + '" target="_blank" rel="noopener">Send feedback</a></div>';
    }
    about += '<div id="wipeArea"><button type="button" class="btn-quiet btn-danger" data-act="wipe">Delete all data…</button></div>';
    about += '<p class="muted small">Version ' + APP_VERSION + '</p>';
    $('aboutCard').innerHTML = about;
  }

  function readText(file) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsText(file);
    });
  }
  async function doExport() {
    say('backupStatus', 'Preparing backup…');
    try {
      const data = await Store.exportBackup($('incPhotos').checked);
      const name = 'lift-ledger-backup-' + todayIso() + '.json';
      const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
      let shared = false;
      if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: 'Lift Ledger backup' }); shared = true; }
        catch (err) {
          if (err && err.name === 'AbortError') { say('backupStatus', 'Backup cancelled.'); return; }
        }
      }
      if (!shared) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(file);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
      }
      meta.lastBackup = todayIso();
      await Store.setMeta('lastBackup', meta.lastBackup);
      say('backupStatus', 'Backup saved. Keep the file somewhere safe, such as your email or cloud storage.');
      renderMore();
      renderBanners();
    } catch (err) {
      say('backupStatus', 'Could not create the backup.');
    }
  }
  async function onImportFile(file) {
    if (!file) return;
    let obj;
    try { obj = JSON.parse(await readText(file)); }
    catch (e) { say('backupStatus', 'That file could not be read as a backup.'); return; }
    const parsed = LL.parseBackup(obj);
    if (!parsed.ok) { say('backupStatus', parsed.error); return; }
    pendingRestore = parsed;
    const c = parsed.counts;
    $('restorePrompt').innerHTML = '<div class="notice"><span>Backup' + (parsed.exportedAt ? ' from ' + esc(fmtDay(parsed.exportedAt, { day: 'numeric', month: 'short', year: 'numeric' })) : '') +
      ': ' + c.days + ' session ' + (c.days === 1 ? 'day' : 'days') + ', ' + c.sets + ' sets, ' + c.photos + ' ' + (c.photos === 1 ? 'photo' : 'photos') +
      '. Restoring adds these and replaces any session on the same date.</span>' +
      '<span class="btnrow"><button type="button" class="btn" data-act="doRestore">Restore</button><button type="button" class="btn-quiet" data-act="cancelRestore">Cancel</button></span></div>';
    say('backupStatus', '');
  }
  async function reloadFromStore() {
    days = await Store.allDays();
    targets = LL.mergeTargets(await Store.getMeta('targets'));
    meta.lastBackup = (await Store.getMeta('lastBackup')) || null;
    urls.forEach(function (v) { URL.revokeObjectURL(v.url); });
    urls.clear();
    photos = new Map((await Store.allPhotos()).map(function (p) { return [p.key, p]; }));
  }
  async function doRestore() {
    if (!pendingRestore) return;
    try {
      await Store.importBackup(pendingRestore);
      pendingRestore = null;
      $('restorePrompt').innerHTML = '';
      await reloadFromStore();
      renderTargets();
      renderAll();
      say('backupStatus', 'Backup restored.');
    } catch (err) { say('backupStatus', 'Could not restore that backup.'); }
  }
  async function doWipe() {
    try {
      await Store.clearAll();
      days = {}; photos = new Map(); targets = LL.cloneTargets(LL.DEFAULT_TARGETS);
      meta = { lastBackup: null, installHintDismissed: false };
      urls.forEach(function (v) { URL.revokeObjectURL(v.url); });
      urls.clear();
      renderTargets();
      renderAll();
      say('backupStatus', 'All data deleted.');
    } catch (err) { say('backupStatus', 'Could not delete the data.'); }
  }

  async function loadExamples() {
    try {
      const ex = LL.exampleDays(todayIso());
      for (const d of Object.keys(ex)) {
        if (!days[d]) { await Store.putDay(ex[d]); days[d] = ex[d]; }
      }
      renderAll();
    } catch (err) { say('status', 'Could not load the examples.'); }
  }
  async function clearExamples() {
    try {
      const dates = Object.keys(days).filter(function (d) { return days[d].sets.some(function (s) { return s.example; }); });
      for (const d of dates) await mutateDay(d, function (sets) { return sets.filter(function (s) { return !s.example; }); });
      renderAll();
      say('status', 'Example sessions cleared.');
    } catch (err) { writeError('status', err); }
  }

  /* ===================== banners and rendering ===================== */
  function renderBanners() {
    const items = [];
    if (ready && !persistent) items.push({ cls: 'warn', text: 'This browser is not keeping data (private browsing?). Entries will be lost when you close the page.' });
    if (hasExamples()) items.push({ text: 'Example sessions are loaded so you can see how the bars work.', act: 'clearEx', label: 'Clear examples' });
    else if (ready && LL.needsBackup(days, meta.lastBackup, todayIso())) items.push({ text: 'Your log lives only on this device. It is a good time to back it up.', act: 'goMore', label: 'Back up' });
    if (ready && isIos && !isStandalone() && !meta.installHintDismissed) items.push({ text: 'Tip: tap Share, then Add to Home Screen, to install this app.', act: 'dismissInstall', label: 'Got it' });
    $('banners').innerHTML = items.map(function (i) {
      return '<div class="notice' + (i.cls ? ' ' + i.cls : '') + '"><span>' + esc(i.text) + '</span>' +
        (i.act ? '<button type="button" class="btn-quiet" data-act="' + i.act + '">' + esc(i.label) + '</button>' : '') + '</div>';
    }).join('');
  }
  function renderAll() {
    renderBanners();
    renderSession();
    renderWeek();
    updateHints(false);
    if (tab === 'photos') renderPhotos();
    if (tab === 'more') renderMore();
  }

  /* ===================== events ===================== */
  function onAction(act) {
    if (act === 'clearEx') clearExamples();
    else if (act === 'loadEx') loadExamples();
    else if (act === 'goMore') setTab('more');
    else if (act === 'dismissInstall') {
      meta.installHintDismissed = true;
      Store.setMeta('installHintDismissed', true).catch(function () {});
      renderBanners();
    } else if (act === 'install' && deferredInstall) {
      deferredInstall.prompt();
      deferredInstall.userChoice.then(function () { deferredInstall = null; renderMore(); });
    } else if (act === 'doRestore') doRestore();
    else if (act === 'cancelRestore') { pendingRestore = null; $('restorePrompt').innerHTML = ''; }
    else if (act === 'wipe') {
      $('wipeArea').innerHTML = '<div class="notice warn"><span>This removes every session, photo and setting on this device. It cannot be undone.</span>' +
        '<span class="btnrow"><button type="button" class="btn-quiet btn-danger" data-act="doWipe">Delete everything</button><button type="button" class="btn-quiet" data-act="cancelWipe">Cancel</button></span></div>';
    } else if (act === 'cancelWipe') renderMore();
    else if (act === 'doWipe') doWipe();
  }

  function bind() {
    TABS.forEach(function (t) { $('nav-' + t).addEventListener('click', function () { setTab(t); }); });
    window.addEventListener('hashchange', function () { setTab((location.hash || '#log').slice(1)); });

    $('exercise').addEventListener('change', function () { updateHints(true); });
    $('date').addEventListener('change', function () { selectedDate = $('date').value || todayIso(); renderSession(); });
    $('setForm').addEventListener('submit', onSubmit);
    $('sessionList').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-rm]');
      if (b) removeSet(parseInt(b.dataset.rm, 10));
    });
    $('recs').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-ex]');
      if (b) pickExercise(b.dataset.ex);
    });
    $('prevWeek').addEventListener('click', function () { viewWeek = addDays(viewWeek, -7); renderWeek(); });
    $('nextWeek').addEventListener('click', function () {
      if (viewWeek < mondayOf(todayIso())) { viewWeek = addDays(viewWeek, 7); renderWeek(); }
    });

    POSES.forEach(function (p) {
      $('add-' + p).addEventListener('click', function () { $('photoIn-' + p).click(); });
      $('photoIn-' + p).addEventListener('change', function (e) { handlePhoto(p, e.target.files[0]); e.target.value = ''; });
      $('del-' + p).addEventListener('click', function () { deletePhoto(p); });
    });
    $('cmpA').addEventListener('change', function () { cmp.a = $('cmpA').value; renderCompareView(); });
    $('cmpB').addEventListener('change', function () { cmp.b = $('cmpB').value; renderCompareView(); });
    document.querySelectorAll('.seg button').forEach(function (b) {
      b.addEventListener('click', function () { cmp.pose = b.dataset.pose; renderCompareView(); });
    });

    $('exportBtn').addEventListener('click', doExport);
    $('importBtn').addEventListener('click', function () { $('importIn').click(); });
    $('importIn').addEventListener('change', function (e) { onImportFile(e.target.files[0]); e.target.value = ''; });
    $('targets').addEventListener('change', onTargetChange);
    $('targets').addEventListener('click', function (e) {
      if (e.target.id === 'resetT') { targets = LL.cloneTargets(LL.DEFAULT_TARGETS); renderTargets(); renderWeek(); saveTargets(); }
    });
    document.addEventListener('click', function (e) {
      const b = e.target.closest('button[data-act]');
      if (b) onAction(b.dataset.act);
    });
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredInstall = e; if (tab === 'more') renderMore(); });
    window.addEventListener('appinstalled', function () { deferredInstall = null; if (tab === 'more') renderMore(); });
  }

  /* ===================== start ===================== */
  async function boot() {
    $('todayLabel').textContent = fmtDay(todayIso(), { weekday: 'long', day: 'numeric', month: 'long' });
    buildSelect();
    $('date').value = selectedDate;
    renderTargets();
    bind();
    setTab((location.hash || '#log').slice(1));
    renderAll();

    persistent = await Store.init();
    try {
      await reloadFromStore();
      meta.installHintDismissed = !!(await Store.getMeta('installHintDismissed'));
      persisted = await Store.isPersisted();
    } catch (e) { /* start empty */ }
    ready = true;
    renderTargets();
    renderAll();
    updateHints(false);

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    }
  }
  boot();
})();
