# 확장·네이티브 구현 행동 계획

기준: [기능 목록](../09-feature-list.md), [기능 명세](../10-feature-specifications.md), [모듈 경계](../03-modules.md), [통신 계약](../04-communication.md), [운영 기준](../06-operations.md), [공식 기술 근거](../08-official-references.md). 이 문서는 구현 전 분할 계획이다. 완료 증거는 구현 후 채울 관찰 항목이며 현재 통과를 뜻하지 않는다.

## 실행 규칙

- 카드별로 공개 책임과 관찰 가능한 상태를 완료 경계로 삼는다. 표의 추가/수정/삭제 범위는 모듈 소유권을 나타낸다. 실제 파일 변경 목록을 인계 조건으로 삼지 않는다.
- 배치·선행 관계의 정본은 [11-implementation-plan.md](../11-implementation-plan.md)의 W0~W14 및 통합 게이트다. 아래 카드의 선행은 그 배치 안에서 해당 기능에 필요한 관계만 표시한다. B05 HTTP 경계는 B03 DB/UoW의 선행이 아니며, 두 기반 작업은 독립 계약·검증 후 결합한다.
- 기반 단계에서 fake 어댑터·계약 검증으로 착수할 수 있는 조건과, 실제 데이터·OS·망에서 통과해야 하는 조건을 분리한다. mock 성공만으로 실환경 조건을 완료 처리하지 않는다.
- `packages/contracts`의 계약 원천, migration 순번·bootstrap·루트 lockfile, 공유 client-core는 오케스트레이터 단일 writer다. 카드 담당자는 상대 모듈 내부·테이블을 변경하지 않는다. 공유 변경이 필요하면 요구 이유, 호출 의미, 실패 의미, 관찰 가능한 결과를 포함한 공개 port 요청으로 오케스트레이터에 전달한다.
- U01~U04는 미확정으로 유지한다. U02가 없으면 관리자 검증을 비활성화하고 허용 판정하지 않는다. U03이 없으면 운영 파일·보존 정책을 활성화하지 않는다. U04가 없으면 device payload·provider·외부 전달·종료 보장을 확정하지 않는다.
- U 미확정으로 기능 route를 활성화할 수 없으면 route를 등록하지 않아 계약상 404로 처리한다. 앱은 활성 상태로 이를 확인한다. 임의의 비활성 응답 DTO는 추가하지 않는다.
- 공식 플랫폼 사실은 [08의 S09~S13](../08-official-references.md)을 우선 사용한다. 대상 OS/버전의 실제 허용망과 종료 동작은 실기기 관찰로 별도 판정한다.

## 확장 기능

### E01
감사 기록 append·조회·정리 · 담당: 6-luna · 기능: F30, F31

| 항목 | 계획 |
| --- | --- |
| 목적 | 관리 행위와 운영 작업을 서버 경계 안에서 추적하고, 권한 있는 관리자가 자기 서버 기록을 페이지 조회하며 보관 만료분을 제한 정리한다. |
| 추가/수정/삭제범위 | audit 소유 API·저장 상태의 추가: append, admin 조회, purge. 조회 핵심은 B01에서 동결된 관리자 guard를 사용한다. 업무 모듈 동작은 수정하지 않고 호출자가 공개 port로 기록한다. 일반 호출 경로에서 기존 감사 기록 수정·삭제는 제공하지 않는다. |
| goal | 필수 감사와 해당 관리 변경이 같은 UnitOfWork에서 함께 commit 또는 rollback된다. 조회는 서버별·페이지 제한이며 정리는 보관 경계와 재시작에 안전하다. |
| non-goal | 변경 행위의 권한 판정, 메시지/파일 업무 실행, 변조 불가능 저장소 보장, 감사 내역의 원문 복제는 포함하지 않는다. |
| 목표-input | 검증된 actor·server 문맥, action/target 분류, outcome, 요청 또는 job 추적 문맥, 허용된 요약, 트랜잭션 문맥; 조회는 검증된 관리자 문맥과 page cursor; purge는 보관 규칙·현재 시각·배치 상한이다. |
| 목표-output | append 결과와 내부 audit 식별자, 자기 서버의 제한 페이지와 다음 위치, purge 건수·재개 상태 또는 명확한 실패다. |
| 구현동작·실패처리 | audit만 자기 저장 상태를 쓴다. 필수 기록 실패는 호출 트랜잭션을 중단한다. cursor/기간/범위 오류는 거부하며 삭제 작업은 짧은 배치와 진행 위치로 반복 가능하게 한다. 일반 API는 불변 기록에 쓰기 경로를 노출하지 않는다. |
| 코드동작확인 Test방식 | 정상 append/list/purge, 일반 사용자·타 서버 관리자 거부, 경계 시각·빈/최대 페이지, audit DB 쓰기 실패 주입과 중단 후 재개, 프로세스 재시작 뒤 불변성 및 만료/미만료 대조를 확인한다. |
| 코드동작확인 로깅방식 | `audit.appended/failed`, `audit.listed`, `audit.retention.completed`에 `featureId`, server/actor 내부 ID, requestId 또는 jobId, 결과·건수를 allowlist로 남긴다. append는 업무 commit 뒤 성공 순서를 맞추고 purge 예약·실제 제거를 구별한다. 본문·이메일·요약 원문 전체·비밀값을 남기지 않는다. |
| 선행·병렬제약 | B01 frozen admin guard와 B03 UoW, B05 HTTP 경계, C01 세션 문맥을 소비한다. B03과 B05는 서로 선행하지 않으며 준비된 계약 단위로 병렬 개발 후 합친다. append/query core는 E02와 병렬 가능하다. 실제 관리자 감사 route의 통과 판정은 E02의 provider 결합 후 E08에서 한다. migration 작성·순번 배정은 오케스트레이터만 한다. |
| 완료증거 | DB 기록과 실제 관리 변경의 원자성, 권한별 페이지 결과, purge 경계·재개 결과를 시험 관찰값으로 대조하고 관련 사건의 featureId/requestId 순서를 남긴다. |

