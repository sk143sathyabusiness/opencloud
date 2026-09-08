import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { kvGet, kvSet, kvDelete } from '../kvStore.js';
import { env } from '../../backend/src/config/env.js';
import { requireAppUser } from '../middleware.js';

const OAUTH_STATE_TTL = 600;

async function clearFilesForAccount(db, userId, cloudAccountId) {
  await db.prepare('DELETE FROM file_metadata WHERE user_id = ? AND cloud_account_id = ?').run(userId, cloudAccountId);
}

function getGoogleOAuthUrl(state) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', env.googleClientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', env.googleRedirectUri);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('scope', 'openid email profile https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.metadata');
  url.searchParams.set('state', state);
  return url.toString();
}

function getOneDriveOAuthUrl(state) {
  const authorityBase = `https://login.microsoftonline.com/${encodeURIComponent(env.onedriveTenantId)}/oauth2/v2.0`;
  const url = new URL(`${authorityBase}/authorize`);
  url.searchParams.set('client_id', env.onedriveClientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', env.onedriveRedirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', 'offline_access openid profile email Files.ReadWrite.All User.Read');
  url.searchParams.set('state', state);
  return url.toString();
}

function getDropboxOAuthUrl(state) {
  const url = new URL('https://www.dropbox.com/oauth2/authorize');
  url.searchParams.set('client_id', env.dropboxClientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', env.dropboxRedirectUri);
  url.searchParams.set('token_access_type', 'offline');
  url.searchParams.set('scope', 'account_info.read files.metadata.read files.content.read files.content.write');
  url.searchParams.set('state', state);
  return url.toString();
}

function getYandexOAuthUrl(state) {
  const url = new URL('https://oauth.yandex.com/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env.yandexClientId);
  url.searchParams.set('redirect_uri', env.yandexRedirectUri);
  url.searchParams.set('scope', 'cloud_api:disk.read cloud_api:disk.write cloud_api:disk.info');
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeOneDriveCode(code) {
  const authorityBase = `https://login.microsoftonline.com/${encodeURIComponent(env.onedriveTenantId)}/oauth2/v2.0`;
  const response = await fetch(`${authorityBase}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.onedriveClientId,
      client_secret: env.onedriveClientSecret,
      code,
      redirect_uri: env.onedriveRedirectUri,
      grant_type: 'authorization_code',
      scope: 'offline_access openid profile email Files.ReadWrite.All User.Read',
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || 'Failed to exchange OneDrive OAuth code');
  }
  return payload;
}

async function exchangeDropboxCode(code) {
  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.dropboxClientId,
      client_secret: env.dropboxClientSecret,
      code,
      redirect_uri: env.dropboxRedirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error_description || payload?.error_summary || payload?.error || 'Failed to exchange Dropbox OAuth code');
  }
  return payload;
}

async function exchangeYandexCode(code) {
  const response = await fetch('https://oauth.yandex.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: env.yandexClientId,
      client_secret: env.yandexClientSecret,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || payload?.error || 'Failed to exchange Yandex OAuth code');
  }
  return payload;
}

async function fetchGoogleProfile(accessToken) {
  const response = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName),storageQuota(limit,usage)', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || 'Unable to read Google account profile');
  }
  return {
    email: data.user?.emailAddress || null,
    displayName: data.user?.displayName || null,
    totalSpace: Number(data.storageQuota?.limit || 0),
    usedSpace: Number(data.storageQuota?.usage || 0),
  };
}

async function fetchOneDriveProfile(accessToken) {
  const [meRes, driveRes] = await Promise.all([
    fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
    fetch('https://graph.microsoft.com/v1.0/me/drive?$select=id,driveType,quota', {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
  ]);
  const me = await meRes.json();
  const drive = await driveRes.json();
  if (!meRes.ok) throw new Error(me.error?.message || 'Unable to read OneDrive profile');
  if (!driveRes.ok) throw new Error(drive.error?.message || 'Unable to read OneDrive drive profile');
  return {
    email: me.mail || me.userPrincipalName || null,
    displayName: me.displayName || null,
    driveId: drive.id || null,
    driveType: drive.driveType || 'personal',
    totalSpace: Number(drive.quota?.total || 0),
    usedSpace: Number(drive.quota?.used || 0),
  };
}

async function fetchDropboxProfile(accessToken) {
  const rpc = async (path, body = {}) => {
    const res = await fetch(`https://api.dropboxapi.com/2${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw new Error(payload?.error_description || payload?.error_summary || 'Dropbox API request failed');
    return payload;
  };
  const [account, space] = await Promise.all([
    rpc('/users/get_current_account'),
    rpc('/users/get_space_usage'),
  ]);
  return {
    email: account.email || null,
    displayName: account.name?.display_name || null,
    accountId: account.account_id || null,
    totalSpace: Number(space.allocation?.allocated || space.allocation?.individual?.allocated || space.allocation?.team?.allocated || 0),
    usedSpace: Number(space.used || 0),
  };
}

async function fetchYandexProfile(accessToken) {
  const response = await fetch('https://cloud-api.yandex.net/v1/disk/', {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  const disk = await response.json().catch(() => null);
  if (!response.ok || !disk) throw new Error(disk?.message || 'Unable to read Yandex Disk profile');
  const login = disk.user?.login || disk.user?.display_name || 'yandex-user';
  return {
    email: disk.user?.email || `${login}@yandex`,
    displayName: disk.user?.display_name || login,
    totalSpace: Number(disk.total_space || 0),
    usedSpace: Number(disk.used_space || 0),
  };
}

export function createAccountsRouter() {
  const router = Router();

  router.use(requireAppUser);

  router.get('/accounts', async (req, res, next) => {
    try {
      const db = getDb();
      const { results } = await db.prepare(
        'SELECT id, user_id, email, provider, total_space, used_space, status, created_at, updated_at FROM cloud_accounts WHERE user_id = ? ORDER BY provider, email'
      ).all(req.user.id);

      const accounts = results.map((account) => ({
        ...account,
        free_space: Number(account.total_space) - Number(account.used_space),
      }));

      res.json({ data: accounts });
    } catch (error) {
      next(error);
    }
  });

  router.get('/accounts/google/status', (_req, res) => {
    res.json({ data: { configured: Boolean(env.googleClientId && env.googleClientSecret), redirectUri: env.googleRedirectUri } });
  });

  router.get('/accounts/onedrive/status', (_req, res) => {
    res.json({ data: { configured: Boolean(env.onedriveClientId && env.onedriveClientSecret), tenantId: env.onedriveTenantId, redirectUri: env.onedriveRedirectUri } });
  });

  router.get('/accounts/dropbox/status', (_req, res) => {
    res.json({ data: { configured: Boolean(env.dropboxClientId && env.dropboxClientSecret), redirectUri: env.dropboxRedirectUri } });
  });

  router.get('/accounts/yandex/status', (_req, res) => {
    res.json({ data: { configured: Boolean(env.yandexClientId && env.yandexClientSecret), redirectUri: env.yandexRedirectUri } });
  });

  router.get('/accounts/mega/status', (_req, res) => {
    res.status(410).json({ error: 'MEGA support removed' });
  });

  router.post('/accounts/mega/connect', (_req, res) => {
    res.status(410).json({ error: 'MEGA support removed' });
  });

  router.get('/accounts/google/connect', async (req, res, next) => {
    try {
      if (!env.googleClientId || !env.googleClientSecret) {
        return res.status(400).json({ error: 'Google OAuth is not configured' });
      }
      const state = randomUUID();
      const authorizationUrl = getGoogleOAuthUrl(state);
      await kvSet(req._env?.STATE, `oauth:google:${state}`, { userId: req.user.id, provider: 'google_drive', redirectUri: env.googleRedirectUri }, OAUTH_STATE_TTL);
      res.json({ data: { authorizationUrl, state, redirectUri: env.googleRedirectUri } });
    } catch (error) {
      next(error);
    }
  });

  router.get('/accounts/onedrive/connect', async (req, res, next) => {
    try {
      if (!env.onedriveClientId || !env.onedriveClientSecret) {
        return res.status(400).json({ error: 'OneDrive OAuth is not configured' });
      }
      const state = randomUUID();
      const authorizationUrl = getOneDriveOAuthUrl(state);
      await kvSet(req._env?.STATE, `oauth:onedrive:${state}`, { userId: req.user.id, provider: 'onedrive', redirectUri: env.onedriveRedirectUri }, OAUTH_STATE_TTL);
      res.json({ data: { authorizationUrl, state, redirectUri: env.onedriveRedirectUri } });
    } catch (error) {
      next(error);
    }
  });

  router.get('/accounts/dropbox/connect', async (req, res, next) => {
    try {
      if (!env.dropboxClientId || !env.dropboxClientSecret) {
        return res.status(400).json({ error: 'Dropbox OAuth is not configured' });
      }
      const state = randomUUID();
      const authorizationUrl = getDropboxOAuthUrl(state);
      await kvSet(req._env?.STATE, `oauth:dropbox:${state}`, { userId: req.user.id, provider: 'dropbox', redirectUri: env.dropboxRedirectUri }, OAUTH_STATE_TTL);
      res.json({ data: { authorizationUrl, state, redirectUri: env.dropboxRedirectUri } });
    } catch (error) {
      next(error);
    }
  });

  router.get('/accounts/yandex/connect', async (req, res, next) => {
    try {
      if (!env.yandexClientId || !env.yandexClientSecret) {
        return res.status(400).json({ error: 'Yandex OAuth is not configured' });
      }
      const state = randomUUID();
      const authorizationUrl = getYandexOAuthUrl(state);
      await kvSet(req._env?.STATE, `oauth:yandex:${state}`, { userId: req.user.id, provider: 'yandex', redirectUri: env.yandexRedirectUri }, OAUTH_STATE_TTL);
      res.json({ data: { authorizationUrl, state, redirectUri: env.yandexRedirectUri } });
    } catch (error) {
      next(error);
    }
  });

  router.get('/accounts/google/callback', async (req, res, next) => {
    const frontendUrl = new URL(env.frontendUrl);
    frontendUrl.pathname = '/quota';
    try {
      const { code, state, error: authError } = req.query;
      if (authError) {
        frontendUrl.searchParams.set('google', 'error');
        frontendUrl.searchParams.set('message', String(authError));
        return res.redirect(frontendUrl.toString());
      }
      const authState = await kvGet(req._env?.STATE, `oauth:google:${state}`);
      if (!authState) {
        frontendUrl.searchParams.set('google', 'error');
        frontendUrl.searchParams.set('message', 'Invalid or expired OAuth state');
        return res.redirect(frontendUrl.toString());
      }
      await kvDelete(req._env?.STATE, `oauth:google:${state}`);

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(code || ''),
          client_id: env.googleClientId,
          client_secret: env.googleClientSecret,
          redirect_uri: env.googleRedirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok) throw new Error(tokens.error_description || tokens.error || 'Failed to exchange Google OAuth code');

      const profile = await fetchGoogleProfile(tokens.access_token);
      if (!profile.email) throw new Error('Unable to read Google account email');

      const db = getDb();
      const credentials = {
        provider: 'google_drive',
        clientId: env.googleClientId,
        clientSecret: env.googleClientSecret,
        redirectUri: env.googleRedirectUri,
        refreshToken: tokens.refresh_token || null,
        accessToken: tokens.access_token || null,
        expiryDate: tokens.expiry_date || null,
        scope: tokens.scope || null,
        tokenType: tokens.token_type || null,
      };

      await db.prepare(`
        INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(user_id, provider, email) DO UPDATE SET
          encrypted_credentials = excluded.encrypted_credentials,
          total_space = excluded.total_space,
          used_space = excluded.used_space,
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
      `).run(randomUUID(), authState.userId, profile.email, 'google_drive', JSON.stringify(credentials), profile.totalSpace, profile.usedSpace);

      frontendUrl.searchParams.set('google', 'connected');
      return res.redirect(frontendUrl.toString());
    } catch (error) {
      frontendUrl.searchParams.set('google', 'error');
      frontendUrl.searchParams.set('message', error.message);
      return res.redirect(frontendUrl.toString());
    }
  });

  router.get('/accounts/onedrive/callback', async (req, res, next) => {
    const frontendUrl = new URL(env.frontendUrl);
    frontendUrl.pathname = '/quota';
    try {
      const { code, state, error: authError } = req.query;
      if (authError) {
        frontendUrl.searchParams.set('onedrive', 'error');
        frontendUrl.searchParams.set('message', String(authError));
        return res.redirect(frontendUrl.toString());
      }
      const authState = await kvGet(req._env?.STATE, `oauth:onedrive:${state}`);
      if (!authState) {
        frontendUrl.searchParams.set('onedrive', 'error');
        frontendUrl.searchParams.set('message', 'Invalid or expired OAuth state');
        return res.redirect(frontendUrl.toString());
      }
      await kvDelete(req._env?.STATE, `oauth:onedrive:${state}`);

      const tokens = await exchangeOneDriveCode(String(code || ''));
      const profile = await fetchOneDriveProfile(tokens.access_token);
      if (!profile.email) throw new Error('Unable to read OneDrive account email');

      const db = getDb();
      const credentials = {
        provider: 'onedrive',
        clientId: env.onedriveClientId,
        clientSecret: env.onedriveClientSecret,
        redirectUri: env.onedriveRedirectUri,
        tenantId: env.onedriveTenantId,
        refreshToken: tokens.refresh_token || null,
        accessToken: tokens.access_token || null,
        expiresIn: tokens.expires_in || null,
        scope: tokens.scope || null,
        tokenType: tokens.token_type || null,
        driveId: profile.driveId,
        driveType: profile.driveType,
      };

      await db.prepare(`
        INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(user_id, provider, email) DO UPDATE SET
          encrypted_credentials = excluded.encrypted_credentials,
          total_space = excluded.total_space,
          used_space = excluded.used_space,
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
      `).run(randomUUID(), authState.userId, profile.email, 'onedrive', JSON.stringify(credentials), profile.totalSpace, profile.usedSpace);

      frontendUrl.searchParams.set('onedrive', 'connected');
      return res.redirect(frontendUrl.toString());
    } catch (error) {
      frontendUrl.searchParams.set('onedrive', 'error');
      frontendUrl.searchParams.set('message', error.message);
      return res.redirect(frontendUrl.toString());
    }
  });

  router.get('/accounts/dropbox/callback', async (req, res, next) => {
    const frontendUrl = new URL(env.frontendUrl);
    frontendUrl.pathname = '/quota';
    try {
      const { code, state, error: authError, error_description } = req.query;
      if (authError) {
        frontendUrl.searchParams.set('dropbox', 'error');
        frontendUrl.searchParams.set('message', String(error_description || authError));
        return res.redirect(frontendUrl.toString());
      }
      const authState = await kvGet(req._env?.STATE, `oauth:dropbox:${state}`);
      if (!authState) {
        frontendUrl.searchParams.set('dropbox', 'error');
        frontendUrl.searchParams.set('message', 'Invalid or expired OAuth state');
        return res.redirect(frontendUrl.toString());
      }
      await kvDelete(req._env?.STATE, `oauth:dropbox:${state}`);

      const tokens = await exchangeDropboxCode(String(code || ''));
      const profile = await fetchDropboxProfile(tokens.access_token);
      if (!profile.email) throw new Error('Unable to read Dropbox account email');
      if (!tokens.refresh_token) throw new Error('Dropbox did not return a refresh token');

      const db = getDb();
      const credentials = {
        provider: 'dropbox',
        clientId: env.dropboxClientId,
        clientSecret: env.dropboxClientSecret,
        redirectUri: env.dropboxRedirectUri,
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token || null,
        expiresIn: tokens.expires_in || null,
        scope: tokens.scope || 'account_info.read files.metadata.read files.content.read files.content.write',
        tokenType: tokens.token_type || 'bearer',
        accountId: profile.accountId,
        displayName: profile.displayName,
      };

      await db.prepare(`
        INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(user_id, provider, email) DO UPDATE SET
          encrypted_credentials = excluded.encrypted_credentials,
          total_space = excluded.total_space,
          used_space = excluded.used_space,
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
      `).run(randomUUID(), authState.userId, profile.email, 'dropbox', JSON.stringify(credentials), profile.totalSpace, profile.usedSpace);

      frontendUrl.searchParams.set('dropbox', 'connected');
      return res.redirect(frontendUrl.toString());
    } catch (error) {
      frontendUrl.searchParams.set('dropbox', 'error');
      frontendUrl.searchParams.set('message', error.message);
      return res.redirect(frontendUrl.toString());
    }
  });

  router.get('/accounts/yandex/callback', async (req, res, next) => {
    const frontendUrl = new URL(env.frontendUrl);
    frontendUrl.pathname = '/quota';
    try {
      const { code, state, error: authError, error_description } = req.query;
      if (authError) {
        frontendUrl.searchParams.set('yandex', 'error');
        frontendUrl.searchParams.set('message', String(error_description || authError));
        return res.redirect(frontendUrl.toString());
      }
      const authState = await kvGet(req._env?.STATE, `oauth:yandex:${state}`);
      if (!authState) {
        frontendUrl.searchParams.set('yandex', 'error');
        frontendUrl.searchParams.set('message', 'Invalid or expired OAuth state');
        return res.redirect(frontendUrl.toString());
      }
      await kvDelete(req._env?.STATE, `oauth:yandex:${state}`);

      const tokens = await exchangeYandexCode(String(code || ''));
      const profile = await fetchYandexProfile(tokens.access_token);

      const db = getDb();
      const credentials = {
        provider: 'yandex',
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        clientId: env.yandexClientId,
        clientSecret: env.yandexClientSecret,
        expiresIn: tokens.expires_in || null,
        tokenType: tokens.token_type || 'bearer',
        displayName: profile.displayName,
      };

      await db.prepare(`
        INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(user_id, provider, email) DO UPDATE SET
          encrypted_credentials = excluded.encrypted_credentials,
          total_space = excluded.total_space,
          used_space = excluded.used_space,
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
      `).run(randomUUID(), authState.userId, profile.email, 'yandex', JSON.stringify(credentials), profile.totalSpace, profile.usedSpace);

      frontendUrl.searchParams.set('yandex', 'connected');
      return res.redirect(frontendUrl.toString());
    } catch (error) {
      frontendUrl.searchParams.set('yandex', 'error');
      frontendUrl.searchParams.set('message', error.message);
      return res.redirect(frontendUrl.toString());
    }
  });

  router.post('/accounts/s3/connect', async (req, res, next) => {
    try {
      const body = await req._webRequest.json();
      const { accessKeyId, secretAccessKey, bucket, region: regionInput, endpoint: endpointInput, label, totalSpace, forcePathStyle } = body;

      if (!accessKeyId || !secretAccessKey || !bucket) {
        return res.status(400).json({ error: 'accessKeyId, secretAccessKey, and bucket are required' });
      }

      const GIB = 1024 * 1024 * 1024;
      const DEFAULT_S3_TOTAL_SPACE = 10 * GIB;
      const email = label || `${bucket}@s3`;
      const resolvedTotal = Number(totalSpace) || DEFAULT_S3_TOTAL_SPACE;

      const credentials = {
        provider: 's3',
        accessKeyId,
        secretAccessKey,
        bucket,
        region: regionInput || 'auto',
        endpoint: endpointInput || null,
        forcePathStyle: forcePathStyle !== false,
      };

      const db = getDb();
      await db.prepare(`
        INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(user_id, provider, email) DO UPDATE SET
          encrypted_credentials = excluded.encrypted_credentials,
          total_space = excluded.total_space,
          used_space = excluded.used_space,
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
      `).run(randomUUID(), req.user.id, email, 's3', JSON.stringify(credentials), resolvedTotal, 0);

      const account = await db.prepare('SELECT * FROM cloud_accounts WHERE user_id = ? AND provider = ? AND email = ?').get(req.user.id, 's3', email);
      res.json({ data: { account, profile: { email, provider: 's3' } } });
    } catch (error) {
      next(error);
    }
  });

  router.post('/accounts/pcloud/connect', async (req, res, next) => {
    try {
      const body = await req._webRequest.json();
      const { username, password } = body;

      if (!username || !password) {
        return res.status(400).json({ error: 'pCloud username (email) and password are required' });
      }

      const PCLOUD_HOSTS = ['api.pcloud.com', 'eapi.pcloud.com'];
      const encoder = new TextEncoder();

      async function sha1Hex(value) {
        const data = encoder.encode(value);
        const hash = await crypto.subtle.digest('SHA-1', data);
        return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
      }

      async function pcloudGet(host, method, params = {}) {
        const url = new URL(`https://${host}/${method}`);
        Object.entries(params).forEach(([key, value]) => {
          if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        });
        const response = await fetch(url.toString());
        const payload = await response.json().catch(() => null);
        if (!payload) throw new Error('pCloud returned an invalid response');
        if (payload.result !== 0) {
          const error = new Error(payload.error || `pCloud error ${payload.result}`);
          error.result = payload.result;
          throw error;
        }
        return payload;
      }

      let lastError = null;
      let loginResult = null;

      for (const host of PCLOUD_HOSTS) {
        try {
          const { digest } = await pcloudGet(host, 'getdigest');
          const usernameHash = await sha1Hex(String(username).toLowerCase());
          const passwordDigest = await sha1Hex(password + usernameHash + digest);
          const auth = await pcloudGet(host, 'login', {
            getauth: 1,
            logout: 0,
            username,
            digest,
            passworddigest: passwordDigest,
          });
          if (!auth.auth) throw new Error('pCloud login did not return an auth token');
          loginResult = { host, auth: auth.auth, email: auth.email || username, totalSpace: Number(auth.quota || 0), usedSpace: Number(auth.usedquota || 0) };
          break;
        } catch (error) {
          lastError = error;
          if (error.result && ![2321, 2330, 4000].includes(error.result)) {
            if (error.result === 2000) break;
          }
        }
      }

      if (!loginResult) throw lastError || new Error('Unable to log in to pCloud');

      const credentials = {
        provider: 'pcloud',
        username,
        password,
        host: loginResult.host,
        auth: loginResult.auth,
      };

      const db = getDb();
      await db.prepare(`
        INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(user_id, provider, email) DO UPDATE SET
          encrypted_credentials = excluded.encrypted_credentials,
          total_space = excluded.total_space,
          used_space = excluded.used_space,
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
      `).run(randomUUID(), req.user.id, loginResult.email, 'pcloud', JSON.stringify(credentials), loginResult.totalSpace, loginResult.usedSpace);

      const account = await db.prepare('SELECT * FROM cloud_accounts WHERE user_id = ? AND provider = ? AND email = ?').get(req.user.id, 'pcloud', loginResult.email);
      res.json({ data: { account, profile: { email: loginResult.email, totalSpace: loginResult.totalSpace, usedSpace: loginResult.usedSpace } } });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/accounts/:id', async (req, res, next) => {
    try {
      const db = getDb();
      const account = await db.prepare('SELECT * FROM cloud_accounts WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
      if (!account) {
        return res.status(404).json({ error: 'Account not found' });
      }

      await clearFilesForAccount(db, req.user.id, account.id);
      await db.prepare('DELETE FROM cloud_accounts WHERE user_id = ? AND id = ?').run(req.user.id, account.id);

      return res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
