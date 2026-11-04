// Reads uploaded 공문 PDFs with an AI model and proposes notices, events and support logs.
// Admin only. Uses ANTHROPIC_API_KEY (Claude) if set, otherwise GEMINI_API_KEY.
import { hasRedis, cmd } from './_redis.js';
const stat = async k => { try { if (hasRedis()) await cmd('HINCRBY', 'hub:aistat', new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7) + ':' + k, '1'); } catch {} };
import { schoolOf } from './hub.js';
export const config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };

const SCHOOLS = { ggm: '경기기계공업고등학교', kwai: '광운인공지능고등학교', dukil: '덕일전자공업고등학교', mungok: '문곡고등학교', magnet: '서울매그넷고등학교', design: '서울디자인고등학교', seoil: '서일문화예술고등학교', yongsan: '용산철도고등학교', eunpyeong: '은평메디텍고등학교', mobility: '한국모빌리티고등학교(구 의정부공업고등학교)' };
const CATS = ['학습기업 발굴지원', '신기술체험캠프', '산업안전 지원', 'AI 활용 지원', '지원단 간 협업', '경력개발 지원(P-TECH·4년제 연계)', '전담인력 전문성 강화', '커뮤니티 운영', '도제준비과정 운영지원(잡데이·컨설팅·기업투어)', '방문 모니터링·유선/방문 컨설팅', '도제학교·일학습병행 홍보', '운영위원회 개최', '기타'];
const KINDS = ['현장실사', '기업 발굴 방문', '학교 컨설팅', '공단 점검', '커뮤니티', '연수·설명회', '신기술체험캠프', '잡데이·기업투어', '운영위원회', '기타'];

const PROMPT = (today) => `너는 고교단계 일학습병행 지원단(한양여대)의 업무 보조다. 첨부된 공문과 붙임 문서를 읽고, 지원단 홈페이지에 올릴 항목을 JSON으로만 답하라. 오늘 날짜: ${today}.
학교 id 목록: ${JSON.stringify(SCHOOLS)}
실적 항목(cat): ${JSON.stringify(CATS)}
일정 종류(kind): ${JSON.stringify(KINDS)}
규칙:
- notice: 반드시 1개 만든다(null 금지). title은 공문 제목을 짧게. body는 핵심 3줄 + 학교가 할 일이 있으면 "학교가 할 일: ..."을 줄바꿈으로. 제출·참여 기한이 있으면 deadline(YYYY-MM-DD). audience: 학생·학부모 등 누구나 알아도 되는 내용이면 "all", 도제학교 선생님이 알아야 하면 "teachers", 지원단 내부 행정(예산, 사업비, 식사권, 내부 보고 등)이면 "internal". 붙임이 없어 내용을 알 수 없어도 공문 본문만으로 요약한다.
- events: 날짜가 정해진 행사·실사·회의·연수·설명회. date(YYYY-MM-DD), time(HH:MM 또는 ""), place, kind, schools(해당 학교 id 배열, 전체면 []), prepare(학교가 준비할 것), public(학생·학부모 공개 행사면 true).
- logs: 이 공문이 지원단이 이미 수행한 활동의 결과보고·실적이면 실적 기록. date, cat, school(id 또는 ""), company(기업명 또는 ""), note(한 줄), count(횟수).
- 개인 이름·전화번호·학생 정보는 넣지 마라. 확실하지 않은 날짜는 만들지 말고 비워라.
형식: {"summary":"이 공문이 무엇인지 한 줄","notice":{...}|null,"events":[...],"logs":[...]}`;

const WEEK = (today) => `너는 고교단계 일학습병행 지원단(한양여대)의 업무 보조다. 아래는 직원들이 센터장에게 보낸 주간 업무 일정 메시지들이다(같은 주의 처음 안내와 변경 안내가 섞여 있을 수 있음). 오늘: ${today}.
학교 id: ${JSON.stringify(SCHOOLS)}
일정 종류(kind): ${JSON.stringify(KINDS)}
규칙:
- 직원별로 나누지 말고 하나로 합친다. 같은 날 같은 활동은 1개로 합친다. 변경 안내가 있으면 나중 메시지를 따른다(빠진 일정은 제외).
- 직원 이름, 연차, 휴가, 건강검진, 근무예정일 같은 개인 일정은 절대 넣지 않는다.
- events: 활동마다 1개. title(짧게), date(YYYY-MM-DD, 연도는 오늘 기준), time(""), place, kind, schools(관련 관할학교 id, 없으면 []), prepare(""), public(박람회·홍보 행사면 true).
- notice: title "이번 주 지원단 일정 (M/D~M/D)", body는 날짜순으로 "11/04(수) 활동, 활동" 한 줄씩, audience "teachers".
형식: {"summary":"한 줄","notice":{...},"events":[...],"logs":[]}`;

