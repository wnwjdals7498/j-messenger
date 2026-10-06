# 이번에 배운 내용: outbox와 WSS

학습일: 2026-10-06. j-messenger의 구현과 그림03·04를 이해하면서 배운 내용을 정리한다. 구현 근거는 코드 commit `9d13adfe74bb7bd9bf8e468801e4fec378b82760`이며 일반 개념은 아래 공식 문서를 따른다.

## 먼저 기억할 전체 흐름

1. 앱·웹이 HTTPS로 메시지 발송을 요청한다.
2. 서버 코드가 메시지와 outbox 사건을 같은 SQLite transaction에 저장하고 commit한다.
3. **서버의 realtime 모듈**이 기본250ms마다 새 사건을 조회한다.
4. 서버가 현재 수신 권한을 확인하고 실제 메시지 데이터를 구성해 WSS로 전달한다.
5. 앱·웹이 사건을 받아 기존 상태와 병합하고 화면을 갱신한다.

SQLite는 DB 저장과 transaction을 담당한다. outbox 사건을 생성하는 것은 우리가 만든 서버 코드다. 앱·웹은 DB를 직접 읽거나250ms마다 수신 조회를 하지 않는다. WSS가 연결되어 있을 때 서버가 전달해 준 사건을 받는다.

## Outbox: 전달할 변화를 남기는 DB 기록

Alice가 “안녕”을 보내는 예로 보면 `messages`에는 본문이, `event_outbox`에는 “메시지가 생성됐다”는 사건과 그 메시지 참조가 저장된다. 메시지 생성·삭제·읽음 변경처럼 클라이언트에 알려야 하는 변화에 사용한다. 운영 로그와 별도로 실제 전달·복구에 쓰이는 업무 데이터다.

