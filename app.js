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
const DB_VERSION = 4;
const STORES     = { students: 'students', attendance: 'attendance', pending: 'pending', settings: 'settings', classes: 'classes' };

const APP = {
  db: null,
  online: navigator.onLine,
  syncing: false,
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
async function syncRoster() {
  if (!APP.online || !APP.settings.gasUrl) return;
  setSyncState('syncing', 'Syncing…');
  try {
    const data = await gasRequest('getStudents');
    if (data.students && Array.isArray(data.students)) {
      await dbClear(STORES.students);
      for (const s of data.students) await dbPut(STORES.students, s);
      toast('Roster synced ✓', 'success');
    }
    setSyncState('online', 'Online');
  } catch (err) {
    setSyncState('online', 'Online');
    toast('Roster sync failed: ' + err.message, 'error');
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
      } else {
        await gasRequest('saveAttendance', item.payload);
      }
      await dbDelete(STORES.pending, item._pendingId);
      synced++;
    } catch {}
  }
  if (synced) toast(`Synced ${synced} records ✓`, 'success');
  setSyncState('online', 'Online');
  refreshDashboard();
}

/* records: [{ studentId, status('P'|'A'), note }] */
async function saveAttendance(dateStr, classId, records) {
  const payload = { date: dateStr, classId, instructor: APP.settings.instructorName, records };

  for (const rec of records) {
    const existing = (await dbGetAll(STORES.attendance, 'studentDate', IDBKeyRange.only([rec.studentId, dateStr])))[0];
    if (existing) {
      existing.status  = rec.status;
      existing.note    = rec.note || '';
      existing.classId = classId;
      existing._synced = false;
      await dbPut(STORES.attendance, existing);
    } else {
      await dbPut(STORES.attendance, {
        studentId: rec.studentId, date: dateStr, classId,
        status: rec.status, note: rec.note || '', _synced: false
      });
    }
  }

  if (APP.online && APP.settings.gasUrl) {
    try {
      await gasRequest('saveAttendance', payload);
      const rows = await dbGetAll(STORES.attendance);
      for (const row of rows) {
        if (row.date === dateStr && records.find(r => r.studentId === row.studentId)) {
          row._synced = true;
          await dbPut(STORES.attendance, row);
        }
      }
      toast('Attendance saved ✓', 'success');
    } catch {
      await dbPut(STORES.pending, { payload, ts: Date.now() });
      toast('Saved offline — will sync later', 'success');
    }
  } else {
    await dbPut(STORES.pending, { payload, ts: Date.now() });
    toast('Saved offline — will sync when online', 'success');
  }
  refreshDashboard();
}

async function saveStudentProfile(studentId, fields) {
  const student = await dbGet(STORES.students, studentId);
  if (!student) return;
  Object.assign(student, fields);
  await dbPut(STORES.students, student);

  if (APP.online && APP.settings.gasUrl) {
    try {
      await gasRequest('updateStudent', { id: studentId, ...fields });
      toast('Profile saved ✓', 'success');
    } catch {
      await dbPut(STORES.pending, { type: 'studentUpdate', payload: { id: studentId, ...fields }, ts: Date.now() });
      toast('Profile saved offline ✓', 'success');
    }
  } else {
    await dbPut(STORES.pending, { type: 'studentUpdate', payload: { id: studentId, ...fields }, ts: Date.now() });
    toast('Profile saved offline ✓', 'success');
  }
}

