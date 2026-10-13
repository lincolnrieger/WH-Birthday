// Reading and normalising the Google Form responses sheet.

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Form questions are matched by keyword so the dashboard keeps working if the
// question wording is tweaked or columns are reordered. Order matters: the
// first field to claim a header wins (e.g. "party bags … camping mug" must be
// claimed by partyBags before camping looks at it).
const FIELDS = [
  ['timestamp', /^timestamp$/i],
  ['email', /email/i],
  ['contactName', /who should we call/i],
  ['phone', /where can we reach/i],
  ['childName', /star of the show/i],
  ['age', /candles/i],
  ['kids', /adventure crew/i],
  ['adults', /grown-?ups|spectators/i],
  ['partyDateRaw', /big adventure happening/i],
  ['planB', /plan b/i],
  ['timeOfDay', /morning explorer|thrill-seeker/i],
  ['partyBags', /party bags/i],
  ['package', /party packages/i],
  ['camping', /camping/i],
  ['familiarity', /how woodhouse/i],
  ['message', /anything else/i],
];

// ---------------------------------------------------------------- fetching

export async function fetchSheetRows(env) {
  const tab = env.SHEET_TAB || 'Form Responses 1';
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const token = await getAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const range = encodeURIComponent(`'${tab}'`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${range}?majorDimension=ROWS`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Google Sheets API returned ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return { rows: data.values || [], source: 'sheets-api' };
  }

  // Fallback: the sheet is shared as "Anyone with the link can view", or
  // SHEET_CSV_URL points at a CSV (e.g. a File > Share > Publish to web link).
  const url = env.SHEET_CSV_URL ||
    `https://docs.google.com/spreadsheets/d/${env.SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  if (!res.ok || /^\s*<!DOCTYPE html/i.test(text)) {
    throw new Error(
      'Could not read the Google Sheet. Either share it as "Anyone with the link can view" ' +
      'or set the GOOGLE_SERVICE_ACCOUNT_JSON secret (see README).'
    );
  }
  return { rows: parseCsv(text), source: 'public-csv' };
}

let cachedToken = null;

async function getAccessToken(serviceAccountJson) {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;

  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const enc = (obj) => base64url(new TextEncoder().encode(JSON.stringify(obj)));
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
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
  if (!res.ok) throw new Error(`Google auth failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  cachedToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------- parsing

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

// Turns raw sheet rows (first row = headers) into enquiry objects.
export async function normaliseRows(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h || '').trim());
  const map = {};
  const claimed = new Set();
  for (const [field, re] of FIELDS) {
    const idx = headers.findIndex((h, i) => !claimed.has(i) && re.test(h));
    if (idx !== -1) { map[field] = idx; claimed.add(idx); }
  }
  // Anything else with a value (e.g. the "Column 1" staff notes) is kept as sheet notes.
  const extraCols = headers.map((h, i) => i).filter((i) => !claimed.has(i));

  const out = [];
  for (const r of rows.slice(1)) {
    const get = (f) => (map[f] === undefined ? '' : String(r[map[f]] ?? '').trim());
    const timestampRaw = get('timestamp');
    if (!timestampRaw && !get('email') && !get('contactName')) continue;

    const received = parseTimestamp(timestampRaw);
    const party = parsePartyDate(get('partyDateRaw'), received);
    const sheetNotes = extraCols
      .map((i) => String(r[i] ?? '').trim())
      .filter(Boolean)
      .join(' · ');

    const e = {
      id: await stableId(`${timestampRaw}|${get('email').toLowerCase()}|${get('contactName')}`),
      received: received ? received.toISOString() : null,
      receivedRaw: timestampRaw,
      email: get('email'),
      contactName: get('contactName'),
      phone: get('phone'),
      childName: get('childName'),
      age: get('age'),
      kids: get('kids'),
      kidsCount: firstNumber(get('kids')),
      adults: get('adults'),
      partyDateRaw: get('partyDateRaw'),
      partyDate: party.date,
      partyDateUncertain: party.uncertain,
      planB: get('planB'),
      timeOfDay: get('timeOfDay'),
      package: get('package'),
      camping: get('camping'),
      partyBags: get('partyBags'),
      familiarity: get('familiarity'),
      message: get('message'),
      sheetNotes,
    };
    out.push(e);
  }
  return out;
}

async function stableId(input) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(hash).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function firstNumber(s) {
  const m = String(s).match(/\d+/);
  return m ? Number(m[0]) : null;
}

// Google Form timestamps in this sheet are US style: M/D/YYYY H:MM:SS
export function parseTimestamp(s) {
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) {
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }
  let [, a, b, y, hh = 0, mm = 0, ss = 0] = m.map((x) => (x === undefined ? undefined : Number(x)));
  let month = a, day = b;
  if (a > 12) { month = b; day = a; } // tolerate D/M if a sheet locale ever changes
  return new Date(Date.UTC(y, month - 1, day, hh, mm, ss));
}

// Party dates are free text: "16th of November", "20/10/2024", "11/3/2024",
// "18/10/25", "19 October 2025 or 25 October 2025". We pick the most plausible
// date on or after the enquiry was received and flag anything we had to guess.
export function parsePartyDate(raw, received) {
  const s = String(raw || '').trim();
  if (!s) return { date: null, uncertain: false };
  const ref = received || new Date();
  const refDay = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());

  const iso = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return result(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]), false);

  const num = s.match(/\b(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?\b/);
  if (num) {
    const a = +num[1], b = +num[2];
    const year = num[3] ? fixYear(+num[3]) : null;
    const candidates = [];
    if (a <= 31 && b <= 12) candidates.push({ day: a, month: b - 1 }); // D/M (Australian)
    if (a <= 12 && b <= 31 && a !== b) candidates.push({ day: b, month: a - 1 }); // M/D (US date picker)
    const dates = candidates
      .map((c) => (year ? Date.UTC(year, c.month, c.day) : nextOccurrence(c.month, c.day, refDay)))
      .filter((t) => validDate(t));
    if (dates.length) {
      return result(pickClosestAfter(dates, refDay), dates.length > 1 || !year);
    }
  }

  const monthName = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
  const dm = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?${monthName}(?:,?\\s+(\\d{4}))?`, 'i'));
  const md = s.match(new RegExp(`${monthName}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'i'));
  let day, month, year;
  if (dm) { day = +dm[1]; month = MONTHS[dm[2].toLowerCase()]; year = dm[3] ? +dm[3] : null; }
  else if (md) { month = MONTHS[md[1].toLowerCase()]; day = +md[2]; year = md[3] ? +md[3] : null; }
  if (month !== undefined && day >= 1 && day <= 31) {
    const t = year ? Date.UTC(year, month, day) : nextOccurrence(month, day, refDay);
    return result(t, !year);
  }
  return { date: null, uncertain: true };

  function result(t, uncertain) {
    return { date: new Date(t).toISOString().slice(0, 10), uncertain };
  }
}

function fixYear(y) {
  return y < 100 ? 2000 + y : y;
}

function validDate(t) {
  return !isNaN(t);
}

// The first date with this month/day that is not more than a week before the reference.
function nextOccurrence(month, day, refDay) {
  const y = new Date(refDay).getUTCFullYear();
  for (const year of [y, y + 1]) {
    const t = Date.UTC(year, month, day);
    if (t >= refDay - 7 * 86400000) return t;
  }
  return Date.UTC(y + 1, month, day);
}

function pickClosestAfter(dates, refDay) {
  const floor = refDay - 7 * 86400000;
  const after = dates.filter((t) => t >= floor).sort((x, y) => x - y);
  if (after.length) return after[0];
  return Math.max(...dates);
}
