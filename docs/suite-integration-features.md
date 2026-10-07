# j-messenger 제품군 연결 기능 목록

j-messenger를 j-groupware 제품군에 연결하기 위해 추가·변경해야 하는 기능 목록이다. 기존 메신저 기능(대화, outbox+WSS 등)은 `docs/pmt-docs/09-feature-list.md`를 따르고 새 기능은 만들지 않는다. 근거는 `j-groupware/docs/decisions.md` 결정 9와 `j-groupware/docs/architecture.md`의 S 번호이고, 담당 Item은 PMT 통합 project 분류 `j-messenger`의 M1~M5다. 모두 구현 전이다.

화면은 j-groupware "메신저" 메뉴(GW-30)가 이 저장소의 client 패키지로 그린다.

작성일: 2026-10-07

| ID | 기능 | 핵심 동작 | 근거 | Item |
| --- | --- | --- | --- | --- |
| MS-01 | PostgreSQL 전환 | SQLite → `jgw_messenger`(전용 계정), `pg`·node-pg-migrate SQL 파일, 기존 서버 테스트 통과 | S2·S9 | M5 |
| MS-02 | Bearer 인증 모드 | `AUTH_MODE=j-auth`: 모든 HTTP와 WSS handshake에서 j-auth 토큰 검증(aud `j-messenger`), 자체 로그인 화면·API·`jm_session` 미사용, 401 | 결정 9, S4 | M1 |
| MS-03 | 사용 권한 검사 | `messenger:use` 없으면 403 | 결정 9 | M1 |
| MS-04 | tenant 매핑 | tenant ID = `serverId`, 사용자 = `(serverId, username)`, 허용 tenant만 | 결정 9, S8 | M1 |
| MS-05 | client 패키지 게시 | `@j-messenger/client-core`·`client-react` 패키지 레지스트리 게시 | S10 | M2 |
| MS-06 | 중계 경로 설정 | API·WSS 기본 주소를 j-groupware 중계 경로로 설정 가능 | 결정 9 | M2 |
| MS-07 | UI 토큰 적용 | `client-react`가 j-groupware `packages/ui` CSS 변수를 따름 | 결정 5 | M2 |
| MS-08 | 앱 동결 | `apps/web`·`apps/desktop`·`apps/android`를 제품 경로에서 제외(삭제 안 함) | S5 | M2 |
| MS-09 | 고객 서버 검증 | 설치·해지 스크립트, 내부 포트, j-groupware 메신저 메뉴 → 대화 | S13·S14 | M4 |

유지: `development-fixed` 모드(테스트용), mail 인증 모드(코드 변경 없음, 실제 MTA 연결은 backlog).

backlog: 메신저 알림 송신(S17), 대화 상대 조직도 연동.
