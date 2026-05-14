/* ============================================================
   ClassTrack – app.js  v2.0
   Changes: editable profiles, P/A + notes attendance,
            load & edit past attendance by date
   ============================================================ */

'use strict';

/* ─────────────────────────────────────────────────────────────
   CONSTANTS & STATE
───────────────────────────────────────────────────────────── */
const DB_NAME    = 'classtrack';
const DB_VERSION = 7;
const STORES     = { students: 'students', attendance: 'attendance', pending: 'pending', settings: 'settings', classes: 'classes', reminders: 'reminders' };


/* ── DEBUG: call window.debugAttState() in browser console ── */
window.debugReminder = async function() {
  const reminders = await dbGetAll(STORES.reminders);
  console.group('=== Reminders in IndexedDB ===');
  console.log('Total:', reminders.length);
  reminders.forEach(r => console.log(JSON.stringify(r)));
  console.groupEnd();

  if (!APP.settings.gasUrl) { console.log('No GAS URL set'); return; }
  console.log('GAS URL:', APP.settings.gasUrl);
  console.log('Online:', APP.online);

  if (reminders.length) {
    const r = reminders[0];
    const payload = { ...r, done: String(r.done || false), completedAt: r.completedAt || '' };
    console.log('Testing saveReminder with:', JSON.stringify(payload));
    try {
      const result = await gasRequest('saveReminder', payload);
      console.log('GAS response:', JSON.stringify(result));
    } catch(e) {
      console.error('GAS error:', e.message);
    }
  }
};

window.debugAttState = async function() {
  const date     = document.getElementById('att-date').value;
  const students = await dbGetAll(STORES.students);
  const allAtt   = await dbGetAll(STORES.attendance);
  const dayAtt   = allAtt.filter(a => a.date === date);

  console.group('=== ClassTrack Debug ===');
  console.log('Date:', date);
  console.log('Total students in DB:', students.length);
  console.log('Total attendance records:', allAtt.length);
  console.log('Attendance for this date:', dayAtt.length);
  console.log('\nFirst student sample:', JSON.stringify(students[0]));
  console.log('First att record sample:', JSON.stringify(allAtt[0]));
  console.log('\nStudent IDs:', students.map(s => s.id));
  console.log('Att studentIds for this date:', dayAtt.map(a => a.studentId));
  const sIds = new Set(students.map(s => s.id));
  const matched = dayAtt.filter(a => sIds.has(a.studentId));
  console.log('\nMatched records:', matched.length);
  console.log('Unmatched att records:', dayAtt.filter(a => !sIds.has(a.studentId)).map(a => a.studentId));
  console.log('\ncurrent attState:', JSON.stringify(attState));
  console.groupEnd();
};

const APP = {
  db: null,
  online: navigator.onLine,
  syncing: false,
  saving: false,
  currentScreen: 'dashboard',
  profileStudentId: null,
  installPrompt: null,
  settings: { gasUrl: '', instructorName: '', classes: [], autoSync: true }
};

