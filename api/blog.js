// Pulls the support group's Naver blog RSS so new posts appear on the site automatically. Cached 30 min.
import { hasRedis, cmd } from './_redis.js';
const BLOG = process.env.NAVER_BLOG_ID || 'support123--';
const pick = (s, tag) => { const m = s.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`)); return m ? m[1].trim() : ''; };
const strip = s => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  const ck = 'hub:blogcache';
  if (hasRedis() && !req.query.fresh) { const c = await cmd('GET', ck); if (c) return res.status(200).send(c); }
  try {
    const xml = await (await fetch(`https://rss.blog.naver.com/${BLOG}.xml`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
      const it = m[1]; const desc = pick(it, 'description');
      const img = (desc.match(/<img[^>]+src="([^"]+)"/) || [])[1] || '';
      const d = new Date(pick(it, 'pubDate'));
      return { title: strip(pick(it, 'title')), link: pick(it, 'link').split('?')[0], date: isNaN(d) ? '' : new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10), cat: strip(pick(it, 'category')), text: strip(desc).slice(0, 160), img: img.replace('http://', 'https://') };
    });
    const body = JSON.stringify({ blog: `https://blog.naver.com/${BLOG}`, posts: items });
    if (hasRedis() && items.length) await cmd('SET', ck, body, 'EX', '1800');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(body);
  } catch (e) { return res.status(502).json({ error: String(e), posts: [] }); }
}
