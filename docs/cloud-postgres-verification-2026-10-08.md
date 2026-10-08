# M5 PostgreSQL 전환과 실제 클라우드 검증 — 2026-10-08

상태: **MS-01 backend·격리 PostgreSQL 검증 완료; 전체 인수 시험 미완료**. M1 [실제 인증 연결](cloud-j-auth-verification-2026-10-08.md)의 후속이며 기존 SQLite migration 1~4와 원본 자료를 보존한다. 회사 노트북·운영 환경에는 설치하거나 이관하지 않았다.

## 저장 계약

비동기 `platform/storage` port를 identity·conversations·messages·receipts·files·retention·audit·jobs·sync·realtime에 연결했다. 기존 SQLite `Database` 동기 transaction API는 유지한다. async SQLite 어댑터는 같은 연결의 작업을 순서대로 처리하고 소유한 transaction만 허용한다. 업무 HTTP/DTO·opaque cursor·development/mail 인증·standalone 소스는 유지한다.

`pg@8.23.1`, `node-pg-migrate@9.0.0`, `@types/pg@8.23.1`을 고정했다. SQL migration `deploy/postgres-migrations/20261008110000-storage.sql`은 forward-only이며 node-pg-migrate와 동일 transaction의 SHA-256 이력을 사용한다. bootstrap 간 migration/checksum 검사는 session advisory lock으로 직렬화한다. 전용 `jgw_messenger` DB/계정은 superuser·다른 DB 접속·role/database 생성 권한이 없다. profile은 loopback DB를 요구한다. 자동 번호는 signed 64-bit BIGINT identity, 날짜/JSON은 기존 TEXT 의미를 유지한다. 쿼리는 bound parameter를 사용하고 생성 ID는 transaction별로 보관한다. SQLite 전용 dedup `rowid` 삭제는 복합키로, 읽음 위치의 정수 `length()`는 정수 비교로 바꿨다.

메시지·dedup·outbox·첨부 연결은 같은 pinned PG client의 transaction에 저장한다. **sequence 번호 발급은 commit 순서가 아니므로 쓰기 transaction 시작에 DB advisory lock을 획득한다.** 초기 구현은 SQLite의 단일 writer 순서를 유지한다. outbox `last_sequence`는 같은 transaction에서 갱신하고 reader는 committed 값만 본다. rollback 번호 구멍·prune 이후 high watermark를 보존하며 scan/stream metadata는 일관된 read snapshot을 사용한다. 동시 reader는 허용한다. writer 병렬 처리량 확대는 후속 설계/부하 시험 대상이다. 외부 인증·파일 stream·job handler I/O는 업무 transaction 밖에 둔다.

## 명시적 이관과 복구 범위

기존 SQLite 자료가 있으면 offline 이관이 필요하다. 자동 시작에서 이관하거나 원본을 삭제하지 않는다. `bootstrap/import-sqlite.ts`는 read-only snapshot, 기존 migration checksum, integrity/FK, 알려진 모든 table·column topology를 확인한다. 대상은 기본 stream 상태이며 모든 업무 table이 비어 있어야 한다. 동일 serverId/ID·본문/만료 상태·dedup/tombstone·outbox/epoch/minimum/sequence·consumer 위치·읽음·job lease·첨부 참조/해시를 하나의 PG transaction으로 복사한다. unknown schema·기존 target 자료를 거절하고 중간 실패는 target 복사를 rollback한다. 원본 삭제·serverId 재명명·파일 이동은 없다.

1. SQLite writer를 정지하고 DB와 FILE_ROOT의 복구 가능한 snapshot을 확보한다. 파일과 DB의 시점이 같아야 한다.
2. 전용 PG 계정/DB를 준비한다. 서버를 시작하기 **전**에 외부 env로 `DATABASE_URL`, `DATABASE_SCHEMA`, 절대 경로 `JMS_SQLITE_IMPORT_SOURCE`를 공급한다.
3. `npm run build` 후 `node --env-file=/external/runtime/import.env apps/server/dist/bootstrap/import-main.js`를 실행한다. stdout에는 table별 count/lastSequence만 남긴다.
4. 기존 FILE_ROOT와 cursor signing key를 유지하고 `DATABASE_DRIVER=postgres`로 검증한다. installed tenant는 기존 serverId와 맞아야 한다. 새 tenant를 원본에 강제로 매핑하지 않는다.
5. PG에 새 업무 쓰기를 허용하기 전에는 보존한 SQLite/파일 snapshot으로 복귀할 수 있다. **새 PG 쓰기 이후 SQLite 역이관은 구현하지 않았다.** 그 이후에는 검증한 PG backup/restore를 사용한다.

