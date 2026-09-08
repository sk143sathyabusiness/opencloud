import { Router } from 'express';
import { getDb } from '../db.js';
import { hashPassword, verifyPassword, generateToken, hashToken } from '../../backend/src/config/crypto.js';
import { LOCAL_USER_ID, LOCAL_USER_EMAIL } from '../../backend/src/config/constants.js';
import { env } from '../../backend/src/config/env.js';
import { setCookie, clearCookie } from '../middleware.js';

const PASSWORD_MIN_LENGTH = 8;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function serializeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    isLocal: Boolean(user.is_local),
  };
}

function getAuthSummary(user) {
  return {
    mode: env.appMode,
    requiresAuth: env.appMode === 'hosted',
    authenticated: Boolean(user),
    user: serializeUser(user),
  };
}

function sessionExpiryDate() {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + Math.max(1, env.authSessionTtlHours));
  return expiresAt;
}

export function createAuthRouter() {
  const router = Router();

  router.get('/auth/me', (req, res) => {
    res.json(getAuthSummary(req.user));
  });

  router.post('/auth/register', async (req, res, next) => {
    try {
      const body = await req._webRequest.json();
      const normalizedEmail = normalizeEmail(body.email);
      if (!normalizedEmail || !normalizedEmail.includes('@')) {
        return res.status(400).json({ error: 'Valid email is required' });
      }

      const password = String(body.password || '');
      if (password.length < PASSWORD_MIN_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
      }

      const db = getDb();
      const existingUser = await db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(normalizedEmail);
      if (existingUser) {
        return res.status(400).json({ error: 'Email is already registered' });
      }

      const { hash, salt } = await hashPassword(password);
      const passwordHash = `${salt}:${hash}`;
      const userId = crypto.randomUUID();

      await db.prepare('INSERT INTO users (id, email, password_hash, is_local) VALUES (?, ?, ?, ?)').run(userId, normalizedEmail, passwordHash, 0);
      const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

      // Clear any existing sessions for this user
      await db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);

      // Create session
      const token = await generateToken();
      const tokenHash = await hashToken(token);
      const sessionId = crypto.randomUUID();
      const expiresAt = sessionExpiryDate();

      await db.prepare('INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').run(sessionId, userId, tokenHash, expiresAt.toISOString());

      setCookie(res, env.authCookieName, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        path: '/',
      });

      res.status(201).json(getAuthSummary(user));
    } catch (error) {
      next(error);
    }
  });

  router.post('/auth/login', async (req, res, next) => {
    try {
      const body = await req._webRequest.json();
      const normalizedEmail = normalizeEmail(body.email);
      const password = String(body.password || '');

      if (!normalizedEmail || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      const db = getDb();
      const user = await db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(normalizedEmail);

      if (!user || !user.password_hash) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const [salt, storedHash] = user.password_hash.split(':');
      const valid = await verifyPassword(password, storedHash, salt);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      // Create session
      const token = await generateToken();
      const tokenHash = await hashToken(token);
      const sessionId = crypto.randomUUID();
      const expiresAt = sessionExpiryDate();

      await db.prepare('INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').run(sessionId, user.id, tokenHash, expiresAt.toISOString());

      setCookie(res, env.authCookieName, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        path: '/',
      });

      res.json(getAuthSummary(user));
    } catch (error) {
      next(error);
    }
  });

  router.post('/auth/logout', (req, res) => {
    const cookieHeader = req.headers.cookie || '';
    const token = cookieHeader
      .split(';')
      .map((item) => item.trim())
      .find((item) => item.startsWith(`${env.authCookieName}=`))
      ?.slice(env.authCookieName.length + 1);

    if (token) {
      // Destroy session asynchronously (fire-and-forget for logout)
      hashToken(token).then((tokenHash) => {
        getDb().prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
      }).catch(() => {});
    }

    clearCookie(res, env.authCookieName);
    res.json(getAuthSummary(env.appMode === 'local' ? req.user : null));
  });

  return router;
}
