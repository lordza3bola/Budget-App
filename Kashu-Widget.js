// ============================================================
// Kashu — Available Balance widget + Shortcuts quick-add
// ============================================================
// SETUP (one-time):
// 1. Install the free "Scriptable" app from the App Store.
// 2. Open Scriptable, tap "+", paste this ENTIRE file in, rename the
//    script (tap its name at the top) to e.g. "Kashu Widget".
// 3. Fill in CONFIG right below this comment:
//      - apiKey / projectId: from the same firebaseConfig shown in the
//        app's Settings -> Cloud Sync (defaults to the app's own
//        built-in project — leave as-is unless you changed it there).
//      - email / password: the SAME Kashu account you signed into on
//        your phone/desktop (Settings -> Cloud Sync -> Sign in).
//
// BALANCE WIDGET:
// Long-press your Home Screen -> "+" -> search "Scriptable" -> add a
// widget in whichever size you like -> Edit Widget -> Script: this
// script. Design "Linen balance" in the app's Sage & Linen colours (follows
// light/dark mode). Small: Available balance, days left in the pay cycle and
// safe to spend per day. Medium: adds a Spent vs income bar and the next
// bill due.
//
// SHORTCUTS (add an expense from an iPhone Shortcut — no browser opens):
// In your Shortcut, replace the Text + "Open URLs" steps with:
//   1. Dictionary  → amount: [Value from Ask for Number]
//                    category: [Selected Item from Choose from List]
//                    (optional keys: subcategory, description, method, date YYYY-MM-DD)
//   2. Scriptable → "Run Script": Script = this script, Parameter = Dictionary,
//      and switch "Run In App" OFF so it runs in the background.
//   3. Show Notification → the Run Script output ("Added 50 E£ → Food").
// Writes straight to your synced Firestore data under the app's active
// profile. A negative amount = income.
//   To fill a "Choose from List" with your categories, run this script with
//   the text "categories": it returns a Dictionary with "categories" (list)
//   and "subs" (each category's sub categories). (There is no "+" add widget —
// adding happens only through the Shortcut.)
//
// SECURITY NOTE: your password is only ever sent straight to Google's own
// Firebase Auth endpoint (identitytoolkit.googleapis.com) to get a fresh
// sign-in token each time the widget runs — the same thing the app itself
// does. It's stored in this script only because Scriptable has no secure
// prompt to type it in each run; it never leaves your phone except in
// that one HTTPS call to Google.
// ============================================================

const CONFIG = {
  apiKey: "AIzaSyDDQwBEbppNEUY1DJlyJQxMv8pY8CQ1cNE",
  projectId: "budget-app-d5876",
  email: "PASTE_YOUR_KASHU_EMAIL_HERE",
  password: "PASTE_YOUR_KASHU_PASSWORD_HERE",

  // Optional — only needed if you have more than one regular budget
  // profile and want a specific one. Leave "" to auto-pick the first one.
  budgetProfileName: ""
};