메시지 저장과 사건 저장을 따로 하면 메시지를 저장한 직후 서버가 종료되어 전달할 기록이 빠질 수 있다. 그래서 한 transaction으로 함께 처리한다. transaction은 여러 DB 작업을 한 묶음으로 처리하는 단위, commit은 저장 확정, rollback은 실패한 묶음을 취소하는 동작이다. 현재 `db.run()`이 `BEGIN IMMEDIATE`→작업→`COMMIT`을 수행하고 실패하면 명시적으로 `ROLLBACK`한다. [SQLite 공식 transaction 설명](https://www.sqlite.org/lang_transaction.html)

설명용으로 줄인 흐름이며 아래는 그대로 실행하는 SQL이 아니다.

```text
저장 묶음 시작
  메시지·중복 방지 기록·첨부 연결 저장
  outbox 사건 저장
모두 성공하면 commit / 실패하면 rollback
```

실제 `event_outbox` 기록에는 다음 의미의 값이 있다.

| 값 | 의미 |
| --- | --- |
| id / eventId | 순서가 있는 사건 번호. 메시지 번호와 별개 |
| type | 어떤 변화인지 구분하는 이름. 예: message.created.v1 |
| occurred_at | 사건이 발생한 시각 |
| server_id / conversation_id | 관련 서버 영역과 대화 |
| entity_id / payload_entity_id | 사건의 대상과 실제 데이터를 다시 조회할 참조 번호 |
| payload_entity_type | 참조할 데이터 종류. 예: message |
| recipient_user_ids | 사건 생성 당시 관련 사용자 목록. 실제 전달 시 현재 참여 권한도 검사 |

본문을 outbox에 복사하지 않고 참조로 남긴다. `db.append(tx, …)`는 유효한 transaction 소유권을 검사해 사건을 그 묶음에 추가한다. 현재 구현은 사건을 전송할 때마다 삭제하는 대기열보다, 순서대로 재조회할 수 있는 사건 기록에 가깝다. 기록 정리와 오래된 cursor의 reset은 별도 정책이며 무한 보관을 뜻하지 않는다.

## 서버는 사건을 어떻게 전달하는가?

각 연결에는 서버가 어디까지 조회했는지 나타내는 `peer.position`이 있다. 번호95까지 처리했고 최신 번호가100이라면 그 사이의 사건을 조회한다. 전체 사건 번호는 공통 순서이고, 조회 결과는 세션의 serverId로 제한한다.

`pollPeer()`는 세션·연결 상태를 확인한 뒤 사건을 한 번에 최대100개 조회한다. 기본 poll 간격은250ms다. `hydrate()`는 참조 번호로 현재 데이터를 읽어 전송 형태를 구성한다. 그림의 “복원”이 이 작업이다. ACL은 현재도 해당 대화에 접근할 수 있는지 검사하는 참여 권한이다.

허용된 사건은 JSON으로 만들어 `socket.send()`에 전달한다. 서버의 조회 위치가 전진했다는 사실은 서버 측 처리 진행을 의미한다. 상대 앱의 수신·화면 반영·읽음을 확정하는 응답으로 해석하지 않는다.250ms도 전체 전달 시간의 보장이 아니라 DB 확인 주기의 기본 설정이다.

## WSS: 연결을 유지하는 암호화 통신

WebSocket은 연결을 맺은 뒤 양쪽이 데이터를 보낼 수 있는 통신이다. WSS는 WebSocket에 TLS 보호를 적용한 주소 방식이다. HTTPS처럼 인증서를 검증하고 통신 구간을 암호화한다. [IETF WebSocket 규격](https://www.rfc-editor.org/rfc/rfc6455.html#section-1.2), [WSS의 TLS 보호](https://www.rfc-editor.org/rfc/rfc6455.html#section-10.6)

현재 앱·웹은 `wss://10.77.0.10/api/v1/events`에 연결한다. 처음 연결할 때 WebSocket handshake를 하고 서버가 세션·Origin을 검사한다. 연결이 열린 뒤에는 서버가 새 사건을 같은 연결로 보내며, 앱의 수신 callback이 실행된다. 브라우저에서는 `WebSocket` API가 연결·수신·종료 처리를 제공한다. [WHATWG 공식 WebSocket API](https://websockets.spec.whatwg.org/)

| 우리 메신저에서의 역할 | 통신 |
| --- | --- |
| 로그인·메시지 발송 요청·파일 업로드/다운로드·이력/sync 조회 | HTTPS |
| 서버가 연결된 앱·웹에 새 메시지/읽음 등의 사건을 전달 | WSS |

WSS 자체는 양방향이다. 우리가 업무 명령을 HTTP로, 실시간 사건을 WSS로 나눈 것이다. 이 프로젝트의 “실시간”은 서버의 outbox 확인과 WSS 전달을 결합한 동작이다. DB 확인 주기와 네트워크 통신 방식을 구분해야 한다.

연결이 끊기면 client-core가 지연·jitter를 두고 재연결한다. signed cursor와 HTTP sync로 놓친 사건을 받아 buffer와 병합한다. 이 복구는 우리가 작성한 애플리케이션 코드의 책임이다. WSS만 켜면 DB 저장·누락 복구가 자동으로 생기는 것은 아니다. TLS의 통신 보호와 DB 암호화·종단간 암호화도 별도의 설계다.

## 수신·병합과 알림을 구분하기

같은 메시지가 HTTP 응답·WSS·sync로 다시 도착할 수 있다. client-core는 `messageId` 또는 `clientMessageId`로 기존 메시지를 찾아 갱신하고 pending을 제거한다. `eventId`는 사건 순서의 기준이고 `messageId`는 메시지의 고유 번호다. 병합한 상태를 React 화면이 표시한다.

| 단계 | 확인하는 의미 |
| --- | --- |
| 서버 저장 성공 | 메시지와 사건이 DB에 commit됨 |
| WSS 전송 처리 | 서버가 연결에 데이터를 보냄 |
| 앱 수신·병합 | 앱 코드가 사건을 처리해 상태에 반영함 |
| 읽음 처리 | 표시된 메시지의 읽음 위치를 별도 요청으로 서버에 기록함 |
| OS 알림·종료한 앱의 푸시 | 별도 기능·제공자가 필요함. 현재 알림 기능은 비활성 |

## 실제 코드를 다시 읽을 위치

| 학습 내용 | 관련 코드 |
| --- | --- |
| 메시지·dedup·첨부·사건의 같은 transaction | [messages.create](../../apps/server/src/modules/messages/index.ts#L426) |
| commit/rollback, event_outbox 생성·append·scan | [database](../../apps/server/src/platform/database/index.ts#L132) |
| 기본250ms·연결별 조회·JSON 전송 | [realtime](../../apps/server/src/modules/realtime/index.ts#L48) |
| 현재 권한과 메시지 데이터를 다시 구성 | [messages.hydrateEvent](../../apps/server/src/modules/messages/index.ts#L376), [bootstrap hydrator](../../apps/server/src/bootstrap/application.ts#L150) |
| 수신 병합·중복 처리·ready/sync·재연결 | [client-core](../../packages/client-core/src/index.ts#L233) |
| WebSocket 생성과 수신 callback 연결 | [Web adapter](../../apps/web/src/main.tsx#L13) |
| 알림 기능의 현재 설정 | [config](../../apps/server/src/platform/config/index.ts#L269) |

그림03·04는[메시지 Archify 도식](workflows/message-delivery.html)과[미리보기](workflows/message-delivery.preview.png)에서 다시 볼 수 있다. 복원·재연결의 자세한 순서는[시퀀스 도식](workflows/session-recovery.html), 환경·검증 범위는[구현 정리](15-implementation-guide.md)를 참조한다. 이 문서는 학습 내용 정리이며 새 기능 구현이나 시험 재실행 결과를 추가한 문서가 아니다.