### E02
메일 서버 관리자 검증·보존 정책 · 담당: 6-luna · 기능: F26, F27

| 항목 | 계획 |
| --- | --- |
| 목적 | U02에서 검증된 서버별 증명에 한해서 관리 권한을 판정하고, U03에서 확정된 허용 범위 내 보존 정책을 감사와 함께 변경한다. |
| 추가/수정/삭제범위 | identity의 공개 관리자 판정 port와 retention 정책 조회/변경 책임을 추가한다. E01의 append와 메시지·파일 소유 모듈 공개 API만 호출한다. |
| goal | 관리자 여부는 서버가 검증한 증명만으로 판정한다. 정책 변경과 필수 감사가 같은 트랜잭션에서 확정되며 다음 처리부터 최신 버전이 적용된다. |
| non-goal | IMAP 로그인만으로 관리자 권한 추정, 사용자 입력 role 신뢰, 미확정 기간/크기/형식의 임의 기본값 설정, 실제 삭제 worker 구현은 포함하지 않는다. |
| 목표-input | 서버가 검증한 세션 문맥, U02 제품 증명 또는 운영 검증 역할 매핑 상태, 행위 범위; 정책은 U03 승인 값·현재 버전·변경 의도다. |
| 목표-output | 서버별 허용/거부 판정과 근거 분류, 정책 버전·적용 상태, 또는 미등록 route의 404다. |
| 구현동작·실패처리 | U02 미확정·증명 오류·서버 불일치는 fail-closed로 처리한다. U03 미확정 동안 정책 route를 등록하지 않아 계약상 404를 반환하며, 앱은 feature 활성 상태로 이를 표시한다. 별도 비활성 응답 DTO를 만들지 않는다. 확정 뒤 유효성 검사 후 정책과 필수 감사 append를 동일 UoW로 기록·commit하며 감사/DB 실패는 둘 다 rollback한다. |
| 코드동작확인 Test방식 | verified admin·일반·타 서버 admin·증명 만료/위조, 경계 정책값·버전 충돌, U02/U03 미설정 거부를 확인한다. 정책 DB 또는 audit 쓰기 실패를 주입하고 트랜잭션 결과를 검증하며 restart 뒤 정책 버전·다음 조회를 대조한다. fake 증명은 계약 시험만 통과시킨다. |
| 코드동작확인 로깅방식 | `identity.admin.checked`, `retention.policy.changed`에 featureId·server/user 내부 ID·requestId·근거 분류·정책 버전·결과를 남긴다. 같은 TxContext에서 필수 감사 append와 정책 변경을 모두 기록한 뒤 commit하고, 성공 로그는 commit 이후에만 남긴다. 증명 원문·역할 전체 설정·메일 주소·기간 입력 원문·비밀값은 제외한다. |
| 선행·병렬제약 | E01+C01. C01 공개 session/admin 입력 경계와 E01 append 계약에 의존한다. U02/U03의 실활성화는 별도 게이트이며 미확정 상태에서도 거부 동작·fake 계약 구현은 병렬 가능하다. |
| 완료증거 | 근거 유형별 거부/허용 매트릭스, U02/U03 미확정 상태의 비활성 관찰, 정책·감사 원자성 및 재시작 후 버전 지속 결과를 남긴다. |

### E03
파일 저장·전송·정리·삭제 port · 담당: 6-luna · 기능: F20, F22, F23, F29

| 항목 | 계획 |
| --- | --- |
| 목적 | 허용 조건을 통과한 스트림을 비공개 저장하고 참여자 다운로드, 미연결 파일 대조, 삭제 요청과 장애 재개를 제공한다. |
| 추가/수정/삭제범위 | files가 metadata·업로드 intent·삭제 job·저장소 port·업로드/다운로드/정리/삭제 공개 API를 소유한다. messages는 호출하지 않으며 files가 messages를 역참조하지 않는다. |
| goal | 파일 상태는 intent부터 준비·연결·삭제 진행·완료를 추적하며 DB와 파일시스템의 비원자성을 복구 가능하게 다룬다. 크기·형식·quota는 확정 정책으로 제한한다. |
| non-goal | 메시지 연결 transaction 조정, 원본 이름/경로를 공개하는 것, U03 없이 운영 제한값을 정하는 것, 파일 무결전 삭제나 디스크 완전 소거 주장은 포함하지 않는다. |
| 목표-input | 검증된 CTX·대화/파일 내부 참조, 스트림과 제한된 metadata, U03 정책·저장소 준비 상태; download는 현재 membership/연결/보존 상태; 정리는 intent·객체 인벤토리·시각·상한; 삭제는 소유 내부 파일 ID와 영속 job 문맥이다. |
| 목표-output | 준비 파일 참조와 안전한 metadata, 허용된 stream 또는 접근 실패, reconciliation 요약, 삭제 예약/완료/재시도 상태다. 실제 경로는 감춘다. |
| 구현동작·실패처리 | 스트림을 상한 내에서 처리하고 intent를 먼저 남긴다. 중단/저장 오류면 ready를 표시하지 않고 임시 상태를 남겨 재조정한다. 다운로드는 권한·보존 상태를 매회 확인하고 전송 완료와 중단을 구분한다. 고아 대조는 진행 중 업로드/연결을 보호한다. 물리 삭제 확인 또는 이미 없음이 확인될 때만 job 완료 처리한다. |
| 코드동작확인 Test방식 | 정상·최대 직전/초과 크기·잘못된 형식·비참여/타 서버·quota 경합·동시 업로드를 확인한다. 저장소 읽기/쓰기/삭제 오류, DB 실패, 스트림 중단과 job 직전/직후 crash를 주입한다. 삭제/정리 재실행·restart 후 정상 연결 보존, 다운로드 byte 일치·경로 비노출을 대조한다. U03 전에는 fake policy 경계만 계약 검증한다. |
| 코드동작확인 로깅방식 | `files.upload.completed/failed`, `files.download.completed/interrupted/rejected`, `files.reconcile.completed`, `files.delete.completed/retry/failed`에 featureId·fileId·conversationId·jobId·requestId·byte/건수·duration·안전한 사유를 기록한다. 성공은 저장/전송/삭제 관찰 뒤 순서대로 남기며 원본 이름·내용·경로·stream chunk를 제외한다. |
| 선행·병렬제약 | C02+B04+B05. conversations membership·B04 영속 job·B05 스트림 경계 필요. U03 실활성화는 미확정 게이트다. E03 공개 준비/삭제 port 확정 후 E04/E07이 병렬 통합 가능하다. |
| 완료증거 | intent/metadata와 객체 상태 대조, 권한·경계 응답, 실패 주입 뒤 재개, restart 뒤 미완료 job 처리, 성공/실패 사건과 실제 byte·객체 결과를 연결한다. |

