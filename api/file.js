// Stores an attachment (HWP, PDF, XLSX ...) in Vercel Blob and returns its URL. Admin only.
import { schoolOf } from './hub.js';
export const config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };
export default async function handler(req, res) {
  const isAdmin = process.env.ADMIN_KEY && req.headers['x-admin-key'] === process.env.ADMIN_KEY;
  const school = schoolOf(req.headers['x-school-code']);
  if (!isAdmin && !school) return res.status(401).json({ error: '로그인이 필요해요' });
  if (req.method !== 'POST') return res.status(405).end();
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  if (!b.data || !b.name) return res.status(400).json({ error: '파일이 없어요' });
  const buf = Buffer.from(b.data, 'base64');
  const safe = String(b.name).replace(/[\\/:*?"<>|#%]+/g, '_').slice(0, 150);
  const path = `${school ? 'submit/' + school : 'files'}/${new Date().toISOString().slice(0, 7)}/${safe}`;
  try {
    const { put } = await import('@vercel/blob');
    const r = await put(path, buf, { access: 'public', addRandomSuffix: true, contentType: b.type || 'application/octet-stream' });
    return res.json({ name: b.name, url: r.url, size: buf.length });
  } catch (e) { return res.status(502).json({ error: String(e.message || e) }); }
}
