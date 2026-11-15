'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET = process.env.APP_SECRET || crypto.randomBytes(32).toString('hex');
const DATA_FILE = process.env.DATA_FILE || path.join(process.env.DATA_DIR || '/tmp', 'aegiscare.json');
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- storage (JSON file; swap for Firestore in production) ----------
let db = { circles: {} };
let timer;
const load = () => { try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { db = { circles: {} }; } };
const save = () => { clearTimeout(timer); timer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(db), () => {}), 200); timer.unref(); };

// ---------- security ----------
const uid = () => crypto.randomBytes(5).toString('hex');
const hash = (pw) => { const s = crypto.randomBytes(16).toString('hex'); return `${s}:${crypto.scryptSync(pw, s, 32).toString('hex')}`; };
const check = (pw, h) => { const [s, k] = h.split(':'); return crypto.timingSafeEqual(crypto.scryptSync(pw, s, 32), Buffer.from(k, 'hex')); };
const mac = (b) => crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
const sign = (p) => { const b = Buffer.from(JSON.stringify(p)).toString('base64url'); return `${b}.${mac(b)}`; };
const verify = (t) => {
  const [b, m] = String(t).split('.');
  if (!b || !m || m.length !== mac(b).length || !crypto.timingSafeEqual(Buffer.from(m), Buffer.from(mac(b)))) return null;
  const p = JSON.parse(Buffer.from(b, 'base64url'));
  return p.exp > Date.now() ? p : null;
};
const hits = new Map();
const limited = (ip) => { const n = Date.now(), h = (hits.get(ip) || []).filter((t) => n - t < 6e4); h.push(n); hits.set(ip, h); return h.length > 10; };

// ---------- validation ----------
const str = (v, max = 80) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
const validTz = (z) => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return z; } catch { return 'Asia/Kolkata'; } };
function parseMed(b) {
  const name = str(b.name), dosage = str(b.dosage, 40);
  const times = Array.isArray(b.times) ? [...new Set(b.times)].filter((t) => TIME.test(t)).slice(0, 8).sort() : [];
  if (!name || !dosage || !times.length) return null;
  return { name, dosage, times, stock: Math.max(0, parseInt(b.stock, 10) || 0), refillAt: Math.max(0, parseInt(b.refillAt, 10) || 5) };
}

// ---------- scheduling ----------
const localNow = (tz, d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute, ts: Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) };
};
const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const shift = (date, n) => new Date(Date.parse(date) + n * 864e5).toISOString().slice(0, 10);
const dosesFor = (c, date) => c.meds.filter((m) => m.start <= date)
  .flatMap((m) => m.times.map((time) => { const key = `${m.id}|${date}|${time}`; return { key, medId: m.id, name: m.name, dosage: m.dosage, time, status: c.logs[key]?.status || 'pending' }; }))
  .sort((a, b) => a.time.localeCompare(b.time));
function adherence(c, now) {
  let due = 0, taken = 0;
  for (let i = 0; i < 7; i++) {
    for (const x of dosesFor(c, shift(now.date, -i))) {
      if (i === 0 && toMin(x.time) > now.min) continue;
      due++; if (x.status === 'taken') taken++;
    }
  }
  return due ? Math.round((100 * taken) / due) : 100;
}

// ---------- email (SMTP if configured, always kept in a demo outbox) ----------
const outbox = [];
let transport;
const emails = (c) => [...new Set(c.members.map((m) => m.email).filter(Boolean))];
async function mail(to, subject, text) {
  outbox.unshift({ to, subject, text, at: new Date().toISOString() });
  outbox.length = Math.min(outbox.length, 30);
  if (!process.env.SMTP_HOST) return;
  try {
    transport ||= require('nodemailer').createTransport({ host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    await transport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: to.join(','), subject, text });
  } catch (e) { console.error('mail failed:', e.message); }
}