/* ─────────────────────────────────────────────────────────────
   IndexedDB LAYER
───────────────────────────────────────────────────────────── */
async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORES.students)) {
        const s = db.createObjectStore(STORES.students, { keyPath: 'id' });
        s.createIndex('program', 'program', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.attendance)) {
        const a = db.createObjectStore(STORES.attendance, { autoIncrement: true, keyPath: '_localId' });
        a.createIndex('dateClass',   ['date','classId'],   { unique: false });
        a.createIndex('studentDate', ['studentId','date'], { unique: false });
      } else {
        // Ensure indexes exist on upgrade
        const a = tx.objectStore(STORES.attendance);
        if (!a.indexNames.contains('studentDate')) {
          a.createIndex('studentDate', ['studentId','date'], { unique: false });
        }
      }
      if (!db.objectStoreNames.contains(STORES.pending)) {
        db.createObjectStore(STORES.pending,  { autoIncrement: true, keyPath: '_pendingId' });
      }
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.classes)) {
        db.createObjectStore(STORES.classes, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.reminders)) {
        const r = db.createObjectStore(STORES.reminders, { keyPath: 'id' });
        r.createIndex('studentId', 'studentId', { unique: false });
        r.createIndex('dueDate',   'dueDate',   { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function dbGetAll(storeName, indexName, query) {
  return new Promise((resolve, reject) => {
    const tx    = APP.db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req   = indexName ? store.index(indexName).getAll(query) : store.getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function dbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx  = APP.db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function dbPut(storeName, data) {
  return new Promise((resolve, reject) => {
    const tx  = APP.db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(data);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function dbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx  = APP.db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function dbClear(storeName) {
  return new Promise((resolve, reject) => {
    const tx  = APP.db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

/* ─────────────────────────────────────────────────────────────
   SETTINGS
───────────────────────────────────────────────────────────── */
async function loadSettings() {
  try {
    for (const key of ['gasUrl','instructorName','classes','autoSync']) {
      const row = await dbGet(STORES.settings, key);
      if (row !== undefined) APP.settings[key] = row.value;
    }
  } catch {}
}

async function saveSetting(key, value) {
  await dbPut(STORES.settings, { key, value });
  APP.settings[key] = value;
}

/* ─────────────────────────────────────────────────────────────
   GAS API
───────────────────────────────────────────────────────────── */
async function gasRequest(action, payload = {}) {
  if (!APP.settings.gasUrl) throw new Error('No GAS URL configured.');
  const url = `${APP.settings.gasUrl}?action=${action}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

/* ─────────────────────────────────────────────────────────────
   SYNC ENGINE
───────────────────────────────────────────────────────────── */
/* Normalize a student object so all keys are consistent camelCase
   regardless of how Google Sheets stored the header */
function normalizeStudent(raw) {
  // Map any casing variation to consistent camelCase keys
  const map = {
    'id':'id', 'studentid':'studentId', 'studentId':'studentId',
    'name':'name', 'gender':'gender', 'phone':'phone', 'email':'email',
    'program':'program', 'workplace':'workplace', 'notes':'notes',
    'observations':'observations', 'followup':'followup'
  };
  const out = {};
  Object.keys(raw).forEach(k => {
    const trimmed = k.trim(); // remove any accidental spaces
    const norm = map[trimmed] || map[trimmed.toLowerCase()];
    if (norm) out[norm] = String(raw[k] || '');
    else out[trimmed] = raw[k];
  });
  // Ensure id is always set as the keyPath
  if (!out.id && out.studentId) out.id = 's' + out.studentId;
  return out;
}

async function syncRoster() {
  if (!APP.online || !APP.settings.gasUrl) return;
  setSyncState('syncing', 'Syncing…');
  try {
    // ── 1. Sync students ──────────────────────────────────
    const data = await gasRequest('getStudents');
    if (data.students && Array.isArray(data.students)) {
      await dbClear(STORES.students);
      for (const s of data.students) {
        await dbPut(STORES.students, normalizeStudent(s));
      }
      console.log('[Sync] Students loaded:', data.students.length);
    }

    // ── 2. Sync attendance from Sheet → IndexedDB ─────────
    const attData = await gasRequest('getAttendance', {});
    if (attData.records && Array.isArray(attData.records)) {
      // Build a set of existing local records keyed by studentId|date
      const localAtt   = await dbGetAll(STORES.attendance);
      const localKeys  = new Set(localAtt.map(r => r.studentId + '|' + r.date));

      let pulled = 0;
      for (const rec of attData.records) {
        // GAS returns lowercase keys — handle both
        const studentId = String(rec.studentid || rec.studentId || '').trim();
        const date      = String(rec.date      || '').trim().substring(0, 10);
        const status    = String(rec.status    || '').trim();

        if (!studentId || !date || !status) continue;

        const key = studentId + '|' + date;
        if (localKeys.has(key)) {
          // Update existing local record with sheet version
          const existing = localAtt.find(r => r.studentId === studentId && r.date === date);
          if (existing && !existing._localDirty) {
            existing.status  = status;
            existing.classId = String(rec.classid || rec.classId || '').trim();
            existing.note    = String(rec.note    || '').trim();
            existing._synced = true;
            await dbPut(STORES.attendance, existing);
          }
        } else {
          // New record from sheet — add to local DB
          await dbPut(STORES.attendance, {
            studentId, date,
            classId: String(rec.classid || rec.classId || '').trim(),
            status,
            note:    String(rec.note || '').trim(),
            _synced: true
          });
          localKeys.add(key);
          pulled++;
        }
      }
      console.log('[Sync] Attendance pulled:', pulled, 'updated existing');
    }

    // Also pull reminders from sheet
    await syncReminders();

    toast('Synced ✓', 'success');
    setSyncState('online', 'Online');
    // Sync reminders from sheet
    await syncRemindersFromSheet();

    // Always re-render attendance screen after sync so P/A reflects sheet data
    if (APP.currentScreen === 'attendance') {
      attState = {}; // clear so synced records seed fresh
      await renderAttendanceList();
    }
    if (APP.currentScreen === 'reminders') await renderRemindersScreen();
    refreshDashboard();
  renderDashboardReminders();
  } catch (err) {
    console.error('[Sync] Failed:', err);
    setSyncState('online', 'Online');
    toast('Sync failed: ' + err.message, 'error');
  }
}

async function syncPendingAttendance() {
  if (!APP.online || !APP.settings.gasUrl) return;
  const pending = await dbGetAll(STORES.pending);
  if (!pending.length) return;
  setSyncState('syncing', 'Syncing…');
  let synced = 0;
  for (const item of pending) {
    try {
      if (item.type === 'studentUpdate') {
        await gasRequest('updateStudent', item.payload);
      } else if (item.type === 'addStudent') {
        await gasRequest('addStudent', item.payload);
      } else if (item.type === 'saveClass') {
        await gasRequest('saveClass', item.payload);
      } else if (item.type === 'deleteClass') {
        await gasRequest('deleteClass', item.payload);
      } else if (item.type === 'saveReminder') {
        await gasRequest('saveReminder', item.payload);
      } else if (item.type === 'deleteReminder') {
        await gasRequest('deleteReminder', item.payload);
      } else if (item.payload) {
        await gasRequest('saveAttendance', item.payload);
      }
      await dbDelete(STORES.pending, item._pendingId);
      synced++;
    } catch (err) {
      console.warn('Sync failed for item', item._pendingId, err.message);
      // Leave in pending queue — will retry on next sync
    }
  }
  if (synced) toast(`Synced ${synced} records ✓`, 'success');
  setSyncState('online', 'Online');
  refreshDashboard();
}

/* records: [{ studentId, status('P'|'A'), note }] */
/* Save or update a single student's attendance record for a date.
   Always upserts — never creates a duplicate for the same studentId+date. */
async function saveOneRecord(studentId, dateStr, classId, status, note) {
  // If classId is empty, fall back to the student's program field
  if (!classId) {
    const student = await dbGet(STORES.students, studentId);
    if (student) classId = student.program || '';
  }

  // Find existing record for this student+date using simple filter (more reliable than compound index)
  const allRecs  = await dbGetAll(STORES.attendance);
  const existing = allRecs.find(r => r.studentId === studentId && r.date === dateStr);

  const record = existing
    ? { ...existing, status, note: note || '', classId, _synced: false, _localDirty: true }
    : { studentId, date: dateStr, classId, status, note: note || '', _synced: false, _localDirty: true };

  await dbPut(STORES.attendance, record);

  // Push to Google Sheets
  const payload = {
    date: dateStr, classId,
    instructor: APP.settings.instructorName,
    records: [{ studentId, status, note: note || '' }]
  };

  if (APP.online && APP.settings.gasUrl) {
    try {
      await gasRequest('saveAttendance', payload);
      // Mark synced
      const allRecs2 = await dbGetAll(STORES.attendance);
      const saved = allRecs2.find(r => r.studentId === studentId && r.date === dateStr);
      if (saved) { saved._synced = true; saved._localDirty = false; await dbPut(STORES.attendance, saved); }
    } catch {
      await queuePending(payload);
    }
  } else {
    await queuePending(payload);
  }
  refreshDashboard();
}

async function queuePending(payload) {
  // Merge into existing pending entry for same date+class if possible
  const allPending = await dbGetAll(STORES.pending);
  const existing   = allPending.find(p => p.payload && p.payload.date === payload.date && p.payload.classId === payload.classId && !p.type);
  if (existing) {
    // Upsert the record inside the pending payload
    const idx = existing.payload.records.findIndex(r => r.studentId === payload.records[0].studentId);
    if (idx >= 0) existing.payload.records[idx] = payload.records[0];
    else existing.payload.records.push(payload.records[0]);
    await dbPut(STORES.pending, existing);
  } else {
    await dbPut(STORES.pending, { payload, ts: Date.now() });
  }
}

/* Bulk save — used by "Mark All Present" then manual save button (kept for compatibility) */
async function saveAttendance(dateStr, classId, records) {
  for (const rec of records) {
    await saveOneRecord(rec.studentId, dateStr, classId, rec.status, rec.note || '');
  }
}

async function saveStudentProfile(studentId, fields) {
  const student = await dbGet(STORES.students, studentId);
  if (!student) return;
  Object.assign(student, fields);
  await dbPut(STORES.students, student);

  const payload = { id: studentId, ...fields };

  if (APP.online && APP.settings.gasUrl) {
    try {
      await gasRequest('updateStudent', payload);
      toast('Profile saved ✓', 'success');
    } catch {
      // Failed online — queue for retry
      await upsertPendingItem('studentUpdate', studentId, payload);
      toast('Profile saved — will sync shortly', 'success');
    }
  } else {
    // Offline — queue for when connection restores
    await upsertPendingItem('studentUpdate', studentId, payload);
    toast('Profile saved offline — will sync when online ✓', 'success');
  }
}

/* Upsert a pending item — replaces existing entry of same type+id to avoid duplicates */
async function upsertPendingItem(type, entityId, payload) {
  const allPending = await dbGetAll(STORES.pending);
  const existing   = allPending.find(p => p.type === type && p.entityId === entityId);
  if (existing) {
    existing.payload = payload;
    existing.ts      = Date.now();
    await dbPut(STORES.pending, existing);
  } else {
    await dbPut(STORES.pending, { type, entityId, payload, ts: Date.now() });
  }
}

/* ─────────────────────────────────────────────────────────────
   UI HELPERS
───────────────────────────────────────────────────────────── */
function setSyncState(state, label) {
  const badge = document.getElementById('sync-badge');
  badge.className = state;
  badge.id = 'sync-badge';
  const span = badge.querySelector('span');
  if (span) span.textContent = label;
  // Update dashboard sync bar color
  const bar = document.getElementById('dash-sync-bar');
  const dot = document.getElementById('dash-sync-dot');
  const onlineBadge = document.getElementById('dash-online-badge');
  if (bar) bar.style.background = state === 'offline' ? 'var(--danger)' : state === 'syncing' ? 'var(--warn)' : 'var(--lime)';
  if (dot) dot.style.background = state === 'offline' ? 'var(--danger)' : state === 'syncing' ? 'var(--warn)' : 'var(--lime)';
  if (onlineBadge) {
    onlineBadge.textContent = label;
    onlineBadge.className = 'badge ' + (state === 'offline' ? 'danger-badge' : state === 'syncing' ? 'orange-badge' : 'lime-badge');
  }
}

function toast(msg, type = '') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ'} ${msg}`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(n => n.classList.remove('active'));
  const screen = document.getElementById('screen-' + name);
  if (screen) screen.classList.add('active');
  const tab = document.querySelector('.tab[data-screen="' + name + '"]');
  if (tab) tab.classList.add('active');
  APP.currentScreen = name;

  // Hide tab bar on home, show on all other screens
  const tabBar = document.getElementById('tab-bar');
  if (tabBar) tabBar.style.display = name === 'dashboard' ? 'none' : 'grid';

  if (name === 'dashboard')  refreshDashboard();
  if (name === 'attendance') initAttendance();
  if (name === 'students')   renderStudentList();
  if (name === 'reports')    renderReports();
  if (name === 'settings')   renderSettings();
  if (name === 'reminders')  renderRemindersScreen();
  if (name === 'classes')    renderClasses();
}

function initials(name = '') {
  return name.split(' ').filter(Boolean).slice(0,2).map(w => w[0].toUpperCase()).join('');
}
function formatDate(d = new Date()) { return d.toISOString().split('T')[0]; }
function niceDate(str) {
  if (!str) return '';
  return new Date(str + 'T00:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}
/* ── Save guard ──────────────────────────────────────────
   Wraps any async save function:
   - Sets APP.saving = true
   - Disables the button, shows "Saving…"
   - Re-enables when done
   ────────────────────────────────────────────────────── */
async function withSaving(btnId, fn) {
  if (APP.saving) return;
  APP.saving = true;
  const btn = document.getElementById(btnId);
  let origText = '';
  if (btn) {
    origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    btn.style.opacity = '0.7';
  }
  try {
    await fn();
  } finally {
    APP.saving = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
      btn.style.opacity = '';
    }
  }
}

function escHtml(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function getClassOptions(selectedValue = '') {
  const students = await dbGetAll(STORES.students);
  const classes  = await dbGetAll(STORES.classes);
  const fromStudents = students.map(s => s.program).filter(Boolean);
  const fromClasses  = classes.map(c => c.name).filter(Boolean);
  const all = [...new Set([...(APP.settings.classes || []), ...fromClasses, ...fromStudents])].sort();
  return '<option value="">— select class —</option>' +
    all.map(c => `<option value="${escHtml(c)}" ${c === selectedValue ? 'selected' : ''}>${escHtml(c)}</option>`).join('');
}

/* ─────────────────────────────────────────────────────────────
   DASHBOARD
───────────────────────────────────────────────────────────── */
async function refreshDashboard() {
  const today = new Date();

  // Update date display
  const dayEl  = document.getElementById('dash-day');
  const dateEl = document.getElementById('dash-date');
  if (dayEl)  dayEl.textContent  = today.toLocaleDateString('en-US', { weekday: 'long' });
  if (dateEl) dateEl.textContent = today.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });

  // Update reminder badge on home tile
  const reminders = await dbGetAll(STORES.reminders);
  const pendingCount = reminders.filter(r => !r.done).length;
  const badge = document.getElementById('ht-reminder-badge');
  if (badge) {
    badge.textContent   = pendingCount;
    badge.style.display = pendingCount > 0 ? 'flex' : 'none';
  }


}

function goToAttDate(date) {
  showScreen('attendance');
  document.getElementById('att-date').value = date;
  attState = {};
  renderAttendanceList();
}

/* ─────────────────────────────────────────────────────────────
   ATTENDANCE  (P / A only, with per-student note)
───────────────────────────────────────────────────────────── */
// attState: { [studentId]: { status: 'P'|'A'|'', note: '' } }
let attState = {};

async function initAttendance() {
  attState = {};
  const dateInput = document.getElementById('att-date');
  dateInput.value = dateInput.value || formatDate(); // always ensure a date is set
  await populateClassSelect();
  await renderAttendanceList();
}

async function populateClassSelect() {
  const sel      = document.getElementById('att-class');
  const current  = sel.value;
  const students = await dbGetAll(STORES.students);
  const fromData = [...new Set(students.map(s => s.program).filter(Boolean))];
  const all      = [...new Set([...APP.settings.classes, ...fromData])];
  sel.innerHTML  = '<option value="">All Classes</option>' + all.map(c =>
    `<option value="${escHtml(c)}" ${c === current ? 'selected' : ''}>${escHtml(c)}</option>`
  ).join('');
}

async function renderAttendanceList() {
  const list    = document.getElementById('att-list');
  const date    = document.getElementById('att-date').value;
  const classId = document.getElementById('att-class').value;

  let students = await dbGetAll(STORES.students);
  if (classId) students = students.filter(s => s.program === classId);
  students.sort((a,b) => a.name.localeCompare(b.name));

  if (!students.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">👥</div><div class="empty-title">No students found</div><div class="empty-sub">Sync your roster or adjust the class filter</div></div>';
    updateAttSummary();
    return;
  }

  // Load saved records for this date
  const allAtt  = await dbGetAll(STORES.attendance);
  const sIdSet  = new Set(students.map(s => s.id));
  const dayRecs = allAtt.filter(a => a.date === date && sIdSet.has(a.studentId));
  console.log('[Attendance] date:', date, 'allAtt:', allAtt.length, 'dayRecs:', dayRecs.length, 'students:', students.length);

  // Always seed attState from saved records — synced data takes priority
  dayRecs.forEach(r => {
    // Only overwrite if the local state is blank (not actively being edited)
    const existing = attState[r.studentId];
    if (!existing || !existing.status) {
      attState[r.studentId] = { status: r.status, note: r.note || '' };
    }
  });
  students.forEach(s => {
    if (!attState[s.id]) attState[s.id] = { status: '', note: '' };
  });

  const hasSaved = dayRecs.length > 0;
  const banner   = document.getElementById('att-edit-banner');
  banner.style.display = hasSaved ? 'flex' : 'none';
  document.getElementById('att-edit-date').textContent = hasSaved ? niceDate(date) : '';

  list.innerHTML = students.map(s => {
    const st = attState[s.id] || { status: '', note: '' };
    const rowBorder = st.status === 'P' ? 'border-left:3px solid var(--lime)' : st.status === 'A' ? 'border-left:3px solid var(--danger)' : '';
    return `
      <div id="srow-${s.id}" style="background:var(--card);border:1.5px solid var(--border);border-radius:14px;padding:10px 12px;margin-bottom:7px;display:flex;align-items:center;gap:8px;flex-wrap:nowrap;overflow:hidden;${rowBorder}">
        <div style="width:34px;height:34px;min-width:34px;border-radius:50%;background:var(--surface);border:1.5px solid var(--border);display:flex;align-items:center;justify-content:center;font-family:var(--f-head);font-weight:700;font-size:11px;color:var(--lime)">${initials(s.name)}</div>
        <div style="flex:1;min-width:0;overflow:hidden">
          <div style="font-family:var(--f-head);font-weight:700;font-size:12px;color:var(--t-pri);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(s.name)}</div>
          <div style="font-size:10px;color:var(--t-muted);font-weight:300;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(s.studentId||'')}${s.studentId && s.program ? ' · ' : ''}${escHtml(s.program||'')}</div>
        </div>
        <div style="display:flex;border:1.5px solid var(--border);border-radius:9px;overflow:hidden;background:var(--surface);flex-shrink:0;width:70px;min-width:70px">
          <button class="pa-btn ${st.status==='P'?'p-on':''}" data-status="P" data-sid="${s.id}" style="width:35px;height:28px;min-width:35px;font-family:var(--f-head);font-weight:700;font-size:11px;display:flex;align-items:center;justify-content:center;cursor:pointer;border:none;flex-shrink:0">P</button>
          <button class="pa-btn ${st.status==='A'?'a-on':''}" data-status="A" data-sid="${s.id}" style="width:35px;height:28px;min-width:35px;font-family:var(--f-head);font-weight:700;font-size:11px;display:flex;align-items:center;justify-content:center;cursor:pointer;border:none;flex-shrink:0">A</button>
        </div>
        <button class="note-btn ${st.note ? 'has-note' : ''}" data-sid="${s.id}" style="width:28px;height:28px;min-width:28px;background:var(--surface);border:1.5px solid var(--border);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:13px;cursor:pointer;color:var(--t-muted);opacity:${st.note?'1':'0.5'};flex-shrink:0">📝</button>
        <button class="student-profile-link" data-sid="${s.id}" style="width:26px;height:26px;min-width:26px;background:var(--surface);border:1.5px solid var(--border);border-radius:7px;display:flex;align-items:center;justify-content:center;color:var(--t-sec);font-size:14px;flex-shrink:0;cursor:pointer">›</button>
      </div>
      <div class="att-note-row ${st.note ? 'open' : ''}" id="note-row-${s.id}">
        <input type="text" class="ct-input att-note-input" id="note-${s.id}" placeholder="Note (e.g. arrived late, left early…)" value="${escHtml(st.note)}" data-sid="${s.id}" style="font-size:.8rem;padding:.6rem .8rem" />
      </div>`;
  }).join('');

  updateAttSummary();
}

function updateAttSummary() {
  const p = Object.values(attState).filter(v => v.status === 'P').length;
  const a = Object.values(attState).filter(v => v.status === 'A').length;
  const u = Object.values(attState).filter(v => !v.status).length;
  document.getElementById('att-summary').innerHTML =
    `<div class="att-summary-pill P">Present <strong>${p}</strong></div>` +
    `<div class="att-summary-pill A">Absent <strong>${a}</strong></div>` +
    (u ? `<div class="att-summary-pill" style="background:var(--surface);color:var(--t-muted);border:1px solid var(--border)">Unmarked <strong>${u}</strong></div>` : '');
}

function showSavedIndicator(sid) {
  const row = document.getElementById(`srow-${sid}`);
  if (!row) return;
  // Remove any existing indicator
  const existing = row.querySelector('.auto-saved-dot');
  if (existing) existing.remove();
  const dot = document.createElement('span');
  dot.className = 'auto-saved-dot';
  dot.title = 'Saved';
  row.appendChild(dot);
  setTimeout(() => dot.remove(), 2000);
}

function handleAttPill(e) {
  const btn    = e.target.closest('.pa-btn');
  const sid    = btn.dataset.sid;
  const status = btn.dataset.status;
  if (!attState[sid]) attState[sid] = { status: '', note: '' };
  attState[sid].status = status;

  // Update UI immediately
  const row = document.getElementById('srow-' + sid);
  if (row) {
    row.style.borderLeft = status === 'P' ? '3px solid var(--lime)' : '3px solid var(--danger)';
    row.querySelectorAll('.pa-btn').forEach(p => {
      p.classList.remove('p-on','a-on');
      if (p.dataset.status === status) {
        p.classList.add(status === 'P' ? 'p-on' : 'a-on');
      }
    });
  }
  updateAttSummary();

  // Auto-save this student's record right away
  const date    = document.getElementById('att-date').value;
  const classId = document.getElementById('att-class').value;
  if (date) {
    saveOneRecord(sid, date, classId, status, attState[sid].note || '')
      .then(() => {
        showSavedIndicator(sid);
        // Re-highlight the active pill to confirm save
        const row = document.getElementById(`srow-${sid}`);
        if (row) {
  
        }
      });
  }
}

function handleNoteToggle(e) {
  const btn = e.target.closest('.note-btn');
  if (!btn) return;
  const sid = btn.dataset.sid;
  // toggle inline note row
  const noteRow = document.getElementById('note-row-' + sid);
  if (noteRow) {
    noteRow.classList.toggle('open');
    if (noteRow.classList.contains('open')) {
      const inp = document.getElementById('note-' + sid);
      if (inp) inp.focus();
    }
  }
}

// Debounce timers per student for note auto-save
const NOTE_SAVE_TIMERS = {};

function handleNoteInput(e) {
  const input = e.target.closest('.att-note-input');
  const sid   = input.dataset.sid;
  if (!attState[sid]) attState[sid] = { status: '', note: '' };
  attState[sid].note = input.value;
  const btn = document.querySelector(`.note-btn[data-sid="${sid}"]`);
  if (btn) btn.classList.toggle('has-note', !!input.value);

  // Auto-save note after 800ms of no typing
  clearTimeout(NOTE_SAVE_TIMERS[sid]);
  NOTE_SAVE_TIMERS[sid] = setTimeout(() => {
    const date    = document.getElementById('att-date').value;
    const classId = document.getElementById('att-class').value;
    const status  = attState[sid] && attState[sid].status;
    if (date && status) {
      saveOneRecord(sid, date, classId, status, input.value)
        .then(() => showSavedIndicator(sid));
    }
  }, 800);
}

async function handleSaveAttendance() {
  // Manual save — saves all marked students at once (backup for bulk changes)
  const date    = document.getElementById('att-date').value;
  const classId = document.getElementById('att-class').value;
  if (!date) { toast('Please select a date', 'error'); return; }
  const records = Object.entries(attState)
    .filter(([, v]) => v.status)
    .map(([studentId, v]) => ({ studentId, status: v.status, note: v.note || '' }));
  if (!records.length) { toast('No attendance marked yet', 'error'); return; }
  for (const rec of records) {
    await saveOneRecord(rec.studentId, date, classId, rec.status, rec.note || '');
  }
  toast('All attendance saved ✓', 'success');
}

/* ─────────────────────────────────────────────────────────────
   STUDENTS LIST
───────────────────────────────────────────────────────────── */
async function renderStudentList(query = '') {
  const list = document.getElementById('student-list');
  let students = await dbGetAll(STORES.students);
  if (query) {
    const q = query.toLowerCase();
    students = students.filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.program||'').toLowerCase().includes(q) ||
      (s.email||'').toLowerCase().includes(q) ||
      (s.studentId||'').toLowerCase().includes(q)
    );
  }
  students.sort((a,b) => a.name.localeCompare(b.name));
  document.getElementById('student-count').textContent = students.length;

  if (!students.length) {
    list.innerHTML = query
      ? '<div class="empty-state"><div class="emoji">🔍</div><h3>No results</h3><p>Try a different search</p></div>'
      : '<div class="empty-state"><div class="emoji">👥</div><h3>No students yet</h3><p>Sync your roster from Google Sheets</p></div>';
    return;
  }

  const allAtt = await dbGetAll(STORES.attendance);
  list.innerHTML = students.map(s => {
    const sAtt = allAtt.filter(a => a.studentId === s.id);
    const barColor = s.program ? 'var(--lime)' : 'var(--warn)';
    const abbr = s.program ? s.program.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,3) : '?';
    return `<div class="entry-card" data-sid="${s.id}">
      <div class="entry-bar" style="background:${barColor}"></div>
      <div class="av">${initials(s.name)}</div>
      <div style="flex:1;min-width:0">
        <div class="entry-name">${escHtml(s.name)}</div>
        <div class="entry-sub">${escHtml(s.studentId||'')}${s.studentId && s.email ? ' · ' : ''}${escHtml(s.email||'')}</div>
      </div>
      <span class="badge lime-badge">${escHtml(abbr)}</span>
    </div>`;
  }).join('');
}

/* ─────────────────────────────────────────────────────────────
   PROFILE  (fully editable)
───────────────────────────────────────────────────────────── */
async function showProfile(studentId) {
  APP.profileStudentId = studentId;
  const student = await dbGet(STORES.students, studentId);
  if (!student) return;

  const allAtt = await dbGetAll(STORES.attendance);
  const sAtt   = allAtt.filter(a => a.studentId === studentId).sort((a,b) => b.date.localeCompare(a.date));
  const pct    = sAtt.length ? Math.round(sAtt.filter(a => a.status === 'P').length / sAtt.length * 100) : 0;

  document.getElementById('profile-avatar').textContent = initials(student.name);
  document.getElementById('profile-class').textContent  = student.program || 'No class assigned';
  document.getElementById('profile-pct').textContent    = pct + '%';
  document.getElementById('profile-total').textContent  = sAtt.length + ' sessions';

  // Populate editable fields
  // Student data may have camelCase or lowercase keys depending on how it was synced
  function getField(obj, key) {
    if (obj[key] !== undefined) return obj[key];
    return obj[key.toLowerCase()] || '';
  }
  ['name','gender','phone','email','program','workplace'].forEach(f => {
    const el = document.getElementById(`pedit-${f}`);
    if (el) el.value = getField(student, f);
  });
  document.getElementById('pedit-notes').value        = getField(student, 'notes');
  document.getElementById('pedit-observations').value = getField(student, 'observations');


  // Populate program select with classes from DB
  const programSel = document.getElementById('pedit-program');
  if (programSel) programSel.innerHTML = await getClassOptions(getField(student, 'program'));

  // Reminders for this student
  await renderProfileReminders(studentId);

  // Attendance history
  const histEl = document.getElementById('profile-history');
  if (!sAtt.length) {
    histEl.innerHTML = '<div class="text-muted" style="font-size:13px;padding:12px 0">No attendance records yet</div>';
  } else {
    histEl.innerHTML = sAtt.slice(0, 40).map(a => `
      <div class="att-hist-row">
        <div class="att-hist-date">${niceDate(a.date)}</div>
        <span class="badge ${a.status === 'P' ? 'lime-badge' : 'danger-badge'}">${a.status === 'P' ? 'Present' : 'Absent'}</span>
        ${a.note ? `<div class="att-hist-note">${escHtml(a.note)}</div>` : ''}
        ${!a._synced ? '<div class="pending-dot" title="Unsynced"></div>' : ''}
      </div>`).join('');
  }

  showScreen('profile');
  document.getElementById('screen-profile').scrollTop = 0;
}

async function handleSaveProfile() {
  const sid = APP.profileStudentId;
  if (!sid) return;
  const fields = {};
  ['name','gender','phone','email','program','workplace','notes','observations'].forEach(f => {
    const el = document.getElementById(`pedit-${f}`);
    if (el) fields[f] = el.value;
  });
  await saveStudentProfile(sid, fields);
  // Refresh header
  document.getElementById('profile-avatar').textContent = initials(fields.name);
  document.getElementById('profile-class').textContent  = fields.program || 'No class assigned';
}

/* ─────────────────────────────────────────────────────────────
   REPORTS – Class Register
───────────────────────────────────────────────────────────── */
async function renderReports() {
  // Set default date range: first day of current month → today
  const today     = formatDate();
  const firstOfMonth = today.slice(0, 8) + '01';
  const fromEl    = document.getElementById('report-date-from');
  const toEl      = document.getElementById('report-date-to');
  if (!fromEl.value) fromEl.value = firstOfMonth;
  if (!toEl.value)   toEl.value   = today;

  // Populate class filter
  await populateReportClassFilter();

  // Hide register, show empty state until user generates
  document.getElementById('report-register-wrap').style.display = 'none';
  document.getElementById('report-empty').style.display = 'block';
}

async function populateReportClassFilter() {
  const sel      = document.getElementById('report-class-filter');
  const current  = sel.value;
  const students = await dbGetAll(STORES.students);
  const classes  = [...new Set(students.map(s => s.program).filter(Boolean))].sort();
  const settings = APP.settings.classes || [];
  const all      = [...new Set([...settings, ...classes])];
  sel.innerHTML  = '<option value="">All Classes</option>' +
    all.map(c => `<option value="${escHtml(c)}" ${c === current ? 'selected' : ''}>${escHtml(c)}</option>`).join('');
}

async function generateRegister() {
  const fromDate  = document.getElementById('report-date-from').value;
  const toDate    = document.getElementById('report-date-to').value;
  const classFilter = document.getElementById('report-class-filter').value;

  if (!fromDate || !toDate) { toast('Please select both dates', 'error'); return; }
  if (fromDate > toDate)    { toast('From date must be before To date', 'error'); return; }

  let students = await dbGetAll(STORES.students);
  if (classFilter) students = students.filter(s => s.program === classFilter);
  students.sort((a,b) => a.name.localeCompare(b.name));

  if (!students.length) {
    toast('No students found for this filter', 'error');
    return;
  }

  // Build list of dates in range that have attendance data
  const allAtt   = await dbGetAll(STORES.attendance);
  const rangeDates = getDatesInRange(fromDate, toDate);

  // Only include dates that actually have records (don't show empty columns)
  const activeDates = rangeDates.filter(d =>
    allAtt.some(a => a.date === d &&
      (!classFilter || students.find(s => s.id === a.studentId)))
  );

  if (!activeDates.length) {
    toast('No attendance records found for this date range', 'error');
    return;
  }

  // Build lookup: studentId+date -> status
  const attMap = {};
  allAtt.forEach(a => { attMap[a.studentId + '|' + a.date] = a.status; });

  // Render table
  renderRegisterTable(students, activeDates, attMap);

  document.getElementById('report-register-wrap').style.display = 'block';
  document.getElementById('report-empty').style.display = 'none';
}

function getDatesInRange(from, to) {
  const dates = [];
  const cur   = new Date(from + 'T00:00:00');
  const end   = new Date(to   + 'T00:00:00');
  while (cur <= end) {
    dates.push(formatDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function renderRegisterTable(students, dates, attMap) {
  const table = document.getElementById('report-register-table');

  // Build header row
  let thead = '<thead><tr>';
  thead += '<th class="reg-th reg-th-name">Employee Name</th>';
  dates.forEach(d => {
    const dt  = new Date(d + 'T00:00:00');
    const day = dt.getDate();
    const dow = dt.toLocaleDateString('en-US', { weekday: 'short' });
    thead += `<th class="reg-th reg-th-date"><div class="reg-day-num">${day}</div><div class="reg-day-name">${dow}</div></th>`;
  });
  thead += '</tr></thead>';

  // Build body rows
  let tbody = '<tbody>';
  students.forEach((s, idx) => {
    const rowClass = idx % 2 === 0 ? 'reg-row-even' : 'reg-row-odd';
    tbody += `<tr class="${rowClass}">`;
    tbody += `<td class="reg-td reg-td-name">${escHtml(s.name)}</td>`;
    dates.forEach(d => {
      const status = attMap[s.id + '|' + d] || '';
      const cls    = status === 'P' ? 'reg-p' : status === 'A' ? 'reg-a' : 'reg-empty';
      tbody += `<td class="reg-td reg-td-cell ${cls}">${status}</td>`;
    });
    tbody += '</tr>';
  });
  tbody += '</tbody>';

  table.innerHTML = thead + tbody;
}

async function exportRegisterXLSX() {
  const fromDate    = document.getElementById('report-date-from').value;
  const toDate      = document.getElementById('report-date-to').value;
  const classFilter = document.getElementById('report-class-filter').value;

  if (!fromDate || !toDate) { toast('Please generate the report first', 'error'); return; }

  let students = await dbGetAll(STORES.students);
  if (classFilter) students = students.filter(s => s.program === classFilter);
  students.sort((a,b) => a.name.localeCompare(b.name));

  const allAtt     = await dbGetAll(STORES.attendance);
  const rangeDates = getDatesInRange(fromDate, toDate);
  const activeDates = rangeDates.filter(d =>
    allAtt.some(a => a.date === d && (!classFilter || students.find(s => s.id === a.studentId)))
  );

  const attMap = {};
  allAtt.forEach(a => { attMap[a.studentId + '|' + a.date] = a.status; });

  // Build CSV-style data and convert to Excel using SheetJS (loaded via CDN)
  // We'll use a simple downloadable CSV that opens cleanly in Excel
  const title    = classFilter || 'All Classes';
  const rows     = [];

  // Header row 1: title
  rows.push([`Class Register – ${title}`, ...new Array(activeDates.length).fill('')]);

  // Header row 2: date range
  rows.push([`${niceDate(fromDate)} – ${niceDate(toDate)}`, ...new Array(activeDates.length).fill('')]);

  // Header row 3: blank
  rows.push([]);

  // Header row 4: column headers
  rows.push(['Employee Name', ...activeDates.map(d => {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('en-US', { month:'short', day:'numeric' });
  })]);

  // Data rows
  students.forEach(s => {
    const row = [s.name];
    activeDates.forEach(d => {
      row.push(attMap[s.id + '|' + d] || '');
    });
    rows.push(row);
  });

  // Convert to CSV (Excel compatible)
  const csv  = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
  const bom  = '﻿'; // UTF-8 BOM so Excel opens correctly
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `register_${classFilter || 'all'}_${fromDate}_to_${toDate}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Register exported ✓', 'success');
}

/* ─────────────────────────────────────────────────────────────
   ADD STUDENT
───────────────────────────────────────────────────────────── */
function openAddStudentModal() {
  // Clear fields
  ['name','gender','phone','email','program','workplace'].forEach(f => {
    const el = document.getElementById(`add-${f}`);
    if (el) el.value = '';
  });
  // Populate program datalist from existing students + settings
  populateProgramSuggestions();
  document.getElementById('add-student-modal').classList.add('open');
  setTimeout(() => document.getElementById('add-name').focus(), 300);
}

function closeAddStudentModal() {
  document.getElementById('add-student-modal').classList.remove('open');
}

async function populateProgramSuggestions() {
  const sel = document.getElementById('add-program');
  if (sel) sel.innerHTML = await getClassOptions();
}

async function handleAddStudent() {
  const name = document.getElementById('add-name').value.trim();
  if (!name) { toast('Name is required', 'error'); return; }

  // Generate a unique id
  const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  // Auto-generate studentId from existing students
  const allStudentsForId = await dbGetAll(STORES.students);
  const maxNum = allStudentsForId.reduce((max, s) => {
    const match = String(s.studentId || '').match(/\d+/);
    return match ? Math.max(max, parseInt(match[0])) : max;
  }, 0);
  const autoStudentId = 'STU' + String(maxNum + 1).padStart(3, '0');

  const student = {
    id,
    studentId: autoStudentId,
    name,
    gender:      document.getElementById('add-gender').value,
    phone:       document.getElementById('add-phone').value.trim(),
    email:       document.getElementById('add-email').value.trim(),
    program:     document.getElementById('add-program').value.trim(),
    workplace:   document.getElementById('add-workplace').value.trim(),
    notes: '', observations: '', followup: ''
  };

  await dbPut(STORES.students, student);

  // Sync to Google Sheets if online
  if (APP.online && APP.settings.gasUrl) {
    try {
      await gasRequest('addStudent', student);
      toast(`${name} added ✓`, 'success');
    } catch {
      await upsertPendingItem('addStudent', student.id, student);
      toast(`${name} saved offline — will sync later`, 'success');
    }
  } else {
    await upsertPendingItem('addStudent', student.id, student);
    toast(`${name} saved offline ✓`, 'success');
  }

  closeAddStudentModal();
  renderStudentList();
  refreshDashboard();
}

/* ─────────────────────────────────────────────────────────────
   CLASSES
───────────────────────────────────────────────────────────── */
async function renderClasses() {
  const list     = document.getElementById('classes-list');
  const allAtt   = await dbGetAll(STORES.attendance);
  const students = await dbGetAll(STORES.students);
  const classes  = await dbGetAll(STORES.classes);

  // Merge: classes from Classes store + programs found on students
  // Auto-add student programs not yet in classes store (default active=true)
  const programsFromStudents = [...new Set(students.map(s => s.program).filter(Boolean))];
  const classIds = new Set(classes.map(c => c.id));
  for (const prog of programsFromStudents) {
    if (![...classIds].some(id => id === slugify(prog))) {
      const auto = { id: slugify(prog), name: prog, description: '', createdAt: new Date().toISOString() };
      await dbPut(STORES.classes, auto);
      classes.push(auto);
      classIds.add(auto.id);
    }
  }

  const allClasses = await dbGetAll(STORES.classes);
  allClasses.sort((a,b) => a.name.localeCompare(b.name));
  document.getElementById('classes-count').textContent = allClasses.length;

  if (!allClasses.length) {
    list.innerHTML = '<div class="empty-state"><div class="emoji">🎓</div><h3>No classes yet</h3><p>Tap "+ Add Class" to create one</p></div>';
    return;
  }

  list.innerHTML = allClasses.map(cls => {
    const enrolled = students.filter(s => s.program === cls.name).length;
    const clsAtt   = allAtt.filter(a => {
      const st = students.find(s => s.id === a.studentId);
      return st && st.program === cls.name;
    });
    const sessions = [...new Set(clsAtt.map(a => a.date))].length;
    return `<div class="class-card">
      <div class="entry-bar" style="background:var(--lime)"></div>
      <div class="class-icon">🎓</div>
      <div style="flex:1;min-width:0">
        <div class="class-name">${escHtml(cls.name)}</div>
        <div class="class-meta">${enrolled} student${enrolled !== 1 ? 's' : ''} · ${sessions} session${sessions !== 1 ? 's' : ''}${cls.description ? ' · ' + escHtml(cls.description) : ''}</div>
      </div>
      <div class="class-actions">
        <button class="class-act-btn" data-edit-class="${escHtml(cls.id)}" title="Edit">✏️</button>
        <button class="class-act-btn del" data-delete-class="${escHtml(cls.id)}" title="Delete">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function openAddClassModal(editId = '') {
  document.getElementById('class-name-input').value = '';
  document.getElementById('class-desc-input').value = '';
  document.getElementById('class-edit-id').value    = editId;
  document.getElementById('class-modal-title').textContent = editId ? 'Edit Class' : 'Add Class';

  if (editId) {
    dbGet(STORES.classes, editId).then(cls => {
      if (cls) {
        document.getElementById('class-name-input').value = cls.name;
        document.getElementById('class-desc-input').value = cls.description || '';
      }
    });
  }

  document.getElementById('add-class-modal').classList.add('open');
  setTimeout(() => document.getElementById('class-name-input').focus(), 300);
}

function closeClassModal() {
  document.getElementById('add-class-modal').classList.remove('open');
}

async function handleSaveClass() {
  const name = document.getElementById('class-name-input').value.trim();
  if (!name) { toast('Class name is required', 'error'); return; }
  const description = document.getElementById('class-desc-input').value.trim();
  const editId      = document.getElementById('class-edit-id').value;

  const id  = editId || slugify(name) + '-' + Date.now().toString(36);
  const cls = { id, name, description, updatedAt: new Date().toISOString() };
  if (!editId) cls.createdAt = new Date().toISOString();

  await dbPut(STORES.classes, cls);

  // Sync to Google Sheets
  if (APP.online && APP.settings.gasUrl) {
    try {
      await gasRequest('saveClass', cls);
      toast(editId ? 'Class updated ✓' : 'Class added ✓', 'success');
    } catch {
      await upsertPendingItem('saveClass', cls.id, cls);
      toast('Saved offline — will sync later', 'success');
    }
  } else {
    await upsertPendingItem('saveClass', cls.id, cls);
    toast('Saved offline ✓', 'success');
  }

  closeClassModal();
  renderClasses();
  await populateClassSelect(); // refresh attendance dropdown
}

async function handleDeleteClass(id) {
  const cls = await dbGet(STORES.classes, id);
  if (!cls) return;
  if (!confirm(`Delete class "${cls.name}"? Students assigned to it won't be deleted.`)) return;

  await dbDelete(STORES.classes, id);

  if (APP.online && APP.settings.gasUrl) {
    try {
      await gasRequest('deleteClass', { id });
    } catch {
      await upsertPendingItem('deleteClass', id, { id });
    }
  } else {
    await upsertPendingItem('deleteClass', id, { id });
  }

  toast(`"${cls.name}" deleted`, 'success');
  renderClasses();
  await populateClassSelect();
}


/* Sync a single reminder to Google Sheets */
async function syncReminderToSheet(reminder) {
  // Ensure done is always a string for Sheets
  const payload = { ...reminder, done: String(reminder.done || false), completedAt: reminder.completedAt || '' };

  if (APP.online && APP.settings.gasUrl) {
    try {
      await gasRequest('saveReminder', payload);
    } catch (err) {
      console.warn('Reminder sync failed, queuing:', err.message);
      await upsertPendingItem('saveReminder', reminder.id, payload);
    }
  } else {
    await upsertPendingItem('saveReminder', reminder.id, payload);
  }
}

/* Pull all reminders from Sheets into IndexedDB on sync */
async function syncRemindersFromSheet() {
  if (!APP.online || !APP.settings.gasUrl) return;
  try {
    const data = await gasRequest('getReminders');
    if (data.reminders && Array.isArray(data.reminders)) {
      for (const r of data.reminders) {
        r.done = r.done === 'true' || r.done === true;
        // Normalize dueDate — may come back as a Date object or full timestamp string
        if (r.duedate !== undefined && r.dueDate === undefined) r.dueDate = r.duedate;
        if (r.dueDate) {
          const d = new Date(r.dueDate);
          if (!isNaN(d.getTime())) {
            r.dueDate = d.getFullYear() + '-' +
              String(d.getMonth() + 1).padStart(2, '0') + '-' +
              String(d.getDate()).padStart(2, '0');
          }
        }
        await dbPut(STORES.reminders, r);
      }
    }
  } catch (err) {
    console.warn('Reminders pull failed:', err.message);
  }
}

async function syncClasses() {
  if (!APP.online || !APP.settings.gasUrl) return;
  try {
    const data = await gasRequest('getClasses');
    if (data.classes && Array.isArray(data.classes)) {
      for (const cls of data.classes) await dbPut(STORES.classes, cls);
    }
  } catch {}
}

async function syncReminders() {
  if (!APP.online || !APP.settings.gasUrl) return;
  try {
    const data = await gasRequest('getReminders');
    if (data.reminders && Array.isArray(data.reminders)) {
      for (const r of data.reminders) {
        // Normalize boolean done field from sheet string
        r.done = r.done === 'true' || r.done === true;
        await dbPut(STORES.reminders, r);
      }
    }
  } catch (e) {
    console.warn('Reminder sync failed:', e.message);
  }
}

/* ─────────────────────────────────────────────────────────────
   REMINDERS
───────────────────────────────────────────────────────────── */
let currentReminderFilter = 'pending';

function reminderStatus(r) {
  if (r.done) return 'done';
  if (!r.dueDate || r.dueDate.trim() === '') return 'upcoming';
  const d = new Date(r.dueDate + 'T00:00:00');
  if (isNaN(d.getTime())) return 'upcoming';
  const today = formatDate();
  if (r.dueDate < today) return 'overdue';
  if (r.dueDate === today) return 'due-today';
  return 'upcoming';
}

function niceReminderDate(dateStr) {
  if (!dateStr || dateStr.trim() === '') return 'No due date';
  // Validate it's a real date
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return 'No due date';
  const today    = formatDate();
  const tomorrow = formatDate(new Date(Date.now() + 86400000));
  if (dateStr === today)    return 'Due today';
  if (dateStr === tomorrow) return 'Due tomorrow';
  if (dateStr < today)      return 'Overdue · ' + niceDate(dateStr);
  return 'Due ' + niceDate(dateStr);
}

function reminderCardHTML(r, studentName, showStudent = true) {
  const status = reminderStatus(r);
  const dueCls = r.done ? 'done-due' : status === 'overdue' ? 'overdue' : status === 'due-today' ? 'due-today' : 'upcoming';
  return `<div class="reminder-card ${status}" data-rid="${r.id}">
    <div class="reminder-top">
      <div class="reminder-body">
        <div class="reminder-text ${r.done ? 'done-text' : ''}">${escHtml(r.text)}</div>
        ${showStudent ? `<div class="reminder-student" data-sid="${r.studentId}">👤 ${escHtml(studentName)}</div>` : ''}
        <div class="reminder-due ${dueCls}">${niceReminderDate(r.dueDate)}</div>
      </div>
      <div class="reminder-actions">
        ${!r.done ? `<button class="rem-btn done-btn" data-done="${r.id}" title="Mark done">✓</button>` : `<button class="rem-btn done-btn" data-undone="${r.id}" title="Reopen">↩</button>`}
        ${!r.done ? `<button class="rem-btn" data-reschedule="${r.id}" title="Reschedule">📅</button>` : ''}
      </div>
    </div>
  </div>`;
}

async function renderRemindersScreen() {
  const list      = document.getElementById('reminders-list');
  const reminders = await dbGetAll(STORES.reminders);
  const students  = await dbGetAll(STORES.students);
  const studentMap = Object.fromEntries(students.map(s => [s.id, s.name]));

  let filtered = reminders;
  if (currentReminderFilter === 'pending') filtered = reminders.filter(r => !r.done);
  if (currentReminderFilter === 'done')    filtered = reminders.filter(r =>  r.done);

  // Sort: overdue first, then due-today, then upcoming, then done
  const order = { overdue:0, 'due-today':1, upcoming:2, done:3 };
  filtered.sort((a,b) => {
    const sa = reminderStatus(a), sb = reminderStatus(b);
    if (order[sa] !== order[sb]) return order[sa] - order[sb];
    return (a.dueDate||'').localeCompare(b.dueDate||'');
  });

  document.getElementById('reminders-count').textContent = reminders.filter(r => !r.done).length;

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-title">${currentReminderFilter === 'done' ? 'No completed reminders' : 'No pending reminders'}</div><div class="empty-sub">Add reminders from a student's profile</div></div>`;
    return;
  }

  list.innerHTML = filtered.map(r => reminderCardHTML(r, studentMap[r.studentId] || 'Unknown', true)).join('');
}

async function renderProfileReminders(studentId) {
  const el        = document.getElementById('profile-reminders-list');
  if (!el) return;
  const reminders = (await dbGetAll(STORES.reminders)).filter(r => r.studentId === studentId);
  reminders.sort((a,b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return (a.dueDate||'').localeCompare(b.dueDate||'');
  });

  if (!reminders.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--t-muted);padding:8px 0">No reminders yet — tap + Add to create one</div>';
    return;
  }
  el.innerHTML = reminders.map(r => reminderCardHTML(r, '', false)).join('');
}

async function renderDashboardReminders() {
  // Dashboard no longer shows reminder list — just update the tile badge
  await refreshDashboard();
}

function openAddReminderModal(studentId, studentName, editId = '', rescheduleId = '') {
  const isReschedule = !!rescheduleId;
  const activeId     = editId || rescheduleId;

  document.getElementById('reminder-student-id').value        = studentId;
  document.getElementById('reminder-student-name').textContent = studentName;
  document.getElementById('reminder-edit-id').value           = activeId;
  document.getElementById('reminder-modal-mode').value        = isReschedule ? 'reschedule' : 'add';
  document.getElementById('reminder-text-input').value        = '';
  document.getElementById('reminder-date-input').value        = formatDate(); // default to today
  document.getElementById('reminder-modal-title').childNodes[0].textContent = isReschedule ? 'Reschedule — ' : 'Add Follow-up — ';

  // Hide text field when rescheduling (only change the date)
  const textGroup = document.getElementById('reminder-text-group');
  textGroup.style.display = isReschedule ? 'none' : 'block';

  if (activeId) {
    dbGet(STORES.reminders, activeId).then(r => {
      if (r) {
        if (!isReschedule) document.getElementById('reminder-text-input').value = r.text || '';
        document.getElementById('reminder-date-input').value = r.dueDate || formatDate();
        document.getElementById('reminder-student-name').textContent = document.getElementById('reminder-student-name').textContent || '';
      }
    });
  }

  document.getElementById('add-reminder-modal').classList.add('open');
  setTimeout(() => document.getElementById('reminder-date-input').focus(), 300);
}

function closeReminderModal() {
  document.getElementById('add-reminder-modal').classList.remove('open');
}

async function handleSaveReminder() {
  const dueDate   = document.getElementById('reminder-date-input').value;
  const studentId = document.getElementById('reminder-student-id').value;
  const editId    = document.getElementById('reminder-edit-id').value;
  const modeEl    = document.getElementById('reminder-modal-mode');
  const mode      = modeEl ? modeEl.value : 'add';

  if (!dueDate) { toast('Please select a due date', 'error'); return; }

  let reminder;

  if (mode === 'reschedule') {
    reminder = await dbGet(STORES.reminders, editId);
    if (!reminder) { toast('Reminder not found', 'error'); return; }
    reminder.dueDate     = dueDate;
    reminder.done        = false;
    reminder.completedAt = '';
  } else {
    const text = document.getElementById('reminder-text-input').value.trim();
    if (!text) { toast('Please enter a reminder', 'error'); return; }
    const id = editId || 'rem-' + Date.now().toString(36);
    reminder = { id, studentId, text, dueDate, done: false, createdAt: new Date().toISOString(), completedAt: '' };
    if (editId) {
      const existing = await dbGet(STORES.reminders, editId);
      if (existing) { reminder.done = existing.done; reminder.completedAt = existing.completedAt || ''; reminder.createdAt = existing.createdAt; }
    }
  }

  await dbPut(STORES.reminders, reminder);
  const payload = { ...reminder, done: String(reminder.done), completedAt: reminder.completedAt || '' };

  if (APP.online && APP.settings.gasUrl) {
    try { await gasRequest('saveReminder', payload); }
    catch { await upsertPendingItem('saveReminder', reminder.id, payload); }
  } else {
    await upsertPendingItem('saveReminder', reminder.id, payload);
  }

  toast(mode === 'reschedule' ? 'Rescheduled ✓' : 'Reminder saved ✓', 'success');
  closeReminderModal();
  await renderProfileReminders(reminder.studentId);
  if (APP.currentScreen === 'reminders') await renderRemindersScreen();
}

async function handleReminderDone(id, done) {
  const r = await dbGet(STORES.reminders, id);
  if (!r) return;
  r.done = done;
  r.completedAt = done ? new Date().toISOString() : '';
  await dbPut(STORES.reminders, r);

  if (APP.online && APP.settings.gasUrl) {
    try {
      await gasRequest('saveReminder', { ...r, done: String(r.done) });
    } catch {
      await upsertPendingItem('saveReminder', r.id, { ...r, done: String(r.done) });
    }
  } else {
    await upsertPendingItem('saveReminder', r.id, { ...r, done: String(r.done) });
  }

  toast(done ? 'Marked done ✓' : 'Reopened', 'success');
  if (APP.currentScreen === 'reminders') await renderRemindersScreen();
  if (APP.currentScreen === 'profile')   await renderProfileReminders(r.studentId);
  await renderDashboardReminders();
}

async function handleDeleteReminder(id) {
  const r = await dbGet(STORES.reminders, id);
  if (!r) return;
  if (!confirm('Delete this reminder?')) return;
  await dbDelete(STORES.reminders, id);

  if (APP.online && APP.settings.gasUrl) {
    try {
      await gasRequest('deleteReminder', { id });
    } catch {
      await upsertPendingItem('deleteReminder', id, { id });
    }
  } else {
    await upsertPendingItem('deleteReminder', id, { id });
  }

  toast('Reminder deleted', 'success');
  if (APP.currentScreen === 'reminders') await renderRemindersScreen();
  if (APP.currentScreen === 'profile')   await renderProfileReminders(r.studentId);
  await renderDashboardReminders();
}

async function handleReminderListClick(e) {
  const doneBtn       = e.target.closest('[data-done]');
  const undoneBtn     = e.target.closest('[data-undone]');
  const rescheduleBtn = e.target.closest('[data-reschedule]');
  const studentLnk    = e.target.closest('[data-sid]');
  if (doneBtn) { handleReminderDone(doneBtn.dataset.done, true); return; }
  if (undoneBtn) { handleReminderDone(undoneBtn.dataset.undone, false); return; }
  if (rescheduleBtn) {
    const rid = rescheduleBtn.dataset.reschedule;
    const r   = await dbGet(STORES.reminders, rid);
    if (!r) return;
    const student = await dbGet(STORES.students, r.studentId);
    openAddReminderModal(r.studentId, student ? student.name : '', '', rid);
    return;
  }
  if (studentLnk && studentLnk.classList.contains('reminder-student')) {
    showProfile(studentLnk.dataset.sid);
  }
}

/* ─────────────────────────────────────────────────────────────
   EXPORT CSV
───────────────────────────────────────────────────────────── */
async function exportCSV() {
  const allAtt   = await dbGetAll(STORES.attendance);
  const students = await dbGetAll(STORES.students);
  const map      = Object.fromEntries(students.map(s => [s.id, s]));
  const rows     = [['Date','Student ID','Name','Program','Status','Note','Synced']];
  allAtt.sort((a,b) => b.date.localeCompare(a.date)).forEach(a => {
    const s = map[a.studentId] || {};
    rows.push([a.date, s.studentId||a.studentId, s.name||'', s.program||'', a.status==='P'?'Present':'Absent', a.note||'', a._synced?'Yes':'No']);
  });
  const csv  = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `attendance_${formatDate()}.csv`;
  a.click(); URL.revokeObjectURL(url);
  toast('CSV exported ✓', 'success');
}

/* ─────────────────────────────────────────────────────────────
   SETTINGS
───────────────────────────────────────────────────────────── */
function renderSettings() {
  document.getElementById('set-gas-url').value    = APP.settings.gasUrl || '';
  document.getElementById('set-autosync').checked = APP.settings.autoSync !== false;
}

async function saveSettings() {
  await saveSetting('gasUrl',   document.getElementById('set-gas-url').value.trim());
  await saveSetting('autoSync', document.getElementById('set-autosync').checked);
  toast('Settings saved ✓', 'success');
}

/* ─────────────────────────────────────────────────────────────
   SAMPLE DATA
───────────────────────────────────────────────────────────── */
async function loadSampleData() {
  // Sample data removed — add students via Google Sheets or the + Add button
}

/* ─────────────────────────────────────────────────────────────
   CONNECTIVITY
───────────────────────────────────────────────────────────── */
function handleOnline()  {
  APP.online = true;
  setSyncState('online', 'Online');
  toast('Back online — syncing…', 'success');
  if (APP.settings.autoSync !== false) syncPendingAttendance();
}
function handleOffline() {
  APP.online = false;
  setSyncState('offline', 'Offline');
  toast('Offline — changes saved locally', '');
}

/* ─────────────────────────────────────────────────────────────
   PWA / SW
───────────────────────────────────────────────────────────── */
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  APP.installPrompt = e;
  document.getElementById('btn-install').style.display = 'flex';
});
window.addEventListener('appinstalled', () => {
  APP.installPrompt = null;
  document.getElementById('btn-install').style.display = 'none';
  toast('App installed ✓', 'success');
});

async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./service-worker.js');
      navigator.serviceWorker.addEventListener('message', e => {
        if (e.data && e.data.type === 'TRIGGER_SYNC') syncPendingAttendance();
      });
    } catch {}
  }
}

/* ─────────────────────────────────────────────────────────────
   EVENT BINDING
───────────────────────────────────────────────────────────── */
function bindEvents() {
  document.querySelectorAll('.tab[data-screen]').forEach(el =>
    el.addEventListener('click', () => showScreen(el.dataset.screen))
  );

  document.getElementById('btn-hdr-sync').addEventListener('click', () => {
    if (!APP.settings.gasUrl) { toast('Configure GAS URL in Settings', 'error'); return; }
    syncRoster(); syncPendingAttendance();
  });
  document.getElementById('btn-install').addEventListener('click', async () => {
    if (!APP.installPrompt) return;
    APP.installPrompt.prompt();
    const { outcome } = await APP.installPrompt.userChoice;
    if (outcome === 'accepted') APP.installPrompt = null;
  });

  // Attendance events
  document.getElementById('att-list').addEventListener('click', e => {
    if (e.target.closest('.pa-btn'))             { handleAttPill(e);    return; }
    if (e.target.closest('.note-btn'))          { handleNoteToggle(e); return; }
    if (e.target.closest('.student-profile-link')) { showProfile(e.target.closest('.student-profile-link').dataset.sid); }
  });
  document.getElementById('att-list').addEventListener('input', e => {
    if (e.target.closest('.att-note-input')) handleNoteInput(e);
  });
  document.getElementById('att-date').addEventListener('change', () => { attState = {}; renderAttendanceList(); });
  document.getElementById('att-class').addEventListener('change', () => { attState = {}; renderAttendanceList(); });
  document.getElementById('btn-mark-all-present').addEventListener('click', () => withSaving('btn-mark-all-present', async () => {
    let students = await dbGetAll(STORES.students);
    const classId = document.getElementById('att-class').value;
    if (classId) students = students.filter(s => s.program === classId);
    students.forEach(s => {
      if (!attState[s.id]) attState[s.id] = { status: 'P', note: '' };
      else attState[s.id].status = 'P';
    });
    renderAttendanceList();
  }));
  document.getElementById('btn-save-att').addEventListener('click', () => withSaving('btn-save-att', handleSaveAttendance));

  // Students
  document.getElementById('student-search').addEventListener('input', e => renderStudentList(e.target.value));
  document.getElementById('student-list').addEventListener('click', e => {
    const card = e.target.closest('.entry-card');
    if (card) showProfile(card.dataset.sid);
  });
  document.getElementById('btn-add-student').addEventListener('click', openAddStudentModal);
  document.getElementById('btn-close-add-modal').addEventListener('click', closeAddStudentModal);
  document.getElementById('btn-confirm-add-student').addEventListener('click', () => withSaving('btn-confirm-add-student', handleAddStudent));
  document.getElementById('add-student-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('add-student-modal')) closeAddStudentModal();
  });

  // Profile
  document.getElementById('profile-back').addEventListener('click', () => showScreen('students'));
  document.getElementById('btn-save-profile').addEventListener('click', () => withSaving('btn-save-profile', handleSaveProfile));

  // Reports
  document.getElementById('btn-generate-report').addEventListener('click', generateRegister);
  document.getElementById('btn-export-xlsx').addEventListener('click', exportRegisterXLSX);

  // Settings
  document.getElementById('btn-save-settings').addEventListener('click', () => withSaving('btn-save-settings', saveSettings));

  // Classes
  document.getElementById('btn-add-class').addEventListener('click', () => openAddClassModal());
  document.getElementById('btn-close-class-modal').addEventListener('click', closeClassModal);
  document.getElementById('btn-confirm-class').addEventListener('click', () => withSaving('btn-confirm-class', handleSaveClass));
  document.getElementById('add-class-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('add-class-modal')) closeClassModal();
  });
  document.getElementById('classes-list').addEventListener('click', e => {
    const editBtn   = e.target.closest('[data-edit-class]');
    const deleteBtn = e.target.closest('[data-delete-class]');
    if (editBtn)   openAddClassModal(editBtn.dataset.editClass);
    if (deleteBtn) handleDeleteClass(deleteBtn.dataset.deleteClass);
  });



  // Home screen tiles — use event delegation so it always works
  document.querySelector('main').addEventListener('click', e => {
    const tile = e.target.closest('.home-tile[data-screen]');
    if (tile) showScreen(tile.dataset.screen);
  });

  // Reminders screen
  document.getElementById('reminders-list').addEventListener('click', handleReminderListClick);
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentReminderFilter = btn.dataset.filter;
      renderRemindersScreen();
    });
  });

  // Add reminder from profile
  document.getElementById('btn-add-reminder').addEventListener('click', async () => {
    const sid  = APP.profileStudentId;
    const s    = await dbGet(STORES.students, sid);
    openAddReminderModal(sid, s ? s.name : 'Student');
  });
  document.getElementById('btn-close-reminder-modal').addEventListener('click', closeReminderModal);
  document.getElementById('btn-confirm-reminder').addEventListener('click', () => withSaving('btn-confirm-reminder', handleSaveReminder));
  document.getElementById('add-reminder-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('add-reminder-modal')) closeReminderModal();
  });

  // Reminders on profile and dashboard
  document.getElementById('profile-reminders-list').addEventListener('click', handleReminderListClick);
  document.getElementById('dash-reminders-list').addEventListener('click', handleReminderListClick);

  window.addEventListener('online',  handleOnline);
  window.addEventListener('offline', handleOffline);
}

/* ─────────────────────────────────────────────────────────────
   BOOT
───────────────────────────────────────────────────────────── */
async function init() {
  APP.db = await openDB();
  await loadSettings();
  await registerSW();
  bindEvents();
  setSyncState(navigator.onLine ? 'online' : 'offline', navigator.onLine ? 'Online' : 'Offline');
  await loadSampleData();
  showScreen('dashboard');
  if (APP.online && APP.settings.autoSync !== false) {
    setTimeout(async () => { await syncClasses(); await syncReminders(); syncPendingAttendance(); }, 2000);
  }
}

document.addEventListener('DOMContentLoaded', init);