### E04
메시지 첨부 연결 조정 · 담당: 6-luna · 기능: F21

| 항목 | 계획 |
| --- | --- |
| 목적 | 소유 사용자의 준비된 파일만 메시지 전송과 원자적으로 연결하여 부분 메시지나 고아 연결을 막는다. |
| 추가/수정/삭제범위 | messages가 전송 조정 책임을 가진다. E03의 공개 준비 확인/연결 port와 호출자 UoW 계약만 사용한다. files 내부 저장소·테이블은 다루지 않는다. |
| goal | message·첨부 관계·dedup·outbox가 하나의 commit으로 확정되며 재시도는 기존 메시지 결과를 재사용한다. |
| non-goal | 파일 업로드/다운로드 구현, files 내부 규칙 변경, 서버 계약 원천·공유 migration 직접 수정은 포함하지 않는다. |
| 목표-input | 검증된 CTX·대화 ID·clientMessageId·내용 의미·준비 파일 참조 목록, 동일 TxContext, conversations 권한 및 E03 상태 판정이다. |
| 목표-output | 첨부 참조를 포함한 확정 메시지/이벤트 결과, 기존 동일 요청 결과, 또는 권한/상태/충돌/저장 실패다. |
| 구현동작·실패처리 | messages가 참여 확인과 dedup을 먼저 수행하고 TxContext 안에서 files 공개 port로 소유·준비·단일 연결 가능성을 확인한 후 메시지·연결·outbox를 함께 commit한다. 미준비/타 대화/삭제 중/중복 파일은 거부하며 실패 시 어떤 관계도 확정하지 않는다. |
| 코드동작확인 Test방식 | 정상 첨부 전송·같은 clientMessageId 재시도, 다른 사용자/서버/대화·미준비/이미 연결/삭제 중 거부, 동시 연결 경합을 확인한다. 메시지·files 연결·outbox DB 저장 실패와 프로세스 종료를 commit 경계에 주입하고 restart 후 전체 원자성과 하나의 메시지/연결만 존재함을 확인한다. 일반 메시지 전송 audit는 원문 요구가 아니므로 실패 주입 범위에 포함하지 않는다. |
| 코드동작확인 로깅방식 | `files.bound`와 기존 message 성공 사건에 featureId·messageId·fileId 내부 참조·대화·requestId·연결 건수·outcome을 기록한다. commit 뒤 성공 순서를 보장하고 rollback에서는 성공 사건이 없어야 한다. 파일명·내용·요청 본문은 제외한다. |
| 선행·병렬제약 | C03+E03. C03 메시지/UoW 계약과 E03의 공개 port가 모두 정해진 뒤. shared contracts/UoW 변경 필요 시 요청만 제출하고 자체 변경하지 않는다. |
| 완료증거 | 정상·재시도 및 거부 매트릭스, DB 후상태·outbox·첨부 관계의 원자성, commit 순서와 로그를 대조한다. |

### E05
읽음 조회·단조 증가·이벤트 · 담당: 6-luna · 기능: F24, F25 server

