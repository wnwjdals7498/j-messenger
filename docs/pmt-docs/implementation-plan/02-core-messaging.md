# 코어 메시징 구현 카드

이 문서는 1차 메시징을 병렬 구현 가능한 행동·책임 단위로 나눈다. 기능 완료는 관찰 가능한 상태와 카드별 완료 증거로 판정한다. 포트 fake로 개발을 시작할 수 있는 시점과 실통합 통과 시점은 별도로 기록한다. `serverId`는 인증된 CTX에서만 얻고 모든 업무 조회·쓰기·이벤트에 적용한다.

공유 원천인 루트 manifest·lock, `packages/contracts`의 공통 계약, migration 순번, bootstrap/조립, workspace 검증·logger 공통 골격은 부모가 단일 writer다. 카드 담당자는 자기 책임의 동작·시험을 작성한다. 공유 변경이 필요하면 파일 수정 지시 대신 필요한 계약 변경, 목적, 영향 동작, 호환성, 검증 조건을 부모에게 요청한다. 다른 소유자의 테이블·store·상태를 직접 변경하지 않는다. 경로 표기는 소유 경계 식별에만 쓴다.

각 카드의 로깅 검증은 기능 명세 10의 공통 규칙을 따른다. 사건마다 `featureId`, `outcome`, 서버 생성 `requestId` 또는 job correlation, 사건 순서와 허용 metadata를 확인한다. 이메일·주소·비밀번호·세션·cookie·token/hash·본문·첨부 원문/파일명·요청 body·cursor 원문은 로그와 진단에 없어야 한다. 정상은 info, 회복 장애·거부·재시도는 warn, 최종 실패·불변식 위반은 error이며 반복 사건은 집계한다. 로그만으로 성공을 판정하지 않고 상태 관찰과 대조한다.

### C01
제목: 등록 메일 서버 선택, 인증, 사용자·세션 수명
담당: identity / 메일 인증 adapter와 서버 인증 문맥
기능 ID: F01-F04, F06 및 F05 중 세션에서 `serverId`를 확정하는 부분

| 항목 | 계획 |
| --- | --- |
| 목적 | 등록된 서버만 선택·해석하고 메일 계정을 확인해 사용자·세션을 만든다. 세션 검증은 CTX의 사용자·서버·세션 문맥을 확정하고 폐기 상태를 보장한다. |
| 추가/수정/삭제범위 | 등록 서버 별칭 해석, `MailAuthenticator` port 경계, 사용자 upsert·서버별 식별, 세션 생성/조회/폐기, 현재 사용자 응답, 사용자 목록의 서버별 페이지 조회 행동을 소유한다. 비밀번호/TLS/timeout 검증은 메일 I/O adapter에 둔다. |
| goal | 허용 서버의 인증만 사용자 등록과 세션으로 이어지고, 요청마다 서버가 검증한 CTX가 만들어진다. 로그아웃·만료·폐기 후 HTTP/WS 자격이 무효다. |
| non-goal | 대화 membership 판단, 메시지/outbox, 클라이언트 store 정리, 관리자 권한 추정은 소유하지 않는다. 이름·로그인 성공으로 관리자 역할을 만들지 않는다. U01 미확정 상태의 fake 성공은 실인증 완료가 아니다. |
| 목표-input | 등록 서버 정의와 별칭, 서버 선택 식별 정보, 사용자 계정 식별 정보와 일회 비밀번호, TLS 신뢰·인증 port·timeout, 기존 사용자/세션 상태, 서버 시각, cookie 또는 허용된 세션 증명. |
| 목표-output | 공개 가능한 서버 선택 정보 또는 거부, 검증된 사용자·serverId·CTX, 보호 cookie/세션 만료 정보, 같은 서버 사용자 페이지, 안전한 인증/접속/DB 오류. 내부 호스트·TLS 비밀·세션 원문은 반환하지 않는다. |
| 구현동작·실패처리 | 등록 목록에 없는 목적지는 외부 접속 전에 거부한다. 메일 인증은 DB 트랜잭션 밖에서 제한 시간·동시성 상한으로 수행한다. 성공 뒤 사용자 upsert와 세션 hash 저장을 일관되게 끝낸다. 계정 거부는 일반 401, 메일 장애는 일반 503으로 구분한다. TLS·timeout·DB 실패 시 세션을 만들지 않는다. 세션 cookie 변경 요청은 정확한 허용 Origin을 요구한다. 서버는 CTX를 만들고 클라이언트의 권한 필드를 신뢰하지 않는다. |
| 코드동작확인 Test방식 | 등록 alias·미등록 주소·내부 설정 비노출과 미등록 외부 호출 0회를 확인한다. 정상/잘못된 자격·TLS 오류·timeout·메일 port 실패·DB 실패에서 사용자 및 세션 상태를 대조한다. 동시 인증 상한, 사용자 upsert 재로그인, 세션 만료·폐기·변조·누락·복수 인증수단 거부를 검사한다. 사용자 페이지 경계·잘못된 cursor·serverId 격리도 확인한다. 재시작 뒤 세션 판정은 저장 상태와 일치해야 한다. U01 이후 실제 제품·계정 시험을 별도 실통합 gate로 기록한다. |
| 코드동작확인 로깅방식 | `identity.servers.listed/resolved`, `identity.login.completed`, `identity.session.checked`, `identity.logout.completed`, `identity.users.listed`를 해당 F01-F06 `featureId`와 연결한다. 해석 결과는 내부 serverId만 허용한다. 인증 사건은 사용자·서버 ID, 결과 사유 code, 소요시간을 허용한다. 실패와 rollback이 같은 request correlation이며 session 원문/hash·계정·메일 원문이 없음을 캡처에서 확인한다. 순서는 검증→인증결과→저장결과이고 DB 실패 시 성공 사건은 없어야 한다. |
| 선행·병렬제약 | 실제 인증의 통합은 B03+B05 이후. 포트 fake로는 B01+B02 뒤 병렬 개발 가능. C02는 identity 사용자 확인 port를 소비하며 초기에 frozen 계약 fake로 병렬 가능. F05의 대화 참여 판정은 C02 소유다. U01이 확정되기 전 C01 fake 통과는 실제 로그인 완료가 아니다. |
| 완료증거 | 공개 행동 계약, 정상/거부/장애 결과, 저장 상태·세션 무효화 증거, 로그 비밀값 검사와 U01 미확정/실통합 판정이 기능별로 기록되어 있다. |