// ---- Firebase Auth (email/password) ---------------------------------------
// Mirrors what the app itself does on Log In: exchanges email+password for
// a short-lived idToken, and returns the account's uid — that uid is the
// Firestore document ID (/users/{uid}) the app writes everything to, and
// is exactly what the security rule (request.auth.uid == userId) checks.
async function signInWithPassword(apiKey, email, password) {
  const req = new Request(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`);
  req.method = 'POST';
  req.headers = { 'Content-Type': 'application/json' };
  req.body = JSON.stringify({ email, password, returnSecureToken: true });
  const res = await req.loadJSON();
  if (res.error) {
    const code = (res.error.message || '').split(' ')[0];
    const map = {
      'EMAIL_NOT_FOUND': 'No Kashu account with that email — sign up in the app first.',
      'INVALID_PASSWORD': 'Wrong password.',
      'INVALID_LOGIN_CREDENTIALS': 'Email or password is incorrect.',
      'USER_DISABLED': 'This account has been disabled.'
    };
    throw new Error(map[code] || res.error.message || 'Sign-in failed — check your email/password in CONFIG.');
  }
  return { idToken: res.idToken, uid: res.localId };
}
function decodeFirestoreValue(v) {
  if (v === undefined || v === null) return null;
  if (v.mapValue) {
    const out = {};
    const fields = v.mapValue.fields || {};
    for (const k in fields) out[k] = decodeFirestoreValue(fields[k]);
    return out;
  }
  if (v.arrayValue) return (v.arrayValue.values || []).map(decodeFirestoreValue);
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.nullValue !== undefined) return null;
  return null;
}
// ---- Firestore write helpers (Shortcuts quick-add only) ------------------
// The reverse of decodeFirestoreValue: turns a plain JS value into
// Firestore's typed REST format so it can be sent back up.
function encodeFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeFirestoreValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const k in v) fields[k] = encodeFirestoreValue(v[k]);
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}
// A lightweight read of just the given field paths (e.g. just
// state.activeProfileId) instead of the whole document — keeps this fast
// and avoids ever touching the (potentially large) expenses arrays.
// docId here is the signed-in account's uid — data lives at /users/{uid},
// same as the app itself writes it.
async function fetchMaskedFields(projectId, docId, idToken, fieldPaths) {
  const qs = fieldPaths.map(fp => 'mask.fieldPaths=' + encodeURIComponent(fp)).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${docId}?${qs}`;
  const req = new Request(url);
  req.headers = { 'Authorization': `Bearer ${idToken}` };
  const res = await req.loadJSON();
  if (res.error) throw new Error(res.error.message || 'Firestore request failed.');
  const decoded = {};
  for (const k in (res.fields || {})) decoded[k] = decodeFirestoreValue(res.fields[k]);
  return decoded;
}
// Appends the expense to the profile's `expenses` array server-side via a
// Firestore field transform (the same primitive behind arrayUnion) rather
// than reading the whole document, editing it locally, and writing it all
// back. That matters here: the app pushes its ENTIRE state with a plain
// .set() on every change, so a read-modify-write from the widget could
// lose a change made on the phone in between. A transform instead applies
// atomically to just this one array, regardless of what else is happening
// to the rest of the document at the same time.
async function commitAddExpense(projectId, docId, idToken, profileId, expense) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`;
  const body = {
    writes: [{
      transform: {
        document: `projects/${projectId}/databases/(default)/documents/users/${docId}`,
        fieldTransforms: [
          {
            fieldPath: `state.profiles.\`${profileId}\`.expenses`,
            appendMissingElements: { values: [encodeFirestoreValue(expense)] }
          },
          { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }
        ]
      }
    }]
  };
  const req = new Request(url);
  req.method = 'POST';
  req.headers = { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' };
  req.body = JSON.stringify(body);
  const res = await req.loadJSON();
  if (res.error) throw new Error(res.error.message || 'Firestore write failed.');
  return res;
}
// Mirrors the app's monthForDate(): a date falls into whichever pay-cycle
// window (if any) is recorded for the profile; otherwise it's bucketed by
// plain calendar month.
function monthForDateOffline(dateStr, incomeCycles) {
  for (const m in (incomeCycles || {})) {
    const c = incomeCycles[m];
    if (c && c.start && c.end && dateStr >= c.start && dateStr <= c.end) return m;
  }
  return dateStr.slice(0, 7);
}
function isoDateToday() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function parseQueryString(qs) {
  const out = {};
  (qs || '').split('&').filter(Boolean).forEach(pair => {
    const [k, v] = pair.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent((v || '').replace(/\+/g, '%20'));
  });
  return out;
}
function configIsFilledIn() {
  return CONFIG.apiKey && !CONFIG.apiKey.startsWith('PASTE_') &&
    CONFIG.projectId && !CONFIG.projectId.startsWith('PASTE_') &&
    CONFIG.email && !CONFIG.email.startsWith('PASTE_') &&
    CONFIG.password && !CONFIG.password.startsWith('PASTE_');
}
// Used by the Shortcuts entry point: signs in, finds the
// app's active profile, and appends one expense atomically to Firestore.
async function addExpenseToCloud({ amount, category, subcategory, description, method, date, idPrefix }) {
  const { idToken, uid } = await signInWithPassword(CONFIG.apiKey, CONFIG.email, CONFIG.password);
  const docId = uid;

  const d1 = await fetchMaskedFields(CONFIG.projectId, docId, idToken, ['state.activeProfileId']);
  const profileId = d1.state && d1.state.activeProfileId;
  if (!profileId) throw new Error('No synced profile found for this account yet — open the app once to sync first.');

  // Backtick-quoted so any profile id is a valid Firestore field path.
  const d2 = await fetchMaskedFields(CONFIG.projectId, docId, idToken, [
    `state.profiles.\`${profileId}\`.incomeCycles`,
    `state.profiles.\`${profileId}\`.currency`,
    `state.profiles.\`${profileId}\`.name`
  ]);
  const prof = (d2.state && d2.state.profiles && d2.state.profiles[profileId]) || {};
  const incomeCycles = prof.incomeCycles || {};
  const currencyCode = prof.currency || 'EGP';

  const day = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : isoDateToday();
  const expense = {
    id: (idPrefix || 'e_widget_') + Date.now(),
    month: monthForDateOffline(day, incomeCycles),
    date: day,
    category,
    subcategory: subcategory || category,
    method: method || '',
    description: description || '',
    value: amount
  };
  await commitAddExpense(CONFIG.projectId, docId, idToken, profileId, expense);
  return { expense, currencyCode, profileName: prof.name || '' };
}
// Shortcuts "categories" mode: Run Script with the text "categories" returns a
// Dictionary the Shortcut can pick from:
//   { categories: ["Housing", "Bills", …],
//     subs: { "Housing": ["Electricity", …], "Bills": [ … ], … } }
// Taken from the profile currently active in the app, in the app's own order.
// On a problem it still returns a Dictionary, with the message as the only
// "category", so the Shortcut shows it instead of failing.
async function categoriesForShortcut() {
  try {
    if (!configIsFilledIn()) throw new Error('Put your email and password into CONFIG in the Kashu script.');
    const { idToken, uid } = await signInWithPassword(CONFIG.apiKey, CONFIG.email, CONFIG.password);
    const d1 = await fetchMaskedFields(CONFIG.projectId, uid, idToken, ['state.activeProfileId']);
    const profileId = d1.state && d1.state.activeProfileId;
    if (!profileId) throw new Error('No synced profile yet — open the app once to sync.');
    const d2 = await fetchMaskedFields(CONFIG.projectId, uid, idToken, [`state.profiles.\`${profileId}\`.categories`]);
    const cats = (d2.state && d2.state.profiles && d2.state.profiles[profileId] && d2.state.profiles[profileId].categories) || {};
    const names = Object.keys(cats);
    if (!names.length) throw new Error('No categories found in the active profile.');
    const subs = {};
    names.forEach(c => { const list = Array.isArray(cats[c]) ? cats[c].filter(Boolean) : []; subs[c] = list.length ? list : [c]; });
    return { categories: names, subs };
  } catch (err) {
    const msg = '⚠️ ' + (err && err.message ? err.message : String(err));
    return { categories: [msg], subs: { [msg]: [msg] }, error: msg };
  }
}
// Shortcuts "Run Script" entry point. Accepts a Dictionary (preferred), JSON
// text, or "amount=50&category=Food" text. Returns a one-line result that the
// Shortcut can show as a notification.
async function runFromShortcut(param) {
  let p = param;
  if (typeof p === 'string') {
    const t = p.trim();
    try { p = JSON.parse(t); } catch (e) { p = parseQueryString(t.replace(/^.*\?/, '')); }
  }
  p = p || {};
  const amount = Number(String(p.amount ?? p.Amount ?? '').trim().replace(/\s/g, '').replace(',', '.'));
  const category = String(p.category ?? p.Category ?? '').trim();
  if (!configIsFilledIn()) return 'Error: open the Kashu script in Scriptable and put your email and password into CONFIG at the top (they are blank placeholders).';
  if (!amount || Number.isNaN(amount)) return 'Error: amount must be a nonzero number.';
  if (!category) return 'Error: category is required.';
  try {
    const { currencyCode, profileName } = await addExpenseToCloud({
      amount, category,
      subcategory: String(p.subcategory ?? '').trim(),
      description: String(p.description ?? '').trim(),
      method: String(p.method ?? '').trim(),
      date: String(p.date ?? '').trim(),
      idPrefix: 'e_shortcut_'
    });
    return `${amount < 0 ? 'Income added' : 'Added'}: ${fmtCur(amount, currencyCode)} → ${category}${profileName ? ' (' + profileName + ')' : ''}`;
  } catch (err) {
    return 'Error: ' + err.message;
  }
}
async function fetchSyncedState(projectId, apiKey, email, password) {
  const { idToken, uid } = await signInWithPassword(apiKey, email, password);
  const docId = uid;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${docId}`;
  const req = new Request(url);
  req.headers = { 'Authorization': `Bearer ${idToken}` };
  const res = await req.loadJSON();
  if (res.error) throw new Error(res.error.message || 'Firestore request failed.');
  if (!res.fields || !res.fields.state) throw new Error('No synced data found for this account yet.');
  const decoded = {};
  for (const k in res.fields) decoded[k] = decodeFirestoreValue(res.fields[k]);
  return decoded; // { state: {...}, updatedAt: "..." }
}

// ---- Budget math (mirrors the app's own calculations exactly) ------------
function actualForBudgetLine(expenses, line) {
  return expenses
    .filter(e => e.month === line.month && e.category === line.category && e.subcategory === line.subcategory)
    .reduce((s, e) => s + Number(e.value || 0), 0);
}
function effectivePlanned(expenses, line) {
  const planned = Number(line.plannedValue || 0);
  const actual = actualForBudgetLine(expenses, line);
  if (actual > planned) return actual;
  if (line.status === 'Done') return actual;
  return planned;
}
function monthSummary(profile, m) {
  const exps = (profile.expenses || []).filter(e => e.month === m);
  const buds = (profile.budget || []).filter(b => b.month === m);
  const allExps = profile.expenses || [];
  // Same rule as the app: negative expense rows are additional income,
  // and "spent" counts only real spending.
  const spent = exps.reduce((s, e) => s + Math.max(0, Number(e.value || 0)), 0);
  const extraIncome = exps.reduce((s, e) => s + Math.max(0, -Number(e.value || 0)), 0);
  const salary = Number((profile.income || {})[m] || 0);
  const totalIncome = salary + extraIncome;
  const remaining = totalIncome - spent;
  const doneActual = buds.filter(b => b.status === 'Done').reduce((s, b) => s + actualForBudgetLine(allExps, b), 0);
  const notPaidPlanned = buds.filter(b => b.status === 'Not Paid Yet').reduce((s, b) => s + effectivePlanned(allExps, b), 0);
  const allActual = buds.reduce((s, b) => s + actualForBudgetLine(allExps, b), 0);
  const availableBalance = remaining - (doneActual + notPaidPlanned - allActual);
  return { availableBalance, spent, totalIncome };
}
function pickBudgetProfile(state, nameOverride) {
  const profiles = Object.values(state.profiles || {});
  if (nameOverride) {
    const m = profiles.find(p => p.name === nameOverride);
    if (m) return m;
  }
  return profiles.find(p => p.cardType !== 'mastercard' && p.cardType !== 'savings') || null;
}
function currentMonthKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function monthLabel(m) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
function fmt(n) {
  n = Math.round((n || 0) * 100) / 100;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Mirrors the app's per-profile currency symbol (display-only, no
// conversion) — CURRENCIES here matches the CURRENCIES map in the app.
const CURRENCIES = {
  EGP: { symbol: 'E£', position: 'suffix' },
  USD: { symbol: '$', position: 'prefix' },
  EUR: { symbol: '€', position: 'prefix' },
  GBP: { symbol: '£', position: 'prefix' },
  SAR: { symbol: 'SR', position: 'suffix' },
  AED: { symbol: 'AED', position: 'suffix' },
  KWD: { symbol: 'KD', position: 'suffix' },
  JPY: { symbol: '¥', position: 'prefix' }
};
function fmtCur(n, currencyCode) {
  const cur = CURRENCIES[currencyCode] || CURRENCIES.EGP;
  const s = fmt(n);
  return cur.position === 'prefix' ? (cur.symbol + s) : (s + ' ' + cur.symbol);
}

// ---- Widget building (design A — "Linen balance") ------------------------
// Sage & Linen colours, matching the app. Each colour has a dark-mode twin.
const COL = {
  bg:   Color.dynamic(new Color('#f0ebe1'), new Color('#1f2622')),
  txt:  Color.dynamic(new Color('#2f3a33'), new Color('#eee8dc')),
  dim:  Color.dynamic(new Color('#6b7468'), new Color('#aaa697')),
  dim2: Color.dynamic(new Color('#8f968a'), new Color('#868476')),
  line: Color.dynamic(new Color('#e0d8c9'), new Color('#2f3832')),
  ok:   Color.dynamic(new Color('#4f7d5c'), new Color('#9ccc9a')),
  bad:  Color.dynamic(new Color('#c0604b'), new Color('#ec9179'))
};
function isoAddDays(iso, n) {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000); }
// The pay cycle today falls in (Settings → Income → From/To), else the calendar month.
function cycleInfo(profile) {
  const today = isoDateToday();
  const m = monthForDateOffline(today, profile.incomeCycles);
  const c = (profile.incomeCycles || {})[m];
  let end;
  if (c && c.start && c.end) end = c.end;
  else { const d = new Date(); const last = new Date(d.getFullYear(), d.getMonth() + 1, 0); end = isoAddDays(today, last.getDate() - d.getDate()); }
  const daysLeft = Math.max(1, daysBetween(today, end) + 1);
  return { m, daysLeft };
}
// The next budget line not yet closed whose date is today or later.
function nextBill(profile) {
  const today = isoDateToday();
  const due = (profile.budget || [])
    .filter(b => b.status !== 'Done' && b.startDate && b.startDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
  if (!due) return null;
  const n = daysBetween(today, due.startDate);
  return { name: due.description || due.subcategory || due.category, amount: Number(due.plannedValue || 0), when: n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' d' };
}
// The Kashu logo, drawn (Scriptable can't load the app's PNG without a network fetch).
function logoImage() {
  const k = 64 / 512, ctx = new DrawContext();
  ctx.size = new Size(64, 64); ctx.opaque = false; ctx.respectScreenScale = true;
  const bg = new Path(); bg.addRoundedRect(new Rect(0, 0, 64, 64), 14, 14);
  ctx.addPath(bg); ctx.setFillColor(new Color('#7f9e85')); ctx.fillPath();
  const piece = (pts, hex) => {
    const pth = new Path(); pth.addLines(pts.map(([x, y]) => new Point(x * k, y * k))); pth.closeSubpath();
    ctx.addPath(pth); ctx.setFillColor(new Color(hex)); ctx.fillPath();
  };
  piece([[226,133],[233,183],[206,222],[188,360],[180,300],[180,152]], '#f0ebe1');
  piece([[246,150],[352,190],[262,268],[233,183]], '#e1d7c3');
  piece([[262,270],[369,317],[289,305],[235,336]], '#b9ac96');
  return ctx.getImage();
}
// A thin rounded progress bar as an image.
function barImage(width, frac) {
  const ctx = new DrawContext(); ctx.size = new Size(width, 6); ctx.opaque = false; ctx.respectScreenScale = true;
  const track = new Path(); track.addRoundedRect(new Rect(0, 0, width, 6), 3, 3);
  ctx.addPath(track); ctx.setFillColor(new Color(Device.isUsingDarkAppearance() ? '#2f3832' : '#e3dbcc')); ctx.fillPath();
  const f = Math.max(0, Math.min(1, frac));
  if (f > 0) {
    const fill = new Path(); fill.addRoundedRect(new Rect(0, 0, Math.max(6, width * f), 6), 3, 3);
    ctx.addPath(fill); ctx.setFillColor(new Color(frac > 1 ? '#c0604b' : '#5f7d68')); ctx.fillPath();
  }
  return ctx.getImage();
}
function addText(stack, str, font, color, opts) {
  const t = stack.addText(str); t.font = font; t.textColor = color; t.lineLimit = 1;
  if (opts && opts.scale) t.minimumScaleFactor = opts.scale;
  return t;
}
// "18,240.50" in big type with the currency symbol small beside it.
function addAmount(stack, value, code, size) {
  const cur = CURRENCIES[code] || CURRENCIES.EGP;
  const row = stack.addStack(); row.bottomAlignContent();
  const color = value >= 0 ? COL.ok : COL.bad;
  const small = Font.boldRoundedSystemFont(Math.round(size * 0.48));
  if (cur.position === 'prefix') addText(row, cur.symbol, small, COL.dim);
  addText(row, fmt(value), Font.boldRoundedSystemFont(size), color, { scale: 0.5 });
  if (cur.position !== 'prefix') { row.addSpacer(3); addText(row, cur.symbol, small, COL.dim); }
}
function shortNum(n) { return Math.round(n).toLocaleString('en-US'); }
// The left half of the medium widget, and the whole of the small one.
function addBalanceColumn(col, d, small) {
  const top = col.addStack(); top.centerAlignContent();
  const logo = top.addImage(d.logo); logo.imageSize = new Size(20, 20); logo.cornerRadius = 5;
  top.addSpacer(6);
  addText(top, small ? 'Kashu' : 'Kashu · ' + d.monthName, Font.semiboldRoundedSystemFont(11), COL.dim);
  if (small) { top.addSpacer(); addText(top, d.monthName.slice(0, 3), Font.semiboldRoundedSystemFont(10), COL.dim2); }
  // Three blocks spread over the full height: header on top, the balance in
  // the middle, the days-left line at the bottom — no empty band in between.
  col.addSpacer();
  addText(col, 'Available', Font.semiboldRoundedSystemFont(small ? 12 : 11.5), COL.dim);
  addAmount(col, d.available, d.code, small ? 30 : 27);
  if (small) {
    // Spent vs income under the balance (the medium size shows this on its right side).
    col.addSpacer(8);
    const sr = col.addStack(); sr.bottomAlignContent();
    addText(sr, 'Spent', Font.semiboldRoundedSystemFont(10), COL.dim);
    sr.addSpacer();
    addText(sr, shortNum(d.spent) + ' / ' + shortNum(d.income), Font.semiboldRoundedSystemFont(10), COL.dim, { scale: 0.7 });
    col.addSpacer(4);
    const bar = col.addImage(barImage(120, d.income > 0 ? d.spent / d.income : 0));
    bar.imageSize = new Size(120, 6);
  }
  col.addSpacer();
  const line = col.addStack(); line.bottomAlignContent();
  const f = Font.semiboldRoundedSystemFont(10.5);
  addText(line, d.daysLeft + (d.daysLeft === 1 ? ' day left' : ' days left'), f, COL.dim, { scale: 0.7 });
  if (small) {
    addText(line, ' · ', f, COL.dim);
    addText(line, fmt(d.perDay), Font.boldRoundedSystemFont(10.5), d.perDay >= 0 ? COL.txt : COL.bad, { scale: 0.7 });
    addText(line, '/day', f, COL.dim);
  }
}
function addDetailsColumn(col, d) {
  addText(col, 'Safe to spend / day', Font.semiboldRoundedSystemFont(10.5), COL.dim);
  addText(col, fmtCur(d.perDay, d.code), Font.boldRoundedSystemFont(18), d.perDay >= 0 ? COL.txt : COL.bad, { scale: 0.6 });
  col.addSpacer();
  const row = col.addStack();
  addText(row, 'Spent', Font.semiboldRoundedSystemFont(10.5), COL.dim);
  row.addSpacer();
  addText(row, shortNum(d.spent) + ' / ' + shortNum(d.income), Font.semiboldRoundedSystemFont(10.5), COL.dim, { scale: 0.7 });
  col.addSpacer(4);
  const bar = col.addImage(barImage(150, d.income > 0 ? d.spent / d.income : 0));
  bar.imageSize = new Size(150, 6);
  col.addSpacer();
  const nx = col.addStack();
  const f = Font.semiboldRoundedSystemFont(10.5);
  if (d.next) {
    addText(nx, 'Next · ', f, COL.dim);
    addText(nx, d.next.name + ' ' + shortNum(d.next.amount), Font.boldRoundedSystemFont(10.5), COL.txt, { scale: 0.6 });
    addText(nx, ' · ' + d.next.when, f, COL.dim);
  } else {
    addText(nx, 'No bills due this cycle', f, COL.dim);
  }
}
async function buildWidget() {
  const widget = new ListWidget();
  widget.backgroundColor = COL.bg;
  const family = config.widgetFamily || 'small';
  const small = family === 'small';
  widget.setPadding(15, 16, 15, 16);

  try {
    if (!configIsFilledIn()) throw new Error('Fill in CONFIG (email/password) at the top of the script first.');
    const data = await fetchSyncedState(CONFIG.projectId, CONFIG.apiKey, CONFIG.email, CONFIG.password);
    const budgetP = pickBudgetProfile(data.state, CONFIG.budgetProfileName);
    if (!budgetP) throw new Error('No budget profile found for this account.');

    const { m, daysLeft } = cycleInfo(budgetP);
    const sum = monthSummary(budgetP, m);
    const d = {
      logo: logoImage(),
      monthName: monthLabel(m).split(' ')[0],
      available: sum.availableBalance,
      perDay: sum.availableBalance / daysLeft,
      daysLeft,
      spent: sum.spent,
      income: sum.totalIncome,
      next: nextBill(budgetP),
      code: budgetP.currency || 'EGP'
    };

    if (small) {
      const col = widget.addStack(); col.layoutVertically();
      addBalanceColumn(col, d, true);
    } else {
      const row = widget.addStack(); row.layoutHorizontally();
      const left = row.addStack(); left.layoutVertically(); left.size = new Size(150, 0);
      addBalanceColumn(left, d, false);
      row.addSpacer(14);
      const divider = row.addStack(); divider.size = new Size(1, 0); divider.backgroundColor = COL.line;
      row.addSpacer(14);
      const right = row.addStack(); right.layoutVertically();
      addDetailsColumn(right, d);
      if (family === 'large') widget.addSpacer();
    }
    widget.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  } catch (err) {
    const top = widget.addStack(); top.centerAlignContent();
    const logo = top.addImage(logoImage()); logo.imageSize = new Size(20, 20); logo.cornerRadius = 5;
    top.addSpacer(6);
    addText(top, 'Kashu', Font.semiboldRoundedSystemFont(11), COL.dim);
    widget.addSpacer(8);
    const errText = widget.addText('⚠️ ' + err.message);
    errText.font = Font.regularSystemFont(12);
    errText.textColor = COL.bad;
    widget.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
  }
  return widget;
}

async function main() {
  if (config.runsWithSiri || (args.shortcutParameter !== undefined && args.shortcutParameter !== null)) {
    const sp = args.shortcutParameter;
    const mode = typeof sp === 'string' ? sp.trim().toLowerCase() : (sp && typeof sp === 'object' && sp.mode ? String(sp.mode).toLowerCase() : '');
    if (mode === 'categories') {
      Script.setShortcutOutput(await categoriesForShortcut());
      Script.complete();
      return;
    }
    let msg;
    try { msg = await runFromShortcut(args.shortcutParameter); }
    catch (err) { msg = 'Error: ' + (err && err.message ? err.message : String(err)); }
    Script.setShortcutOutput(msg);
    Script.complete();
    return;
  }

  const widget = await buildWidget();
  if (config.runsInWidget) {
    Script.setWidget(widget);
    Script.complete();
  } else {
    const family = config.widgetFamily || 'small';
    if (family === 'medium') await widget.presentMedium();
    else if (family === 'large') await widget.presentLarge();
    else await widget.presentSmall();
    Script.complete();
  }
}
await main();