| 항목 | 계획 |
| --- | --- |
| 목적 | 사용자별 읽음 위치를 유효하게 전진시키고 동기화 가능한 읽음 상태를 제공한다. |
| 추가/수정/삭제범위 | receipts가 read cursor와 조회/advance 책임을 소유한다. conversations의 공개 membership 판정과 messages의 유효 ID 확인, event/outbox 공개 port만 호출한다. |
| goal | 저장 위치는 기존 위치보다 작아지지 않으며 실제 전진과 해당 이벤트가 원자 commit된다. 조회는 참여자별 현재 서버 데이터로 제한된다. |
| non-goal | 화면이 보지 않은 메시지의 자동 읽음, 메시지 본문 변경, 클라이언트 store/UI 수정은 포함하지 않는다. |
| 목표-input | 검증 CTX·conversationId·마지막으로 화면 확인된 메시지 ID, 기존 cursor·유효 메시지 판정, snapshot/event cursor 문맥이다. |
| 목표-output | 확정 위치·변경/no-op/거부 판정, 참여자별 읽음 목록과 snapshotCursor, commit된 업데이트 이벤트다. |
| 구현동작·실패처리 | membership과 같은 대화의 유효 메시지를 검증하고 동시 갱신은 max(old,new)로 저장한다. no-op에는 불필요 이벤트를 만들지 않는다. 저장/outbox 오류는 위치 변경을 rollback한다. 조회·이벤트 모두 현재 권한으로 거른다. |
| 코드동작확인 Test방식 | 과거/동일/신규·동시 두 기기·큰 문자열 ID·없는 ID/타 대화/비참여 경계를 확인한다. DB/outbox 실패 주입 후 cursor 불변, 순서 역전 이벤트·restart/snapshot 병합 후 후퇴 없음, 조회와 저장값 일치를 확인한다. |
| 코드동작확인 로깅방식 | `receipts.advanced`, `receipts.listed`에 featureId·server/conversation/user 내부 ID·위치 분류·결과·requestId·반환/변경 건수를 남긴다. 전진 commit 후 event 순서를 대조하고 본문·사용자명·전체 목록은 제외한다. |
| 선행·병렬제약 | C02+C03. C04 event/outbox 공개 계약과 함께 통합한다. 클라이언트 F25 UI는 E06이 맡으며 server port 확정 후 병렬 가능. |
| 완료증거 | DB 단조성, 이벤트 cursor, 조회 권한 및 순서 역전/restart 결과를 대조하고 로그 추적으로 변경/no-op/거부를 구별한다. |

### E06
파일·읽음·보존 관리 UI · 담당: 6-luna · 기능: F20·F21·F22·F24·F25·F26·F27 UI

| 항목 | 계획 |
| --- | --- |
| 목적 | 공통 화면 모델로 업로드 진행·첨부·다운로드·읽음 표시·관리자 보존 설정을 보여주고 실패 상태를 사용자에게 일관되게 알린다. |
| 추가/수정/삭제범위 | client-react feature 화면/상태와 기능별 UX 책임을 추가한다. client-core 공유 store/API adapter의 변경은 오케스트레이터 단일 writer에 요청해 직렬 통합한다. 서버 내부/계약 원천을 직접 편집하지 않는다. |
| goal | 기존 client-core 상태와 서버 결과를 기준으로 상태가 일치하고 권한/정책 미확정은 명확히 비활성/오류로 나타난다. 대화 전환·로그아웃에서 이전 서버 정보가 남지 않는다. |
| non-goal | 브라우저별 인증 토큰 보관, 로컬 영구 파일 캐시, 클라이언트에서 권한 판정, U03 값을 정하는 행위는 포함하지 않는다. |
| 목표-input | C06 core의 승인된 화면 상태/API 호출 경계, 서버의 file/receipt/admin 결과와 오류, 선택 대화·세션, U02/U03의 활성 상태다. |
| 목표-output | 업로드/다운로드/첨부/읽음 진행·결과, 서버 권한이 확인된 보존 설정 화면 또는 비활성/거부 설명, 접근 가능한 오류 상태다. |
| 구현동작·실패처리 | 화면은 core에 의도와 결과만 전달하고 원격 기록을 복제 소유하지 않는다. 업로드 취소·재시도·권한 거부·만료를 구분하며 응답 지연/대화 전환 뒤 낡은 결과를 적용하지 않는다. 관리자 화면 숨김과 서버 거부를 혼동하지 않는다. 공유 core 수정은 명시적 port 제안 뒤 오케스트레이터가 통합한다. |
| 코드동작확인 Test방식 | 컴포넌트/통합에서 정상 업로드·다운로드·읽음 병합·정책 조회/변경, 역할 거부·U02/U03 미설정·파일 경계·만료·네트워크 실패를 확인한다. 느린 응답 중 대화/계정 전환, restart/재로그인 뒤 과거 상태 미노출, 접근성 키보드·작은 화면 경계를 확인한다. |
| 코드동작확인 로깅방식 | 로컬 UI 사건은 featureId·기능 분류·outcome·안전한 사유와 서버 requestId 상관값만 둔다. 서버 사건 순서와 응답 상태를 대조하며 파일 경로/URI·이메일·본문·token·정책 원문은 로컬 로그에도 제외한다. |
| 선행·병렬제약 | C06+C07+E02/E03/E04/E05. 화면 skeleton·mock 계약 작업은 병렬 가능하나 실제 연동은 공개 결과 확정 후. core 공유 수정은 반드시 오케스트레이터 단일 writer가 직렬 반영한다. |
| 완료증거 | 주요 상태별 UI 관찰과 서버 결과/requestId 연결, 역할·정책 미확정 시 차단, 전환 후 잔류 상태 없음, core 공유 변경의 통합 확인을 기록한다. |

### E07
보존 만료·삭제 배치 · 담당: 6-luna · 기능: F28