function parseJSON(t) { const m = String(t).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; }

export default async function handler(req, res) {
  const isAdmin = process.env.ADMIN_KEY && req.headers['x-admin-key'] === process.env.ADMIN_KEY;
  const school = schoolOf(req.headers['x-school-code']);
  const bb = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  if (!isAdmin && school && ['check', 'ask', 'report'].includes(bb.mode)) return schoolAI(req, res, school, bb);
  if (!isAdmin) return res.status(401).json({ error: '로그인이 필요해요' });
  if (req.method !== 'POST') return res.status(405).end();
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  if (b.text) return run(res, [{ type: 'text', text: WEEK(new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)) + '\n\n---\n' + String(b.text).slice(0, 20000) }], [{ text: WEEK(new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)) + '\n\n---\n' + String(b.text).slice(0, 20000) }]);
  const files = (b.files || []).filter(f => f && f.data).slice(0, 5);
  if (!files.length) return res.status(400).json({ error: 'PDF 파일을 올려주세요' });
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  try {
    let text;
    if (process.env.ANTHROPIC_API_KEY) {
      const content = [...files.map(f => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } })), { type: 'text', text: PROMPT(today) }];
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: process.env.AI_MODEL || 'claude-sonnet-5-5', max_tokens: 4000, messages: [{ role: 'user', content }] }) });
      const j = await r.json(); if (!r.ok) throw new Error(j?.error?.message || 'AI 오류');
      text = j.content.map(c => c.text || '').join('');
    } else if (process.env.GEMINI_API_KEY) {
      const parts = [...files.map(f => ({ inline_data: { mime_type: 'application/pdf', data: f.data } })), { text: PROMPT(today) }];
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.AI_MODEL || 'gemini-2.5-flash'}:generateContent?key=${process.env.GEMINI_API_KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json' } }) });
      const j = await r.json(); if (!r.ok) throw new Error(j?.error?.message || 'AI 오류');
      text = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    } else return res.status(503).json({ error: 'AI 키가 없어요 (Vercel 환경변수 ANTHROPIC_API_KEY 또는 GEMINI_API_KEY)' });
    const out = parseJSON(text);
    if (!out) return res.status(502).json({ error: 'AI 답을 읽지 못했어요. 다시 시도해 주세요' });
    await stat('doc');
    return res.json(out);
  } catch (e) { return res.status(502).json({ error: String(e.message || e) }); }
}

async function run(res, content, parts, key) {
  try {
    let text;
    if (process.env.ANTHROPIC_API_KEY) {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: process.env.AI_MODEL || 'claude-sonnet-5-5', max_tokens: 4000, messages: [{ role: 'user', content }] }) });
      const j = await r.json(); if (!r.ok) throw new Error(j?.error?.message || 'AI 오류'); text = j.content.map(c => c.text || '').join('');
    } else if (process.env.GEMINI_API_KEY) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.AI_MODEL || 'gemini-2.5-flash'}:generateContent?key=${process.env.GEMINI_API_KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json' } }) });
      const j = await r.json(); if (!r.ok) throw new Error(j?.error?.message || 'AI 오류'); text = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    } else return res.status(503).json({ error: 'AI 키가 없어요' });
    const out = parseJSON(text); if (!out) return res.status(502).json({ error: 'AI 답을 읽지 못했어요' });
    await stat(key || 'week');
    return res.json(out);
  } catch (e) { return res.status(502).json({ error: String(e.message || e) }); }
}

