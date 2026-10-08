# 클라우드 M1 j-auth 실제 인증 연결 — 2026-10-08

기존 `cf8bff9fe29c44f7a97e4e4866dd8be2a75e4de9`의 메일/개발 인증과 SQLite 메시징을 보존하고 제품군 M1 인증 어댑터를 추가했다. `MS-02~04` backend 구현과 실제 Keycloak HTTP/WSS를 검증했다. M5 PostgreSQL 전환, M2 client 패키지/BFF 업무 HTTP/정식 화면, M3 전체 제품군 인수, M4 고객 VM은 완료로 표시하지 않는다.

## 인증·식별·연결 계약

`AUTH_MODE=j-auth`는 `JAUTH_TENANT`의 고정 고객 tenant와 `KC_PUBLIC_URL`의 등록 HTTPS origin을 요구하며 내부 loopback host만 허용한다. 3001·operator·외부/임의 경로 issuer를 거절한다. 공개 `@j-auth/token-verifier@0.1.0`으로 issuer/tenant/azp/RS256 서명/만료를 검증하고 정확히 단일 `j-messenger` audience와 `messenger:use`를 확인한다. 무효 token은 401, role 없음은 403, JWKS 장애는 503이다. 인증/권한/username 검증 이전 사용자 쓰기는 없다.

사용자는 `(serverId=tenant, preferred_username)`으로 upsert하며 기존 decimal 사용자 id를 유지한다. Keycloak sub를 메신저 사용자 id로 바꾸지 않는다. username은 원문 대소문자를 보존하고 1~256 UTF-16자, 공백만 있는 값과 C0/C1 control을 거절한다. 표시명은 name 또는 username, 1~128자로 제한한다.

JWT나 새로운 jm_session을 sessions에 저장하지 않는다. 검증 후 생성·freeze한 RequestContext만 WeakMap에서 신뢰하며 기존 decimal sessionId 필드는 서버 메모리의 문맥 식별자다. 원문 token을 저장하지 않고 token exp와 최대 5분의 만료 중 이른 시각까지만 문맥을 사용한다. HTTP는 매 요청 검증하고 WSS는 최초 검증과 기존 주기 검사로 만료된 문맥을 닫는다. 이미 발급된 서명 token의 중앙 role 회수 즉시 검사는 이 어댑터가 수행하지 않는다. BFF가 실제 세션/role 회수와 logout으로 relay를 즉시 닫는 경로를 별도로 검증했다.

j-auth 모드의 모든 업무 HTTP/WSS는 Authorization Bearer만 허용하며 cookie header·혼합 자격·query credential·부적합 Origin을 거절한다. `/api/v1/session` POST/DELETE, native session, 공개 서버 목록은 미등록이다. `GET /health/live`, `GET /health/ready`만 비밀 없는 공개 진단 예외이며 사용자 route는 기존 보호 정책을 따른다. 기존 mail/development-fixed 모드와 테스트는 유지한다. bootstrap이 j-auth tenant의 데이터/maintenance scope를 사용하고 native session capability는 false다. 실행 설정 예시는 [j-auth.env.example](../deploy/j-auth.env.example)이며 기존 DB를 자동 이관/삭제하지 않는다.

## 실제 실행과 범위

- `npm ci --ignore-scripts --offline`: 실제 registry 공개 패키지·기존 workspace 설치 성공.
- Node 24.19 `npm run check`: contracts 10/10, client-core 13/13, client-react 13/13, 서버 **93/93**, web 4/4, 배포 프로필 11/11과 desktop 타입·의존 경계·lint 통과.
- `npm run build`와 `npm run format:check`: 전체 산출물/format 통과.
- Node **22.18.0** `npm run check:server`: 서버 타입 검사와 93/93 회귀 통과.
- 실제 j-groupware M1 연결 시험 **11/11**: 실제 j-auth 두 임시 realm/서비스 가입/회원, Keycloak Code/PKCE와 token exchange, compiled 메신저 HTTP/WSS, 실제 격리 파일 SQLite를 사용했다.