| 항목 | 계획 |
| --- | --- |
| 목적 | 최신 서버 정책으로 만료 메시지와 첨부 접근을 차단하고 소유 모듈에 후속 정리를 요청한다. |
| 추가/수정/삭제범위 | retention이 정책 버전·run·진행 상태를 소유하고 messages의 만료 purge와 files의 공개 삭제 예약 API만 호출한다. 상대 테이블·저장소를 직접 변경하지 않는다. |
| goal | 짧은 제한 배치가 중단·재시작 가능하고 논리 삭제 즉시 조회/sync/알림에서 제외된다. 첨부가 더 짧게 만료되면 메시지 수명은 유지한다. |
| non-goal | files 물리 삭제 구현, 백업에서 완전 소거, 새 보존 기간 선택, 감사 저장을 대체하는 것은 포함하지 않는다. |
| 목표-input | 활성화된 관리자 정책/버전·시각·배치 cursor/상한, 메시지·파일 만료 후보 요약, messages/files 공개 호출 port, job 문맥이다. |
| 목표-output | 만료 메시지/tombstone·접근 차단·삭제 예약 결과, 정책 버전·처리 요약·재개 위치다. |
| 구현동작·실패처리 | 각 제한 배치 단위에서 최신 정책 버전을 확인하고 동일 TxContext로 messages/files 소유 공개 port를 호출한다. 본문 삭제·tombstone·파일 접근 차단/삭제 job·삭제 이벤트·진행 위치를 한 원자 단위로 기록한다. 어느 단계든 실패하면 해당 단위를 rollback하고 같은 job을 재시도한다. 알림/재전송 경로는 삭제 자료를 재생하지 않는다. 정책 미확정이면 route/worker를 등록하지 않고 route는 404, 앱은 기능 비활성 상태로 표시한다. 별도 비활성 DTO는 만들지 않는다. |
| 코드동작확인 Test방식 | 만료 직전/시각 경계·파일이 먼저 만료·정책 변경·배치 상한·중단 후 재개를 확인한다. messages/files 호출 실패·DB/worker 종료·restart를 주입하고 조회/download/sync/알림의 삭제 내용 비노출과 tombstone 비부활을 확인한다. |
| 코드동작확인 로깅방식 | `retention.batch.completed/failed`와 audit 요약에 featureId·jobId·serverId·정책 버전·검사/삭제/예약/실패 수·duration·request 추적을 기록한다. 논리 차단→삭제 예약→물리 완료 순서를 구분하며 본문·파일 내용은 남기지 않는다. |
| 선행·병렬제약 | E02+E03+E04+C03. 정책 활성 상태와 동일 TxContext를 받는 두 소유 port가 필요하다. E03/E04 공개 port 착수와 병렬 설계 가능하지만 통합 실행은 해당 port 확정 후다. |
| 완료증거 | 현재 정책 버전으로 만료 경계 판정, 단계별 접근 차단·job 재개·이벤트 비부활·audit/log 순서를 검증한다. |

### E08
확장 권한·중단·재시도·복원 관통 시험 · 담당: 6-luna · 기능: F20-F31

| 항목 | 계획 |
| --- | --- |
| 목적 | 파일·읽음·관리·보존·감사 기능이 서버 격리와 원자성, 삭제 복구 경계를 함께 지키는지 통합 확인한다. |
| 추가/수정/삭제범위 | 테스트 harness·fixture·관찰 기록을 추가한다. 제품 모듈 동작이나 정책 값을 바꾸지 않으며 실패 발견 시 소유 카드에 수정 요청을 연결한다. |
| goal | 권한 거부·삭제 접근 차단·중단 재개·복원 후 최신 정책 적용이 end-to-end로 확인된다. |
| non-goal | 외부 메일·TLS/망·부하·journal 운영·실제 백업 매체 시험은 O01~O05로 남기며 이 카드에서 통과 처리하지 않는다. |
| 목표-input | 승인된 contracts/모듈 port, 격리 DB·임시 저장소, fake clock/job/provider, 서버/사용자 역할 fixture, 실패 주입 지점과 복구 시나리오다. |
| 목표-output | 기능 ID별 정상/거부/경계/주입 실패/restart 결과, 관찰된 DB·객체·이벤트·audit 상태, 미통과/환경 미검증 사유다. |
| 구현동작·실패처리 | 시나리오별 전제와 기대 관찰을 실행하고 외부효과 직전/직후 실패를 주입한다. 테스트 격리 데이터를 정리하되 실패 흔적을 성공으로 바꾸지 않는다. 발견 이슈는 소유 모듈에 귀속하고 본 카드는 확인 결과만 갱신한다. |
| 코드동작확인 Test방식 | 타 서버·비참여·일반 사용자 거부, 스트림 경계, 단조 receipt, 정책 변경/audit rollback, retention 중단, 파일 삭제 retry, 복원 이후 정책·세션/cursor 경계를 확인한다. DB·파일·worker crash 및 restart를 시나리오별 주입하며 mock 통과와 실환경 통과를 분리한다. |
| 코드동작확인 로깅방식 | 각 실행에 featureId·시험 run/request/job 추적·시나리오 분류·outcome·안전한 errorCode를 연결한다. 업무 사건 순서와 저장 상태를 대조하고 fixture 본문·파일·token·증명 원문을 로그에 남기지 않는다. |
| 선행·병렬제약 | E06+E07 및 E01~E05 공개 경계. local 관통검증은 첨부 포함 checkpoint인 O04/O05가 선행한다. O03 journal 실환경 검증은 별도 gate로 분리하며 E08 local 판정의 선행으로 묶지 않는다. |
| 완료증거 | 기능별 실행 결과표, 실패 지점·재시작 후 관찰, 권한/데이터 격리 결과와 미검증 환경 조건을 분리 기록한다. |

## 네이티브·알림 기능

### N01
기기별 세션·자격 증명 port · 담당: 6-luna · 기능: F32

