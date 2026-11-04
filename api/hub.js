// Backend for the apprenticeship support-group site. One endpoint, action in ?a=.
// Data lives in Upstash Redis hashes (hub:<collection>), one JSON value per id.
import crypto from 'node:crypto';
import { hasRedis, pipe, cmd } from './_redis.js';

export const SCHOOLS = ['ggm', 'kwai', 'dukil', 'mungok', 'magnet', 'design', 'seoil', 'yongsan', 'eunpyeong', 'mobility'];
const ADMIN = process.env.ADMIN_KEY;
const SALT = process.env.SCHOOL_SALT || 'dojae';
export const codeOf = id => id.toUpperCase().slice(0, 3) + '-' + crypto.createHash('sha256').update(id + SALT).digest('hex').slice(0, 4).toUpperCase();
export const schoolOf = code => SCHOOLS.find(id => codeOf(id) === String(code || '').trim().toUpperCase());
const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const now = () => new Date().toISOString();

async function all(col) {
  const h = (await cmd('HGETALL', 'hub:' + col)) || [];
  const out = [];
  for (let i = 0; i < h.length; i += 2) { try { out.push(JSON.parse(h[i + 1])); } catch {} }
  return out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}
const put = (col, obj) => cmd('HSET', 'hub:' + col, obj.id, JSON.stringify(obj));
const get = async (col, id) => { const v = await cmd('HGET', 'hub:' + col, id); return v ? JSON.parse(v) : null; };
const clip = (s, n = 2000) => String(s ?? '').slice(0, n);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!hasRedis()) return res.status(503).json({ error: 'Redis가 연결되지 않았어요 (Vercel Storage에서 Upstash 연결 필요)' });
  const a = req.query.a;
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const isAdmin = ADMIN && (req.headers['x-admin-key'] === ADMIN);
  const toggles = JSON.parse((await cmd('GET', 'hub:toggles')) || '{}');

  // ---------- public ----------
  if (a === 'public') {
    const [notices, events, logs] = await Promise.all([all('notice'), all('event'), all('log')]);
    const y = String(new Date().getFullYear()), cats = {};
    let total = 0; logs.filter(l => String(l.date || l.at || '').startsWith(y)).forEach(l => { const c = +l.count || 1; total += c; cats[l.cat || '기타'] = (cats[l.cat || '기타'] || 0) + c; });
    return res.json({ notices: notices.filter(n => n.audience === 'all' && !n.schools?.length).slice(0, 20), events: events.filter(e => e.public), toggles, stats: { year: y, total, cats } });
  }
  if (a === 'consult' && req.method === 'POST') {
    if (!b.consent || !SCHOOLS.includes(b.school) || !b.phone) return res.status(400).json({ error: '필수 항목을 확인해 주세요' });
    const o = { id: newId(), at: now(), school: b.school, name: clip(b.name, 30), phone: clip(b.phone, 30), field: clip(b.field, 50), grade: clip(b.grade, 20), msg: clip(b.msg, 500), status: '접수' };
    await put('consult', o);
    return res.json({ ok: true });
  }

  // ---------- school (invite code) ----------
  if (a === 'login') { const s = schoolOf(b.code); return s ? res.json({ school: s }) : res.status(401).json({ error: '코드가 맞지 않아요' }); }
  const school = schoolOf(req.headers['x-school-code']);
  if (['school', 'confirm', 'request', 'consults', 'submit'].includes(a) && !school) return res.status(401).json({ error: '학교 코드가 필요해요' });
  if (a === 'school') {
    const [notices, events, requests, confirms, submits] = await Promise.all([all('notice'), all('event'), all('request'), all('confirm'), all('submit')]);
    const mine = new Set(confirms.filter(c => c.school === school).map(c => c.notice));
    return res.json({ school, toggles,
      notices: notices.filter(n => n.audience !== 'internal' && (!n.schools?.length || n.schools.includes(school))).map(n => ({ ...n, confirmed: mine.has(n.id) })),
      events: events.filter(e => !e.schools?.length || e.schools.includes(school)),
      requests: requests.filter(r => r.school === school), submits: submits.filter(x => x.school === school) });
  }
  if (a === 'confirm' && req.method === 'POST') {
    const id = school + ':' + clip(b.notice, 40);
    await cmd('HSET', 'hub:confirm', id, JSON.stringify({ id, at: now(), school, notice: b.notice }));
    return res.json({ ok: true });
  }
  if (a === 'request' && req.method === 'POST') {
    if (toggles[b.type] === false) return res.status(400).json({ error: '지금은 받지 않는 요청이에요' });
    const o = { id: newId(), at: now(), school, type: clip(b.type, 40), date: clip(b.date, 20), detail: clip(b.detail, 1500), status: '접수', reply: '' };
    await put('request', o);
    return res.json({ ok: true });
  }
  if (a === 'submit' && req.method === 'POST') {
    const files = (Array.isArray(b.files) ? b.files : []).slice(0, 20).map(f => ({ name: clip(f.name, 200), url: clip(f.url, 600) })).filter(f => /^https:\/\//.test(f.url));
    if (!files.length) return res.status(400).json({ error: '파일을 골라주세요' });
    const o = { id: newId(), at: now(), school, kind: clip(b.kind, 40), notice: clip(b.notice, 40), noticeTitle: clip(b.noticeTitle, 200), memo: clip(b.memo, 1000), files, status: '접수', reply: '' };
    await put('submit', o); return res.json({ ok: true });
  }
  if (a === 'consults') return res.json({ consults: (await all('consult')).filter(c => c.school === school) });

  // ---------- admin ----------
  if (!isAdmin) return res.status(401).json({ error: '관리자 키가 필요해요' });
  if (a === 'admin') {
    const [notices, events, requests, confirms, consults, logs, submits] = await Promise.all(['notice', 'event', 'request', 'confirm', 'consult', 'log', 'submit'].map(all));
    return res.json({ notices, events, requests, confirms, consults, logs, submits, toggles, codes: Object.fromEntries(SCHOOLS.map(s => [s, codeOf(s)])) });
  }
  if (req.method !== 'POST') return res.status(405).end();
  if (a === 'notice') { const o = { id: b.id || newId(), at: b.at || now(), title: clip(b.title, 200), body: clip(b.body, 5000), deadline: clip(b.deadline, 20), audience: ['all', 'teachers', 'internal'].includes(b.audience) ? b.audience : 'teachers', link: clip(b.link, 500), schools: (Array.isArray(b.schools) ? b.schools : []).filter(x => SCHOOLS.includes(x)), files: (Array.isArray(b.files) ? b.files : []).slice(0, 20).map(f => ({ name: clip(f.name, 200), url: clip(f.url, 600) })).filter(f => /^https:\/\//.test(f.url)) }; await put('notice', o); return res.json(o); }
  if (a === 'event') { const o = { id: b.id || newId(), at: now(), title: clip(b.title, 200), kind: clip(b.kind, 40), date: clip(b.date, 20), time: clip(b.time, 20), place: clip(b.place, 200), prepare: clip(b.prepare, 1000), schools: (b.schools || []).filter(s => SCHOOLS.includes(s)), public: !!b.public }; await put('event', o); return res.json(o); }
  if (a === 'log') { const o = { id: b.id || newId(), at: now(), date: clip(b.date, 20), cat: clip(b.cat, 60), school: SCHOOLS.includes(b.school) ? b.school : '', company: clip(b.company, 100), note: clip(b.note, 1000), count: Math.max(1, +b.count || 1) }; await put('log', o); return res.json(o); }
  if (a === 'reqstatus') { const r = await get('request', b.id); if (!r) return res.status(404).end(); r.status = clip(b.status, 20); r.reply = clip(b.reply, 1000); await put('request', r);
    if (r.status === '완료') await put('log', { id: 'req-' + r.id, at: now(), date: now().slice(0, 10), cat: '학교 지원 요청 처리', school: r.school, note: r.type + ' · ' + r.detail.slice(0, 80), count: 1 });
    return res.json(r); }
  if (a === 'submitstatus') { const x = await get('submit', b.id); if (!x) return res.status(404).end(); x.status = clip(b.status, 20); x.reply = clip(b.reply, 1000); await put('submit', x); return res.json(x); }
  if (a === 'consultstatus') { const c = await get('consult', b.id); if (!c) return res.status(404).end(); c.status = clip(b.status, 20); await put('consult', c); return res.json(c); }
  if (a === 'toggles') { await cmd('SET', 'hub:toggles', JSON.stringify(b || {})); return res.json({ ok: true }); }
  if (a === 'del') { if (!['notice', 'event', 'log', 'request', 'consult', 'submit'].includes(b.col)) return res.status(400).end(); await cmd('HDEL', 'hub:' + b.col, b.id); return res.json({ ok: true }); }
  res.status(400).json({ error: 'unknown action' });
}