### C02
제목: 개인·그룹 대화, 고정 참여자와 서버 경계
담당: conversations backend / 대화 및 membership 권한
기능 ID: F05, F07-F09 backend

| 항목 | 계획 |
| --- | --- |
| 목적 | 같은 서버 사용자 간 개인 대화를 재사용하고 고정 참여자의 그룹 대화를 생성·열람한다. 모든 결과는 요청자의 참여 범위로 제한한다. |
| 추가/수정/삭제범위 | 개인 대화 참여자 쌍의 유일성, 그룹 생성 요청 dedup, 참여 관계와 목록·권한 공개 기능을 소유한다. 사용자 유효성은 C01 identity port로 확인한다. |
| goal | 동시 요청·재시도에도 개인 대화 하나와 그룹 요청 하나만 남고, 비참여자/타 서버 접근은 존재 여부를 드러내지 않는다. 그룹 생성 후 참여자는 1차 범위에서 고정된다. |
| non-goal | 메시지 본문·메시지 조회, identity 사용자 저장·세션, client UI 선택 store, 관리자 대화 변경은 소유하지 않는다. 그룹 참여자 추가/탈퇴 정책을 임의로 열지 않는다. |
| 목표-input | 검증된 CTX, 대화 종류, 상대/참여 사용자 식별자, 표시 제목, 그룹 요청 재시도 식별자, 기존 대화 쌍 및 참여 상태, 페이지 위치/상한. |
| 목표-output | 대화 식별자·종류·참여 정보·생성 또는 재사용 판정, 참여 대화 페이지와 읽은 DB 상태의 snapshot 위치, 존재 여부 비노출 접근 오류. |
| 구현동작·실패처리 | 모든 사용자와 대화는 CTX의 serverId 아래에서 확인한다. 개인 대화는 정렬된 사용자 쌍의 유일성으로 동시 생성을 조정한다. 그룹 요청 ID에 같은 의미면 기존 결과를, 다른 의미면 conflict를 반환한다. 대화·참여·생성 outbox는 조정 UoW에서 원자 처리하고 일부 실패 시 전부 취소한다. |
| 코드동작확인 Test방식 | 실제 파일 DB로 양측 동시 개인 생성·반복 요청의 단일 대화 수렴, 그룹 중복 참여 정규화, 타 서버/미등록 참여자 거부, 같은 요청/다른 내용 conflict를 확인한다. 각 쓰기 실패 주입 때 대화·membership·이벤트가 모두 없음을 검사한다. 비참여·타 서버 조회는 404 의미, 목록 페이지 연속성·snapshot을 검사한다. 재시작 후 생성 결과와 고정 membership이 유지되어야 한다. |
| 코드동작확인 로깅방식 | `conversations.direct.resolved`, `conversations.group.created`, `conversations.listed`, `access.denied`를 F05/F07-F09 `featureId`와 연결한다. 대화 ID·결과·참여자 수·반환 건수·사유 code만 허용하고 제목/이름/참여자 목록은 금지한다. 검증→생성/재사용→commit 사건 순서와 rollback 시 성공 로그 부재를 확인한다. |
| 선행·병렬제약 | 실제 저장 통합은 B03+B05+C01 identity user port와 함께 통과한다. 초기 개발은 frozen identity/access port fake로 병렬 가능. C03은 공개 `requireMember`/사용자 확인 port를 소비하고 C02 내부 repository나 테이블을 직접 호출하지 않는다. |
| 완료증거 | 개인/그룹 중복·권한·원자성·목록·재시작 관찰 결과, 공개 대화 기능 계약 및 허용 metadata 로그 검사가 남아 있다. |

