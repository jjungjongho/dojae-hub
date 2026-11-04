// Tiny Upstash Redis REST helper. Finds the env vars Vercel's Upstash integration creates, whatever prefix was chosen.
function find(suffix) {
  const pref = ['KV', 'UPSTASH_REDIS', 'STORAGE'];
  for (const p of pref) if (process.env[`${p}_${suffix}`]) return process.env[`${p}_${suffix}`];
  const k = Object.keys(process.env).find(k => k.endsWith(`_${suffix}`) && !k.includes('READ_ONLY'));
  return k ? process.env[k] : undefined;
}
const URL_ = find('REST_API_URL') || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = find('REST_API_TOKEN') || process.env.UPSTASH_REDIS_REST_TOKEN;
export const hasRedis = () => !!(URL_ && TOKEN);
export async function pipe(cmds) {
  const r = await fetch(`${URL_}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  return r.json();
}
export async function cmd(...args) { const [x] = await pipe([args]); return x?.result; }