// Reminder engine: upcoming dose (10 min before) -> elder; missed dose (30+ min) -> whole circle; appointments 24h / 2h before.
async function tick(date = new Date()) {
  for (const c of Object.values(db.circles)) {
    const t = localNow(c.tz, date);
    const once = (k) => (c.sent[k] ? false : (c.sent[k] = 1));
    for (const x of dosesFor(c, t.date)) {
      if (x.status !== 'pending') continue;
      const d = t.min - toMin(x.time);
      if (d >= -10 && d < 0 && once(`u${x.key}`)) await mail([c.email], `Upcoming dose: ${x.name}`, `It is almost time for ${x.name} (${x.dosage}) at ${x.time}.`);
      if (d >= 30 && d < 360 && once(`m${x.key}`)) await mail(emails(c), `Missed dose: ${c.elder}`, `${c.elder} has not confirmed ${x.name} (${x.dosage}) due at ${x.time}.`);
    }
    for (const a of c.appts) {
      const d = (Date.parse(`${a.at}:00Z`) - t.ts) / 6e4;
      if (d > 0 && d <= 1440 && once(`a1${a.id}`)) await mail(emails(c), `Appointment within 24h: ${a.title}`, `${c.elder}: ${a.title}${a.doctor ? ` with ${a.doctor}` : ''} at ${a.at.replace('T', ' ')}.`);
      if (d > 0 && d <= 120 && once(`a2${a.id}`)) await mail(emails(c), `Appointment in 2 hours: ${a.title}`, `${c.elder}: ${a.title} at ${a.at.replace('T', ' ')}.`);
    }
  }
  save();
}

// ---------- AI family summary (Gemini if key present, else rule-based) ----------
async function summary(c, now) {
  const low = c.meds.filter((m) => m.stock > 0 && m.stock <= m.refillAt).map((m) => m.name);
  const facts = `${c.elder} took ${adherence(c, now)}% of doses in the last 7 days. Upcoming appointments: ${c.appts.filter((a) => a.at.slice(0, 10) >= now.date).length}. Low stock: ${low.join(', ') || 'none'}.`;
  if (!process.env.GEMINI_API_KEY) return facts;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || 'gemini-2.5-flash'}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: `Write a warm, 3-sentence plain-language update for family members. Give no medical advice.\n${facts}` }] }] }),
    });
    return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text || facts;
  } catch { return facts; }
}

// ---------- http ----------
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((ok, no) => {
  let s = '';
  req.on('data', (d) => { s += d; if (s.length > 1e5) { req.destroy(); no(new Error('big body')); } });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(new Error('bad json')); } });
});
const session = (c, m) => ({ token: sign({ c: c.id, m: m.id, exp: Date.now() + 12 * 36e5 }), circleId: c.id });
const view = (c, m, now) => ({
  id: c.id, elder: c.elder, role: m.role, me: m.name, date: now.date,
  meds: c.meds, today: dosesFor(c, now.date), adherence: adherence(c, now),
  appts: c.appts.filter((a) => a.at.slice(0, 10) >= now.date).sort((a, b) => a.at.localeCompare(b.at)),
  members: m.role === 'owner' ? c.members.map(({ id, name, role, email }) => ({ id, name, role, email })) : [],
  outbox: m.role === 'owner' ? outbox.filter((o) => o.to.some((e) => emails(c).includes(e))) : [],
});

