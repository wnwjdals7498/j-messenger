# PostgreSQL 파일 포함 offline 백업·복구 — 2026-10-08

상태: **전용 PG와 실제 첨부 저장 경로의 함수 통합 검증 완료; 운영 lifecycle/VM 인수 미완료**. M5 저장 port·기존 SQLite operations·standalone 소스와 데이터를 보존했다. 새 HTTP 관리 경로·자동 복원·systemd 활성화를 만들지 않았다.

`platform/operations/postgres-offline.ts`는 실제 pg_dump custom archive, 첨부 참조·크기·SHA-256 manifest, pg_restore 검증·복구를 수행한다. `bootstrap/postgres-recovery.ts`는 파일·메시지·보존·세션 소유 모듈의 공개 port만 호출한다. operations가 다른 모듈 테이블을 직접 조회하지 않는다. file owner가 실제 shard 상대 경로를 제공하며 archive의 flat objectKey 저장 형식과 live FILE_ROOT의 `앞 두 글자/UUID`를 구별한다.

## 호출 경계와 복구 순서

- 호출자는 서비스 listener와 background writer를 모두 멈추고 공용 operation lock을 제공해야 한다. factory는 같은 전용 DB/schema와 FILE_ROOT의 `createApplication(config, {maintenance:false})`를 사용하며 `listen()`을 호출하지 않는다. 실제 listener가 열려 있으면 거절한다. lifecycle callback은 신뢰된 운영 소유자만 공급한다.
- backup은 workspace 내부·겹치지 않는 root·symlink 없는 경로·소유 참조/해시·실제 archive schema를 검증한다. private partial 디렉터리에 기록한 뒤 UUID 최종 폴더로 공개한다. 중복 ID는 기존 정상본을 보존하고 거절한다. 기존 정책인 최대7개·로컬 합계2GiB를 적용하고 신규 정상본을 삭제해 성공 처리하지 않는다.
- restore는 manifest/전체 첨부/실제 archive schema를 먼저 검증한다. 현재 DB archive와 FILE_ROOT 전체를 recovery 위치에 보존한다. 참조 없는 로컬 객체도 실패 시 원위치로 돌아간다. pg_restore는 전용 schema에 clean·single transaction·no-owner/no-acl로 수행하고 비밀번호는 child 환경에만 공급한다.
- 실제 owner 조립이 현재5일 본문/14일 파일 정책을 다시 적용하고 기존30/30 정책을 회복하지 않는다. 만료 file job을 처리하고 설정에서 제거된 서버의 세션까지 포함한 모든 메신저 로컬 cookie/native 세션을 폐기한 뒤 stream epoch를 회전한다. 이전 signed cursor는 reset을 요구한다. 외부 Keycloak/BFF 세션·JWT는 이 DB 복구의 소유 데이터가 아니므로 전역 회수 완료로 주장하지 않는다.
- 파일/메시지의 tenant·대화·messageId·연결 상태를 양방향 검사한다. 복원 후 실제 file owner 다운로드가 원래 byte를 읽어야 한다. 누락·훼손·잘못된 namespace·dangling/cross-tenant 참조는 거절한다.
- 대상 변경 전 검증 실패는 원래 DB handle을 닫거나 불필요하게 복원하지 않는다. 대상 변경 이후 실패는 직전 DB와 FILE_ROOT를 복구하고 접속을 열지 않는다. rollback도 실패하면 `PostgresRestoreRecoveryError`가 부분 상태와 보존 위치를 명시한다. 성공 후 recovery 자료는 보존하며 운영자가 검증한 뒤 별도로 정리한다.

archive TOC/schema 검사는 SQL sandbox가 아니다. 신뢰된 archive만 전용 DB/schema에 복구한다. 서비스 stop/restart·실제 cross-process operation lock·host/VM 적용은 caller/lifecycle 연결의 미완료 범위다. 같은 디스크의 로컬 백업을 VM/디스크 손실 대비로 표현하지 않는다.

## 실행과 한계

| 실행                                                 | 결과                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `npm run check`                                      | 기존 contracts10/core17/React13/server94/web4/deploy11·build/type/lint/format 통과 |
| Node22.18 + PG18 binary PATH `npm run test:postgres` | 전체21/21, 실패·skip0, exit0                                                       |
| Node24.19 + PG18 binary PATH `npm run test:postgres` | 전체21/21, 실패·skip0, exit0                                                       |
| j-groupware actual Keycloak/PG 첨부 BFF              | Node24 전체125/125, 메신저 Node22·24 각각17/17                                     |

첫 Node22 전체 실행은 pg_dump/pg_restore PATH가 빠져16통과·5실패였다. 로그·JSON을 `recovery-full-node22-missing-pgtools-*`로 보존하고 PG18 PATH를 공급했다. 이후21개가 통과했지만 최종 검토에서 fixture/operations가 실제 shard 경로 대신 평면 파일을 사용한 결함을 찾았다. 그 결과를 실제 첨부 복구 성공 근거로 쓰지 않는다. file owner가 제공한 storagePath와 실제 다운로드 검증으로 수정한 최종 재실행 결과만 아래 기록한다.

최종 actual PG 통합은 Node22·24 각각21/21이다. 파일 소유자의 실제 다운로드 stream을 읽어 byte 일치를 확인하며 5일 본문 만료·14일 파일 보존/삭제·현재 정책 재적용·모든 메신저 로컬 세션 폐기(이전 설정의 서버 세션 포함)·이전 cursor reset·손상/누락/schema/참조 거절·중복 ID/정상본 보존·실패 rollback·실제 열린 listener 거절을 검증했다. 원본 자료·백업·세션·cursor 복구/실패 중단 검증은 실제 독립 PG schema와 임시 파일로 실행하며 운영 DB를 대상으로 하지 않는다. 재현 marker/전용 URL은 [PG 저장 기록](cloud-postgres-verification-2026-10-08.md)과 동일하다. 외부 결과는 `/workspace/.suite-runtime/j-messenger-pg/recovery-full-node{22,24}-results.json` 및 대응 로그다. Windows PMT 경로 `D:/workspace/test-space/github/docs/projects/j-messenger`와 도구가 없어 PMT note/verify/end만 미실행이며 저장소 실행 증거를 남긴다. 회사 노트북·운영 설치·PR/main·배포는 실행하지 않았다.
