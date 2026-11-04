// Stores an attachment (HWP, PDF, XLSX ...) in Vercel Blob and returns its URL. Admin only.
export const config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };
export default async function handler(req, res) {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: '관리자 키가 필요해요' });
  if (req.method !== 'POST') return res.status(405).end();
  const token = process.env.BLOB_READ_WRITE_TOKEN || Object.entries(process.env).find(([k]) => k.endsWith('READ_WRITE_TOKEN'))?.[1];
  if (!token) return res.status(503).json({ error: '파일 저장소(Blob)가 연결되지 않았어요' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  if (!b.data || !b.name) return res.status(400).json({ error: '파일이 없어요' });
  const buf = Buffer.from(b.data, 'base64');
  const safe = String(b.name).replace(/[\\/:*?"<>|#%]+/g, '_').slice(0, 150);
  const path = `files/${new Date().toISOString().slice(0, 7)}/${safe}`;
  try {
    const r = await fetch(`https://blob.vercel-storage.com/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
      method: 'PUT', body: buf,
      headers: { authorization: `Bearer ${token}`, 'x-api-version': '7', 'x-content-type': b.type || 'application/octet-stream', 'x-add-random-suffix': '1' }
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || '업로드 실패');
    return res.json({ name: b.name, url: j.url, size: buf.length });
  } catch (e) { return res.status(502).json({ error: String(e.message || e) }); }
}