| 항목 | 계획 |
| --- | --- |
| 목적 | 네이티브 앱의 별도 bearer 세션 흐름과 OS 보호 저장소 경계를 계약으로 제공한다. |
| 추가/수정/삭제범위 | identity의 공개 native session 판정과 CredentialStore/transport port 경계를 구현한다. 사용자·session 업무 소유권은 identity, 플랫폼 비밀 저장은 해당 native adapter다. 공유 identity 내부 구현은 수정하지 않는다. |
| goal | 기기별 opaque 세션을 발급·검증·폐기하고 비밀은 OS 보호 저장소를 통해서만 저장/제출한다. |
| non-goal | U01 미확정 메일 인증 운영, 브라우저 cookie 대체, token의 앱 일반 설정/JS 저장은 포함하지 않는다. |
| 목표-input | 등록 서버 문맥·일회 인증 입력·기기 port의 저장/읽기/삭제 결과·native transport 인증 문맥·폐기 신호다. |
| 목표-output | 검증된 사용자/server 문맥과 opaque 세션 상태, OS 저장소 저장/삭제 확인 또는 안전한 실패/재로그인 상태다. |
| 구현동작·실패처리 | bearer는 Authorization 경계로만 제출하고 URL/query와 cookie 동시 제출은 거부한다. 저장소 실패 시 로그인 완료로 표시하지 않는다. 로그아웃/폐기 시 로컬 증명과 서버 세션을 각각 폐기하고 어느 한쪽 실패도 숨기지 않는다. |
| 코드동작확인 Test방식 | 계약/fake adapter로 login·restart·만료·폐기·저장소 접근 거부·cookie/bearer 혼합 거부를 확인한다. 앱 종료/DB/session 저장 오류와 재시작을 주입한다. OS 보안 저장소 실제 검증은 플랫폼 실앱에서 별도 증거가 필요하다. |
| 코드동작확인 로깅방식 | `identity.native.login.completed`, 로컬 `client.credentials.updated`에 featureId·내부 user/device 참조·결과·사유·requestId를 둔다. 저장/서버 발급/폐기 순서를 관찰하고 비밀번호·token·hash·보호 저장소 원문을 제외한다. |
| 선행·병렬제약 | C01+B05. native 계약 초안은 B01 공개 port 뒤 가능하며 identity 공유 변경/계약 원천은 오케스트레이터 직렬 통합. U01은 실제 메일 인증 게이트, U04는 기기 운영 조건 게이트로 유지한다. |
| 완료증거 | fake port 경계 및 세션 폐기 통합 결과, token 미노출 검색, restart 상태와 OS 저장소 실기기 판정을 별도로 남긴다. |

### N02
Windows 앱·OS port · 담당: 6-luna · 기능: F33

| 항목 | 계획 |
| --- | --- |
| 목적 | Windows 앱에서 공통 기능 계약을 연결하고 자격 증명·파일 선택·알림 등 OS 동작을 공개 port 뒤에 둔다. |
| 추가/수정/삭제범위 | desktop/Tauri adapter와 OS port 구현을 맡는다. client-core 공유 동작은 변경 제안만 하고 오케스트레이터가 직렬 통합한다. |
| goal | Web과 동일 계약의 로그인·대화·파일·읽음 흐름을 제공하고 창 종료/재실행 상태를 관찰 가능하게 한다. |
| non-goal | provider 허용 결정이나 종료 알림 성공 보장, U04 없는 설치/망 조건 임의 지정은 포함하지 않는다. |
| 목표-input | N01 session/credential 계약·C06/C07 화면 상태·E06 feature 동작, OS 자격 저장·파일 picker·notification port 실행 결과다. |
| 목표-output | 공통 화면 업무 결과, OS 파일 선택/취소 및 알림 관찰 결과, 연결·세션 오류 상태다. |
| 구현동작·실패처리 | OS 권한과 자격 증명은 어댑터가 감싸고 앱 기능은 공개 port를 호출한다. 사용자 취소·권한 거부·네트워크 단절·세션 만료를 분리한다. 창 닫기와 프로세스 종료를 별도 상태로 보고 앱 재실행 후 이전 사용자 데이터 노출을 막는다. |
| 코드동작확인 Test방식 | 공통 계약 vector 및 Windows 실앱에서 로그인/재실행/만료·대화·파일 저장/취소·읽음·망 중단을 확인한다. 저장소·파일 권한·앱 종료·재시작 실패를 주입하며 종료 상태별 알림은 N06 실기기 시험에서만 판정한다. |
| 코드동작확인 로깅방식 | 로컬 `desktop.operation.completed/failed`에 featureId·OS 동작 분류·outcome·안전한 사유·서버 requestId를 연결한다. credential/file 선택 결과와 서버 응답 순서를 대조하고 파일 경로·내용·token은 제외한다. |
| 선행·병렬제약 | N01+C06+E06. UI skeleton은 병렬 가능하나 실제 core 공유 연결은 오케스트레이터 직렬 통합 후. U04의 OS/배포/망 결정 전에는 앱 계약 구현까지만 한다. |
| 완료증거 | 공통 vector 비교, 실제 Windows OS port 결과, 창 닫기/프로세스 종료 구분, 서버 추적과 민감값 부재 증거를 남긴다. |

### N03
Android 계약·앱·수명주기 · 담당: 6-luna · 기능: F34

