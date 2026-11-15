'use strict';
const $ = (s) => document.querySelector(s);
let token = sessionStorage.getItem('t'), S = null;
const say = (m) => { $('#status').textContent = m; };
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const call = async (path, method = 'GET', body) => {
  const r = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
};
const btn = (label, aria, fn) => el('button', { type: 'button', className: 'alt', textContent: label, ariaLabel: aria, onclick: fn });
const fill = (sel, items, row, empty) => $(sel).replaceChildren(...(items.length ? items.map((i) => { const [t, ...b] = row(i); return el('li', {}, t, ...b); }) : [el('li', {}, empty)]));
const act = async (p, m, b) => {
  try {
    S = await call(p, m, b); render();
    say(S.passcode ? `Passcode for the new member: ${S.passcode} (shown once, share it privately)` : 'Saved.'); delete S.passcode;
  } catch (e) { say(e.message); }
};

function render() {
  $('#auth').hidden = !!S; $('#app').hidden = !S; $('#logout').hidden = !S;
  if (!S) return;
  const edit = S.role !== 'family';
  $('#who').textContent = `${S.elder}'s care circle · code ${S.id} · signed in as ${S.me} (${S.role})`;
  $('#score').textContent = `Doses taken in the last 7 days: ${S.adherence}%`;
  fill('#today', S.today, (d) => [`${d.time} · ${d.name} ${d.dosage} — ${d.status}`, ...(edit && d.status === 'pending' ? [
    btn('Taken', `Mark ${d.name} at ${d.time} as taken`, () => act('/doses', 'POST', { medId: d.medId, date: S.date, time: d.time, status: 'taken' })),
    btn('Skip', `Skip ${d.name} at ${d.time}`, () => act('/doses', 'POST', { medId: d.medId, date: S.date, time: d.time, status: 'skipped' }))] : [])], 'No doses scheduled today.');
  fill('#meds', S.meds, (m) => [`${m.name} ${m.dosage} at ${m.times.join(', ')}${m.stock ? ` · ${m.stock} left` : ''}`, ...(edit ? [btn('Remove', `Remove ${m.name}`, () => act(`/meds/${m.id}`, 'DELETE'))] : [])], 'No medicines added yet.');
  fill('#appts', S.appts, (a) => [`${a.at.replace('T', ' ')} · ${a.title}${a.doctor ? ` with ${a.doctor}` : ''}`, ...(edit ? [btn('Remove', `Remove ${a.title}`, () => act(`/appts/${a.id}`, 'DELETE'))] : [])], 'No upcoming appointments.');
  fill('#members', S.members, (m) => [`${m.name} (${m.role}) ${m.email || ''}`, ...(m.role !== 'owner' ? [btn('Remove', `Remove ${m.name}`, () => act(`/members/${m.id}`, 'DELETE'))] : [])], 'Only you so far.');
  fill('#outbox', S.outbox, (o) => [`${o.subject} → ${o.to.join(', ')}`], 'No reminder emails yet.');
  $('#editor').hidden = !edit; $('#ownerOnly').hidden = S.role !== 'owner';
}

const refresh = async () => { try { S = await call('/state'); } catch { S = null; token = null; sessionStorage.removeItem('t'); } render(); };
async function enter(path, b) {
  try {
    const r = await (await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
    if (!r.token) throw new Error(r.error || 'Could not sign in');
    token = r.token; sessionStorage.setItem('t', token); await refresh();
    say(path === '/circles' ? `Your circle code is ${r.circleId}. Keep it with your passcode.` : 'Signed in.');
  } catch (e) { say(e.message); }
}
const onSubmit = (sel, fn) => $(sel).addEventListener('submit', async (e) => { e.preventDefault(); await fn(Object.fromEntries(new FormData(e.target))); e.target.reset(); });

onSubmit('#formLogin', (b) => enter('/login', b));
onSubmit('#formCreate', (b) => enter('/circles', { ...b, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }));
onSubmit('#formMed', (b) => act('/meds', 'POST', { ...b, times: b.times.split(',').map((t) => t.trim()) }));
onSubmit('#formAppt', (b) => act('/appts', 'POST', b));
onSubmit('#formMember', (b) => act('/members', 'POST', b));
$('#logout').onclick = () => { token = null; S = null; sessionStorage.removeItem('t'); render(); say('Signed out.'); };
$('#big').onclick = (e) => { e.target.setAttribute('aria-pressed', document.body.classList.toggle('big')); };
$('#speak').onclick = () => {
  const t = `Today for ${S.elder}. ${S.today.map((d) => `${d.time}, ${d.name}, ${d.status}`).join('. ') || 'No medicines today.'}`;
  speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(t));
};
$('#sum').onclick = async () => { say('Preparing summary…'); try { say((await call('/summary')).summary); } catch (e) { say(e.message); } };
if (token) refresh();
setInterval(() => token && refresh(), 60000);
