// Shared-password login with an HMAC-signed session cookie.

const COOKIE = 'wh_session';
const SESSION_DAYS = 14;

function secret(env) {
  return env.SESSION_SECRET || env.DASHBOARD_PASSWORD;
}

async function hmac(env, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] || 0) ^ (eb[i] || 0);
  return diff === 0;
}

export async function checkPassword(env, password) {
  return Boolean(env.DASHBOARD_PASSWORD) && safeEqual(String(password || ''), env.DASHBOARD_PASSWORD);
}

export async function createSessionCookie(env, name) {
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify({
    name: String(name || 'Staff').slice(0, 40),
    exp: Date.now() + SESSION_DAYS * 86400000,
  }))));
  const value = `${payload}.${await hmac(env, payload)}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearSessionCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// Returns { name } for a valid session, otherwise null.
export async function getSession(request, env) {
  if (!secret(env)) return null;
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return null;
  const [payload, sig] = match[1].split('.');
  if (!payload || !sig || !safeEqual(sig, await hmac(env, payload))) return null;
  try {
    const data = JSON.parse(decodeURIComponent(escape(atob(payload))));
    return data.exp > Date.now() ? { name: data.name } : null;
  } catch {
    return null;
  }
}