### C03
제목: 메시지 페이지 조회, 검증, 원자 저장과 중복 판정
담당: messages backend / 메시지·dedup·메시지 삭제 의미
기능 ID: F10, F11 server, F12, F13 backend

| 항목 | 계획 |
| --- | --- |
| 목적 | 권한 있는 대화의 메시지를 페이지로 조회하고 검증된 제출을 dedup·메시지·outbox의 원자 결과로 만든다. |
| 추가/수정/삭제범위 | 메시지 저장·이전/이후 조회, UTF-16 기준 텍스트 검증, clientMessageId 판정, 본문 삭제 후 tombstone 의미, 메시지 DTO와 commit 결과를 소유한다. 대화 권한은 C02 공개 port, 트랜잭션은 B03 UoW를 사용한다. |
| goal | 응답 유실·동시 재시도에서도 한 메시지만 저장되고, 같은 ID의 의미 변경은 충돌, 삭제/만료된 dedup 재시도는 되살아나지 않는다. |
| non-goal | WS 전송·outbox poll/job 실행, 클라이언트 재시도 정책, UI 검증 표시는 소유하지 않는다. outbox 테이블이나 membership 테이블에 직접 쓰지 않는다. |
| 목표-input | CTX, 대화 식별자, 텍스트 후보, clientMessageId, 준비된 첨부 참조가 생길 경우 해당 참조, before/after 경계와 상한, 기존 메시지/dedup/tombstone 상태, 서버 시각과 TxContext. |
| 목표-output | 오름차순 메시지 페이지와 cursor 의미, 서버 메시지 ID·시각·발신자 DTO, 생성/기존 결과/충돌/만료 판정. 성공 commit에는 메시지·dedup·outbox가 함께 있고 실패는 안전한 오류다. |
| 구현동작·실패처리 | 세션 serverId 및 대화 membership을 조회와 쓰기 전에 확인한다. 텍스트는 trim 후 비어있지 않고 1-4000 UTF-16 코드 단위다. ID는 큰 정수 안전성을 위해 문자열 계약을 쓴다. 동일 clientMessageId와 같은 의미면 원 결과, 다른 대화/본문/첨부 의미면 409, tombstone 기간 종료 후 오래된 재시도는 410이다. 메시지·dedup·첨부 연결·outbox를 동일 UoW로 commit하고 트랜잭션 안에서 네트워크 I/O를 하지 않는다. |
| 코드동작확인 Test방식 | 이전/이후 경계, 상한, 잘못된 동시 경계, 빈 페이지, 큰 ID 문자열, 삭제 본문 제외 및 연속 페이지의 중복/누락을 검사한다. 한글·이모지·조합문자와 trim 포함 길이 경계를 server/client 공통 벡터로 확인한다. 메시지/dedup/outbox 각 쓰기 실패를 주입해 전체 rollback·이벤트 없음, 동시 동일 요청·응답 유실 재시도에서 단일 행, 다른 내용 conflict를 검사한다. commit 직후 프로세스를 종료하고 디스크 DB 재시작 뒤 기록과 outbox가 보존됨을 관찰한다. |
| 코드동작확인 로깅방식 | `messages.listed`, `messages.accepted`, `messages.store.failed`, `messages.dedup.checked`를 F10-F13 `featureId`로 기록한다. 대화/메시지 내부 ID·조회 방향·건수·처리시간·결과·안전 사유 code만 허용한다. commit 성공 사건은 commit 뒤에만 나타나고 저장 실패에는 성공 사건이 없어야 한다. 본문·client 요청 원문·첨부 이름·cursor 원문이 로그 캡처에 없는지 검사한다. |
| 선행·병렬제약 | C02의 실 access port와 B03 실제 UoW 통합이 최종 통과 조건이다. 구현은 frozen access/UoW fake로 선행 개발 가능하나 fake 통과는 실통합 완료가 아니다. C04는 outbox의 공개 reader 계약만 사용한다. |
| 완료증거 | 실제 SQLite 상태, 실패 주입 rollback, dedup 충돌/만료, 재시작 상태, API 경계 및 F10-F13 로그 순서·비밀값 검사 결과가 남아 있다. |