PG `backup()`은 PATH의 호환 `pg_dump`로 전용 schema custom archive를 생성한다. 파일 0600·원자적 최종 생성·기존 파일 덮어쓰기 거절을 적용하며 비밀번호는 child 환경으로만 공급한다. 운영자는 정지된 서비스의 확인된 전용 대상에 `pg_restore`를 실행한다. 기존 SQLite operations restore를 PG restore로 오인하지 않는다. DB dump에는 첨부 파일 자체가 없으므로 FILE_ROOT backup을 함께 보존해야 한다. VM 설치/해지 자동 orchestration은 M4의 미완료 범위다.

## 실행 증거

- `npm run check`: 계약10·core13·React13·**SQLite 서버94**·web4·배포 프로필11, typecheck·경계/lint 통과. build/format 통과.
- Node22.18의 실제 PostgreSQL18.6 `npm run test:postgres`: **15/15**, 실패/skip 0. 기존 bootstrap HTTP/실제 WS/첨부/5일·14일 보존/재시작 5개와 신규 저장·이관·backup·동시 HTTP 10개다.
- 2^53+1 ID와 bound 값, 메시지/outbox atomic rollback·afterCommit, 두 인스턴스의 commit 순서/커서 누락 방지, nested/foreign/escaped transaction, consumer monotonic 위치·prune·tenant scan, checksum tamper 거절을 확인했다.
- 원본 SQLite SHA-256 유지, 메시지/dedup/읽음/cursor/첨부 byte 복구, 이관 이후 새 ID와 pruned sequence, 기존 대상/unknown schema 거절·중간 topology 실패 rollback을 확인했다. 실제 pg_dump→pg_restore 후 migration/커서/consumer 복구도 확인했다.
- 두 실제 HTTP 서버의 같은 clientMessageId 동시 재시도는 201/200·같은 ID·메시지/outbox 각1개다. outbox 오류503 후 메시지/dedup 없음과 재시도 복구, 내용 충돌409, 다른 tenant404를 확인했다.
- j-groupware PG profile의 actual Keycloak·HTTPS/WSS·BFF relay **11개**도 통과했다. 같은 username 두 tenant, aud/role/claim·사용자 무변경·JWKS503·cookie/query 거절·송수신/단절 sync·logout/role 회수·compiled main/SIGTERM을 재검증했다. BFF 업무 HTTP/client/UI 완료와 구분한다.

재현: 외부 `JMS_TEST_ENV`에 `JMS_PG_TEST_MARKER=isolated-cloud-messenger-pg`와 전용 계정/DB의 `JMS_TEST_DATABASE_URL`(127.0.0.1:54240)을 공급하고 PG18의 pg_dump/pg_restore를 PATH에 둔다. `npm run test:postgres`는 새 test_ms schema만 정리한다. 잘못된 env·없는 PG/client는 skip 없이 실패한다. cloud client binary는 체크아웃 밖에서만 준비했다. 고객 DB 이관·외부 VM·UI/Playwright·부하 인수는 미실행이다. Windows PMT 경로/도구가 없어 PMT 기록만 미실행이며 저장소 증거로 남긴다.

## 공식 근거

[node-postgres transaction](https://node-postgres.com/features/transactions), [PG18 sequence](https://www.postgresql.org/docs/18/functions-sequence.html), [advisory lock](https://www.postgresql.org/docs/18/explicit-locking.html), [node-pg-migrate API](https://salsita.github.io/node-pg-migrate/migrations/)를 확인했다. 설치 package의 Node>=20.11·pg<9 peer 범위와 프로젝트 Node22.18의 실제 실행을 확인했다.
