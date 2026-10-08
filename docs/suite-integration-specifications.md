# j-messenger 제품군 연결 기능 명세

작성일: 2026-10-08. 상태: **연결 기능 구현·인수 시험 전**. [연결 목록](suite-integration-features.md), [제품군 결정](../../j-groupware/docs/decisions.md), [공통 기준](../../j-groupware/docs/suite-feature-specifications.md)을 따른다. 기존 [메신저 명세](pmt-docs/10-feature-specifications.md)와 [실행 현황](pmt-docs/12-execution-status.md)을 보존한다. 기존 구현 완료와 이번 연결 완료는 구별한다.

## 입력·출력·연결 경계

| 대상 | 최소 계약 |
| --- | --- |
| 인증 | AUTH_MODE=j-auth에서 모든 업무 HTTP·WSS handshake의 Bearer를 j-auth 기준으로 검증한다. j-messenger aud·messenger:use·허용 tenant를 요구한다. token을 jm_session으로 바꾸거나 mail 로그인으로 우회하지 않는다. |
| 식별 | token tenant=기존 serverId, 사용자=(serverId, username). Keycloak sub와 기존 메신저 사용자 식별을 구별한다. |
| 저장 | 기존 메시지·dedup·event_outbox·cursor·파일 참조의 의미를 PostgreSQL jgw_messenger에서 유지한다. schema/쿼리 전환으로 메시지 보존 정책을 바꾸지 않는다. |
| client | client-core/client-react의 API·WSS 주소를 BFF 중계로 지정한다. 브라우저는 BFF 쿠키로 접속하고 BFF가 내부 Bearer를 붙인다. 회원 token은 브라우저 client 설정에 노출하지 않는다. |
| UI/배포 | 기존 client-react가 j-groupware CSS 변수를 쓰며 공유 패키지로 게시된다. 별도 web/desktop/android 앱은 삭제하지 않고 제품군 실행 경로에서 제외한다. |

흐름: BFF 로그인 → 메신저 메뉴 → client 패키지 → BFF HTTP/WSS → Bearer 검증 → tenant 사용자 등록/기존 사용자 선택 → 기존 송수신. 연결 단절은 기존 cursor sync로 복구한다. 로그아웃/권한 회수는 BFF가 해당 중계를 닫는다.

## 기능별 계약

| 기능 ID | PMT Item | 입력·정상 동작·출력 | 권한·실패 경계 | 인수 시험 |
| --- | --- | --- | --- | --- |
| MS-01 | M5 | 기존 저장 port→pg·SQL migration·jgw_messenger | 기존 dedup/outbox/커서/첨부 보존·원본 SQLite 자동 삭제 없음 | MS-T01 |
| MS-02 | M1 | j-auth 모드 Bearer→인증 주체 | 무효 401·JWKS 장애 구별, 자체 로그인/API/cookie 세션 미사용 | MS-T02 |
| MS-03 | M1 | token effective roles→messenger:use 확인 | 없으면 403·메시지/사용자 쓰기 없음 | MS-T02 |
| MS-04 | M1 | tenant/username→serverId·사용자 선택 | 같은 username도 다른 tenant는 별도 사용자·다른 tenant 접근 거절 | MS-T02 |
| MS-05 | M2 | core/react 빌드→공유 패키지 게시·정확한 버전 설치 | 레지스트리 방식 X1 선행·기존 공개 인터페이스 호환 | MS-T03 |
| MS-06 | M2 | API/WSS 기본 주소 설정→BFF 중계 사용 | 재연결 시 BFF 갱신 Bearer·token 브라우저 비노출 | MS-T03·MS-T04 |
| MS-07 | M2 | j-groupware CSS 변수→메신저 화면 | 실제 색·간격·타이포가 UI 기준과 일치 | MS-T03 |
| MS-08 | M2 | 제품군 빌드/배포 목록→client와 내부 server | 독립 앱 제품 경로 제외·소스 보존 | MS-T03 |
| MS-09 | M4 | VM 설치→BFF 메뉴 송수신→해지 백업 | 내부 포트·PG 전용 계정·G12 화면·M3 재검증 | MS-T04 |

## 인수 시험

| ID | 관찰할 결과 |
| --- | --- |
| MS-T01 | 실제 PostgreSQL에서 기존 서버 시나리오·메시지/outbox 동일 트랜잭션·중복 재시도·sync·격리·첨부 보존. SQLite의 자동 번호·잠금·트랜잭션 차이를 검사하고 기존 자료 이관 필요 여부는 M5에 기록한다. |
| MS-T02 | 실제 Keycloak 토큰으로 HTTP/WSS·401/403·claim/tenant/JWKS 실패, 동일 username 두 tenant 격리, j-auth 모드에서 기존 로그인/jm_session으로 우회 불가. |
| MS-T03 | 두 패키지의 정확한 버전 설치→BFF 렌더링·주소 설정·CSS 적용, token 클라이언트 비노출·독립 앱 제품 경로 제외·source 보존. |
| MS-T04 | 같은 tenant 두 회원의 화면 송수신·단절 중 이벤트 sync·재연결 새 token·권한 회수/로그아웃 종료, VM 설치/해지·DB 백업·다른 서비스 보존. |

## 확정 관문

M1에서 j-auth 모드의 HTTP/WSS 인증 어댑터와 공개/진단 route 예외를 명시한다. M2에서 BFF 중계 path·client 버전·CSS 변수명을 고정한다. M5에서 기존 SQLite 자료 이관 필요 여부와 rollback 범위를 확인하며 기존 자료를 시험용으로 덮지 않는다. 대화 상대는 한 번 이상 메신저를 쓴 회원이라는 기존 한계와 development-fixed 시험 모드·mail 모드를 유지한다. 조직도 연결·알림 송신은 이후 범위다.
