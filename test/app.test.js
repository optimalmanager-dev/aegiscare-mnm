'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
process.env.DATA_FILE = path.join(os.tmpdir(), `aegis-${Date.now()}.json`);
const app = require('../server');

test('parseMed validates input', () => {
  assert.strictEqual(app.parseMed({ name: '', dosage: '1', times: ['08:00'] }), null);
  assert.strictEqual(app.parseMed({ name: 'A', dosage: '1', times: ['25:00'] }), null);
  assert.deepStrictEqual(app.parseMed({ name: 'A', dosage: '1', times: ['20:00', '08:00'] }).times, ['08:00', '20:00']);
});
test('passcode hashing', () => {
  const h = app.hash('secret123');
  assert.ok(app.check('secret123', h));
  assert.ok(!app.check('wrong', h));
});
test('tokens reject tampering and expiry', () => {
  const t = app.sign({ c: 'X', exp: Date.now() + 1000 });
  assert.ok(app.verify(t));
  assert.strictEqual(app.verify(`${t}x`), null);
  assert.strictEqual(app.verify(app.sign({ c: 'X', exp: 1 })), null);
});
test('adherence calculation', () => {
  const c = { meds: [{ id: 'a', name: 'x', dosage: '1', start: '2000-01-01', times: ['08:00'] }], logs: {} };
  const now = { date: '2026-01-10', min: 600 };
  assert.strictEqual(app.adherence(c, now), 0);
  c.logs['a|2026-01-10|08:00'] = { status: 'taken' };
  assert.strictEqual(app.adherence(c, now), 14);
});
test('API: owner edits, family is view-only', async () => {
  const s = app.createServer().listen(0);
  const base = `http://127.0.0.1:${s.address().port}`;
  const post = (p, b, tok) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: `Bearer ${tok}` }) }, body: JSON.stringify(b) });
  try {
    const own = await (await post('/api/circles', { elder: 'Asha', email: 'asha@example.com', passcode: 'secret123' })).json();
    const med = await post('/api/meds', { name: 'Metformin', dosage: '500mg', times: ['08:00'] }, own.token);
    assert.strictEqual(med.status, 201);
    const inv = await (await post('/api/members', { name: 'Ravi', email: 'ravi@example.com', role: 'family' }, own.token)).json();
    const fam = await (await post('/api/login', { circleId: own.circleId, passcode: inv.passcode })).json();
    assert.strictEqual((await post('/api/meds', { name: 'X', dosage: '1', times: ['09:00'] }, fam.token)).status, 403);
    assert.strictEqual((await post('/api/login', { circleId: own.circleId, passcode: 'nope' })).status, 401);
    assert.strictEqual((await fetch(`${base}/api/state`)).status, 401);
  } finally { s.close(); }
});
