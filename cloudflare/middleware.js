import { getDb } from './db.js';
import { constantTimeEqual, hashToken } from '../backend/src/config/crypto.js';
import { LOCAL_USER_ID, LOCAL_USER_EMAIL } from '../backend/src/config/constants.js';
import { env } from '../backend/src/config/env.js';

export function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    String(header || '')
      .split(';')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf('=');
        return i === -1 ? [c, ''] : [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
      }),
  );
}

export function setCookie(res, name, value, opts = {}) {
  let cookie = `${name}=${encodeURIComponent(value)}`;
  if (opts.httpOnly) cookie += '; HttpOnly';
  if (opts.secure) cookie += '; Secure';
  if (opts.sameSite) cookie += `; SameSite=${opts.sameSite}`;
  if (opts.maxAge !== undefined) cookie += `; Max-Age=${opts.maxAge}`;
  if (opts.path) cookie += `; Path=${opts.path}`;
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', existing ? `${existing}, ${cookie}` : cookie);
}

export function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0, path: '/' });
}

export async function attachAuthContext(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[env.authCookieName];

  if (token) {
    try {
      const tokenHash = await hashToken(token);
      const db = getDb();
      const session = await db.prepare(
        'SELECT * FROM auth_sessions WHERE token_hash = ? AND expires_at > datetime("now")',
      ).get(tokenHash);
      if (session) {
        const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
        if (user) {
          req.user = { id: user.id, email: user.email, is_local: user.is_local === 1 };
          return next();
        }
      }
    } catch (e) {
      // session lookup failed, fall through
    }
  }

  // Local mode: auto-inject local user
  if (env.appMode === 'local') {
    req.user = { id: LOCAL_USER_ID, email: LOCAL_USER_EMAIL, is_local: true };
  }

  next();
}

export function requireAppUser(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}