/* ─────────────────────────────────────────────────────────────
   UI HELPERS
───────────────────────────────────────────────────────────── */
function setSyncState(state, label) {
  const badge = document.getElementById('sync-badge');
  badge.className = '';
  badge.id = 'sync-badge';
  badge.classList.add(state);
  badge.querySelector('span').textContent = label;
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
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const screen = document.getElementById(`screen-${name}`);
  if (screen) screen.classList.add('active');
  const nav = document.querySelector(`.nav-item[data-screen="${name}"]`);
  if (nav) nav.classList.add('active');
  APP.currentScreen = name;
  const titles = { dashboard:'ClassTrack', attendance:'Attendance', students:'Students', classes:'Classes', reports:'Reports', settings:'Settings', profile:'' };
  document.getElementById('topbar-title').textContent = titles[name] || '';
  if (name === 'dashboard')  refreshDashboard();
  if (name === 'attendance') initAttendance();
  if (name === 'students')   renderStudentList();
  if (name === 'reports')    renderReports();
  if (name === 'settings')   renderSettings();
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
function escHtml(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ─────────────────────────────────────────────────────────────
   DASHBOARD
───────────────────────────────────────────────────────────── */
async function refreshDashboard() {
  const today    = formatDate();
  const students = await dbGetAll(STORES.students);
  const allAtt   = await dbGetAll(STORES.attendance);
  const todayAtt = allAtt.filter(a => a.date === today);
  const pending  = await dbGetAll(STORES.pending);

  document.getElementById('dash-total').textContent   = students.length;
  document.getElementById('dash-present').textContent = todayAtt.filter(a => a.status === 'P').length;
  document.getElementById('dash-absent').textContent  = todayAtt.filter(a => a.status === 'A').length;
  document.getElementById('dash-date').textContent    = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
  const pendingEl = document.getElementById('dash-pending');
  pendingEl.textContent = pending.length ? `${pending.length} unsynced` : 'All synced';
  pendingEl.className   = pending.length ? 'pending-badge' : 'tag';

  const recentEl = document.getElementById('dash-recent');
  const dates    = [...new Set(allAtt.map(a => a.date))].sort((a,b) => b.localeCompare(a)).slice(0,5);
  if (!dates.length) {
    recentEl.innerHTML = '<div class="empty-state"><div class="emoji">📋</div><h3>No records yet</h3><p>Start by taking attendance</p></div>';
  } else {
    recentEl.innerHTML = dates.map(date => {
      const recs  = allAtt.filter(a => a.date === date);
      const p     = recs.filter(a => a.status === 'P').length;
      const total = recs.length;
      const pct   = total ? Math.round(p / total * 100) : 0;
      return `<div class="card card-sm flex items-center gap-3" style="cursor:pointer" onclick="goToAttDate('${date}')">
        <div style="flex:1">
          <div class="fw-bold" style="font-size:14px">${niceDate(date)}</div>
          <div class="text-muted" style="font-size:12px">${total} students · ${p} present</div>
        </div>
        <div class="att-pct ${pct < 70 ? 'danger' : pct < 85 ? 'warn' : ''}">${pct}%</div>
        <span style="color:var(--accent);font-size:12px;font-weight:600">Edit ›</span>
      </div>`;
    }).join('');
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
  if (!dateInput.value) dateInput.value = formatDate();
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
    list.innerHTML = '<div class="empty-state"><div class="emoji">👥</div><h3>No students found</h3><p>Sync your roster or adjust the class filter</p></div>';
    updateAttSummary();
    return;
  }

  // Load saved records for this date — enables editing past sessions
  const allAtt  = await dbGetAll(STORES.attendance);
  const dayRecs = allAtt.filter(a => a.date === date && (!classId || !a.classId || a.classId === classId));

  // Seed attState from saved records (don't overwrite live in-session changes)
  dayRecs.forEach(r => {
    if (!attState[r.studentId]) {
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
    return `
      <div class="student-row is-${st.status === 'P' ? 'present' : st.status === 'A' ? 'absent' : ''}" id="srow-${s.id}">
        <div class="student-avatar">${initials(s.name)}</div>
        <div class="student-info">
          <div class="name">${escHtml(s.name)}</div>
          <div class="meta">${escHtml(s.program||'')}${s.program && s.studentId ? ' · ' : ''}${escHtml(s.studentId||'')}</div>
        </div>
        <div class="att-pills">
          <button class="att-pill ${st.status==='P'?'active':''}" data-status="P" data-sid="${s.id}" title="Present">P</button>
          <button class="att-pill ${st.status==='A'?'active':''}" data-status="A" data-sid="${s.id}" title="Absent">A</button>
        </div>
        <button class="note-toggle ${st.note ? 'has-note' : ''}" data-sid="${s.id}" title="${st.note ? 'Edit note' : 'Add note'}">📝</button>
        <button class="student-profile-link" data-sid="${s.id}" title="View Profile">›</button>
      </div>
      <div class="att-note-row ${st.note ? 'open' : ''}" id="note-row-${s.id}">
        <input type="text" class="att-note-input" id="note-${s.id}" placeholder="Note (e.g. arrived late, left early, excused…)" value="${escHtml(st.note)}" data-sid="${s.id}" />
      </div>`;
  }).join('');

  updateAttSummary();
}

function updateAttSummary() {
  const p = Object.values(attState).filter(v => v.status === 'P').length;
  const a = Object.values(attState).filter(v => v.status === 'A').length;
  const u = Object.values(attState).filter(v => !v.status).length;
  document.getElementById('att-summary').innerHTML = `
    <div class="att-summary-pill P">Present <strong>${p}</strong></div>
    <div class="att-summary-pill A">Absent <strong>${a}</strong></div>
    ${u ? `<div class="att-summary-pill" style="background:var(--bg-3);color:var(--text-2)">Unmarked <strong>${u}</strong></div>` : ''}`;
}

function handleAttPill(e) {
  const btn    = e.target.closest('.att-pill');
  const sid    = btn.dataset.sid;
  const status = btn.dataset.status;
  if (!attState[sid]) attState[sid] = { status: '', note: '' };
  attState[sid].status = status;
  const row = document.getElementById(`srow-${sid}`);
  row.className = `student-row is-${status === 'P' ? 'present' : 'absent'}`;
  row.querySelectorAll('.att-pill').forEach(p => p.classList.toggle('active', p.dataset.status === status));
  updateAttSummary();
}

function handleNoteToggle(e) {
  const sid     = e.target.closest('.note-toggle').dataset.sid;
  const noteRow = document.getElementById(`note-row-${sid}`);
  noteRow.classList.toggle('open');
  if (noteRow.classList.contains('open')) {
    document.getElementById(`note-${sid}`).focus();
  }
}

function handleNoteInput(e) {
  const input = e.target.closest('.att-note-input');
  const sid   = input.dataset.sid;
  if (!attState[sid]) attState[sid] = { status: '', note: '' };
  attState[sid].note = input.value;
  const btn = document.querySelector(`.note-toggle[data-sid="${sid}"]`);
  if (btn) btn.classList.toggle('has-note', !!input.value);
}

async function handleSaveAttendance() {
  const date    = document.getElementById('att-date').value;
  const classId = document.getElementById('att-class').value;
  if (!date) { toast('Please select a date', 'error'); return; }
  const records = Object.entries(attState)
    .filter(([, v]) => v.status)
    .map(([studentId, v]) => ({ studentId, status: v.status, note: v.note || '' }));
  if (!records.length) { toast('No attendance marked yet', 'error'); return; }
  await saveAttendance(date, classId, records);
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
    const pct  = sAtt.length ? Math.round(sAtt.filter(a => a.status === 'P').length / sAtt.length * 100) : null;
    const pctClass = pct === null ? '' : pct < 70 ? 'danger' : pct < 85 ? 'warn' : '';
    return `<div class="student-card" data-sid="${s.id}">
      <div class="student-card-avatar">${initials(s.name)}</div>
      <div class="student-card-body">
        <div class="student-card-name">${escHtml(s.name)}</div>
        <div class="student-card-meta">
          ${s.program ? `<span>🎓 ${escHtml(s.program)}</span>` : ''}
          ${s.email   ? `<span>✉️ ${escHtml(s.email)}</span>`   : ''}
          ${s.phone   ? `<span>📱 ${escHtml(s.phone)}</span>`   : ''}
        </div>
      </div>
      ${pct !== null ? `<div class="student-card-att"><div class="att-pct ${pctClass}">${pct}%</div><div style="font-size:10px;color:var(--text-2)">attend.</div></div>` : ''}
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
  ['name','studentId','gender','phone','email','program','workplace'].forEach(f => {
    const el = document.getElementById(`pedit-${f}`);
    if (el) el.value = student[f] || '';
  });
  document.getElementById('pedit-notes').value        = student.notes        || '';
  document.getElementById('pedit-observations').value = student.observations || '';
  document.getElementById('pedit-followup').value     = student.followup     || '';

  // Attendance history
  const histEl = document.getElementById('profile-history');
  if (!sAtt.length) {
    histEl.innerHTML = '<div class="text-muted" style="font-size:13px;padding:12px 0">No attendance records yet</div>';
  } else {
    histEl.innerHTML = sAtt.slice(0, 40).map(a => `
      <div class="att-history-item">
        <div class="att-date">${niceDate(a.date)}</div>
        <div class="att-status-badge ${a.status}">${a.status === 'P' ? 'Present' : 'Absent'}</div>
        ${a.note ? `<div class="att-history-note">${escHtml(a.note)}</div>` : ''}
        ${!a._synced ? '<span class="pending-badge">⏳</span>' : ''}
      </div>`).join('');
  }

  showScreen('profile');
  document.getElementById('screen-profile').scrollTop = 0;
}

async function handleSaveProfile() {
  const sid = APP.profileStudentId;
  if (!sid) return;
  const fields = {};
  ['name','studentId','gender','phone','email','program','workplace','notes','observations','followup'].forEach(f => {
    const el = document.getElementById(`pedit-${f}`);
    if (el) fields[f] = el.value;
  });
  await saveStudentProfile(sid, fields);
  // Refresh header
  document.getElementById('profile-avatar').textContent = initials(fields.name);
  document.getElementById('profile-class').textContent  = fields.program || 'No class assigned';
}

/* ─────────────────────────────────────────────────────────────
   REPORTS
───────────────────────────────────────────────────────────── */
async function renderReports() {
  const allAtt   = await dbGetAll(STORES.attendance);
  const students = await dbGetAll(STORES.students);
  const today    = new Date();

  const weekDays = Array.from({length:7}, (_,i) => {
    const d = new Date(today); d.setDate(d.getDate() - 6 + i);
    return formatDate(d);
  });
  document.getElementById('report-week').innerHTML = weekDays.map(d => {
    const recs  = allAtt.filter(a => a.date === d);
    const p     = recs.filter(a => a.status === 'P').length;
    const total = recs.length;
    const pct   = total ? Math.round(p / total * 100) : 0;
    const day   = new Date(d + 'T00:00:00').toLocaleDateString('en-US', {weekday:'short'})[0];
    return `<div class="week-cell ${total ? (pct > 85 ? 'P' : pct > 70 ? 'L' : 'A') : ''}" title="${niceDate(d)}: ${pct}%">${day}</div>`;
  }).join('');

  const studentStats = students.map(s => {
    const sAtt = allAtt.filter(a => a.studentId === s.id);
    return { ...s, pct: sAtt.length ? Math.round(sAtt.filter(a=>a.status==='P').length/sAtt.length*100) : 0, total: sAtt.length };
  }).filter(s => s.total > 0).sort((a,b) => a.pct - b.pct);

  document.getElementById('report-bars').innerHTML = studentStats.length
    ? studentStats.slice(0,15).map(s => `
        <div class="report-bar-wrap">
          <div class="report-bar-label"><span>${escHtml(s.name)}</span><span>${s.pct}% (${s.total} sessions)</span></div>
          <div class="report-bar-track"><div class="report-bar-fill ${s.pct<70?'danger':s.pct<85?'warn':''}" style="width:${s.pct}%"></div></div>
        </div>`).join('')
    : '<div class="empty-state"><div class="emoji">📊</div><h3>No data yet</h3></div>';

  const total = allAtt.length;
  const P = allAtt.filter(a=>a.status==='P').length;
  const A = allAtt.filter(a=>a.status==='A').length;
  document.getElementById('report-overall').innerHTML = total
    ? `<div class="report-bar-wrap">
         <div class="report-bar-label"><span>Present</span><span>${P}/${total} (${Math.round(P/total*100)}%)</span></div>
         <div class="report-bar-track"><div class="report-bar-fill" style="width:${Math.round(P/total*100)}%"></div></div>
       </div>
       <div class="report-bar-wrap">
         <div class="report-bar-label"><span>Absent</span><span>${A}/${total} (${Math.round(A/total*100)}%)</span></div>
         <div class="report-bar-track"><div class="report-bar-fill danger" style="width:${Math.round(A/total*100)}%"></div></div>
       </div>`
    : '<div class="text-muted" style="font-size:13px">No data recorded yet</div>';
}

/* ─────────────────────────────────────────────────────────────
   ADD STUDENT
───────────────────────────────────────────────────────────── */
function openAddStudentModal() {
  // Clear fields
  ['name','studentId','gender','phone','email','program','workplace'].forEach(f => {
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
  const students = await dbGetAll(STORES.students);
  const programs = [...new Set([
    ...(APP.settings.classes || []),
    ...students.map(s => s.program).filter(Boolean)
  ])];
  const dl = document.getElementById('program-suggestions');
  dl.innerHTML = programs.map(p => `<option value="${escHtml(p)}">`).join('');
}

async function handleAddStudent() {
  const name = document.getElementById('add-name').value.trim();
  if (!name) { toast('Name is required', 'error'); return; }

  // Generate a unique id
  const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  const student = {
    id,
    studentId:   document.getElementById('add-studentId').value.trim(),
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
      await dbPut(STORES.pending, { type: 'addStudent', payload: student, ts: Date.now() });
      toast(`${name} saved offline — will sync later`, 'success');
    }
  } else {
    await dbPut(STORES.pending, { type: 'addStudent', payload: student, ts: Date.now() });
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
  const programsFromStudents = [...new Set(students.map(s => s.program).filter(Boolean))];
  const classIds = new Set(classes.map(c => c.id));
  // Auto-add any student programs not yet in classes store
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
      <div class="class-icon">🎓</div>
      <div class="class-body">
        <div class="class-name">${escHtml(cls.name)}</div>
        <div class="class-meta">
          ${enrolled} student${enrolled !== 1 ? 's' : ''} · ${sessions} session${sessions !== 1 ? 's' : ''}
          ${cls.description ? ' · ' + escHtml(cls.description) : ''}
        </div>
      </div>
      <div class="class-actions">
        <button class="class-action-btn" data-edit-class="${escHtml(cls.id)}" title="Edit">✏️</button>
        <button class="class-action-btn danger" data-delete-class="${escHtml(cls.id)}" title="Delete">🗑</button>
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
      await dbPut(STORES.pending, { type: 'saveClass', payload: cls, ts: Date.now() });
      toast('Saved offline — will sync later', 'success');
    }
  } else {
    await dbPut(STORES.pending, { type: 'saveClass', payload: cls, ts: Date.now() });
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
      await dbPut(STORES.pending, { type: 'deleteClass', payload: { id }, ts: Date.now() });
    }
  } else {
    await dbPut(STORES.pending, { type: 'deleteClass', payload: { id }, ts: Date.now() });
  }

  toast(`"${cls.name}" deleted`, 'success');
  renderClasses();
  await populateClassSelect();
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
  document.getElementById('set-instructor').value = APP.settings.instructorName || '';
  document.getElementById('set-classes').value    = (APP.settings.classes||[]).join(', ');
  document.getElementById('set-autosync').checked = APP.settings.autoSync !== false;
}

async function saveSettings() {
  await saveSetting('gasUrl',         document.getElementById('set-gas-url').value.trim());
  await saveSetting('instructorName', document.getElementById('set-instructor').value.trim());
  await saveSetting('classes',        document.getElementById('set-classes').value.split(',').map(c=>c.trim()).filter(Boolean));
  await saveSetting('autoSync',       document.getElementById('set-autosync').checked);
  toast('Settings saved ✓', 'success');
}

/* ─────────────────────────────────────────────────────────────
   SAMPLE DATA
───────────────────────────────────────────────────────────── */
async function loadSampleData() {
  const existing = await dbGetAll(STORES.students);
  if (existing.length) return;
  const sample = [
    { id:'s001', studentId:'STU001', name:'Alice Johnson',  gender:'Female', phone:'876-555-0101', email:'alice@example.com',  program:'Computer Science', workplace:'TechCorp',    notes:'', observations:'', followup:'' },
    { id:'s002', studentId:'STU002', name:'Bob Williams',   gender:'Male',   phone:'876-555-0102', email:'bob@example.com',    program:'Computer Science', workplace:'StartupX',    notes:'', observations:'', followup:'' },
    { id:'s003', studentId:'STU003', name:'Carol Brown',    gender:'Female', phone:'876-555-0103', email:'carol@example.com',  program:'Business Admin',   workplace:'RetailCo',    notes:'', observations:'', followup:'' },
    { id:'s004', studentId:'STU004', name:'David Lee',      gender:'Male',   phone:'876-555-0104', email:'david@example.com',  program:'Computer Science', workplace:'Freelance',   notes:'', observations:'', followup:'' },
    { id:'s005', studentId:'STU005', name:'Emma Davis',     gender:'Female', phone:'876-555-0105', email:'emma@example.com',   program:'Business Admin',   workplace:'FinanceJA',   notes:'', observations:'', followup:'' },
    { id:'s006', studentId:'STU006', name:'Frank Miller',   gender:'Male',   phone:'876-555-0106', email:'frank@example.com',  program:'Data Science',     workplace:'Analytics',   notes:'', observations:'', followup:'' },
    { id:'s007', studentId:'STU007', name:'Grace Wilson',   gender:'Female', phone:'876-555-0107', email:'grace@example.com',  program:'Data Science',     workplace:'Govt Office', notes:'', observations:'', followup:'' },
    { id:'s008', studentId:'STU008', name:'Henry Taylor',   gender:'Male',   phone:'876-555-0108', email:'henry@example.com',  program:'Computer Science', workplace:'ITFirm',      notes:'', observations:'', followup:'' },
  ];
  for (const s of sample) await dbPut(STORES.students, s);
  toast('Sample data loaded', 'success');
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
  document.getElementById('btn-install').classList.add('show');
});
window.addEventListener('appinstalled', () => {
  APP.installPrompt = null;
  document.getElementById('btn-install').classList.remove('show');
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
  document.querySelectorAll('.nav-item[data-screen]').forEach(el =>
    el.addEventListener('click', () => showScreen(el.dataset.screen))
  );

  document.getElementById('btn-install').addEventListener('click', async () => {
    if (!APP.installPrompt) return;
    APP.installPrompt.prompt();
    const { outcome } = await APP.installPrompt.userChoice;
    if (outcome === 'accepted') APP.installPrompt = null;
  });

  // Attendance events
  document.getElementById('att-list').addEventListener('click', e => {
    if (e.target.closest('.att-pill'))             { handleAttPill(e);    return; }
    if (e.target.closest('.note-toggle'))          { handleNoteToggle(e); return; }
    if (e.target.closest('.student-profile-link')) { showProfile(e.target.closest('.student-profile-link').dataset.sid); }
  });
  document.getElementById('att-list').addEventListener('input', e => {
    if (e.target.closest('.att-note-input')) handleNoteInput(e);
  });
  document.getElementById('att-date').addEventListener('change', () => { attState = {}; renderAttendanceList(); });
  document.getElementById('att-class').addEventListener('change', () => { attState = {}; renderAttendanceList(); });
  document.getElementById('btn-mark-all-present').addEventListener('click', async () => {
    let students = await dbGetAll(STORES.students);
    const classId = document.getElementById('att-class').value;
    if (classId) students = students.filter(s => s.program === classId);
    students.forEach(s => {
      if (!attState[s.id]) attState[s.id] = { status: 'P', note: '' };
      else attState[s.id].status = 'P';
    });
    renderAttendanceList();
  });
  document.getElementById('btn-save-att').addEventListener('click', handleSaveAttendance);
  document.getElementById('btn-sync-roster').addEventListener('click', () => {
    if (!APP.settings.gasUrl) { toast('Set GAS URL in Settings first', 'error'); return; }
    syncRoster();
  });

  // Students
  document.getElementById('student-search').addEventListener('input', e => renderStudentList(e.target.value));
  document.getElementById('student-list').addEventListener('click', e => {
    const card = e.target.closest('.student-card');
    if (card) showProfile(card.dataset.sid);
  });
  document.getElementById('btn-sync-roster-2').addEventListener('click', () => {
    if (!APP.settings.gasUrl) { toast('Set GAS URL in Settings first', 'error'); return; }
    syncRoster().then(() => renderStudentList());
  });
  document.getElementById('btn-add-student').addEventListener('click', openAddStudentModal);
  document.getElementById('btn-close-add-modal').addEventListener('click', closeAddStudentModal);
  document.getElementById('btn-confirm-add-student').addEventListener('click', handleAddStudent);
  document.getElementById('add-student-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('add-student-modal')) closeAddStudentModal();
  });

  // Profile
  document.getElementById('profile-back').addEventListener('click', () => showScreen('students'));
  document.getElementById('btn-save-profile').addEventListener('click', handleSaveProfile);

  // Reports
  document.getElementById('btn-export-csv').addEventListener('click', exportCSV);
  document.getElementById('btn-sync-reports').addEventListener('click', () => syncRoster().then(() => renderReports()));

  // Settings
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-load-sample').addEventListener('click', async () => {
    await dbClear(STORES.students);
    await loadSampleData();
    renderStudentList(); refreshDashboard();
  });
  document.getElementById('btn-clear-data').addEventListener('click', async () => {
    if (!confirm('Clear ALL local data? This cannot be undone.')) return;
    await dbClear(STORES.students);
    await dbClear(STORES.attendance);
    await dbClear(STORES.pending);
    toast('All local data cleared', 'success');
    refreshDashboard();
  });

  // Classes
  document.getElementById('btn-add-class').addEventListener('click', () => openAddClassModal());
  document.getElementById('btn-close-class-modal').addEventListener('click', closeClassModal);
  document.getElementById('btn-confirm-class').addEventListener('click', handleSaveClass);
  document.getElementById('add-class-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('add-class-modal')) closeClassModal();
  });
  document.getElementById('classes-list').addEventListener('click', e => {
    const editBtn   = e.target.closest('[data-edit-class]');
    const deleteBtn = e.target.closest('[data-delete-class]');
    if (editBtn)   openAddClassModal(editBtn.dataset.editClass);
    if (deleteBtn) handleDeleteClass(deleteBtn.dataset.deleteClass);
  });

  // Dashboard quick actions
  document.getElementById('qa-take-att').addEventListener('click',     () => showScreen('attendance'));
  document.getElementById('qa-view-students').addEventListener('click',() => showScreen('students'));
  document.getElementById('qa-reports').addEventListener('click',      () => showScreen('reports'));
  document.getElementById('qa-sync').addEventListener('click', () => {
    if (!APP.settings.gasUrl) { toast('Configure GAS URL in Settings', 'error'); return; }
    syncRoster(); syncPendingAttendance();
  });

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
    setTimeout(async () => { await syncClasses(); syncPendingAttendance(); }, 2000);
  }
}

document.addEventListener('DOMContentLoaded', init);