| 항목 | 계획 |
| --- | --- |
| 목적 | 생성 계약을 기준으로 Android 앱 업무 흐름과 OS 수명주기·보호 저장소 port를 연결한다. |
| 추가/수정/삭제범위 | Android 앱/adapter와 수명주기 처리 책임을 추가한다. 생성 DTO·OpenAPI 및 공유 client-core 동작은 직접 수정하지 않고 오케스트레이터에 통합 요청한다. |
| goal | Web과 같은 API 의미·ID/시간 처리·오류 결과를 제공하고 프로세스 재생성 뒤 이전 계정 상태가 잘못 복원되지 않는다. |
| non-goal | 특정 Android 버전·배포 채널·허용망을 U04 없이 확정하거나 강제 중지 상태에서 백그라운드 실행을 보장하지 않는다. |
| 목표-input | B01 생성 계약, N01 credential/session port, 사용자 동작·앱 상태 복원 신호·OS 권한·허용망 실행 조건이다. |
| 목표-output | Compose 화면의 로그인/대화/파일/읽음 상태와 복구/재로그인 결과, OS 권한·접속 불가를 구분한 결과다. |
| 구현동작·실패처리 | 프로세스/화면 재생성을 분리해 복원 가능한 비밀 없는 화면 상태만 재구성한다. stale async 결과를 세션 세대와 대조해 폐기한다. 파일 picker 취소, 권한 거부, 백그라운드 제한과 망 변화는 사용자에게 구별해 전달한다. |
| 코드동작확인 Test방식 | 계약 vector에서 큰 ID 문자열·UTC/서울 표시·UTF-16 경계·파일·읽음을 검증한다. 화면 회전/재생성·백그라운드 복귀·권한 거부·네트워크 변경·저장소 실패·재시작을 확인한다. 허용 사설망 실제 접속은 U04 확정 뒤 실기기로 따로 확인한다. |
| 코드동작확인 로깅방식 | 로컬 `android.operation.completed/failed`에 featureId·기능/수명주기 분류·outcome·사유·server requestId를 기록한다. 계정·본문·파일 URI·token·OS 개인정보 없이 앱 관찰과 서버 추적을 연결한다. |
| 선행·병렬제약 | mock·생성 계약 착수는 B01+N01 뒤 가능하다. 실제 공통 기능 통과 판정에는 E08의 확장 구현 통합 완료가 필요하다. 앱 skeleton은 병렬 가능하고 생성 계약 변경은 오케스트레이터 직렬 통합이다. U04는 실기기 조건을 제한한다. |
| 완료증거 | 공통 계약 vector 결과, 수명주기 별 상태 복구/폐기 결과, U04 실망 접속 증거 또는 미확정 상태를 분리 기록한다. |

### N04
기기 등록·해제 · 담당: 6-luna · 기능: F35

| 항목 | 계획 |
| --- | --- |
| 목적 | 인증된 사용자 소유 기기의 알림 대상 상태를 관리하고 해제된 기기를 후속 발송에서 제외한다. |
| 추가/수정/삭제범위 | notifications의 device 등록·갱신·해제 공개 책임과 내부 상태를 추가한다. identity session 검증 및 provider 증명 저장 port만 소비한다. |
| goal | server/user 소유 경계를 지키고 중복 갱신·해제가 안전하며 해제는 후속 작업 대상에서 제외된다. |
| non-goal | U04가 정하지 않은 payload 필드, provider token 형식, 특정 provider/알림 경로를 확정하거나 외부 provider를 호출하는 것은 포함하지 않는다. |
| 목표-input | native CTX, U04 확정 뒤 정해질 등록/갱신/해제 의도와 기기·플랫폼·권한 증명의 계약 의미, 서버 내부 소유 관계다. |
| 목표-output | 내부 기기 참조·활성 상태·갱신/해제 결과 또는 미확정/권한 오류다. |
| 구현동작·실패처리 | U04 계약 미확정이면 등록 route를 등록하지 않아 계약상 404로 처리하고 앱 UI는 feature 비활성 상태로 표시한다. 임의 비활성 응답 DTO를 만들지 않는다. 계약 확정 후에는 증명을 비밀로 저장하고 서버/user 소유권을 검증한다. 해제와 갱신은 idempotent하게 처리하며 해제 중 전달 경합은 N05에서 재검증한다. |
| 코드동작확인 Test방식 | 계약 확정 전에는 route 미등록/404와 UI 비활성 표시, 임의 DTO 부재를 확인한다. 이후 등록·중복 갱신·해제·다른 사용자/서버 거부·동시 변경을 확인하고 DB/증명 저장 실패와 restart를 주입한다. |
| 코드동작확인 로깅방식 | `notifications.device.registered/updated/unregistered`에 featureId·내부 device/user/server ID·platform 분류·requestId·outcome을 남긴다. 변경 commit 뒤 발행 순서를 확인하고 provider token/실기기 개인정보/원 payload를 제외한다. |
| 선행·병렬제약 | N01+U04. 계약 skeleton은 N01 뒤 병렬 가능하다. 외부 provider 선택·실제 등록은 U04 조건 확정 전 금지이며 contracts 변경은 오케스트레이터 단일 writer다. |
| 완료증거 | 미확정 게이트에서 비활성 결과, 확정 이후 소유권·갱신/해제·restart 결과와 실제 발송 대상 제외를 대조한다. |

### N05
알림 job 적재·provider 재시도 · 담당: 6-luna · 기능: F36

