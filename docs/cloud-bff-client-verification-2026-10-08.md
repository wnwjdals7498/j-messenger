# M2 BFF transport 연결 — 2026-10-08

`client-core`에 `createGroupwareMessengerClient`를 추가했다. canonical HTTPS origin과 CSRF 공급 함수로 생성하며 업무 HTTP는 `/api/messenger/api/v1`, WSS는 `/api/messenger/ws`로 고정한다. 브라우저에서 현재 origin과 다르면 거절한다. 쿠키를 포함하고 매 변경 요청마다 최신 CSRF를 읽으며 Authorization 헤더는 제거한다. 기존 native API 기본 주소와 동작은 보존했다.

client-core 단위 **17/17**(기존13+새4), 전체 `npm run check`, `npm run build`, `npm run format:check`가 통과했다. 실제 j-auth·Keycloak·PostgreSQL 두 메신저와 BFF의 **14/14** 시험에서 이 공개 client로 현재 회원·대화 생성/목록·메시지 목록 및 signed64 초과 오류 처리까지 확인했다. BFF POST의 메시지 저장/동일 ID 재시도/충돌, WSS 배달/읽음 사건, 단절 sync, 다른 tenant404도 실제 HTTP/WSS로 검증했다. [BFF 연결 증거](../../j-groupware/docs/cloud-messenger-bff-verification-2026-10-08.md)를 함께 읽는다.

이 helper는 이미 로그인한 j-groupware 세션에서 사용한다. 로그인·로그아웃은 j-groupware가 소유한다. native login/server-list, 파일 업로드/다운로드, 보존 관리자 API는 이번 BFF 경로에 없다. BFF capabilities도 해당 기능을 false로 보고한다. 기능 버튼·색/간격 등의 정식 UI 적용, 패키지 registry 게시·설치와 고객 VM/전체 인수는 미완료다. 기존 메신저 UI/VM 시험을 이번 suite 화면의 시험으로 옮겨 적지 않는다.

Windows PMT 경로와 도구는 클라우드에 없어 해당 기록만 남기지 못했다. 회사 노트북·운영 자격/구독·PR/main·배포는 변경하지 않았다.
