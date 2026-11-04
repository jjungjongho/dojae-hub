// Reads uploaded 공문 PDFs with an AI model and proposes notices, events and support logs.
// Admin only. Uses ANTHROPIC_API_KEY (Claude) if set, otherwise GEMINI_API_KEY.
export const config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };

const SCHOOLS = { ggm: '경기기계공업고등학교', kwai: '광운인공지능고등학교', dukil: '덕일전자공업고등학교', mungok: '문곡고등학교', magnet: '서울매그넷고등학교', design: '서울디자인고등학교', seoil: '서일문화예술고등학교', yongsan: '용산철도고등학교', eunpyeong: '은평메디텍고등학교', mobility: '한국모빌리티고등학교(구 의정부공업고등학교)' };
const CATS = ['학습기업 발굴지원', '신기술체험캠프', '산업안전·AI 활용 지원', '지원단 간 협업', '경력개발 지원(P-TECH·4년제 연계)', '전담인력 전문성 강화', '커뮤니티 운영', '도제준비과정 운영지원(잡데이·컨설팅·기업투어)', '방문 모니터링·유선/방문 컨설팅', '도제학교·일학습병행 홍보', '운영위원회 개최', '기타'];
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
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: '관리자 키가 필요해요' });
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
    return res.json(out);
  } catch (e) { return res.status(502).json({ error: String(e.message || e) }); }
}

async function run(res, content, parts) {
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
    return res.json(out);
  } catch (e) { return res.status(502).json({ error: String(e.message || e) }); }
}
