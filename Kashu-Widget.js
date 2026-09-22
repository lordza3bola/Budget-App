// ============================================================
// Kashu — Home Screen widgets (Available Balance + Add Expense)
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
// ADD EXPENSE WIDGET (quick-add without opening the app):
// This same script also powers a separate "+" tile that logs an expense
// straight to Firestore — no browser/app ever opens.
// 1. Long-press the Home Screen -> "+" -> Scriptable -> add a SMALL
//    widget (a second, separate one from your balance widget).
// 2. Long-press it -> Edit Widget:
//      - Script: this same script
//      - Parameter: add
//      - When Interacting: Run Script   <- important, this is what lets
//        it pop up a prompt instead of just opening Scriptable
// 3. Tap the tile any time: it opens a small Kashu-styled form (Amount /
//    Category / Subcategory / Description), then writes the expense
//    directly to your synced Firestore doc under whichever profile is
//    currently active in the app (same profile the app's own quick-add
//    Shortcut/URL route would use). Enter a negative amount to log
//    income, same as the app's own convention. Pay-cycle month bucketing
//    is computed the same way the app does it.
//    Note: tapping it still briefly switches to the Scriptable app before
//    the form appears — that hop is an iOS platform requirement for
//    running any code from a widget tap, not something this script (or
//    any app's widget) can skip.
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
// ---- Firestore write helpers (Add Expense widget only) -------------------
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
async function presentSimpleAlert(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction('OK');
  await a.presentAlert();
}
function parseQueryString(qs) {
  const out = {};
  (qs || '').split('&').filter(Boolean).forEach(pair => {
    const [k, v] = pair.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent((v || '').replace(/\+/g, '%20'));
  });
  return out;
}
// Matches the app's own palette/neumorphism (see manifest.json theme_color
// and the app's --card/--shadow-* variables) so this doesn't look like a
// generic system dialog dropped on top of Kashu.
const KASHU_STYLE = `
  :root { --sage:#6e8c78; --sage-dark:#4f6a58; --cream:#f0ebe1; --card:#f5f1e9;
          --shadow-l:#ffffff; --shadow-d:#d7d0bf; --txt:#3a3a34; --txt-dim:#8a8578; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;
         background:var(--cream); color:var(--txt);
         padding:calc(env(safe-area-inset-top) + 28px) 20px calc(env(safe-area-inset-bottom) + 24px); }
`;
function buildAddExpenseFormHtml() {
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${KASHU_STYLE}
  h1 { font-size:22px; font-weight:800; margin:0 0 4px; color:var(--sage-dark); }
  p.sub { font-size:13px; color:var(--txt-dim); margin:0 0 26px; line-height:1.4; }
  .field { margin-bottom:16px; }
  label { display:block; font-size:11.5px; font-weight:700; color:var(--txt-dim); margin-bottom:6px;
          text-transform:uppercase; letter-spacing:.04em; }
  input { width:100%; border:none; border-radius:14px; padding:14px 16px; font-size:16px; background:var(--card);
          box-shadow: inset 3px 3px 6px var(--shadow-d), inset -3px -3px 6px var(--shadow-l); color:var(--txt); }
  input:focus { outline:2px solid var(--sage); }
  .hint { font-size:11px; color:var(--txt-dim); margin-top:6px; }
  #err { color:#c0524f; font-size:12.5px; min-height:16px; margin:-10px 0 14px; }
  .btns { display:flex; gap:12px; margin-top:12px; }
  button { flex:1; border:none; border-radius:14px; padding:15px; font-size:16px; font-weight:700; }
  .btn-add { background:var(--sage); color:#fff; box-shadow: 3px 3px 8px var(--shadow-d); }
  .btn-cancel { background:var(--card); color:var(--txt-dim);
                box-shadow: 3px 3px 8px var(--shadow-d), -3px -3px 8px var(--shadow-l); }
</style></head><body>
  <h1>Add Expense</h1>
  <p class="sub">Logs to the profile currently active in Kashu.</p>
  <div id="err"></div>
  <div class="field"><label>Amount</label>
    <input id="amount" type="number" inputmode="decimal" step="0.01" placeholder="0.00" autofocus>
    <div class="hint">Negative amount = income</div>
  </div>
  <div class="field"><label>Category</label><input id="category" type="text" placeholder="e.g. Food"></div>
  <div class="field"><label>Subcategory (optional)</label><input id="subcategory" type="text" placeholder="e.g. Restaurant"></div>
  <div class="field"><label>Description (optional)</label><input id="description" type="text" placeholder="e.g. lunch with team"></div>
  <div class="btns">
    <button class="btn-cancel" onclick="location.href='kashu://cancel'">Cancel</button>
    <button class="btn-add" onclick="submitForm()">Add</button>
  </div>
<script>
function submitForm() {
  const amount = document.getElementById('amount').value.trim();
  const category = document.getElementById('category').value.trim();
  const subcategory = document.getElementById('subcategory').value.trim();
  const description = document.getElementById('description').value.trim();
  const err = document.getElementById('err');
  const n = Number(amount);
  if (!amount || isNaN(n) || n === 0) { err.textContent = 'Enter a nonzero amount.'; return; }
  if (!category) { err.textContent = 'Category is required.'; return; }
  const qs = ['amount=' + encodeURIComponent(amount), 'category=' + encodeURIComponent(category),
              'subcategory=' + encodeURIComponent(subcategory), 'description=' + encodeURIComponent(description)].join('&');
  location.href = 'kashu://submit?' + qs;
}
</script>
</body></html>`;
}
function buildResultHtml(success, title, message) {
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${KASHU_STYLE}
  body { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; text-align:center; }
  .icon { font-size:46px; margin-bottom:10px; }
  h1 { font-size:19px; margin:0 0 6px; color:${success ? 'var(--sage-dark)' : '#c0524f'}; }
  p { font-size:13.5px; color:var(--txt-dim); margin:0; max-width:280px; }
</style></head><body>
  <div class="icon">${success ? '✓' : '⚠️'}</div>
  <h1>${title}</h1>
  <p>${message}</p>
</body></html>`;
}
// Presents the branded form and resolves once the user submits, cancels,
// or dismisses it manually. Returns the still-open WebView (so the caller
// can swap its content to a result screen) alongside the submitted fields
// (null if cancelled/dismissed without submitting).
function presentAddExpenseForm() {
  const wv = new WebView();
  return new Promise((resolve) => {
    wv.shouldAllowRequest = (request) => {
      if (request.url.startsWith('kashu://submit')) {
        resolve({ wv, fields: parseQueryString(request.url.split('?')[1] || '') });
        return false;
      }
      if (request.url.startsWith('kashu://cancel')) {
        resolve({ wv, fields: null });
        return false;
      }
      return true;
    };
    wv.loadHTML(buildAddExpenseFormHtml())
      .then(() => wv.present(true))
      .then(() => resolve({ wv, fields: null })); // dismissed without submit/cancel button
  });
}
function configIsFilledIn() {
  return CONFIG.apiKey && !CONFIG.apiKey.startsWith('PASTE_') &&
    CONFIG.projectId && !CONFIG.projectId.startsWith('PASTE_') &&
    CONFIG.email && !CONFIG.email.startsWith('PASTE_') &&
    CONFIG.password && !CONFIG.password.startsWith('PASTE_');
}
// Prompts for Amount/Category/Subcategory/Description in a Kashu-styled
// form, then writes straight to Firestore — the same active profile the
// app's own quick-add uses. Amount can be negative, matching the app's own
// convention for logging income inline as a negative expense.
async function runAddExpenseFlow() {
  if (!configIsFilledIn()) {
    await presentSimpleAlert('Not configured', 'Fill in CONFIG (email/password) at the top of the script first.');
    return;
  }
  const { wv, fields } = await presentAddExpenseForm();
  if (!fields) return; // cancelled or dismissed

  const amount = Number(fields.amount);
  const category = (fields.category || '').trim();
  const subcategory = (fields.subcategory || '').trim();
  const description = (fields.description || '').trim();
  // The form's own JS already validates before it ever sends kashu://submit;
  // this is just a defensive second check.
  if (!amount || Number.isNaN(amount)) { await wv.loadHTML(buildResultHtml(false, 'Could not add expense', 'Enter a nonzero amount.')); return; }
  if (!category) { await wv.loadHTML(buildResultHtml(false, 'Could not add expense', 'Category is required.')); return; }

  try {
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

    const date = isoDateToday();
    const expense = {
      id: 'e_widget_' + Date.now(),
      month: monthForDateOffline(date, incomeCycles),
      date,
      category,
      subcategory: subcategory || category,
      method: '',
      description,
      value: amount
    };
    await commitAddExpense(CONFIG.projectId, docId, idToken, profileId, expense);
    await wv.loadHTML(buildResultHtml(true, amount < 0 ? 'Income added' : 'Added', `${fmtCur(amount, currencyCode)} → ${category}`));
  } catch (err) {
    await wv.loadHTML(buildResultHtml(false, 'Could not add expense', err.message));
  }
}
// The static "+" tile shown for this widget's background/home-screen
// rendering — tapping it is what triggers runAddExpenseFlow() above via
// the widget's "Run Script" interaction, not this rendering pass.
function buildAddExpenseTile() {
  const widget = new ListWidget();
  widget.backgroundColor = Color.dynamic(new Color('#F4F5F9'), new Color('#1B1C22'));
  const col = widget.addStack();
  col.layoutVertically();
  col.addSpacer();
  const row = col.addStack();
  row.layoutHorizontally();
  row.addSpacer();
  const plus = row.addText('+');
  plus.font = Font.boldSystemFont(46);
  plus.textColor = new Color('#6e8c78');
  row.addSpacer();
  col.addSpacer(4);
  const label = col.addText('Add Expense');
  label.font = Font.mediumSystemFont(12);
  label.centerAlignText();
  label.textColor = Color.dynamic(new Color('#6b6f7d'), new Color('#9a9dab'));
  col.addSpacer();
  return widget;
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

    const m = currentMonthKey();
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
  if ((args.widgetParameter || '').trim() === 'add') {
    if (config.runsInWidget) {
      // Background/home-screen render of this widget instance: just the tile.
      Script.setWidget(buildAddExpenseTile());
    } else {
      // Triggered by a tap ("Run Script") or run manually from Scriptable.
      await runAddExpenseFlow();
    }
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