### C04
제목: WebSocket 인증, 상한 핸드셰이크와 commit된 이벤트 배포
담당: realtime backend / 연결·구독·전달
기능 ID: F14-F15

| 항목 | 계획 |
| --- | --- |
| 목적 | 검증된 세션의 연결만 유지하고 commit된 업무 변경을 권한 있는 구독자에게 전달한다. |
| 추가/수정/삭제범위 | cookie 기반 브라우저 WS 인증, Origin 검사, 연결 수명·heartbeat·큐 상한, 구독 등록과 high-water 상한, outbox reader polling/배포를 소유한다. 이벤트 원천·저장은 B03 및 업무 모듈 소유다. |
| goal | handshake 등록과 상한 확정 사이의 변경 누락을 막고, 미 commit 변경을 보내지 않으며 장애 후 DB outbox와 sync로 복구 가능하다. |
| non-goal | 메시지 쓰기 명령·업무 테이블 쓰기·클라이언트 cursor 영속화는 하지 않는다. 전달 성공을 메시지 commit 성공 조건으로 만들지 않는다. |
| 목표-input | handshake cookie·Origin·CTX 검증 결과, 세션 폐기/만료 신호, 구독 등록 시점, durable outbox reader, 이벤트별 현재 권한·수신 대상, heartbeat·송신 큐 한도. |
| 목표-output | 연결 거부 또는 인증된 연결과 구독 상한 ready 통지, 권한 필터된 이벤트 전달, 제한/만료/느린 연결 종료 사유, commit 후 처리된 outbox 위치. |
| 구현동작·실패처리 | WS는 정확한 허용 Origin과 cookie session을 확인하고 query token은 받지 않는다. 구독 등록과 상한 H 산출을 틈 없이 수행한다. H 초과 이벤트는 클라이언트 sync가 끝날 때까지 live 수신 구간으로 처리한다. job은 소유 기능에서 현재 권한을 재확인하고 event DTO를 만든다. 속도 초과·60초 heartbeat 무응답은 연결 종료 후 sync 복구 대상이며, 배포 실패는 메시지 commit에 역영향을 주지 않고 재시도 상태로 남긴다. |
| 코드동작확인 Test방식 | 정상/만료/위조/로그아웃 세션, 누락·부정 Origin, query credential 차단을 실제 handshake에서 검사한다. 구독 경계에 이벤트를 주입해 누락 없이 H/이후 구간으로 나뉘는지 확인한다. commit 전 crash는 미전달, commit 후 crash/restart는 durable outbox 재개, 중복 전달은 eventId로 병합 가능해야 한다. 큐 상한·heartbeat timeout·권한 없는 대상·중복 worker·outbox 실패 주입을 검사하고 재시작 뒤 재개 상태를 확인한다. |
| 코드동작확인 로깅방식 | `realtime.connection.opened/closed/rejected` 및 F15 전달 사건을 F14/F15 `featureId`와 연결한다. 사용자/서버 ID, 종료 사유, 지속시간, 큐 크기, 내부 event/job ID, 결과만 허용한다. handshake 판정→open→전달/종료 순서와 session 폐기 correlation을 대조한다. heartbeat 건별 로그·토큰·Origin 원문·cursor·payload/body가 없는지 검사한다. |
| 선행·병렬제약 | 실통합은 B04 job runner+B05 HTTP/Origin/limit+C01 세션+C02 권한+C03 commit outbox reader가 필요하다. 동결된 계약으로 연결/배포 fake를 선행 구현할 수 있다. outbox 스키마·공유 reader 변경은 부모 단일 writer에 요구한다. |
| 완료증거 | 브라우저 handshake, 구독 경계, commit 전후 중단·재시작, 권한 필터, 큐 제한 및 사건 상관 로그 검사 증거가 있다. |

