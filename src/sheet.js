// Reading from and writing to the Google Form responses sheet.

// Short labels for the form questions, matched by keyword so the dashboard
// keeps working if questions are reworded slightly or reordered. Order
// matters: the first field to claim a header wins (the party bags question
// mentions a "camping mug", so it must be claimed before camping).
export const FIELDS = [
  ['timestamp', 'Received', /^timestamp$/i],
  ['email', 'Email', /email/i],
  ['contactName', 'Contact', /who should we call/i],
  ['phone', 'Phone', /where can we reach/i],
  ['childName', 'Birthday child', /star of the show/i],
  ['age', 'Turning', /candles/i],
  ['kids', 'Kids', /adventure crew/i],
  ['adults', 'Adults', /grown-?ups|spectators/i],
  ['partyDate', 'Party date', /big adventure happening/i],
  ['planB', 'Plan B date', /plan b/i],
  ['timeOfDay', 'Time of day', /morning explorer|thrill-seeker/i],
  ['partyBags', 'Party bags', /party bags/i],
  ['package', 'Package', /party packages/i],
  ['camping', 'Camping', /camping/i],
  ['familiarity', 'Been before?', /how woodhouse/i],
  ['message', 'Their message', /anything else/i],
  ['status', 'Status', /^status$/i],
  ['notes', 'Notes', /^(staff )?notes$/i],
];

const SPARE = /^(column \d+)?$/i; // empty or Google's placeholder "Column 3" headers

// ---------------------------------------------------------------- columns

// Works out what each column is. Status and Notes live in the sheet's spare
// columns: "Column 1" already holds notes like "emailed 29/8/25", so it
// becomes Notes, and the first completely empty spare column becomes Status.
// `header` is the header text the column should have once something is saved.
export function describeColumns(rows) {
  const headers = (rows[0] || []).map((h) => String(h ?? '').trim());
  const columns = headers.map((header, index) => ({ index, header, key: null, label: header }));
  const claimed = new Set();

  for (const [key, label, re] of FIELDS) {
    const col = columns.find((c) => !claimed.has(c.index) && re.test(c.header));
    if (col) { Object.assign(col, { key, label }); claimed.add(col.index); }
  }

  const isEmpty = (i) => rows.slice(1).every((r) => !String(r[i] ?? '').trim());
  const spare = columns.filter((c) => !claimed.has(c.index) && SPARE.test(c.header));

  const ensure = (key, label, pick) => {
    if (columns.some((c) => c.key === key)) return;
    let col = pick(spare.filter((c) => !claimed.has(c.index)));
    if (!col) {
      col = { index: columns.length, header: '', key: null, label };
      columns.push(col);
    }
    Object.assign(col, { key, label });
    claimed.add(col.index);
  };
  ensure('notes', 'Notes', (cs) => cs.find((c) => /^column 1$/i.test(c.header)) || cs.find((c) => isEmpty(c.index)));
  ensure('status', 'Status', (cs) => cs.find((c) => isEmpty(c.index)));

  for (const c of columns) {
    // Show leftover spare columns only if somebody has written something in them.
    c.hidden = !c.key && SPARE.test(c.header) && isEmpty(c.index);
    c.newHeader = c.key === 'status' || c.key === 'notes' ? c.label : null;
  }
  return columns;
}

export function columnLetter(index) {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// ---------------------------------------------------------------- reading

export async function fetchSheetRows(env) {
  const tab = env.SHEET_TAB || 'Form Responses 1';
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const token = await getAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const range = encodeURIComponent(`'${tab}'`);
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${range}?majorDimension=ROWS`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Google Sheets returned ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return { rows: data.values || [], canEdit: true };
  }

  // Without a service account we can only read, and only while the sheet is
  // shared as "Anyone with the link can view" (or SHEET_CSV_URL is a published CSV).
  const url = env.SHEET_CSV_URL ||
    `https://docs.google.com/spreadsheets/d/${env.SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  if (!res.ok || /^\s*<!DOCTYPE html/i.test(text)) {
    throw new Error(
      'Could not read the Google Sheet. Share it as "Anyone with the link can view", ' +
      'or add the GOOGLE_SERVICE_ACCOUNT_JSON secret (see README).'
    );
  }
  return { rows: parseCsv(text), canEdit: false };
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------- writing

// updates: [{ row: 5, col: 2, value: 'x' }] using 1-based sheet rows and 0-based columns.
export async function writeCells(env, updates) {
  const token = await getAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const tab = (env.SHEET_TAB || 'Form Responses 1').replace(/'/g, "''");
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // RAW keeps text exactly as typed, e.g. phone numbers keep their leading 0.
      valueInputOption: 'RAW',
      data: updates.map((u) => ({ range: `'${tab}'!${columnLetter(u.col)}${u.row}`, values: [[u.value]] })),
    }),
  });
  if (res.status === 403) {
    throw new Error('Google refused the change. Share the sheet with the service account as an Editor (see README).');
  }
  if (!res.ok) throw new Error(`Google Sheets returned ${res.status}: ${await res.text()}`);
}

// ---------------------------------------------------------------- Google auth

let cachedToken = null;

async function getAccessToken(serviceAccountJson) {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;

  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const enc = (obj) => base64url(new TextEncoder().encode(JSON.stringify(obj)));
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;

  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${base64url(new Uint8Array(sig))}`,
    }),
  });
  if (!res.ok) throw new Error(`Google sign-in for the service account failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  cachedToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