const KIND_HINT = {
  '자체점검표': '학교명, 점검일, 점검자, 모든 점검 항목의 체크 여부, 미흡 항목의 개선 계획, 서명·날인',
  '날인지·서명지': '행사명, 날짜, 참석자 소속, 서명 칸 누락, 날인 여부',
  '결과보고서': '행사명, 일시, 장소, 대상·참석 인원, 추진 내용, 성과(숫자), 개선점, 사진 등 증빙, 작성일·작성자',
  '신청서': '신청 기관, 담당자, 신청 내용, 날짜, 서명',
};
async function schoolAI(req, res, school, b) {
  const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  if (hasRedis()) { const n = await cmd('HINCRBY', 'hub:ailimit:' + day, school, '1'); await cmd('EXPIRE', 'hub:ailimit:' + day, '172800'); if (+n > 40) return res.status(429).json({ error: '오늘 AI 사용 횟수를 다 썼어요. 내일 다시 써주세요' }); }
  const files = (b.files || []).filter(f => f && f.data).slice(0, 6);
  const docs = files.map(f => /pdf/i.test(f.type || f.name) ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } } : { type: 'image', source: { type: 'base64', media_type: /png/i.test(f.type) ? 'image/png' : 'image/jpeg', data: f.data } });
  const parts = files.map(f => ({ inline_data: { mime_type: /pdf/i.test(f.type || f.name) ? 'application/pdf' : (/png/i.test(f.type) ? 'image/png' : 'image/jpeg'), data: f.data } }));
  const base = `너는 한양여대 고교단계 일학습병행 지원단이 산학일체형 도제학교 선생님을 돕기 위해 만든 AI 도우미다. 오늘: ${day}. 쉬운 존댓말로 답한다. 학생 개인정보는 출력하지 않는다.`;
  let prompt;
  if (b.mode === 'check') {
    if (!files.length) return res.status(400).json({ error: 'PDF나 사진을 올려주세요 (한글 파일은 PDF로 저장)' });
    prompt = `${base}
선생님이 지원단에 제출하기 전에 "${b.kind || '서류'}"를 점검해 달라고 했다. 이 서류에 보통 필요한 항목: ${KIND_HINT[b.kind] || '제목, 날짜, 작성자, 주요 내용, 서명'}.
빠진 칸, 날짜 오류(요일 불일치·미래 날짜·기간 역전), 합계 오류, 서명·날인 누락, 학교명 불일치를 찾아라. 확실하지 않으면 "확인 필요"로 적는다.
JSON만: {"ok":true|false,"summary":"한 줄 총평","issues":[{"where":"위치","problem":"문제","fix":"고치는 방법"}]}`;
  } else if (b.mode === 'ask') {
    const q = String(b.q || '').slice(0, 1500); if (!q.trim()) return res.status(400).json({ error: '질문을 입력해 주세요' });
    let ctx = '';
    try { if (hasRedis()) { const h = (await cmd('HGETALL', 'hub:notice')) || []; const N = []; for (let i = 0; i < h.length; i += 2) { try { const n = JSON.parse(h[i + 1]); if (n.audience !== 'internal') N.push(n); } catch {} } ctx = N.sort((a, c) => String(c.at).localeCompare(String(a.at))).slice(0, 25).map(n => `- [${String(n.at).slice(0, 10)}] ${n.title}: ${String(n.body).slice(0, 400)}`).join('\n'); } } catch {}
    prompt = `${base}
아래는 지원단이 올린 최근 공지다. 공지에 근거가 있으면 그것을 우선해 답하고, 일반적인 일학습병행(도제학교) 운영 지식으로 답할 때는 "일반적인 기준"이라고 밝혀라. 규정·서식·기한처럼 틀리면 곤란한 내용은 "정확한 건 지원단이나 공단 지침으로 꼭 확인해 주세요"를 붙여라. 모르면 지어내지 말고 "지원단에 요청하기로 물어봐 주세요"라고 해라.
[지원단 공지]
${ctx || '(없음)'}
[질문]
${q}
JSON만: {"answer":"답변(5~10줄)","sure":true|false}`;
  } else {
    if (!files.length && !String(b.memo || '').trim()) return res.status(400).json({ error: '사진이나 메모를 넣어주세요' });
    prompt = `${base}
선생님이 올린 행사 사진과 메모로 학교 내부 결과보고서 초안을 만든다. 메모에 없는 숫자·이름·날짜는 지어내지 말고 "○○"로 비워둔다. 사진에서 확인되는 장면만 묘사한다.
[메모]
${String(b.memo || '').slice(0, 2000)}
형식: 1. 개요(행사명·일시·장소·대상·인원) 2. 추진 내용 3. 성과 4. 개선점 및 향후 계획.
JSON만: {"title":"보고서 제목","body":"보고서 본문(줄바꿈 포함)"}`;
  }
  return run(res, [...docs, { type: 'text', text: prompt }], [...parts, { text: prompt }], 's-' + b.mode);
}