### C05
제목: 서버 cursor 동기화, 권한 필터와 만료·상한 처리
담당: sync backend / cursor 발급·스캔·페이지 의미
기능 ID: F16

| 항목 | 계획 |
| --- | --- |
| 목적 | 클라이언트가 확인한 위치 이후 변경을 고정 상한까지 안전하게 페이지화하고 만료·권한 변화를 명확히 알린다. |
| 추가/수정/삭제범위 | 서명 cursor 의미(사용자·serverId·위치·만료), through 고정, 이벤트 스캔/권한 필터, 마지막 반환행과 무관한 마지막 스캔 위치, 만료 410 및 snapshot 일관성을 소유한다. |
| goal | 숨겨진 이벤트가 있어도 cursor가 전진하며, 페이지 중 새 이벤트가 상한에 섞이지 않고 다른 사용자/서버의 위치나 데이터가 노출되지 않는다. |
| non-goal | React/클라이언트 merge·cache 초기화, 업무 이벤트 생성/outbox 소유는 하지 않는다. cursor 원문을 운영 로그에 남기지 않는다. |
| 목표-input | CTX, 서명 cursor 또는 최초 동기화 의도, 고정 through, 페이지 limit, 보존 minimum valid position, 현재 참여 권한, DB snapshot 시점. |
| 목표-output | 권한 있는 변경 목록, 스캔 위치 기반 nextCursor, 고정 상한·hasMore, snapshot 위치 또는 만료/위조/다른 문맥의 안전한 오류. |
| 구현동작·실패처리 | signed cursor 검증은 사용자·serverId·위치·만료를 묶고 다른 문맥 재사용·변조를 거부한다. 각 페이지의 through는 고정한다. 서버가 최대 스캔량을 제한하고 권한 없는 이벤트는 payload를 숨기되 스캔 위치는 진행한다. 만료된 위치는 410 reset 요구를 반환한다. 목록 snapshot과 이벤트 위치는 같은 DB snapshot에 결합한다. |
| 코드동작확인 Test방식 | 서명 위조·다른 user/server cursor·경계 위치·through 고정·숨겨진 이벤트만 있는 페이지·scan cap·hasMore·7일 만료를 검사한다. 전체 스트림 reset/복원으로 stream epoch를 갱신한 뒤 이전 epoch의 유효 서명 cursor도 거부되는지, 새 cursor로 재동기화되는지 확인한다. 동시 새 이벤트가 다음 상한으로 분리되고 페이지 사이 중복/누락이 없는지 실제 DB snapshot으로 확인한다. 권한 변경과 만료 경계의 반환 DTO/DB 무변경을 검사한다. 디스크 DB 재시작 뒤 event 위치 재사용·증가가 안정적이어야 한다. |
| 코드동작확인 로깅방식 | F16 동기화 사건은 featureId·requestId·내부 시작/끝 event position·scan/return 건수·hasMore·outcome·안전 사유 code만 허용한다. 시작→페이지 완료/410 사건 순서를 확인하고 서명 cursor 원문·payload·비인가 대상 ID가 없음을 검사한다. 반복 페이지는 집계해 폭주를 막는다. |
| 선행·병렬제약 | B01 frozen 계약에서 cursor가 사용자·serverId·stream epoch·위치·만료를 묶고 reset/복원 때 epoch가 바뀌며 이전 cursor가 거부됨을 소비한다. 실제 권한은 C02, 이벤트 위치/outbox 내구성은 C04 및 B03의 reader/metadata 계약에 의존한다. frozen cursor codec·reader fake로 병렬 구현은 가능하다. 실 cursor 통과는 C02/C04/B03 통합 후다. |
| 완료증거 | cursor 위조·격리·만료·상한·숨김 스캔 동작과 실제 snapshot/재시작 결과, 안전 로그 검사가 있다. |

### C06
제목: client-core 전송, 단일 store, 재시도·sync·재접속·초기화
담당: client-core / transport와 서버 기록 상태 병합
기능 ID: F04 client, F09 state, F13 client, F17

