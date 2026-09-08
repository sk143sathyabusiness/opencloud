import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAuthError, isTransientError, withRetry } from '../utils/providerErrors.js';

// isAuthError tests

test('isAuthError returns true for status 401', () => {
  assert.equal(isAuthError({ status: 401 }), true);
});

test('isAuthError returns true for status 403', () => {
  assert.equal(isAuthError({ status: 403 }), true);
});

test('isAuthError returns true for statusCode 401', () => {
  assert.equal(isAuthError({ statusCode: 401 }), true);
});

test('isAuthError returns true for statusCode 403', () => {
  assert.equal(isAuthError({ statusCode: 403 }), true);
});

test('isAuthError returns true for "unauthorized_client" message', () => {
  assert.equal(isAuthError(new Error('unauthorized_client')), true);
});

test('isAuthError returns true for "invalid_grant" message', () => {
  assert.equal(isAuthError(new Error('invalid_grant')), true);
});

test('isAuthError returns true for "token expired" message', () => {
  assert.equal(isAuthError(new Error('token expired')), true);
});

test('isAuthError returns true for "token has been revoked" message', () => {
  assert.equal(isAuthError(new Error('token has been revoked')), true);
});

test('isAuthError returns true for "expired_token" message', () => {
  assert.equal(isAuthError(new Error('expired_token')), true);
});

test('isAuthError returns true for "AADSTS" message', () => {
  assert.equal(isAuthError(new Error('AADSTS50013: invalid credentials')), true);
});

test('isAuthError returns true for "invalid email or password"', () => {
  assert.equal(isAuthError(new Error('invalid email or password')), true);
});

test('isAuthError returns false for transient error', () => {
  assert.equal(isAuthError(new Error('timeout')), false);
});

test('isAuthError returns false for unrelated error', () => {
  assert.equal(isAuthError(new Error('something went wrong')), false);
});

test('isAuthError returns false for status 500', () => {
  assert.equal(isAuthError({ status: 500 }), false);
});

test('isAuthError returns false for status 429', () => {
  assert.equal(isAuthError({ status: 429 }), false);
});

// isTransientError tests

test('isTransientError returns true for status 500', () => {
  assert.equal(isTransientError({ status: 500 }), true);
});

test('isTransientError returns true for status 502', () => {
  assert.equal(isTransientError({ status: 502 }), true);
});

test('isTransientError returns true for status 503', () => {
  assert.equal(isTransientError({ status: 503 }), true);
});

test('isTransientError returns true for status 504', () => {
  assert.equal(isTransientError({ status: 504 }), true);
});

test('isTransientError returns true for status 429', () => {
  assert.equal(isTransientError({ status: 429 }), true);
});

test('isTransientError returns true for status 408', () => {
  assert.equal(isTransientError({ status: 408 }), true);
});

test('isTransientError returns true for "timeout" message', () => {
  assert.equal(isTransientError(new Error('timeout')), true);
});

test('isTransientError returns true for "ECONNRESET" message', () => {
  assert.equal(isTransientError(new Error('ECONNRESET')), true);
});

test('isTransientError returns true for "rate_limit" message', () => {
  assert.equal(isTransientError(new Error('rate_limit')), true);
});

test('isTransientError returns true for "socket hang up" message', () => {
  assert.equal(isTransientError(new Error('socket hang up')), true);
});

test('isTransientError returns true for "fetch failed" message', () => {
  assert.equal(isTransientError(new Error('fetch failed')), true);
});

test('isTransientError returns true for "temporary" message', () => {
  assert.equal(isTransientError(new Error('temporary failure')), true);
});

test('isTransientError returns true for "try again" message', () => {
  assert.equal(isTransientError(new Error('try again later')), true);
});

test('isTransientError returns true for "too many requests"', () => {
  assert.equal(isTransientError(new Error('too many requests')), true);
});

test('isTransientError returns false for auth error (401)', () => {
  assert.equal(isTransientError({ status: 401 }), false);
});

test('isTransientError returns false for auth error (403)', () => {
  assert.equal(isTransientError({ status: 403 }), false);
});

test('isTransientError returns false for unrelated error', () => {
  assert.equal(isTransientError(new Error('something went wrong')), false);
});

test('isTransientError returns false for status 404', () => {
  assert.equal(isTransientError({ status: 404 }), false);
});

test('isTransientError returns false for "invalid_grant" message (auth)', () => {
  assert.equal(isTransientError(new Error('invalid_grant')), false);
});

// withRetry tests

test('withRetry succeeds on first try', async () => {
  let callCount = 0;
  const result = await withRetry(async () => {
    callCount++;
    return 'success';
  }, { retries: 3, baseDelayMs: 10 });
  assert.equal(result, 'success');
  assert.equal(callCount, 1);
});

test('withRetry retries on transient error and eventually succeeds', async () => {
  let callCount = 0;
  const result = await withRetry(async () => {
    callCount++;
    if (callCount < 3) {
      const err = new Error('Server error');
      err.status = 500;
      throw err;
    }
    return 'success';
  }, { retries: 5, baseDelayMs: 10 });
  assert.equal(result, 'success');
  assert.equal(callCount, 3);
});

test('withRetry throws immediately on auth error (no retry)', async () => {
  let callCount = 0;
  await assert.rejects(
    () => withRetry(async () => {
      callCount++;
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }, { retries: 5, baseDelayMs: 10 }),
    /Unauthorized/,
  );
  assert.equal(callCount, 1);
});

test('withRetry throws after exhausting retries', async () => {
  let callCount = 0;
  await assert.rejects(
    () => withRetry(async () => {
      callCount++;
      const err = new Error('Server error');
      err.status = 503;
      throw err;
    }, { retries: 3, baseDelayMs: 10 }),
    /Server error/,
  );
  assert.equal(callCount, 4);
});

test('withRetry calls onRetry callback on each retry', async () => {
  const retryCalls = [];
  let callCount = 0;
  await withRetry(async () => {
    callCount++;
    if (callCount < 4) {
      const err = new Error('rate_limit');
      err.status = 429;
      throw err;
    }
    return 'ok';
  }, {
    retries: 5,
    baseDelayMs: 10,
    onRetry: (error, attempt) => {
      retryCalls.push({ message: error.message, attempt });
    },
  });
  assert.equal(retryCalls.length, 3);
  assert.equal(retryCalls[0].attempt, 1);
  assert.equal(retryCalls[1].attempt, 2);
  assert.equal(retryCalls[2].attempt, 3);
});

test('withRetry handles string errors', async () => {
  let callCount = 0;
  const result = await withRetry(async () => {
    callCount++;
    if (callCount < 2) throw 'network error';
    return 'ok';
  }, { retries: 3, baseDelayMs: 10 });
  assert.equal(result, 'ok');
  assert.equal(callCount, 2);
});
