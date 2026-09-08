import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAppUser } from '../middleware.js';

export const ALLOCATION_STRATEGIES = [
  'round_robin',
  'weighted_round_robin',
  'least_used',
  'most_free',
  'manual',
];

const DEFAULT_STRATEGY = 'round_robin';

const SETTING_KEYS = {
  strategy: 'allocation_strategy',
  order: 'allocation_order',
  rrCursor: 'allocation_rr_cursor',
  swrrState: 'allocation_swrr_state',
};

async function readSetting(db, userId, key) {
  const row = await db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
  return row ? row.value : null;
}

async function writeSetting(db, userId, key, value) {
  await db.prepare(`
    INSERT INTO user_settings (id, user_id, key, value, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(crypto.randomUUID(), userId, key, value);
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

async function getAllocationConfig(db, userId) {
  const strategyRaw = await readSetting(db, userId, SETTING_KEYS.strategy);
  const strategy = ALLOCATION_STRATEGIES.includes(strategyRaw) ? strategyRaw : DEFAULT_STRATEGY;
  const orderRaw = await readSetting(db, userId, SETTING_KEYS.order);
  const order = parseJson(orderRaw, []).filter((id) => typeof id === 'string');
  return { strategy, order };
}

async function getOrderedActiveAccounts(db, userId) {
  const result = await db.prepare("SELECT * FROM cloud_accounts WHERE user_id = ? AND status = 'active'").all(userId);
  const active = result.results || result;
  const { order } = await getAllocationConfig(db, userId);
  const byId = new Map(active.map((account) => [account.id, account]));

  const ordered = [];
  order.forEach((id) => {
    if (byId.has(id)) {
      ordered.push(byId.get(id));
      byId.delete(id);
    }
  });

  [...byId.values()]
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    .forEach((account) => ordered.push(account));

  return ordered;
}

function serializeAccount(account) {
  const total = Number(account.total_space) || 0;
  const used = Number(account.used_space) || 0;
  return {
    id: account.id,
    email: account.email,
    provider: account.provider,
    total_space: total,
    used_space: used,
    free_space: Math.max(0, total - used),
  };
}

export function createAllocationRouter() {
  const router = Router();
  router.use(requireAppUser);

  router.get('/allocation', async (req, res, next) => {
    try {
      const db = getDb();
      const config = await getAllocationConfig(db, req.user.id);
      const accounts = await getOrderedActiveAccounts(db, req.user.id);
      res.json({
        data: {
          strategy: config.strategy,
          strategies: ALLOCATION_STRATEGIES,
          accounts: accounts.map(serializeAccount),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/allocation', async (req, res, next) => {
    try {
      const body = await req._webRequest.json();
      const { strategy, order } = body || {};
      const db = getDb();
      const current = await getAllocationConfig(db, req.user.id);

      let nextStrategy = current.strategy;
      let nextOrder = current.order;

      if (strategy !== undefined) {
        if (!ALLOCATION_STRATEGIES.includes(strategy)) {
          return res.status(400).json({ error: `Invalid allocation strategy: ${strategy}` });
        }
        nextStrategy = strategy;
        await writeSetting(db, req.user.id, SETTING_KEYS.strategy, strategy);
      }

      if (order !== undefined) {
        if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) {
          return res.status(400).json({ error: 'Allocation order must be an array of account ids' });
        }
        nextOrder = order;
        await writeSetting(db, req.user.id, SETTING_KEYS.order, JSON.stringify(order));
      }

      const accounts = await getOrderedActiveAccounts(db, req.user.id);
      res.json({
        data: {
          strategy: nextStrategy,
          strategies: ALLOCATION_STRATEGIES,
          accounts: accounts.map(serializeAccount),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