| 항목 | 계획 |
| --- | --- |
| 목적 | HTTP 응답과 WS/sync 이벤트를 하나의 ID 기반 상태로 합치고 실패·재접속·로그아웃에도 사용자 간 데이터가 섞이지 않게 한다. |
| 추가/수정/삭제범위 | Transport port, 오류 정규화, 단일 서버 기록 store, 메시지 ID별 pending/confirmed 상태, 동일 clientMessageId 재시도 정책, cursor sync·live buffer 병합·재접속·reset을 소유한다. 화면 선택·초안 UI 상태는 client-react 책임이다. |
| goal | 동일 메시지의 응답/이벤트 순서와 중복을 한 건으로 병합하고 연속 sync cursor만 복구 위치로 저장한다. 로그아웃/서버 전환 후 늦은 응답이 이전 계정 상태를 되살리지 않는다. |
| non-goal | 서버 권한·서버 cursor 검증 구현, React 화면/문구, 영구 오프라인 기록은 소유하지 않는다. UI 초안·선택 상태를 직접 수정하지 않고, 7일 이후 자동 재전송하거나 로그아웃 후 전송하지 않는다. |
| 목표-input | API/WS Transport, 메시지·대화 DTO, clientMessageId와 최초 시각, 기존 store/cursor, reconnect/foreground 신호, 서버 high-water H·sync 페이지·snapshot, session/logout/서버 전환 신호. |
| 목표-output | 정규화된 단일 store, 확정/재시도/충돌/만료/재로그인 상태, 연속 복구 cursor, 버퍼 적용 결과, 초기화 완료 상태. |
| 구현동작·실패처리 | 전송 ID는 최초 한 번 생성해 결과 불명확 시 유지한다. HTTP·WS 이벤트는 메시지 ID와 eventId로 멱등 병합한다. reconnect 때 구독 H 이후 live를 버퍼링하고 이전 C부터 고정 H까지 sync한 뒤 버퍼를 순서 적용한다. live 단독 수신은 복구 cursor를 전진시키지 않는다. cursor 만료/첫 접속은 캐시 reset 후 조회별 snapshot과 최신 이벤트를 병합한다. 재시도는 최초부터 최대 7일·로그인 상태에서만 한다. 로그아웃/전환은 core store·socket·cursor·대기 요청 generation을 폐기하고 상태 초기화 port/event로 C07에 UI 초안·선택 폐기를 통지한다. 오래된 generation의 callback과 UI action은 무시한다. |
| 코드동작확인 Test방식 | transport fake로 HTTP/WS 역순·중복·응답 유실, 동일 ID 재시도·충돌·timeout·401·410을 주입한다. 페이지 경계의 연속 cursor 전진, H 전후 버퍼 적용, 숨김 이벤트 구간, snapshot 이하 버퍼 배제, reset 재조회·동시 늦은 응답 무시를 검사한다. 로그아웃/서버 전환 직후 완료되는 요청이 store를 바꾸지 않는지, 초기화 port/event가 C07에 전달되어 UI 초안·선택이 폐기되는지 확인한다. 메모리 상태 초기화 및 재시작 시 영구 오프라인 데이터가 생성되지 않음을 확인한다. |
| 코드동작확인 로깅방식 | 로컬 `client.send.retry`, `client.state.cleared`, `client.sync.*` 사건을 F04/F09/F13/F17 `featureId`에 연결한다. 시도 회차·내부 message/conversation ID·cursor 전후 위치 요약·건수·사유 code·outcome만 허용한다. 전송→서버 결과/이벤트→sync 적용→cursor 확정 순서와 로그아웃 초기화 이후 이전 generation 성공 없음 확인. 본문·초안·credential·cursor 원문 금지. 로컬/시험 수집만 한다. |
| 선행·병렬제약 | B01 frozen 계약과 B02 workspace/config/logger 골격만 있으면 transport/server fake로 개발 시작 가능. 실통합은 C01-C05의 API·WS·sync 동작 통과 뒤다. |
| 완료증거 | 공통 state 전이 벡터, 중복·순서·복구·reset·로그아웃 격리 관찰, retry 한도 증거와 로컬 로그 비밀 검사 결과가 있다. |

### C07
제목: React/Web 대화 화면, 작성기와 한국어·시간·반응형 표시
담당: client-react/Web UI / feature 화면 및 조합
기능 ID: F09 UI, F11 UI, F18

