import { fetchSheetRows, normaliseRows } from './sheet.js';
import { checkPassword, createSessionCookie, clearSessionCookie, getSession } from './auth.js';

export const STATUSES = ['new', 'contacted', 'quoted', 'booked', 'completed', 'lost'];

// Files that can be loaded before signing in.
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/styles.css', '/favicon.svg']);

const SHEET_CACHE_SECONDS = 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/login' && request.method === 'POST') return login(request, env);
      if (url.pathname === '/api/logout' && request.method === 'POST') {
        return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
      }

      if (PUBLIC_PATHS.has(url.pathname)) return env.ASSETS.fetch(request);

      const session = await getSession(request, env);
      if (!session) {
        if (url.pathname.startsWith('/api/')) return json({ error: 'Sign in to continue' }, 401);
        return Response.redirect(new URL('/login', url), 302);
      }

      if (url.pathname.startsWith('/api/')) return api(request, env, ctx, url, session);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: err.message || 'Something went wrong' }, 500);
    }
  },
};

async function login(request, env) {
  if (!env.DASHBOARD_PASSWORD) {
    return json({ error: 'DASHBOARD_PASSWORD has not been set for this Worker. See the README.' }, 500);
  }
  const body = await request.json().catch(() => ({}));
  if (!(await checkPassword(env, body.password))) {
    return json({ error: 'That password is not correct' }, 401);
  }
  const name = String(body.name || '').trim() || 'Staff';
  return json({ ok: true, name }, 200, { 'Set-Cookie': await createSessionCookie(env, name) });
}

async function api(request, env, ctx, url, session) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'enquiries', id?, 'activity'?]

  if (parts[1] === 'me') return json({ name: session.name });

  if (parts[1] === 'enquiries' && parts.length === 2 && request.method === 'GET') {
    return listEnquiries(env, ctx, url.searchParams.has('fresh'), session);
  }

  if (parts[1] === 'enquiries' && parts.length === 3 && request.method === 'PATCH') {
    return updateEnquiry(request, env, parts[2], session);
  }

  if (parts[1] === 'enquiries' && parts[3] === 'activity') {
    if (!/^[0-9a-f]{16}$/.test(parts[2])) return json({ error: 'Unknown enquiry' }, 404);
    if (request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT at, by, action FROM activity WHERE enquiry_id = ? ORDER BY at DESC, id DESC LIMIT 100'
      ).bind(parts[2]).all();
      return json({ activity: results });
    }
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const action = String(body.action || '').trim().slice(0, 500);
      if (!action) return json({ error: 'Add a description of what happened' }, 400);
      await logActivity(env, parts[2], session.name, action);
      return json({ ok: true });
    }
  }

  return json({ error: 'Not found' }, 404);
}

async function listEnquiries(env, ctx, fresh, session) {
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.internal/sheet/${env.SHEET_ID}/${encodeURIComponent(env.SHEET_TAB || '')}`);

  let sheet = fresh ? null : await cache.match(cacheKey).then((r) => r && r.json());
  if (!sheet) {
    const { rows, source } = await fetchSheetRows(env);
    sheet = { enquiries: await normaliseRows(rows), source, fetchedAt: new Date().toISOString() };
    ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(sheet), {
      headers: { 'Cache-Control': `max-age=${SHEET_CACHE_SECONDS}` },
    })));
  }

  const { results } = await env.DB.prepare('SELECT * FROM enquiry_state').all();
  const state = new Map(results.map((r) => [r.id, r]));

  const enquiries = sheet.enquiries.map((e) => {
    const s = state.get(e.id);
    return {
      ...e,
      status: s ? s.status : defaultStatus(e),
      notes: s?.notes || '',
      confirmedDate: s?.confirmed_date || null,
      followUp: s?.follow_up || null,
      quote: s?.quote || '',
      updatedAt: s?.updated_at || null,
      updatedBy: s?.updated_by || null,
    };
  });

  return json({
    enquiries,
    source: sheet.source,
    fetchedAt: sheet.fetchedAt,
    user: session.name,
    statuses: STATUSES,
  });
}

// Enquiries nobody has touched in the dashboard yet. If staff already wrote
// something in the sheet's spare columns (e.g. "emailed 29/8/25") treat it as contacted.
function defaultStatus(e) {
  return e.sheetNotes ? 'contacted' : 'new';
}

const EDITABLE = {
  status: 'status',
  notes: 'notes',
  confirmedDate: 'confirmed_date',
  followUp: 'follow_up',
  quote: 'quote',
};

const LABELS = {
  status: 'Status',
  confirmedDate: 'Party date',
  followUp: 'Follow-up date',
  quote: 'Quote',
};

async function updateEnquiry(request, env, id, session) {
  if (!/^[0-9a-f]{16}$/.test(id)) return json({ error: 'Unknown enquiry' }, 404);
  const body = await request.json().catch(() => ({}));

  const changes = {};
  for (const key of Object.keys(EDITABLE)) {
    if (!(key in body)) continue;
    let value = body[key] === null ? null : String(body[key]).trim();
    if (key === 'status' && !STATUSES.includes(value)) return json({ error: 'Choose a valid status' }, 400);
    if ((key === 'confirmedDate' || key === 'followUp') && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return json({ error: 'Dates must be in YYYY-MM-DD format' }, 400);
    }
    if (key === 'notes') value = (value || '').slice(0, 5000);
    if (key === 'quote') value = (value || '').slice(0, 200);
    if ((key === 'confirmedDate' || key === 'followUp') && !value) value = null;
    changes[key] = value;
  }
  if (!Object.keys(changes).length) return json({ error: 'Nothing to update' }, 400);

  const existing = await env.DB.prepare('SELECT * FROM enquiry_state WHERE id = ?').bind(id).first();
  const current = existing || {
    id,
    status: body.previousStatus && STATUSES.includes(body.previousStatus) ? body.previousStatus : 'new',
    notes: '',
    confirmed_date: null,
    follow_up: null,
    quote: '',
  };

  const next = { ...current };
  const log = [];
  for (const [key, value] of Object.entries(changes)) {
    const col = EDITABLE[key];
    if ((current[col] ?? null) === value) continue;
    next[col] = value;
    if (key === 'notes') log.push('Updated notes');
    else if (key === 'status') log.push(`Status: ${current.status} → ${value}`);
    else log.push(`${LABELS[key]}: ${value || 'cleared'}`);
  }
  next.updated_at = new Date().toISOString();
  next.updated_by = session.name;

  await env.DB.prepare(
    `INSERT INTO enquiry_state (id, status, notes, confirmed_date, follow_up, quote, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET status = ?2, notes = ?3, confirmed_date = ?4, follow_up = ?5,
       quote = ?6, updated_at = ?7, updated_by = ?8`
  ).bind(id, next.status, next.notes, next.confirmed_date, next.follow_up, next.quote, next.updated_at, next.updated_by).run();

  for (const action of log) await logActivity(env, id, session.name, action);

  return json({
    ok: true,
    enquiry: {
      status: next.status,
      notes: next.notes,
      confirmedDate: next.confirmed_date,
      followUp: next.follow_up,
      quote: next.quote,
      updatedAt: next.updated_at,
      updatedBy: next.updated_by,
    },
  });
}

async function logActivity(env, id, by, action) {
  await env.DB.prepare('INSERT INTO activity (enquiry_id, at, by, action) VALUES (?, ?, ?, ?)')
    .bind(id, new Date().toISOString(), by, action).run();
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}
