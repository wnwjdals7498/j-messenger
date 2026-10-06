# 모듈 책임과 확장

## 서버 모듈

`S`는 1차, `F`는 후속 기능이다. 공개 함수는 책임을 보여주는 계약 이름이며 구현 시 타입과 오류를 `index.ts`에 명시한다.

| 모듈 | 단계 | 소유 기능·데이터 | 공개 기능·의존 |
| --- | --- | --- | --- |
| identity | S | 등록 메일 서버, users, sessions, 서버별 관리자 역할 | `authenticate`, `resolveSession`, `listUsers`, `requireServerAdmin`; `MailAuthenticator` 사용 |
| conversations | S | conversations, members, 개인 대화의 참여자 쌍 | `createDirect`, `createGroup`, `listForUser`, `requireMember`; identity의 사용자 확인 |
| messages | S | messages, message_dedup | `send`, `listBefore`, `listAfter`, `purgeExpired`; conversations의 권한·참여자 조회 |
| realtime | S | 소켓·사용자 연결 집합; 업무 테이블 없음 | `attach`, `publishCommitted`, `disconnectSession`; identity·conversations로 매번 권한 확인 |
| files | F | files, file_deletion_jobs, 비공개 파일 객체 | `upload`, `requireReady`, `bindToMessage`, `download`, `scheduleDelete`; conversations 권한 확인 |
| receipts | F | read_cursors | `advance`, `listForConversation`; conversations 권한 및 messages의 유효 ID 확인 |
| retention | F | retention_policies, retention_runs | `setPolicy`, `runBatch`; identity 관리자 확인, messages·files의 삭제 기능 호출 |
| notifications | F | devices, notification_jobs | `registerDevice`, `enqueue`, `deliver`; identity·conversations 확인, `NotificationProvider` 호출 |
| audit | S/F | audit_events | `append`, `listForAdmin`, `purgeOld`; 호출자의 검증된 행위 기록, 타 모듈 업무 수행 안 함 |
| platform | S | DB 연결·트랜잭션, migrations, event_outbox, config·clock·logger | `UnitOfWork`, `EventWriter`, `EventReader`, 작업 스케줄러; 업무 규칙 없음 |

각 모듈의 기본 구성은 `index.ts`, `application.ts`, `repository.ts`, `routes.ts`다. 복잡해지면 `domain/`, `adapters/`, `ports.ts`를 나눈다. 한 파일·폴더를 규칙적으로 늘리는 것보다 공개 책임과 소유권을 먼저 지킨다.

`routes`는 입력 검증·인증 문맥·응답 변환, `application`은 업무 순서와 트랜잭션, `repository`는 자기 테이블 SQL을 맡는다. domain은 HTTP·SQL·시간·파일 시스템에 의존하지 않는다. bootstrap만 구체 어댑터를 조립한다.

## 격리와 데이터 규칙

- `serverId`는 테넌트 경계다. 인증 후 `RequestContext = { userId, serverId, sessionId, requestId }`를 서버가 만들고 모든 업무 호출에 전달한다. 클라이언트의 `senderId`·관리자 여부를 신뢰하지 않는다.
- 사용자 고유키는 `(server_id, canonical_username)`. 사용자 이름 정규화는 U01의 메일 제품 규칙을 적용하며 임의 소문자화하지 않는다.
- 대화·참여·메시지·파일·읽음·정책·이벤트·기기 데이터는 `server_id`를 포함한다. `(server_id, id)` UNIQUE와 복합 외래키로 교차 서버 참조를 막고 조회 조건도 같은 경계를 적용한다.
- membership은 `(server_id, conversation_id, user_id)`로 유일하다. 개인 대화는 정렬한 두 사용자 ID의 유일키로 동시 생성 중복을 막는다. 그룹 생성은 요청 ID를 저장해 재시도를 구분한다.
- 메시지는 서버가 부여한 증가 ID로 정렬하고 API에서는 10진 문자열로 전송한다. 큰 ID를 JavaScript `number`로 변환하지 않는다. 메시지 조회 인덱스는 `(server_id, conversation_id, id)`다.
- 중복 방지는 `(server_id, sender_id, client_message_id)` UNIQUE다. 기존 내용·대화·첨부와 같으면 기존 결과, 다르면 409다. 보존 삭제 뒤에는 본문 없는 dedup tombstone을 세션 최대 수명보다 긴 30일 동안 유지하여 예전 재시도가 삭제된 메시지를 되살리지 않게 한다.
- WebSocket·다운로드·보존 배치·백업 복구에도 같은 경계를 적용한다. DB를 공유한다고 권한을 생략하지 않는다.

## 내부 호출·트랜잭션