| 항목 | 계획 |
| --- | --- |
| 목적 | 사용자 목록·대화 선택·메시지 읽기/작성 흐름을 한국어로 제공하고 core 상태를 화면에 일관되게 표현한다. |
| 추가/수정/삭제범위 | auth/directory/conversations/chat 화면·composer, 로딩/빈/오류/전송상태 표시, 안전한 본문 rendering, UTC 시각의 서울 표시, 640px 기준 목록/대화 전환을 소유한다. 서버 기록 cache는 C06 store를 소비한다. |
| goal | 데스크톱 분할 화면과 좁은 화면 전환에서 선택·기록이 유지되고, 한글 IME·UTF-16 길이·Enter 규칙이 계약대로 동작한다. |
| non-goal | 서버/API 구현, core store 중복 보관, F20 이후 파일 UI, 읽음·관리자·native UI는 포함하지 않는다. feature mock만으로 core 완료를 표시하지 않는다. |
| 목표-input | client-core 공개 model/action, 사용자·대화·메시지 상태, 로딩/오류 code, 초안·선택·IME 상태, 브라우저 viewport와 timezone 규칙. |
| 목표-output | 한국어 화면 상태, 대화 전환·전송 action, 메시지 순서·전송 상태·시각 표시, 안전한 빈/오류/재로그인 안내. |
| 구현동작·실패처리 | 화면은 core action과 단일 store를 통해 기록을 읽고 바꾼다. Enter는 전송, Shift+Enter는 줄바꿈, composition 중 Enter는 무시한다. 제출 직전 trim·UTF-16 길이를 확인하고 서버에서도 재검증된다. 본문은 텍스트로 escaping한다. UTC를 Asia/Seoul로 표시하며 실패 상태를 raw 예외 대신 한국어 문구로 변환한다. 640px 이하에서 목록과 대화 보기 간 전환을 제공한다. |
| 코드동작확인 Test방식 | 브라우저에서 빈/공백·길이 경계·한글/이모지/조합 문자·Enter·Shift+Enter·IME·이중 클릭 동작과 API 호출 수를 확인한다. 악성 markup 입력은 실행되지 않아야 한다. 빠른 대화 전환 시 응답 역순에서도 선택 상태가 맞고 다른 서버/로그아웃 화면 잔존이 없어야 한다. 360px와 데스크톱에서 목록/대화 전환, UTC 날짜 경계의 서울 표시, 빈/로딩/오류 상태를 실제 브라우저로 확인한다. C06 연결 후 실제 API/WS 플로우로 통과 판정한다. |
| 코드동작확인 로깅방식 | 로컬 `client.compose.validated`, `client.conversation.selected`를 F09/F11/F18과 연결하고 제출 가능·사유·내부 대화 ID·전환 결과만 허용한다. 초안·키 입력·본문·표시명은 기록하지 않는다. composition 중 전송 호출 0회, core action과 화면 결과 일치, remote UI 수집 부재를 시험 수집에서 확인한다. |
| 선행·병렬제약 | B02+C06 공개 계약으로 화면 skeleton/fake 개발 가능. C06 상태/전송 완료가 실제 UI 통합 gate다. F11 mock 화면 동작을 메시지 검증/저장 완료로 보고하지 않는다. |
| 완료증거 | 실브라우저 주요 흐름·IME/길이·escaping·시간대·반응형 결과와 C06 실연결 여부, 안전 로컬 로그 검사가 남아 있다. |

### C08
제목: 두 브라우저·디스크 DB 재시작·격리·로그 관통 acceptance
담당: 로컬 acceptance / F01-F19 통합 행동 증거
기능 ID: F01-F19 로컬 acceptance

