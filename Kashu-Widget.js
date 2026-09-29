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
// script. Shows only Available Balance for the current pay-cycle month.
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
// profile. A negative amount = income. (There is no "+" add widget —
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

  const d2 = await fetchMaskedFields(CONFIG.projectId, docId, idToken, [
    `state.profiles.${profileId}.incomeCycles`,
    `state.profiles.${profileId}.currency`
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
  return { expense, currencyCode };
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
  if (!configIsFilledIn()) return 'Error: fill in CONFIG (email/password) at the top of the Kashu script first.';
  if (!amount || Number.isNaN(amount)) return 'Error: amount must be a nonzero number.';
  if (!category) return 'Error: category is required.';
  try {
    const { currencyCode } = await addExpenseToCloud({
      amount, category,
      subcategory: String(p.subcategory ?? '').trim(),
      description: String(p.description ?? '').trim(),
      method: String(p.method ?? '').trim(),
      date: String(p.date ?? '').trim(),
      idPrefix: 'e_shortcut_'
    });
    return `${amount < 0 ? 'Income added' : 'Added'}: ${fmtCur(amount, currencyCode)} → ${category}`;
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
  const totalExpenses = exps.reduce((s, e) => s + Number(e.value || 0), 0);
  const totalSalary = Number((profile.income || {})[m] || 0);
  const remaining = totalSalary - totalExpenses;
  const doneActual = buds.filter(b => b.status === 'Done').reduce((s, b) => s + actualForBudgetLine(allExps, b), 0);
  const notPaidPlanned = buds.filter(b => b.status === 'Not Paid Yet').reduce((s, b) => s + effectivePlanned(allExps, b), 0);
  const allActual = buds.reduce((s, b) => s + actualForBudgetLine(allExps, b), 0);
  const availableBalance = remaining - (doneActual + notPaidPlanned - allActual);
  return { availableBalance };
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

// ---- Widget building ------------------------------------------------------
async function buildWidget() {
  const widget = new ListWidget();
  widget.backgroundColor = Color.dynamic(new Color('#F4F5F9'), new Color('#1B1C22'));
  widget.setPadding(16, 16, 16, 16);
  const family = config.widgetFamily || 'small';

  try {
    if (!configIsFilledIn()) {
      throw new Error('Fill in CONFIG (email/password) at the top of the script first.');
    }
    const data = await fetchSyncedState(CONFIG.projectId, CONFIG.apiKey, CONFIG.email, CONFIG.password);
    const budgetP = pickBudgetProfile(data.state, CONFIG.budgetProfileName);
    if (!budgetP) throw new Error('No budget profile found for this account.');

    // Pay-cycle month for today (e.g. 30 Sep → October when October's cycle starts on the 30th).
    const m = monthForDateOffline(isoDateToday(), budgetP.incomeCycles);
    const value = monthSummary(budgetP, m).availableBalance;
    const currencyCode = budgetP.currency || 'EGP';

    const col = widget.addStack();
    col.layoutVertically();
    col.addSpacer();
    const label = col.addText('Available Balance');
    label.font = Font.mediumSystemFont(family === 'small' ? 12 : 14);
    label.textColor = Color.dynamic(new Color('#6b6f7d'), new Color('#9a9dab'));
    col.addSpacer(6);
    const val = col.addText(fmtCur(value, currencyCode));
    val.font = Font.boldSystemFont(family === 'small' ? 22 : 34);
    val.textColor = value >= 0 ? new Color('#e0a33c') : new Color('#e0524f');
    val.minimumScaleFactor = 0.5;
    col.addSpacer(4);
    const sub = col.addText(monthLabel(m));
    sub.font = Font.regularSystemFont(family === 'small' ? 10 : 12);
    sub.textColor = Color.dynamic(new Color('#9a9dab'), new Color('#6b6f7d'));
    col.addSpacer();

    widget.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  } catch (err) {
    const title = widget.addText('Kashu');
    title.font = Font.mediumSystemFont(13);
    title.textColor = Color.dynamic(new Color('#6b6f7d'), new Color('#9a9dab'));
    widget.addSpacer(6);
    const errText = widget.addText('⚠️ ' + err.message);
    errText.font = Font.regularSystemFont(12);
    errText.textColor = new Color('#e0524f');
    widget.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
  }

  return widget;
}

async function main() {
  if (config.runsWithSiri || args.shortcutParameter !== undefined && args.shortcutParameter !== null) {
    const msg = await runFromShortcut(args.shortcutParameter);
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
