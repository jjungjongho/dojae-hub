# 도제학교 지원 허브
- index.html : 사이트 전체 화면
- api/hub.js : 서버 기능 (공지, 일정, 요청, 상담, 지원 기록, 실적)
- api/_redis.js : 데이터 저장 도우미
Vercel 환경변수: ADMIN_KEY(지원단 로그인 키), SCHOOL_SALT(학교 코드용 아무 단어) + Upstash Redis 연결