| 항목 | 계획 |
| --- | --- |
| 목적 | 실제 서버·브라우저·파일 기반 DB 조합에서 로그인부터 대화·메시지·재접속까지 사용자 관점의 통합 완료 여부를 판정한다. |
| 추가/수정/삭제범위 | 격리된 acceptance fixture, 두 브라우저 시나리오, 프로세스 중단/재시작 조정, 관찰 증거 수집·기능별 결과를 소유한다. 기능 구현·공유 bootstrap/migration/contract를 수정하지 않는다. |
| goal | 대화 송수신·격리·영속성·중복/누락 복구가 실제 조립 상태에서 확인되고 미통과·미실행·fake-only 범위가 분명하다. |
| non-goal | U01 실제 메일 서버 성공 판정, VM/TLS/사설망 배포, 운영 성능·백업 복원, 후속 기능·네이티브를 로컬 acceptance로 대신하지 않는다. |
| 목표-input | 실행 가능한 전체 앱 조립, 허용된 dev/fake identities, 두 독립 브라우저 context, 임시 디스크 DB, control 가능한 프로세스 lifecycle, 기능별 기대 동작·로그 수집기. |
| 목표-output | 두 브라우저의 관찰 결과, DB·outbox·세션 상태 전후, 재시작·재연결 결과, 격리 거부 증거, featureId별 시험 판정·환경·한계. |
| 구현동작·실패처리 | 같은 메일 서버의 참여자 두 명, 같은 서버의 비참여자 한 명, 다른 메일 서버의 사용자 한 명으로 격리 fixture를 준비한다. 참여자 간 개인/그룹 흐름을 수행하고 같은 서버 비참여자와 타 서버 사용자의 접근을 각각 시도한다. HTTP와 WS 도착 순서를 바꾸고 응답 유실·동일 clientMessageId 재시도를 주입한다. commit 경계 종료 뒤 재시작하고 outbox/sync를 통해 복구한다. 로그를 기능 ID와 request/job correlation으로 관통 확인하고 비밀값 fixture를 검색한다. |
| 코드동작확인 Test방식 | 같은 서버의 참여자 두 명이 두 브라우저에서 로그인하고 대화 생성·메시지 왕복·페이지 조회·재시도 후 한 건만 존재하는지 assertion한다. 같은 서버 비참여자와 다른 메일 서버 사용자의 HTTP·sync·WS 데이터 접근 차단, 사용자 목록 격리 및 DB 교차 서버 FK를 각각 확인한다. 프로세스 강제 종료 지점을 commit 전후로 나눠 재시작하고 영속 행·outbox·event cursor·UI 상태의 예상 복구를 비교한다. 네트워크 단절/복귀, 이벤트 중복/역순, cursor 만료 reset을 실제 통합으로 검사한다. 로그 사건 발생 순서와 허용 metadata·비밀값 부재를 캡처에서 확인한다. 테스트 프로세스는 자체 종료·임시 자원 정리를 관찰한다. |
| 코드동작확인 로깅방식 | F01-F19 사건의 featureId·outcome·requestId/job correlation·허용 내부 ID·건수·사유·순서를 end-to-end로 대조한다. 로그가 기능 관찰 결과와 일치해야 하고, 비밀번호/cookie/token/hash/email/본문/첨부명/전체 body/cursor 원문이 없는지 검사한다. UI 로그는 로컬 시험 수집에 한정한다. fake 인증 결과와 실제 U01 통합 결과를 구분해 표기한다. |
| 선행·병렬제약 | B06의 재현 가능한 bootstrap/lifecycle 및 C01-C07 구현이 실제 acceptance 선행이다. 각 기능 개발 중 테스트 시나리오·fixture 계약은 작성할 수 있으나 전체 통과 선언은 모든 해당 카드 실통합 이후다. 실제 인증 판정은 별도 O01 U01 통합 단계다. |
| 완료증거 | 재실행 가능한 acceptance 결과, 프로세스 재시작 전후 DB/브라우저 상태, 권한 격리, 로그 관통·비밀 검사, 실행 환경 및 미검증 한계가 기능별로 남아 있다. |

## 부모 조정 및 다른 배치의 경계

기반 그룹 B01 계약/ports 동결, B02 workspace 검증·config/logger 골격, B03 DB/UoW/outbox, B04 job runner, B05 공통 HTTP schema/Origin/limit, B06 lifecycle/bootstrap은 코어 카드와 별도 문서에서 부모가 조정한다. 위의 선행 항목은 fake로 병렬 착수할 수 있는 때와 실제 통합 gate를 구분한다. 공통 계약·manifest·lock·migration 순번·조립 변경은 부모가 단일 writer로 관리한다.

U01 실제 메일 제품·TLS·계정 인증은 O01에서 실통합 판정한다. C01 fake 결과를 전체 완료로 표시하지 않는다. E01 audit, E02 관리/정책, E03 files, E04 message attachment, E05 receipts, E06 확장 클라이언트, E07 retention, E08 확장 통합은 별도 확장 배치다. N01 session, N02 Windows, N03 Android, N04 devices, N05 notification, N06 실기기는 네이티브 배치다. O01 실제 메일/TLS/망/release, O02 부하, O03 journal, O04 backup, O05 restore는 운영 배치이며 C08 로컬 acceptance와 합쳐 판정하지 않는다.
