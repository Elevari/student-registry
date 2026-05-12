# ClassTrack – Attendance PWA

A production-ready Progressive Web App for classroom attendance and student profile management. Works offline. Syncs to Google Sheets.

---

## 🚀 Quick Start

### 1. Download & Unzip
```
attendance-pwa/
├── index.html
├── manifest.json
├── service-worker.js
├── app.js
├── styles.css
├── icons/
│   ├── icon-72.png … icon-512.png
├── google-apps-script/
│   └── Code.gs
└── README.md
```

### 2. Deploy to GitHub Pages

```bash
# Create a new GitHub repository
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/attendance-pwa.git
git push -u origin main
```

Then in GitHub → Settings → Pages → Source: **Deploy from branch `main` / `/ (root)`**

Your app is live at: `https://YOUR_USERNAME.github.io/attendance-pwa/`

---

## 🔧 Google Sheets Backend Setup

### Step 1 – Create your Spreadsheet

1. Go to [Google Sheets](https://sheets.google.com) → **New Spreadsheet**
2. Copy the Spreadsheet ID from the URL:
   `https://docs.google.com/spreadsheets/d/**SPREADSHEET_ID**/edit`

### Step 2 – Set up Apps Script

1. In your spreadsheet: **Extensions → Apps Script**
2. Delete the existing code
3. Paste the contents of `google-apps-script/Code.gs`
4. Replace `const SPREADSHEET_ID = '';` with your actual Spreadsheet ID:
   ```js
   const SPREADSHEET_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms';
   ```
5. Click **Run → `setup`** (first-time setup, creates sheets and sample data)
6. Grant permissions when prompted

### Step 3 – Deploy as Web App

1. Click **Deploy → New Deployment**
2. Type: **Web App**
3. Execute as: **Me**
4. Who has access: **Anyone** *(required for the PWA to call it)*
5. Click **Deploy** → Copy the Web App URL

It looks like:
```
https://script.google.com/macros/s/AKfycbxxxxxxxxxxxxxxx/exec
```

### Step 4 – Configure the PWA

1. Open ClassTrack → tap **Settings** (gear icon)
2. Paste your Apps Script URL into **"Apps Script URL"**
3. Enter your name as **Instructor Name**
4. Add your class names (comma-separated)
5. Tap **Save Settings**
6. Tap **🔄 Sync** on the dashboard to pull your student roster

---

## 📱 Installing the PWA

### Android (Chrome)
- Open the app URL in Chrome
- Tap the **"Install"** button in the top bar, OR
- Tap ⋮ menu → **"Add to Home Screen"**

### iPhone / iPad (Safari)
- Open the app URL in Safari
- Tap **Share** icon → **"Add to Home Screen"**
- Tap **Add**

### Desktop (Chrome / Edge)
- Click the install icon in the address bar, OR
- Tap the **"Install"** button in the top bar

---

## 📋 Student Roster Format (Google Sheets)

Your "Students" sheet should have these column headers in row 1:

| Column      | Description                     |
|-------------|--------------------------------|
| id          | Unique internal ID (e.g. s001) |
| studentId   | Display student ID (STU001)    |
| name        | Full name                      |
| gender      | Male / Female / Other          |
| phone       | Phone number                   |
| email       | Email address                  |
| program     | Class / Program name           |
| workplace   | Current employer               |
| notes       | General notes                  |
| observations| Instructor observations        |
| followup    | Follow-up reminders            |

> The `setup()` function creates this sheet automatically with sample data.

---

## 🗄️ Data Architecture

### Local (IndexedDB)
| Store      | Purpose                          |
|------------|----------------------------------|
| students   | Cached student roster            |
| attendance | All attendance records           |
| pending    | Unsynced changes queue           |
| settings   | App configuration                |

### Google Sheets
| Sheet      | Purpose                          |
|------------|----------------------------------|
| Students   | Source of truth for roster       |
| Attendance | All attendance records           |

### Sync Strategy
1. **Roster sync**: Pull from Sheets → overwrite local cache
2. **Attendance save**: Always write locally → attempt Sheets → queue if offline
3. **Auto-sync**: On reconnect, flush pending queue to Sheets
4. **Conflict resolution**: Last-write wins (by timestamp)

---

## 📱 Features

| Feature              | Online | Offline |
|----------------------|--------|---------|
| View student roster  | ✅      | ✅ (cached) |
| Take attendance      | ✅      | ✅ (stored locally) |
| Student profiles     | ✅      | ✅ |
| Edit notes           | ✅      | ✅ (queued) |
| View reports         | ✅      | ✅ |
| Sync to Google Sheets| ✅      | ❌ (queued) |
| Export CSV           | ✅      | ✅ |

---

## 🔌 GAS API Reference

Your Apps Script handles these `action` values:

| Action           | Method | Payload                                  | Returns              |
|------------------|--------|------------------------------------------|----------------------|
| `getStudents`    | GET    | —                                        | `{ students: [...] }` |
| `saveAttendance` | POST   | `{ date, classId, instructor, records }` | `{ ok, saved }`      |
| `updateStudent`  | POST   | `{ id, notes, observations, followup }`  | `{ ok }`             |
| `getAttendance`  | POST   | `{ date?, studentId? }`                  | `{ records: [...] }` |
| `ping`           | GET    | —                                        | `{ ok, ts }`         |

---

## 🛠️ Local Development

No build tools required. Just open `index.html` in a browser:

```bash
# Option 1: Python server (recommended for Service Worker)
python3 -m http.server 8080
# → http://localhost:8080

# Option 2: Node.js
npx serve .
# → http://localhost:3000
```

> **Note**: Service Workers require HTTPS or localhost. GitHub Pages serves over HTTPS automatically.

---

## 📁 File Reference

| File                         | Purpose                          |
|------------------------------|----------------------------------|
| `index.html`                 | App shell, all screens           |
| `styles.css`                 | Design system, all UI styles     |
| `app.js`                     | App logic, IndexedDB, sync       |
| `service-worker.js`          | Offline caching, background sync |
| `manifest.json`              | PWA metadata, installability     |
| `icons/`                     | App icons (72px → 512px)         |
| `google-apps-script/Code.gs` | Backend API (paste into GAS)     |

---

## 🎨 Customization

### Colors
Edit CSS variables at the top of `styles.css`:
```css
:root {
  --accent:  #6c63ff;  /* primary purple */
  --accent-2: #00e5c3; /* teal accent */
  --present: #00e5a0;  /* green */
  --late:    #ffd166;  /* yellow */
  --absent:  #ff6b6b;  /* red */
  --excused: #7eb8f7;  /* blue */
}
```

### App Name
Edit `manifest.json` → `name` / `short_name`, and the `<title>` in `index.html`.

---

## 🐛 Troubleshooting

**"No GAS URL configured"**
→ Go to Settings and paste your deployed Apps Script URL.

**Roster not loading**
→ Make sure your GAS deployment has access set to "Anyone". Re-deploy if needed.

**App not installing**
→ Must be served over HTTPS (GitHub Pages works). Service Worker must register successfully.

**Offline sync not working**
→ Check browser DevTools → Application → Service Workers. Ensure SW is activated.

**CORS errors in console**
→ This is expected for GAS — the app uses `no-cors` mode for the initial call. Make sure your GAS script returns proper JSON.

---

## 📄 License

MIT License — free to use, modify, and distribute.

---

*Built with ❤️ — HTML + CSS + Vanilla JS + Google Apps Script*
