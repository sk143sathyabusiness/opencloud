import assert from 'node:assert/strict';
import { test } from 'node:test';
import { corsHeaders, parseCookies, setCookie, clearCookie } from '../middleware.js';

test('corsHeaders returns Access-Control headers', () => {
  const h = corsHeaders('http://localhost:5173');
  assert.equal(h['Access-Control-Allow-Origin'], 'http://localhost:5173');
  assert.equal(h['Access-Control-Allow-Credentials'], 'true');
  assert.ok(h['Access-Control-Allow-Methods']);
});

test('parseCookies parses cookie header', () => {
  const cookies = parseCookies('session=abc123; theme=dark');
  assert.equal(cookies.session, 'abc123');
  assert.equal(cookies.theme, 'dark');
});

test('parseCookies handles empty header', () => {
  const cookies = parseCookies('');
  assert.deepEqual(cookies, {});
});

test('setCookie builds Set-Cookie header', () => {
  const res = { _headers: new Headers(), getHeader(n) { return this._headers.get(n) ?? undefined; }, setHeader(n, v) { this._headers.set(n, v); } };
  setCookie(res, 'session', 'abc', { httpOnly: true, maxAge: 3600 });
  const cookie = res._headers.get('Set-Cookie');
  assert.ok(cookie.includes('session=abc'));
  assert.ok(cookie.includes('HttpOnly'));
});

test('clearCookie sets expired cookie', () => {
  const res = { _headers: new Headers(), getHeader(n) { return this._headers.get(n) ?? undefined; }, setHeader(n, v) { this._headers.set(n, v); } };
  clearCookie(res, 'session');
  const cookie = res._headers.get('Set-Cookie');
  assert.ok(cookie.includes('session='));
  assert.ok(cookie.includes('Max-Age=0'));
});