function serve(p, res) {
  const f = path.resolve(PUBLIC, `.${p === '/' ? '/index.html' : p}`);
  if (!f.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(f, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function api(req, res, p) {
  const m = req.method;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress;
  if (m === 'POST' && p === '/api/cron/tick') {
    if (!process.env.CRON_SECRET || req.headers['x-cron-secret'] !== process.env.CRON_SECRET) return send(res, 401, { error: 'Unauthorized' });
    await tick(); return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/circles') {
    if (limited(ip)) return send(res, 429, { error: 'Too many attempts, wait a minute' });
    const b = await body(req), elder = str(b.elder), email = str(b.email, 120), pw = str(b.passcode, 64);
    if (!elder || !EMAIL.test(email || '') || !pw || pw.length < 6) return send(res, 400, { error: 'Name, valid email and a passcode of 6+ characters are required' });
    const c = { id: crypto.randomBytes(3).toString('hex').toUpperCase(), elder, email, tz: validTz(b.tz), meds: [], appts: [], logs: {}, sent: {}, members: [{ id: uid(), name: elder, email, role: 'owner', hash: hash(pw) }] };
    db.circles[c.id] = c; save();
    return send(res, 201, session(c, c.members[0]));
  }
  if (m === 'POST' && p === '/api/login') {
    if (limited(ip)) return send(res, 429, { error: 'Too many attempts, wait a minute' });
    const b = await body(req), c = db.circles[String(b.circleId || '').toUpperCase()];
    const mem = c && typeof b.passcode === 'string' && c.members.find((x) => check(b.passcode, x.hash));
    return mem ? send(res, 200, session(c, mem)) : send(res, 401, { error: 'Wrong circle code or passcode' });
  }

  const t = verify((req.headers.authorization || '').slice(7));
  const c = t && db.circles[t.c], mem = c && c.members.find((x) => x.id === t.m);
  if (!mem) return send(res, 401, { error: 'Please sign in' });
  const now = localNow(c.tz), edit = mem.role !== 'family';
  if (m === 'GET' && p === '/api/state') return send(res, 200, view(c, mem, now));
  if (m === 'GET' && p === '/api/summary') return send(res, 200, { summary: await summary(c, now) });
  if (!edit && m !== 'GET') return send(res, 403, { error: 'View-only access' });

  if (m === 'POST' && p === '/api/doses') {
    const b = await body(req), date = DATE.test(b.date) ? b.date : now.date;
    const x = dosesFor(c, date).find((d) => d.key === `${b.medId}|${date}|${b.time}`);
    if (!x || !['taken', 'skipped'].includes(b.status)) return send(res, 400, { error: 'Unknown dose' });
    c.logs[x.key] = { status: b.status, by: mem.name, at: new Date().toISOString() };
    const med = c.meds.find((q) => q.id === b.medId);
    if (b.status === 'taken' && med.stock > 0 && --med.stock <= med.refillAt) mail(emails(c), `Refill needed: ${med.name}`, `Only ${med.stock} dose(s) of ${med.name} remain for ${c.elder}.`);
    save(); return send(res, 200, view(c, mem, now));
  }
  const r = p.match(/^\/api\/(meds|appts|members)(?:\/([\w-]+))?$/);
  if (!r) return send(res, 404, { error: 'Not found' });
  if (r[1] === 'members' && mem.role !== 'owner') return send(res, 403, { error: 'Only the owner manages members' });
  let extra = {};
  if (m === 'POST' && !r[2]) {
    const b = await body(req);
    if (r[1] === 'meds') {
      const x = parseMed(b); if (!x) return send(res, 400, { error: 'Name, dosage and valid times (HH:MM) are required' });
      c.meds.push({ id: uid(), start: now.date, ...x });
    } else if (r[1] === 'appts') {
      const title = str(b.title); if (!title || !DATETIME.test(b.at)) return send(res, 400, { error: 'Title and date/time are required' });
      c.appts.push({ id: uid(), title, doctor: String(b.doctor || '').slice(0, 60), at: b.at });
    } else {
      const name = str(b.name), email = str(b.email, 120);
      if (!name || !EMAIL.test(email || '') || !['caretaker', 'family'].includes(b.role)) return send(res, 400, { error: 'Name, email and role are required' });
      const pw = crypto.randomBytes(4).toString('hex');
      c.members.push({ id: uid(), name, email, role: b.role, hash: hash(pw) }); extra = { passcode: pw };
    }
  } else if (m === 'DELETE' && r[2]) {
    c[r[1]] = c[r[1]].filter((x) => x.id !== r[2] || x.role === 'owner');
  } else return send(res, 405, { error: 'Method not allowed' });
  save(); return send(res, 201, { ...view(c, mem, now), ...extra });
}

async function handle(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
  if (p === '/healthz') return send(res, 200, { ok: true });
  return p.startsWith('/api/') ? api(req, res, p) : serve(p, res);
}

function createServer() {
  load();
  return http.createServer((req, res) => handle(req, res).catch((e) => send(res, /json|big/.test(e.message) ? 400 : 500, { error: 'Request failed' })));
}

module.exports = { createServer, tick, localNow, dosesFor, adherence, parseMed, hash, check, sign, verify };

if (require.main === module) {
  createServer().listen(process.env.PORT || 8080, () => console.log('AegisCare running'));
  setInterval(() => tick().catch((e) => console.error(e)), 60000);
}