모듈 간 즉시 결과가 필요한 기능은 공개 인터페이스를 직접 호출한다. 여러 모듈의 쓰기가 하나의 업무라면 조정하는 application이 `UnitOfWork`를 시작하고 동일한 `TxContext`를 소유 모듈에 넘긴다. 상대 테이블 직접 SQL과 중첩 트랜잭션은 금지한다.

메시지+첨부 연결+event_outbox, 보존 정책+감사 기록은 각각 같은 트랜잭션으로 기록한다. 트랜잭션 안에서는 메일·소켓·파일 I/O를 수행하지 않는다. DB commit 뒤의 알림·파일 삭제는 영속 작업으로 재시도한다. audit는 호출 대상만 되고 업무 모듈을 호출하지 않는다. files도 messages를 역참조하지 않아 순환 의존을 피한다.

event_outbox의 원본은 최소 메타데이터다. `event_id`, `type`, `server_id`, `conversation_id`, `entity_id`, `occurred_at`, 전달 상태를 저장한다. 메시지 본문과 파일명은 복제하지 않는다. 실시간 전송 시 소유 모듈에서 현재 DTO를 받아 권한을 다시 확인한다.

event ID는 삭제 후에도 재사용하지 않는 증가값이다. 최종 위치와 최소 유효 cursor는 별도 metadata로 유지하여 outbox가 비어도 위치가 0으로 돌아가지 않게 한다. 7일이 지난 이벤트는 sync 재조회 대신 전체 갱신 대상으로 정리하되, 필요한 후속 작업은 독립 job으로 먼저 영속화한다. worker는 성공 처리 뒤에만 완료 표시하며, 중복 실행을 허용하는 idempotent handler를 쓴다. 초기 재시도는 1초부터 최대 5분까지 늘리고 10회 실패 시 failed 상태·운영 오류를 남겨 원인 수정 후 같은 job ID로 재개한다. 파일 삭제 실패 job은 포기하거나 삭제하지 않는다.

## 클라이언트 분리

| 경계 | 책임 |
| --- | --- |
| client-core | API 호출·오류 정규화, 메시지 ID별 상태 병합, 재시도, 이벤트 cursor, 플랫폼 포트 |
| client-react/features/auth·directory | 로그인, 같은 서버의 사용자 선택 |
| client-react/features/conversations·chat | 대화 목록, 메시지 목록·작성·전송 상태 |
| client-react/features/files·receipts·admin | 후속: 첨부 UI·읽음·서버별 보존 관리 |
| apps/web | 브라우저 cookie·history·메모리 cache 어댑터 |
| apps/desktop | Tauri 진입, OS 자격 증명·파일 선택·알림 어댑터 |
| apps/android | Compose 기능 화면과 동일 API 계약을 쓰는 별도 앱 |

서버 기록은 client-core의 ID 기반 store 하나가 소유한다. UI 상태(선택·초안·모달)는 해당 feature가 소유하고 서버 기록을 각 컴포넌트에 중복 저장하지 않는다. 로그아웃·서버 전환 때 store·소켓·cursor·미전송 초안을 제거한다. 1차 오프라인 영구 저장은 포함하지 않는다.

## 확장 지점과 절차

| 바뀌는 것 | 유지할 계약 | 교체 위치 |
| --- | --- | --- |
| 메일 인증 제품 | `MailAuthenticator.authenticate` | identity/adapters; OAuth 등도 로그인 후 동일 사용자 문맥 생성 |
| 저장소·DB | 모듈 repository port, `UnitOfWork` | 플랫폼 DB·각 repository 구현; 트랜잭션·격리 계약 시험 재사용 |
| 로컬 파일 → 객체 저장 | `FileStore.put/open/delete` | files/adapters; 클라이언트에 물리 경로 노출 금지 |
| 기기별 알림 | `NotificationProvider.send` | notifications/adapters; message 저장 흐름은 변경하지 않음 |
| Web → Windows | client-core의 `Transport`, `CredentialStore`, `PlatformNotifications` | 앱 어댑터; React 화면은 재사용 |
| 새 업무 기능 | contracts + 공개 module API | 소유 데이터·권한·이벤트·보존·검증을 먼저 선언 |

확장은 요구 ID → 계약 → 소유 모듈 → migration → 구현 → 경계·복구 시험 → 문서 순서로 한다. 플러그인 임의 로딩·전역 서비스 탐색기·거대한 `utils` 폴더는 만들지 않는다. DB worker·PostgreSQL·별도 작업 프로세스·브로커는 [성능 기준](07-rebuild-plan.md)을 벗어난 병목 증거가 있을 때 검토한다.