같은 username 두 tenant가 서로 다른 내부 id인지, 무권한/wrong audience/다른 realm/변조/미제출 bearer의 401/403과 사용자 무변경, 기존 로그인/cookie/query 우회 거절을 확인했다. 두 실제 회원의 개인 대화→메시지 저장→WSS `message.created.v1`, 같은 clientMessageId 재시도 200/내용 충돌409/타 tenant404, 연결이 끊긴 동안 저장한 메시지의 authoritative cursor sync 복구도 통과했다. BFF의 실제 메신저 ready frame 중계와 actual logout/role 회수 연결 종료, 실제 JWKS 접속 불가 503, 파일 DB 재열기 후 사용자/메시지 보존과 재검증, compiled main의 기본 remote verifier HTTP 요청과 SIGTERM 정상 exit 0를 확인했다. 원문 token/비밀번호/메시지 내용이 로그에 없는지도 검사했다.

서명 fixture의 single/multi-audience·claim/username·문맥 위조/만료 시험은 서버의 단위/모듈 시험으로 구별한다. 실제 Keycloak 시험을 local key resolver/fake identity/메신저 echo server로 대체하지 않았다. M1의 실제 영속 저장소는 SQLite이므로 PostgreSQL/M3 성공을 뜻하지 않는다.

새 의존성은 검증기 0.1.0과 단위 서명 시험용 `jose@6.2.12`를 exact version/integrity로 고정했다. [jose 공식 ESM/JWT/JWKS 문서](https://github.com/panva/jose)와 [Fastify hook 순서](https://fastify.dev/docs/latest/Reference/Hooks/)를 확인했으며 Node22/24 실제 회귀로 호환성을 검사했다. jose는 MIT이고 공개 검증기의 Node 최소 버전은 22.18이다. `npm audit --omit=dev --json`에서 알려진 production advisories 0건을 확인했다. 이 조회는 알려지지 않은 문제나 private 코드 안전을 보증하지 않는다.

원본은 체크아웃 밖 `/workspace/.suite-runtime/j-messenger-{ci,check,build,format-check,node22-check}.log`, `j-messenger-audit.json`, `/workspace/.suite-runtime/j-groupware/messenger-integration-results.json`, `messenger-integration.log`다. 처음 실제 시험에서 fixture 인증서 SAN과 localhost 주소가 달랐고 BFF process의 trust bundle에 메신저용 테스트 CA가 없었다. 주소/격리 CA 묶음을 맞추고 공개 이벤트의 `.v1` 계약을 확인해 다시 실행했다. TLS 검증을 끄거나 실패 실행을 성공으로 계산하지 않았다.

## 다음 의존성·실제 제한

M5는 synchronous SQLite `Database.prepare`와 synchronous UnitOfWork 계약을 사용하는 각 repository, 메시지+dedup+outbox 트랜잭션, bigint ID·cursor·첨부·보존·복구 의미를 PostgreSQL의 비동기 transaction에 함께 옮겨야 한다. 단순 driver 교체를 완료로 표시하지 않는다. PG 전용 DB/계정과 새 immutable migration, 공개 내부 port 정리, 각 모듈의 parameter SQL/원자성·restart·두 tenant·파일 회귀를 먼저 고정해야 한다. 기존 SQLite 데이터 이관은 원본을 보존하고 별도 격리 대상으로 검증할 후속이다.

구독/설치 상태 자동 투영·정식 UI 기준·BFF 메시지 업무 HTTP·client packages/CSS·VM/Nginx/해지는 남은 구현/인수 범위다. 현재 클라우드 명령/파일/네트워크 차단은 없다. AGENTS의 PMT 도구와 Windows `D:/workspace/test-space/github/docs` 프로젝트 상태는 이 클라우드에 없으므로 해당 PMT 기록만 실행하지 못했다. cloud-only 사용자 지시에 따라 회사 노트북 설치 없이 저장소 문서에 검증 증거를 남겼다. `whole_suite_verified=false`이며 PR/main 병합/배포는 수행하지 않았다.
