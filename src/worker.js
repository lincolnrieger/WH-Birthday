import { fetchSheetRows, describeColumns, writeCells } from './sheet.js';
import { checkPassword, createSessionCookie, clearSessionCookie, getSession } from './auth.js';

// Files that can be loaded before signing in.
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/styles.css', '/favicon.svg']);

const CACHE_SECONDS = 60;
const MAX_VALUE_LENGTH = 5000;

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

      if (url.pathname === '/api/enquiries' && request.method === 'GET') {
        return listEnquiries(env, ctx, url.searchParams.has('fresh'), session);
      }
      if (url.pathname === '/api/enquiries' && request.method === 'PATCH') {
        return updateEnquiry(request, env);
      }
      if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);

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

function cacheKey(env) {
  return new Request(`https://cache.internal/sheet/${env.SHEET_ID}/${encodeURIComponent(env.SHEET_TAB || '')}`);
}

async function listEnquiries(env, ctx, fresh, session) {
  let sheet = fresh ? null : await caches.default.match(cacheKey(env)).then((r) => r && r.json());
  if (!sheet) {
    const { rows, canEdit } = await fetchSheetRows(env);
    sheet = { rows, canEdit, fetchedAt: new Date().toISOString() };
    ctx.waitUntil(caches.default.put(cacheKey(env), new Response(JSON.stringify(sheet), {
      headers: { 'Cache-Control': `max-age=${CACHE_SECONDS}` },
    })));
  }

  const columns = describeColumns(sheet.rows);
  const enquiries = [];
  sheet.rows.slice(1).forEach((r, i) => {
    const values = columns.map((c) => String(r[c.index] ?? ''));
    if (values.some((v) => v.trim())) enquiries.push({ row: i + 2, values });
  });

  return json({
    columns: columns.map(({ index, key, label, header, hidden }) => ({ index, key, label, header, hidden })),
    enquiries,
    canEdit: sheet.canEdit,
    fetchedAt: sheet.fetchedAt,
    user: session.name,
  });
}

// Body: { row: 12, timestamp: '8/23/2025 20:27:10', changes: { "<column index>": "new value" } }
async function updateEnquiry(request, env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return json({ error: 'Editing needs the Google service account set up (see README, step 4).' }, 400);
  }
  const body = await request.json().catch(() => ({}));
  const changes = Object.entries(body.changes || {});
  if (!changes.length) return json({ error: 'Nothing to save' }, 400);

  // Always check against the live sheet, in case rows were sorted or deleted since the page loaded.
  const { rows } = await fetchSheetRows(env);
  const columns = describeColumns(rows);
  const tsCol = columns.find((c) => c.key === 'timestamp');

  let row = Number(body.row);
  if (tsCol) {
    const matches = (n) => n >= 2 && String(rows[n - 1]?.[tsCol.index] ?? '') === String(body.timestamp ?? '');
    if (!matches(row)) {
      const found = rows.findIndex((r, i) => i > 0 && matches(i + 1));
      if (found === -1) {
        return json({ error: 'This enquiry has moved or been deleted in the sheet. Refresh and try again.' }, 409);
      }
      row = found + 1;
    }
  }
  if (!Number.isInteger(row) || row < 2) return json({ error: 'Unknown row' }, 400);

  const updates = [];
  for (const [colIndex, value] of changes) {
    const col = columns.find((c) => c.index === Number(colIndex));
    if (!col) return json({ error: 'Unknown column' }, 400);
    if (col.key === 'timestamp') return json({ error: 'The form timestamp cannot be edited' }, 400);
    updates.push({ row, col: col.index, value: String(value ?? '').slice(0, MAX_VALUE_LENGTH) });
    // First time Status or Notes is used, give the spare column a proper heading.
    if (col.newHeader && col.header !== col.newHeader) updates.push({ row: 1, col: col.index, value: col.newHeader });
  }

  await writeCells(env, updates);
  await caches.default.delete(cacheKey(env));
  return json({ ok: true, row });
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}
