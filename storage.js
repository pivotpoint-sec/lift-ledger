/* Lift Ledger: on-device storage (IndexedDB), with an in-memory fallback.
 *
 * Stores
 *   days   { date, sets: [...] }            keyed by 'YYYY-MM-DD'
 *   meta   key/value (targets, lastBackup, installHintDismissed)
 *   photos { key, weekStart, pose, takenOn, blob }   key = 'YYYY-MM-DD:front' (weekStart + pose)
 *
 * Nothing here talks to a network.
 */
(function (root) {
  'use strict';

  const DB_NAME = 'lift-ledger';
  const DB_VERSION = 1;
  let db = null;       // IDBDatabase, or null when running on the in-memory fallback
  let mem = null;      // { days: Map, meta: Map, photos: Map }
  let persistRequested = false;

  function openDb() {
    return new Promise(function (resolve, reject) {
      const r = root.indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = function () {
        const d = r.result;
        d.createObjectStore('days', { keyPath: 'date' });
        d.createObjectStore('meta');
        d.createObjectStore('photos', { keyPath: 'key' });
      };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.onblocked = function () { reject(new Error('blocked')); };
    });
  }
  function reqP(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function txDone(t) {
    return new Promise(function (resolve, reject) {
      t.oncomplete = function () { resolve(); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error || new Error('aborted')); };
    });
  }

  // Resolves true when data will be kept on the device, false when running in memory only.
  async function init() {
    try {
      if (!root.indexedDB) throw new Error('no indexedDB');
      db = await openDb();
      return true;
    } catch (e) {
      db = null;
      mem = { days: new Map(), meta: new Map(), photos: new Map() };
      return false;
    }
  }

  async function all(name) {
    if (!db) return Array.from(mem[name].values());
    return reqP(db.transaction(name, 'readonly').objectStore(name).getAll());
  }
  async function put(name, value, key) {
    if (!db) { mem[name].set(key !== undefined ? key : (value.date || value.key), value); return; }
    const t = db.transaction(name, 'readwrite');
    if (key !== undefined) t.objectStore(name).put(value, key); else t.objectStore(name).put(value);
    await txDone(t);
  }
  async function del(name, key) {
    if (!db) { mem[name].delete(key); return; }
    const t = db.transaction(name, 'readwrite');
    t.objectStore(name).delete(key);
    await txDone(t);
  }

  const api = {
    init: init,

    allDays: async function () {
      const out = {};
      (await all('days')).forEach(function (d) {
        const clean = root.LL.sanitizeDay(d.date, d);
        if (clean) out[clean.date] = clean;
      });
      return out;
    },
    putDay: function (day) { return put('days', day); },
    deleteDay: function (date) { return del('days', date); },

    getMeta: async function (key) {
      if (!db) return mem.meta.get(key);
      return reqP(db.transaction('meta', 'readonly').objectStore('meta').get(key));
    },
    setMeta: function (key, value) { return put('meta', value, key); },

    allPhotos: function () { return all('photos'); },
    putPhoto: function (rec) { return put('photos', rec); },
    deletePhoto: function (key) { return del('photos', key); },

    clearAll: async function () {
      if (!db) { mem = { days: new Map(), meta: new Map(), photos: new Map() }; return; }
      const t = db.transaction(['days', 'meta', 'photos'], 'readwrite');
      t.objectStore('days').clear(); t.objectStore('meta').clear(); t.objectStore('photos').clear();
      await txDone(t);
    },

    // Ask the browser not to evict this data. Safe to call repeatedly; only asks once per page load.
    requestPersist: async function () {
      if (persistRequested) return;
      persistRequested = true;
      try { if (root.navigator && root.navigator.storage && root.navigator.storage.persist) await root.navigator.storage.persist(); } catch (e) { /* ignore */ }
    },
    isPersisted: async function () {
      try { return !!(root.navigator.storage && root.navigator.storage.persisted && await root.navigator.storage.persisted()); } catch (e) { return false; }
    },

    /* ---------- backup ---------- */
    exportBackup: async function (includePhotos) {
      const days = await api.allDays();
      const targets = await api.getMeta('targets');
      const out = {
        app: 'lift-ledger', version: 1, exportedAt: new Date().toISOString(),
        days: days, targets: targets || null, photos: []
      };
      if (includePhotos) {
        const photos = await api.allPhotos();
        for (const p of photos) {
          out.photos.push({ weekStart: p.weekStart, pose: p.pose, takenOn: p.takenOn, data: await blobToDataUrl(p.blob) });
        }
      }
      return out;
    },
    // `parsed` must come from LL.parseBackup. Days on the same date are replaced.
    importBackup: async function (parsed) {
      for (const d of Object.keys(parsed.days)) await api.putDay(parsed.days[d]);
      if (parsed.targets) await api.setMeta('targets', parsed.targets);
      for (const p of parsed.photos) {
        const blob = await (await root.fetch(p.data)).blob();
        await api.putPhoto({ key: p.weekStart + ':' + p.pose, weekStart: p.weekStart, pose: p.pose, takenOn: p.takenOn, blob: blob });
      }
    }
  };

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      const fr = new root.FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  root.LLStore = api;
})(typeof self !== 'undefined' ? self : this);