| 항목 | 계획 |
| --- | --- |
| 목적 | 메시지 commit 뒤 알림 업무를 영속 job으로 만들고 확정된 provider의 접수/재시도 결과를 관리한다. |
| 추가/수정/삭제범위 | notifications job/enqueue/deliver와 B04 공개 scheduler/provider port를 소비한다. messages의 commit/outbox 공개 이벤트를 입력으로 받으며 메시지 저장 흐름은 변경하지 않는다. |
| goal | 알림 장애가 메시지 commit을 취소하지 않고 중복 job/중단 뒤 재시도가 안전하며 삭제 자료·해제 기기는 전달 대상에서 빠진다. |
| non-goal | U04 전 provider 선택·외부 호출·OS 표시 성공 판정, 알림 payload 본문 저장은 포함하지 않는다. |
| 목표-input | commit된 메시지/event 내부 참조, 현재 membership·retention 삭제 여부·활성 기기 상태, B04 job 상태·확정 provider 설정·전달 정책이다. |
| 목표-output | 영속 notification job과 accepted/retry/failed 판정이다. accepted는 OS 표시 완료를 의미하지 않는다. |
| 구현동작·실패처리 | commit된 outbox를 재조회하는 소비자가 메시지/기기별 유일한 알림 job을 만든다. job 적재와 해당 소비자의 처리 위치 전진을 같은 트랜잭션으로 확정하여 commit 뒤 enqueue 전 crash에도 누락되지 않게 한다. realtime 전달 완료와 자기 소비 위치를 공유하지 않는다. provider 호출 전 권한·삭제·기기 상태를 다시 확인한다. provider 미확정이면 전달 worker를 비활성화한다. timeout/crash/중복은 같은 job ID로 재시도하고 최종 실패를 보존한다. |
| 코드동작확인 Test방식 | 저장 rollback 시 job 없음, 메시지 commit 직후·job 적재/소비 위치 전진 전후 crash, 이벤트 중복 소비에서 단일 job, realtime 소비가 먼저 끝난 경우의 독립 재개를 확인한다. provider timeout/중복/오류, 기기 해제·retention 삭제 경합, 재시도 상한·restart를 fake provider로 확인한다. U04 이전 결과는 내부 fake까지만이며 실 provider 통과로 기록하지 않는다. |
| 코드동작확인 로깅방식 | `notifications.job.enqueued`, `notifications.delivery.accepted/retry/failed`에 featureId·jobId·message/device 내부 ID·provider 분류·attempt·outcome·request/correlation ID를 기록한다. commit→enqueue→전달 순서를 대조하고 payload·token·본문은 제외한다. |
| 선행·병렬제약 | N04+B04+C03. 메시지 commit 사건과 영속 worker port가 필요하다. fake adapter 구현은 계약 작업과 병렬 가능하나 U04 전 실 provider 선택·호출은 활성화할 수 없다. |
| 완료증거 | job DB 상태와 provider fake 관찰을 대조하고 중복/재시작 후 결과·삭제/해제 대상 제외·accepted와 표시의 구분을 기록한다. |

### N06
실기기 OS 상태별 알림 판정 · 담당: 6-luna · 기능: F37

| 항목 | 계획 |
| --- | --- |
| 목적 | Windows/Android 실행 상태별로 알림이 실제 표시되는지 관찰하고 R10/R11 달성 여부와 허용 대안 판단에 필요한 증거를 정리한다. |
| 추가/수정/삭제범위 | 플랫폼 실기기 시험 시나리오·관찰 결과·대안 결정 기록을 추가한다. OS/provider 설정 변경이나 제품 기능 확정은 U04 승인 조건에 따라 별도 수행한다. |
| goal | 상주·백그라운드·프로세스 종료·OS 강제 종료·재부팅·오프라인을 구분하고 provider 접수와 표시를 각각 증명한다. |
| non-goal | 상주를 프로세스 종료 성공으로 간주하거나 provider 접수를 OS 표시로 간주하는 것, 공식 문서만으로 실기기 성공을 주장하는 것은 포함하지 않는다. |
| 목표-input | U04에서 확정한 폰 허용망·OS/배포 경로·종료 알림 허용 대안, N02/N03/N05 실행 산출물, 기기 전원/망/권한/상태 및 실제 관찰 시각이다. |
| 목표-output | 상태별 displayed/blocked/not observed 결과, 앱으로 진입한 후 대화 접근 결과, 요구 달성/미달성/조건부 판정 및 미달 시 대안 결정 필요 상태다. |
| 구현동작·실패처리 | 상태별 독립 시나리오와 사전조건을 기록한다. 종료 중 앱 로그가 없으면 서버 provider 사건과 OS 화면·시험 관찰을 별도 연결한다. 조건 불가 시 성공으로 추정하지 않고 실패 원인·재현 조건을 남겨 U04 대안 결정 대상으로 돌린다. |
| 코드동작확인 Test방식 | 실기기에서 전경·백그라운드·창 닫기/상주·프로세스 종료·OS 강제 중지·재부팅·오프라인/복귀·권한 거부를 각각 실행한다. provider accepted와 표시 관찰을 분리하고 허용 사설망 접근, 알림 선택 후 해당 대화 접근도 확인한다. 조건을 마련할 수 없는 항목은 미검증으로 남긴다. |
| 코드동작확인 로깅방식 | 가능한 상태에서 `client.notification.observed`에 featureId·device 내부 참조·상태 분류·표시/차단 결과·시각·correlation ID를 기록한다. 서버 `accepted`/retry 사건과 OS 관찰 시각을 연결하되 본문·token·실기기 개인정보는 제외한다. |
| 선행·병렬제약 | N02+N03+N05+U04. 앱/worker fake 시나리오는 선행 개발 가능하지만 실제 판정에는 U04와 접근 가능한 실기기·망이 필요하다. 환경 조건 불가 시 대안 선택을 기록하고 종료 상태 보장을 주장하지 않는다. |
| 완료증거 | 각 OS 상태의 provider 접수와 화면 표시를 구분한 관찰표, 실행·망 조건, 미달/미검증 사유, U04에 따른 대안 결정 기록이다. |
