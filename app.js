/* ============================================================
   ClassTrack – app.js  v1.0
   All logic: DB, API, Attendance, Students, Reports, Settings
   ============================================================ */

'use strict';

/* ─────────────────────────────────────────────────────────────
   CONSTANTS & STATE
───────────────────────────────────────────────────────────── */
const DB_NAME    = 'classtracK';
const DB_VERSION = 3;
const STORES     = { students: 'students', attendance: 'attendance', pending: 'pending', settings: 'settings' };

const APP = {
  db: null,
  online: navigator.onLine,
  syncing: false,
  currentScreen: 'dashboard',
  profileStudentId: null,
  installPrompt: null,
  settings: {
    gasUrl: '',
    instructorName: '',
    classes: [],
    autoSync: true
  }
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
        a.createIndex('dateClass', ['date', 'classId'], { unique: false });
        a.createIndex('studentDate', ['studentId', 'date'], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.pending)) {
        db.createObjectStore(STORES.pending, { autoIncrement: true, keyPath: '_pendingId' });
      }
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: 'key' });
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
    const keys = ['gasUrl', 'instructorName', 'classes', 'autoSync'];
    for (const key of keys) {
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
   GOOGLE APPS SCRIPT API
───────────────────────────────────────────────────────────── */
async function gasRequest(action, payload = {}) {
  if (!APP.settings.gasUrl) throw new Error('No GAS URL configured.');
  const url = `${APP.settings.gasUrl}?action=${action}`;
  const res  = await fetch(url, {
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
      await gasRequest('saveAttendance', item.payload);
      await dbDelete(STORES.pending, item._pendingId);
      synced++;
    } catch {}
  }
  if (synced) toast(`Synced ${synced} records ✓`, 'success');
  setSyncState('online', 'Online');
  refreshDashboard();
}

async function saveAttendance(dateStr, classId, records) {
  const payload = { date: dateStr, classId, instructor: APP.settings.instructorName, records };

  // Always save locally first
  for (const rec of records) {
    const existing = (await dbGetAll(STORES.attendance, 'studentDate', IDBKeyRange.only([rec.studentId, dateStr])))[0];
    if (existing) {
      existing.status = rec.status;
      existing.classId = classId;
      existing._synced = false;
      await dbPut(STORES.attendance, existing);
    } else {
      await dbPut(STORES.attendance, {
        studentId: rec.studentId, date: dateStr, classId,
        status: rec.status, _synced: false
      });
    }
  }

  if (APP.online && APP.settings.gasUrl) {
    try {
      await gasRequest('saveAttendance', payload);
      // Mark as synced
      for (const rec of records) {
        const rows = await dbGetAll(STORES.attendance, 'studentDate', IDBKeyRange.only([rec.studentId, dateStr]));
        for (const row of rows) { row._synced = true; await dbPut(STORES.attendance, row); }
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

async function saveStudentNotes(studentId, notes, observations, followup) {
  const student = await dbGet(STORES.students, studentId);
  if (!student) return;
  student.notes = notes;
  student.observations = observations;
  student.followup = followup;
  await dbPut(STORES.students, student);

  if (APP.online && APP.settings.gasUrl) {
    try {
      await gasRequest('updateStudent', { id: studentId, notes, observations, followup });
      toast('Notes saved ✓', 'success');
    } catch {
      await dbPut(STORES.pending, { type: 'studentUpdate', payload: { id: studentId, notes, observations, followup }, ts: Date.now() });
      toast('Notes saved offline ✓', 'success');
    }
  } else {
    await dbPut(STORES.pending, { type: 'studentUpdate', payload: { id: studentId, notes, observations, followup }, ts: Date.now() });
    toast('Notes saved offline ✓', 'success');
  }
}

/* ─────────────────────────────────────────────────────────────
   UI HELPERS
───────────────────────────────────────────────────────────── */
function setSyncState(state, label) {
  const badge = document.getElementById('sync-badge');
  badge.className = 'sync-badge ' + state;
  badge.querySelector('span').textContent = label;
  // Handle id-based class
  badge.id = 'sync-badge';
  badge.classList.add(state);
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
  document.getElementById('topbar-title').textContent = { dashboard: 'ClassTrack', attendance: 'Attendance', students: 'Students', reports: 'Reports', settings: 'Settings', profile: '' }[name] || 'ClassTrack';
  if (name === 'dashboard')  refreshDashboard();
  if (name === 'attendance') initAttendance();
  if (name === 'students')   renderStudentList();
  if (name === 'reports')    renderReports();
  if (name === 'settings')   renderSettings();
}

function initials(name = '') {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

function formatDate(d = new Date()) {
  return d.toISOString().split('T')[0];
}

function niceDate(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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

  const present  = todayAtt.filter(a => a.status === 'P').length;
  const absent   = todayAtt.filter(a => a.status === 'A').length;
  const late     = todayAtt.filter(a => a.status === 'L').length;
  const excused  = todayAtt.filter(a => a.status === 'E').length;

  document.getElementById('dash-total').textContent     = students.length;
  document.getElementById('dash-present').textContent   = present;
  document.getElementById('dash-absent').textContent    = absent;
  document.getElementById('dash-late').textContent      = late;
  document.getElementById('dash-date').textContent      = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
  document.getElementById('dash-pending').textContent   = pending.length ? `${pending.length} unsynced` : 'All synced';
  document.getElementById('dash-pending').className     = pending.length ? 'pending-badge' : 'tag';

  // Recent activity
  const recentEl = document.getElementById('dash-recent');
  const recent   = allAtt.sort((a,b) => (b.date > a.date ? 1 : -1)).slice(0, 5);
  if (!recent.length) {
    recentEl.innerHTML = '<div class="empty-state"><div class="emoji">📋</div><h3>No records yet</h3><p>Start by taking attendance</p></div>';
  } else {
    const dates = [...new Set(recent.map(r => r.date))];
    recentEl.innerHTML = dates.map(date => {
      const recs = allAtt.filter(a => a.date === date);
      const p = recs.filter(a=>a.status==='P').length;
      const total = recs.length;
      return `<div class="card card-sm flex items-center gap-3">
        <div style="flex:1">
          <div class="fw-bold" style="font-size:14px">${niceDate(date)}</div>
          <div class="text-muted" style="font-size:12px">${total} students recorded</div>
        </div>
        <div class="att-pct ${p/total < .7 ? 'danger' : p/total < .85 ? 'warn' : ''}">${total ? Math.round(p/total*100) : 0}%</div>
      </div>`;
    }).join('');
  }
}

/* ─────────────────────────────────────────────────────────────
   ATTENDANCE
───────────────────────────────────────────────────────────── */
let attState = {}; // { studentId: status }

async function initAttendance() {
  attState = {};
  const dateInput = document.getElementById('att-date');
  if (!dateInput.value) dateInput.value = formatDate();
  await populateClassSelect();
  renderAttendanceList();
}

async function populateClassSelect() {
  const sel    = document.getElementById('att-class');
  const stored = document.getElementById('att-class').value;
  const students = await dbGetAll(STORES.students);
  const classes  = [...new Set(students.map(s => s.program).filter(Boolean))];
  const all      = [...new Set([...APP.settings.classes, ...classes])];
  sel.innerHTML  = '<option value="">All Classes</option>' + all.map(c => `<option value="${c}" ${c===stored?'selected':''}>${c}</option>`).join('');
}

async function renderAttendanceList() {
  const list   = document.getElementById('att-list');
  const date   = document.getElementById('att-date').value;
  const classId = document.getElementById('att-class').value;
  let students  = await dbGetAll(STORES.students);
  if (classId)  students = students.filter(s => s.program === classId);

  if (!students.length) {
    list.innerHTML = `<div class="empty-state"><div class="emoji">👥</div><h3>No students found</h3><p>Sync your roster or add students in Settings</p></div>`;
    updateAttSummary();
    return;
  }

  // Load existing attendance for this date+class
  const existing = await dbGetAll(STORES.attendance);
  const dayRecs  = existing.filter(a => a.date === date && (!classId || a.classId === classId || !a.classId));
  dayRecs.forEach(r => { if (!attState[r.studentId]) attState[r.studentId] = r.status; });

  students.sort((a,b) => a.name.localeCompare(b.name));

  list.innerHTML = students.map(s => {
    const status = attState[s.id] || '';
    return `<div class="student-row is-${status === 'P' ? 'present' : status === 'L' ? 'late' : status === 'A' ? 'absent' : status === 'E' ? 'excused' : ''}" id="srow-${s.id}">
      <div class="student-avatar">${initials(s.name)}</div>
      <div class="student-info">
        <div class="name">${escHtml(s.name)}</div>
        <div class="meta">${escHtml(s.program||'')}${s.program && s.studentId ? ' · ' : ''}${escHtml(s.studentId||'')}</div>
      </div>
      <div class="att-pills">
        ${['P','L','A','E'].map(st => `<button class="att-pill ${status===st?'active':''}" data-status="${st}" data-sid="${s.id}" title="${{P:'Present',L:'Late',A:'Absent',E:'Excused'}[st]}">${st}</button>`).join('')}
      </div>
      <button class="student-profile-link" data-sid="${s.id}" title="View Profile">›</button>
    </div>`;
  }).join('');
  updateAttSummary();
}

function updateAttSummary() {
  const counts = { P:0, L:0, A:0, E:0 };
  Object.values(attState).forEach(s => { if (counts[s] !== undefined) counts[s]++; });
  const bar = document.getElementById('att-summary');
  bar.innerHTML = Object.entries(counts).map(([s,n]) =>
    `<div class="att-summary-pill ${s}">${{P:'Present',L:'Late',A:'Absent',E:'Excused'}[s]} <strong>${n}</strong></div>`
  ).join('');
}

function handleAttPill(e) {
  const btn = e.target.closest('.att-pill');
  if (!btn) return;
  const sid    = btn.dataset.sid;
  const status = btn.dataset.status;
  attState[sid] = status;
  const row  = document.getElementById(`srow-${sid}`);
  row.className = `student-row is-${status === 'P' ? 'present' : status === 'L' ? 'late' : status === 'A' ? 'absent' : 'excused'}`;
  row.querySelectorAll('.att-pill').forEach(p => p.classList.toggle('active', p.dataset.status === status));
  updateAttSummary();
}

async function handleSaveAttendance() {
  const date    = document.getElementById('att-date').value;
  const classId = document.getElementById('att-class').value;
  if (!date) { toast('Please select a date', 'error'); return; }
  const records = Object.entries(attState).map(([studentId, status]) => ({ studentId, status }));
  if (!records.length) { toast('No attendance marked yet', 'error'); return; }
  await saveAttendance(date, classId, records);
}

/* ─────────────────────────────────────────────────────────────
   STUDENTS LIST
───────────────────────────────────────────────────────────── */
async function renderStudentList(query = '') {
  const list     = document.getElementById('student-list');
  let students   = await dbGetAll(STORES.students);
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
      ? `<div class="empty-state"><div class="emoji">🔍</div><h3>No results</h3><p>Try a different search</p></div>`
      : `<div class="empty-state"><div class="emoji">👥</div><h3>No students yet</h3><p>Sync your roster from Google Sheets</p></div>`;
    return;
  }

  const allAtt = await dbGetAll(STORES.attendance);

  list.innerHTML = students.map(s => {
    const sAtt   = allAtt.filter(a => a.studentId === s.id);
    const pct    = sAtt.length ? Math.round(sAtt.filter(a => a.status === 'P').length / sAtt.length * 100) : null;
    const pctClass = pct === null ? '' : pct < 70 ? 'danger' : pct < 85 ? 'warn' : '';
    return `<div class="student-card" data-sid="${s.id}">
      <div class="student-card-avatar">${initials(s.name)}</div>
      <div class="student-card-body">
        <div class="student-card-name">${escHtml(s.name)}</div>
        <div class="student-card-meta">
          ${s.program ? `<span>🎓 ${escHtml(s.program)}</span>` : ''}
          ${s.email   ? `<span>✉️ ${escHtml(s.email)}</span>` : ''}
          ${s.phone   ? `<span>📱 ${escHtml(s.phone)}</span>` : ''}
        </div>
      </div>
      ${pct !== null ? `<div class="student-card-att"><div class="att-pct ${pctClass}">${pct}%</div><div style="font-size:10px;color:var(--text-2)">attend.</div></div>` : ''}
    </div>`;
  }).join('');
}

/* ─────────────────────────────────────────────────────────────
   PROFILE
───────────────────────────────────────────────────────────── */
async function showProfile(studentId) {
  APP.profileStudentId = studentId;
  const student = await dbGet(STORES.students, studentId);
  if (!student) return;

  const allAtt = await dbGetAll(STORES.attendance);
  const sAtt   = allAtt.filter(a => a.studentId === studentId).sort((a,b) => b.date.localeCompare(a.date));
  const pct    = sAtt.length ? Math.round(sAtt.filter(a=>a.status==='P').length/sAtt.length*100) : 0;

  document.getElementById('profile-avatar').textContent  = initials(student.name);
  document.getElementById('profile-name').textContent    = student.name;
  document.getElementById('profile-class').textContent   = student.program || 'No class assigned';
  document.getElementById('profile-id').textContent      = student.studentId   || '—';
  document.getElementById('profile-gender').textContent  = student.gender      || '—';
  document.getElementById('profile-phone').textContent   = student.phone       || '—';
  document.getElementById('profile-email').textContent   = student.email       || '—';
  document.getElementById('profile-workplace').textContent = student.workplace || '—';
  document.getElementById('profile-pct').textContent     = pct + '%';
  document.getElementById('profile-total').textContent   = sAtt.length + ' sessions';

  document.getElementById('profile-notes').value        = student.notes        || '';
  document.getElementById('profile-observations').value = student.observations || '';
  document.getElementById('profile-followup').value     = student.followup     || '';

  const histEl = document.getElementById('profile-history');
  if (!sAtt.length) {
    histEl.innerHTML = '<div class="text-muted" style="font-size:13px;padding:12px 0">No attendance records</div>';
  } else {
    histEl.innerHTML = sAtt.slice(0, 30).map(a => `
      <div class="att-history-item">
        <div class="att-date">${niceDate(a.date)}</div>
        <div class="att-status-badge ${a.status}">${{P:'Present',L:'Late',A:'Absent',E:'Excused'}[a.status]||a.status}</div>
        ${!a._synced ? '<span class="pending-badge">⏳ Pending</span>' : ''}
      </div>`).join('');
  }

  showScreen('profile');
  document.getElementById('screen-profile').scrollTop = 0;
}

/* ─────────────────────────────────────────────────────────────
   REPORTS
───────────────────────────────────────────────────────────── */
async function renderReports() {
  const allAtt   = await dbGetAll(STORES.attendance);
  const students = await dbGetAll(STORES.students);
  const today    = new Date();

  // Weekly summary (last 7 days)
  const weekDays = Array.from({length:7}, (_,i) => {
    const d = new Date(today); d.setDate(d.getDate()-6+i);
    return formatDate(d);
  });
  const weekEl = document.getElementById('report-week');
  weekEl.innerHTML = weekDays.map(d => {
    const recs  = allAtt.filter(a => a.date === d);
    const p     = recs.filter(a=>a.status==='P').length;
    const total = recs.length;
    const pct   = total ? Math.round(p/total*100) : 0;
    const day   = new Date(d+'T00:00:00').toLocaleDateString('en-US',{weekday:'short'})[0];
    return `<div class="week-cell ${total ? (pct>85?'P':pct>70?'L':'A') : ''}" title="${niceDate(d)}: ${pct}%">${day}</div>`;
  }).join('');

  // Top students by attendance
  const studentStats = students.map(s => {
    const sAtt = allAtt.filter(a => a.studentId === s.id);
    return { ...s, pct: sAtt.length ? Math.round(sAtt.filter(a=>a.status==='P').length/sAtt.length*100) : 0, total: sAtt.length };
  }).filter(s => s.total > 0).sort((a,b) => a.pct - b.pct);

  const barsEl = document.getElementById('report-bars');
  if (!studentStats.length) {
    barsEl.innerHTML = '<div class="empty-state"><div class="emoji">📊</div><h3>No data yet</h3></div>';
  } else {
    barsEl.innerHTML = studentStats.slice(0, 15).map(s => `
      <div class="report-bar-wrap">
        <div class="report-bar-label"><span>${escHtml(s.name)}</span><span>${s.pct}% (${s.total} sessions)</span></div>
        <div class="report-bar-track"><div class="report-bar-fill ${s.pct<70?'danger':s.pct<85?'warn':''}" style="width:${s.pct}%"></div></div>
      </div>`).join('');
  }

  // Overall stats
  const total   = allAtt.length;
  const P = allAtt.filter(a=>a.status==='P').length;
  const L = allAtt.filter(a=>a.status==='L').length;
  const A = allAtt.filter(a=>a.status==='A').length;
  const E = allAtt.filter(a=>a.status==='E').length;
  document.getElementById('report-overall').innerHTML = total ? `
    <div class="report-bar-wrap">
      <div class="report-bar-label"><span>Present</span><span>${P}/${total} (${Math.round(P/total*100)}%)</span></div>
      <div class="report-bar-track"><div class="report-bar-fill" style="width:${Math.round(P/total*100)}%"></div></div>
    </div>
    <div class="report-bar-wrap">
      <div class="report-bar-label"><span>Late</span><span>${L}/${total} (${Math.round(L/total*100)}%)</span></div>
      <div class="report-bar-track"><div class="report-bar-fill warn" style="width:${Math.round(L/total*100)}%"></div></div>
    </div>
    <div class="report-bar-wrap">
      <div class="report-bar-label"><span>Absent</span><span>${A}/${total} (${Math.round(A/total*100)}%)</span></div>
      <div class="report-bar-track"><div class="report-bar-fill danger" style="width:${Math.round(A/total*100)}%"></div></div>
    </div>` : '<div class="text-muted" style="font-size:13px">No data recorded yet</div>';
}

/* ─────────────────────────────────────────────────────────────
   EXPORT
───────────────────────────────────────────────────────────── */
async function exportCSV() {
  const allAtt   = await dbGetAll(STORES.attendance);
  const students = await dbGetAll(STORES.students);
  const studentMap = Object.fromEntries(students.map(s => [s.id, s]));

  const rows = [['Date','Student ID','Name','Program','Status','Synced']];
  allAtt.sort((a,b)=>b.date.localeCompare(a.date)).forEach(a => {
    const s = studentMap[a.studentId] || {};
    rows.push([a.date, s.studentId||a.studentId, s.name||'', s.program||'', a.status, a._synced?'Yes':'No']);
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
  document.getElementById('set-gas-url').value       = APP.settings.gasUrl || '';
  document.getElementById('set-instructor').value    = APP.settings.instructorName || '';
  document.getElementById('set-classes').value       = (APP.settings.classes||[]).join(', ');
  document.getElementById('set-autosync').checked    = APP.settings.autoSync !== false;
}

async function saveSettings() {
  const gasUrl = document.getElementById('set-gas-url').value.trim();
  const instructor = document.getElementById('set-instructor').value.trim();
  const classesRaw = document.getElementById('set-classes').value;
  const classes = classesRaw.split(',').map(c=>c.trim()).filter(Boolean);
  const autoSync = document.getElementById('set-autosync').checked;

  await saveSetting('gasUrl', gasUrl);
  await saveSetting('instructorName', instructor);
  await saveSetting('classes', classes);
  await saveSetting('autoSync', autoSync);
  toast('Settings saved ✓', 'success');
}

/* ─────────────────────────────────────────────────────────────
   SAMPLE DATA (for demo when GAS not configured)
───────────────────────────────────────────────────────────── */
async function loadSampleData() {
  const existing = await dbGetAll(STORES.students);
  if (existing.length) return; // don't overwrite

  const sample = [
    { id: 's001', studentId: 'STU001', name: 'Alice Johnson',  gender: 'Female', phone: '876-555-0101', email: 'alice@example.com',   program: 'Computer Science', workplace: 'TechCorp', notes: '', observations: '', followup: '' },
    { id: 's002', studentId: 'STU002', name: 'Bob Williams',   gender: 'Male',   phone: '876-555-0102', email: 'bob@example.com',     program: 'Computer Science', workplace: 'StartupX', notes: '', observations: '', followup: '' },
    { id: 's003', studentId: 'STU003', name: 'Carol Brown',    gender: 'Female', phone: '876-555-0103', email: 'carol@example.com',   program: 'Business Admin',   workplace: 'RetailCo', notes: '', observations: '', followup: '' },
    { id: 's004', studentId: 'STU004', name: 'David Lee',      gender: 'Male',   phone: '876-555-0104', email: 'david@example.com',   program: 'Computer Science', workplace: 'Freelance', notes: '', observations: '', followup: '' },
    { id: 's005', studentId: 'STU005', name: 'Emma Davis',     gender: 'Female', phone: '876-555-0105', email: 'emma@example.com',    program: 'Business Admin',   workplace: 'FinanceJA', notes: '', observations: '', followup: '' },
    { id: 's006', studentId: 'STU006', name: 'Frank Miller',   gender: 'Male',   phone: '876-555-0106', email: 'frank@example.com',   program: 'Data Science',     workplace: 'Analytics Co', notes: '', observations: '', followup: '' },
    { id: 's007', studentId: 'STU007', name: 'Grace Wilson',   gender: 'Female', phone: '876-555-0107', email: 'grace@example.com',   program: 'Data Science',     workplace: 'Govt Office', notes: '', observations: '', followup: '' },
    { id: 's008', studentId: 'STU008', name: 'Henry Taylor',   gender: 'Male',   phone: '876-555-0108', email: 'henry@example.com',   program: 'Computer Science', workplace: 'ITFirm', notes: '', observations: '', followup: '' },
  ];
  for (const s of sample) await dbPut(STORES.students, s);
  toast('Sample data loaded — connect Google Sheets for real data', 'success');
}

/* ─────────────────────────────────────────────────────────────
   CONNECTIVITY
───────────────────────────────────────────────────────────── */
function handleOnline() {
  APP.online = true;
  setSyncState('online', 'Online');
  toast('Back online — syncing…', 'success');
  if (APP.settings.autoSync !== false) {
    syncPendingAttendance();
  }
}

function handleOffline() {
  APP.online = false;
  setSyncState('offline', 'Offline');
  toast('Offline mode — data saved locally', '');
}

/* ─────────────────────────────────────────────────────────────
   UTILITY
───────────────────────────────────────────────────────────── */
function escHtml(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ─────────────────────────────────────────────────────────────
   PWA INSTALL
───────────────────────────────────────────────────────────── */
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  APP.installPrompt = e;
  document.getElementById('btn-install').classList.add('show');
});

window.addEventListener('appinstalled', () => {
  APP.installPrompt = null;
  document.getElementById('btn-install').classList.remove('show');
  toast('App installed successfully!', 'success');
});

/* ─────────────────────────────────────────────────────────────
   SERVICE WORKER
───────────────────────────────────────────────────────────── */
async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('./service-worker.js');
      navigator.serviceWorker.addEventListener('message', e => {
        if (e.data && e.data.type === 'TRIGGER_SYNC') syncPendingAttendance();
      });
      // Background sync
      if ('sync' in reg) {
        try { await reg.sync.register('sync-attendance'); } catch {}
      }
    } catch (err) {
      console.warn('SW registration failed:', err);
    }
  }
}

/* ─────────────────────────────────────────────────────────────
   EVENT LISTENERS
───────────────────────────────────────────────────────────── */
function bindEvents() {
  // Bottom nav
  document.querySelectorAll('.nav-item[data-screen]').forEach(el => {
    el.addEventListener('click', () => showScreen(el.dataset.screen));
  });

  // Install button
  document.getElementById('btn-install').addEventListener('click', async () => {
    if (!APP.installPrompt) return;
    APP.installPrompt.prompt();
    const { outcome } = await APP.installPrompt.userChoice;
    if (outcome === 'accepted') APP.installPrompt = null;
  });

  // Attendance
  document.getElementById('att-list').addEventListener('click', e => {
    const pill = e.target.closest('.att-pill');
    if (pill) { handleAttPill(e); return; }
    const profileLink = e.target.closest('.student-profile-link');
    if (profileLink) showProfile(profileLink.dataset.sid);
  });
  document.getElementById('att-date').addEventListener('change', renderAttendanceList);
  document.getElementById('att-class').addEventListener('change', renderAttendanceList);
  document.getElementById('btn-mark-all-present').addEventListener('click', async () => {
    let students = await dbGetAll(STORES.students);
    const classId = document.getElementById('att-class').value;
    if (classId) students = students.filter(s => s.program === classId);
    students.forEach(s => { attState[s.id] = 'P'; });
    renderAttendanceList();
  });
  document.getElementById('btn-save-att').addEventListener('click', handleSaveAttendance);
  document.getElementById('btn-sync-roster').addEventListener('click', () => {
    if (!APP.settings.gasUrl) {
      toast('Set your Google Apps Script URL in Settings first', 'error');
      return;
    }
    syncRoster();
  });

  // Students
  document.getElementById('student-search').addEventListener('input', e => renderStudentList(e.target.value));
  document.getElementById('student-list').addEventListener('click', e => {
    const card = e.target.closest('.student-card');
    if (card) showProfile(card.dataset.sid);
  });
  document.getElementById('btn-sync-roster-2').addEventListener('click', () => {
    if (!APP.settings.gasUrl) {
      toast('Set your Google Apps Script URL in Settings first', 'error');
      return;
    }
    syncRoster().then(() => renderStudentList());
  });

  // Profile
  document.getElementById('profile-back').addEventListener('click', () => showScreen('students'));
  document.getElementById('btn-save-notes').addEventListener('click', async () => {
    const sid  = APP.profileStudentId;
    const notes = document.getElementById('profile-notes').value;
    const obs   = document.getElementById('profile-observations').value;
    const fu    = document.getElementById('profile-followup').value;
    await saveStudentNotes(sid, notes, obs, fu);
  });

  // Reports
  document.getElementById('btn-export-csv').addEventListener('click', exportCSV);
  document.getElementById('btn-sync-reports').addEventListener('click', () => syncRoster().then(() => renderReports()));

  // Settings
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-load-sample').addEventListener('click', async () => {
    await dbClear(STORES.students);
    APP.settings.gasUrl = ''; // don't accidentally call GAS
    await loadSampleData();
    renderStudentList();
    refreshDashboard();
  });
  document.getElementById('btn-clear-data').addEventListener('click', async () => {
    if (!confirm('Clear ALL local data? This cannot be undone.')) return;
    await dbClear(STORES.students);
    await dbClear(STORES.attendance);
    await dbClear(STORES.pending);
    toast('All local data cleared', 'success');
    refreshDashboard();
  });

  // Dashboard quick actions
  document.getElementById('qa-take-att').addEventListener('click',    () => showScreen('attendance'));
  document.getElementById('qa-view-students').addEventListener('click',() => showScreen('students'));
  document.getElementById('qa-reports').addEventListener('click',     () => showScreen('reports'));
  document.getElementById('qa-sync').addEventListener('click', () => {
    if (!APP.settings.gasUrl) { toast('Configure Google Apps Script URL in Settings', 'error'); return; }
    syncRoster();
    syncPendingAttendance();
  });

  // Online/offline
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

  // Initial sync state
  if (navigator.onLine) {
    setSyncState('online', 'Online');
  } else {
    setSyncState('offline', 'Offline');
  }

  // Load sample data if empty
  await loadSampleData();

  showScreen('dashboard');

  // Auto-sync if online
  if (APP.online && APP.settings.autoSync !== false) {
    setTimeout(() => syncPendingAttendance(), 2000);
  }
}

document.addEventListener('DOMContentLoaded', init);
