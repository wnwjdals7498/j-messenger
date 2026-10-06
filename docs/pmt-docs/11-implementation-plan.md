# 6-luna 병렬 구현 상세계획

작성일: 2026-10-02. [47개 기능](09-feature-list.md)과 [기능 명세](10-feature-specifications.md)를 구현 가능한 책임 단위로 나눈다. **이번 산출물은 실행 계획이며 애플리케이션 구현 결과가 아니다.**

## 목표와 계획 범위

목표는 같은 메일 서버의 사용자들이 실제 인증 후 개인·단체 대화를 하고, 재시작·중복 요청·연결 끊김에도 기록을 유지하는 서비스다. 파일·읽음·보존·네이티브 앱은 같은 계약 위에 단계적으로 연결한다.

인계 단위는 파일이 아니라 **소유 기능 + 공개 계약 + 상태 변화 + 실패 처리 + 검증 결과**다. 구현자는 자기 소유 영역 안에서 구체 파일 배치를 결정한다. 아래의 경로는 동시 변경 충돌을 막는 책임 경계이며 파일별 편집 지시가 아니다.

카드의 추가/수정/삭제는 새 책임 도입, 기존 동작의 변경, 폐기 가능한 동작과 그 조건을 의미한다. 구 데모·사용자 변경·실데이터는 자동 삭제 대상이 아니다. 앱 구현·시험·실환경 판정은 구분하여 보고한다.

카드가 별도로 폐기를 명시하지 않은 기존 코드·환경 자산의 삭제 범위는 없음이다. 기존 코드가 없는 책임은 신규 구현하고, 이미 구현된 책임은 카드에 정한 계약·상태 전이 안에서 수정한다. 기능의 정책상 데이터 삭제와 기존 구현 철거 권한을 혼동하지 않는다.

| 상세 카드 | 범위 |
| --- | --- |
| [기반·운영](implementation-plan/01-foundation-operations.md) | B01~B06·O01~O05: 계약·DB·실행·배포·로그·자원·복구 |
| [메신저 핵심](implementation-plan/02-core-messaging.md) | C01~C08: 인증·참여·메시지·실시간·sync·client-core·Web·통합 |
| [확장·네이티브](implementation-plan/03-extensions-native.md) | E01~E08·N01~N06: 감사·정책·파일·읽음·보존·앱·알림 |

## 실행자와 소유권

구현 worker는 `gpt-6-luna` 모델을 사용한다. 오케스트레이터 한 명과 동시에 최대 세 worker로 진행하며, 다음 작업은 완료/통합된 계약을 확인한 뒤 배정한다. 이번 계획 작성에도 6-luna 세 명을 사용했다. 서브에이전트 간 인계·공통 자산 변경·PMT 기록은 오케스트레이터가 통제한다.

| 책임 영역 | 소유자·병렬 규칙 |
| --- | --- |
| 공개 wire 계약·공통 port·feature/오류/로그 식별 | B01 계약 책임을 오케스트레이터가 통합. `contracts` 원천은 한 writer |
| root workspace·lockfile·공통 검사·공유 설정 | B02/B05 책임을 오케스트레이터가 통합. 의존성 설치·lockfile 갱신 동시 실행 금지 |
| DB 연결·UoW·outbox·job 플랫폼 | B03/B04 담당 worker. 업무 모듈 데이터 규칙은 각 업무 owner가 제안 |
| migration 순번·적용·bootstrap 등록 | 오케스트레이터 단일 writer. worker가 소유 테이블 정의·필요한 제약/등록 요구를 제출 |
| identity·conversations·messages·realtime | C01·C02·C03·C04가 각 모듈과 자기 시험 소유. 같은 모듈의 확장 카드는 직렬 배정 |
| server sync·cursor | C05가 플랫폼 reader와 업무 조회 port 조정 소유. C04의 연결 코드 변경은 owner 통합 |
| client-core·client-react | C06·C07가 각 상태/화면 책임 소유. E06·N01/N02의 공유 core 변경은 해당 owner와 직렬 통합 |
| audit·retention·files·receipts | E01·E02/E07·E03·E05. E02→E07은 같은 retention 영역이므로 동시 writer 금지 |
| messages의 첨부 연결·삭제 기능 | C03 owner를 E04/보존 연계 때 재사용. E03/E07은 공개 port만 호출 |
| desktop·android·notifications | N02·N03·N04/N05. N04→N05는 같은 notifications 모듈을 직렬 확장 |
| 운영 도구·실행 절차·복구 시험 | O01~O05의 책임별 배정. 같은 배포 대상·공유 검증 설정·실DB는 동시에 변경하지 않음 |
| AGENTS·설계 정본·PMT·통합 증거 | 오케스트레이터만 기록. worker가 스스로 PMT/lock/다른 agent 영역을 수정하지 않음 |

모듈 소유는 [구조](02-architecture.md)·[모듈](03-modules.md)을 따른다. 상대 repository·테이블·내부 폴더 참조는 금지한다. 영역이 겹치면 동시에 배정하지 않거나 owner에게 통합 변경을 맡긴다. 비충돌 코드 변경과 독립 fixture 검증만 병렬 실행한다.

## 먼저 동결할 계약

B01의 완료는 아래 의미·오류·권한·부작용이 소비자와 합의되고 공통 계약 시험이 통과한 상태다. 공유 타입은 상대 모듈의 구현 완료와 별도로 먼저 고정한다.

| 계약 | 입력 의미 | 출력·불변식 |
| --- | --- | --- |
| RequestContext·SessionResolver | 인증 증명·현재 시각·서버 생성 추적값 | 검증된 사용자/서버/세션 문맥 또는 인증 거부. client가 server/sender/admin을 지정하지 못함 |
| RuntimeCapabilities | 검증된 사용자 문맥·확정된 기능 활성 설정 | 현재 사용자 응답의 공개 기능 상태. 파일/보존/알림 등의 사용 가능 여부만 전달하며 호스트·경로·비밀·미검증 관리자 권한은 제외 |
| ConversationAccess·UserDirectory | 검증 문맥·대화/사용자 참조 | 같은 서버의 참여/사용자 판단과 수신 대상. 비참여/타 서버는 존재 여부 비노출 |
| UnitOfWork·TxContext | 동기 DB 업무와 소유 모듈의 동일 트랜잭션 문맥 | 전부 commit 또는 전부 rollback. 문맥은 업무 밖으로 탈출하지 않고 외부 I/O는 트랜잭션 밖 |
| MessageCommands·MessageQueries | 대화·전송 식별·내용·조회 ID 경계 | 저장/중복/충돌/만료 판정·정렬 DTO. 삭제용 공개 업무도 소유자가 수행 |
| EventWriter·EventReader·EventHydrator | commit 대상 변경 참조·조회 위치·고정 상한·권한 | 본문을 복제하지 않는 영속 참조·스캔 위치·현재 허용 DTO/삭제 사실. 후속 소비자는 자기 처리 위치를 소유하고 job 적재와 위치 전진을 같은 트랜잭션으로 확정 |
| SyncCursor | 사용자/서버·event 위치·만료·서명 검증 정보 | 소유자/유효 기간/스트림 세대를 묶는 불투명 cursor. 복원 후 새 세대 발급으로 구 cursor 무효화 |
| JobRunner·Handler | 영속 작업 참조·회차·시계·재시도 정책 | side effect 확인 후 완료, 중복 안전, 실패/중단 후 같은 job으로 재개 |
| FileCommands·FileStore | 검증 문맥·파일 참조·stream·연결/삭제 의도 | 준비/연결/삭제 상태·권한 스트림. 실제 경로는 내부, 미준비/타 소유 파일 연결 금지 |
| ReceiptCommands·RetentionCommands·AuditWriter | 읽음 위치·검증 관리자·정책·허용 감사 요약 | 읽음 후퇴 없음, 정책+감사 원자 확정, 만료 삭제는 소유 port로 실행 |
| ClientTransport·CredentialStore·PlatformNotifications | 계약 요청·OS 저장/알림 의도·현재 사용자 세대 | 정규화 결과·보호된 증명·OS 실행 결과. 이전 세대 응답은 현재 store에 반영하지 않음 |
| FeatureLog | 기능/사건/추적·허용된 결과 metadata | 단일 형태의 로그·민감값 비노출. 원자 쓰기의 성공 사건은 commit 뒤 발행, rollback된 쓰기의 성공 사건 폐기. 응답의 `X-Request-Id`는 서버 생성 추적값이며 클라이언트/시험과 로그를 연결 |

스트림 세대·클라이언트 사용자 세대는 [복원 시 cursor 초기화](06-operations.md)·[로그아웃 후 지연 응답 무시](10-feature-specifications.md#f04)의 구현 수단이다. 새 사용자 기능이 아니다. B01에서 구체 스키마를 정한 후 정본 계약에 반영한다. U01~U04를 모르는 상황에서 관리자 근거·기기 payload·provider를 임의 고정하지 않는다.

기능 활성 상태는 B01이 현재 사용자 조회 계약의 공개 metadata로 정의하고 C01/B06이 설정·권한을 적용해 제공한다. E06/N02/N03은 이를 소비한다. 기능 route의 미등록/404와 사용자가 선택한 대화의 not_found를 UI에서 임의로 동일시하지 않는다. 응답 추적 헤더·공개 기능 상태도 기존 wire 계약의 호환 가능한 확장으로 선언하고 시험한 뒤 동결한다.

## 선행 관계와 병렬 배치

아래 선행은 실제 통합 완료를 위해 필요한 결과다. **동결된 port + 공통 계약 fake**가 있으면 상대 구현 이전에 자기 모듈을 개발할 수 있다. fake는 개발 가능성만 열고 실제 기능 완료를 증명하지 않는다. 카드 원문과 선행이 다르면 오케스트레이터가 범위를 정합화한 뒤 배정한다.

| 배치 | worker A | worker B | worker C | 다음 단계 진입 기준 |
| --- | --- | --- | --- | --- |
| W0 | B01 계약 | — | — | 계약·오류·로그·권한 port와 fixture 동결 |
| W1 | B02 기반 검증 | — | — | workspace 실행/검사·모듈별 verify 진입점 존재 |
| W2 | B03 DB/UoW | B05 HTTP 경계 | C06 client-core 초기 구현 | DB·HTTP·client port의 계약 시험 통과 |
| W3 | B04 job | C01 identity | C07 Web 초기 화면 | worker별 독립 시험. Web은 계약 fake 수준을 명시 |
| W4 | B06 lifecycle | C02 conversations | C06/C07 client 실제 연결 준비 | 공통 부팅·사용자/참여 계약 실통합 |
| W5 | C03 messages | C04 realtime | E01 audit 기반 | 메시지와 실시간은 fake로 병렬 개발 후 commit/권한 관통 검증 |
| W6 | C05 server sync | C06 core 통합 준비 | C07 Web 통합 준비 | 준비는 병렬, 최종은 C05→C06→C07 순으로 실연결 검증 |
| W7 | C08 로컬 통합 | O03 logger 격리 검증 | O04 1차 DB backup | 두 브라우저·디스크 DB 재시작·로그·backup 정상. 실제 journal은 O01 배치 후 |
| W8 | O01 실제 인증/TLS/배치 | O02 부하 fixture 준비 | O05 1차 복원 도구 검증 | 준비는 병렬, 동일 VM 배치·journal·부하·복원 실행은 차례로 검증 |
| W9 | E02 관리자/정책 | E03 files | E05 receipts | 계약 시험 + U02/U03에 따른 활성화 판정 |
| W10 | E04 메시지 첨부 | E06 클라이언트 확장 초기 | N01 native 세션 | 메시지/파일/읽음 각 소유 port 실통합 |
| W11 | E07 retention | E06 확장 화면 최종 | O04/O05 첨부 포함 복구 확장 | 삭제 중단·재시도·보존·복원 정책 일치 |
| W12 | E08 2차 통합 | N04 기기 계약/등록 | — | 2차 통과, 기기 업무는 U04 확정 조건 |
| W13 | N02 Windows | N03 Android | N05 알림 delivery | 동일 계약 기능·보호 저장·provider 접수와 표시 분리 |
| W14 | N06 실제 OS 알림 판정 | — | — | 상태별 결과·중계/비용 조건·허용 대안 기록 |

표의 초기/최종 연결은 동일 카드의 중간 체크포인트다. 별도 완료로 중복 집계하지 않는다. 병렬 개시 가능한 카드도 선행 실통합 이전에는 `개발/모의 검증 완료`로만 보고한다. 같은 client-core/client-react 수정은 C06/C07 owner가 직렬 처리하며 자기 다른 카드와 동시 writer가 되지 않는다.

O04/O05는 DB만 있는 1차와 첨부·활성 보존 정책이 있는 2차를 별도 checkpoint로 검증한다. C06/C07의 모의/실연결도 분리한다. 실행 시 checkpoint별 PMT 자식 Item에 범위·완료 기준·verify를 설정하고, 카드 전체의 필요한 checkpoint가 모두 검증되기 전에는 상위 카드를 Done으로 기록하지 않는다. 1차 gate가 통과해도 2차 복구 요구가 검증된 것은 아니다.

## 카드별 선행표

이 표는 dispatch의 구조화된 선행 기준이다. `기본 선행`은 첫 실통합에 필요하고, `추가 검증 선행`은 해당 checkpoint까지 완료하려면 더 필요한 카드다. 외부 U 조건은 기능 목록·각 카드·위 게이트를 함께 따른다. 카드별 fake 착수 조건은 상세 본문에 있다.

| 카드 | 기본 선행 | 추가 검증 선행 |
| --- | --- | --- |
| [B01](implementation-plan/01-foundation-operations.md#b01) | 없음 | 없음 |
| [B02](implementation-plan/01-foundation-operations.md#b02) | B01 | 없음 |
| [B03](implementation-plan/01-foundation-operations.md#b03) | B02 | 없음 |
| [B04](implementation-plan/01-foundation-operations.md#b04) | B03 | 없음 |
| [B05](implementation-plan/01-foundation-operations.md#b05) | B02 | 없음 |
| [B06](implementation-plan/01-foundation-operations.md#b06) | B04·B05 | 없음 |
| [C01](implementation-plan/02-core-messaging.md#c01) | B03·B05 | O01: 실제 메일 인증 |
| [C02](implementation-plan/02-core-messaging.md#c02) | B03·B05·C01 | 없음 |
| [C03](implementation-plan/02-core-messaging.md#c03) | B03·C02 | E04: 첨부 연결, E07: 보존 소유 port 관통 |
| [C04](implementation-plan/02-core-messaging.md#c04) | B04·B05·C01·C02·C03 | 없음 |
| [C05](implementation-plan/02-core-messaging.md#c05) | B03·C02·C04 | O05: 복원 세대 경계 관통 |
| [C06](implementation-plan/02-core-messaging.md#c06) | B02·C01·C02·C03·C04·C05 | E06: 후속 feature client port |
| [C07](implementation-plan/02-core-messaging.md#c07) | B02·C06 | E06: 후속 화면 |
| [C08](implementation-plan/02-core-messaging.md#c08) | B06·C01·C02·C03·C04·C05·C06·C07 | 없음 |
| [E01](implementation-plan/03-extensions-native.md#e01) | B03·B05·C01 | E02: 실제 관리자 guard 결합을 E08에서 판정 |
| [E02](implementation-plan/03-extensions-native.md#e02) | C01·E01 | 없음 |
| [E03](implementation-plan/03-extensions-native.md#e03) | B04·B05·C02 | E04: 실제 메시지 연결, E07: 보존 삭제 관통 |
| [E04](implementation-plan/03-extensions-native.md#e04) | C03·E03 | 없음 |
| [E05](implementation-plan/03-extensions-native.md#e05) | C02·C03·C04 | 없음 |
| [E06](implementation-plan/03-extensions-native.md#e06) | C06·C07·E02·E03·E04·E05 | 없음 |
| [E07](implementation-plan/03-extensions-native.md#e07) | B04·C03·E01·E02·E03·E04 | 없음 |
| [E08](implementation-plan/03-extensions-native.md#e08) | E01·E02·E03·E04·E05·E06·E07 | O04·O05: 첨부·현재 정책 복구 checkpoint |
| [N01](implementation-plan/03-extensions-native.md#n01) | B05·C01 | N02·N03: OS 보호 저장소의 실제 확인은 N06 gate |
| [N02](implementation-plan/03-extensions-native.md#n02) | C06·C07·E06·N01 | 없음 |
| [N03](implementation-plan/03-extensions-native.md#n03) | B01·E08·N01 | 없음 |
| [N04](implementation-plan/03-extensions-native.md#n04) | N01 | 없음 |
| [N05](implementation-plan/03-extensions-native.md#n05) | B04·C03·N04 | 없음 |
| [N06](implementation-plan/03-extensions-native.md#n06) | N02·N03·N05 | 없음 |
| [O01](implementation-plan/01-foundation-operations.md#o01) | B06·C08 | 없음 |
| [O02](implementation-plan/01-foundation-operations.md#o02) | B06·C08 | O01: 배치한 VM에서의 실제 부하 |
| [O03](implementation-plan/01-foundation-operations.md#o03) | B02 | O01: 실제 journal, E01·E02: 감사 연계 |
| [O04](implementation-plan/01-foundation-operations.md#o04) | B03·B06 | E03·E07: 첨부 포함 snapshot |
| [O05](implementation-plan/01-foundation-operations.md#o05) | B06·C01·C05·O04 | E03·E07: 현재 정책·첨부 복구, O01: VM 운영 복원 |

`추가 검증 선행`은 기존 소유자가 후속 기능을 소비해 다시 확인하는 통합 시험이며 **카드 구현 착수를 막는 DAG 간선이 아니다.** 추가 검증을 기본 선행에 합치면 C01↔O01, C03↔E04, E01↔E02 등의 순환이 생긴다. 기본 DAG를 먼저 완료하고 후속 소비 기능이 생길 때 같은 계약 owner의 회귀 checkpoint를 수행한다. E08은 2차 O04/O05까지 통과해야 완료한다. 오케스트레이터는 추가 checkpoint의 실제 선행을 PMT 자식 Item에 별도로 기록한다.

## 기능·완료 책임 추적

| 기능 | 구현 책임 | 최종 확인 |
| --- | --- | --- |
| F01·F02·F03·F06 | C01 | C08 로컬, F02 실제 인증 O01 |
| F04 | C01 세션 폐기·C06 store 세대·C07 UI 초기화 | C08 |
| F05·F07·F08 | C01 서버 문맥·C02 참여/대화 | C08·E08 교차 기능 권한 |
| F09 | C02 목록·C06 상태·C07 선택 화면 | C08 |
| F10·F12 | C03 조회·원자 저장 | C08 |
| F11·F13 | C03 검증/dedup·C06 재시도·C07 작성 | C08 |
| F14·F15 | C04 연결/배포·B03/B04 영속 기반 | C08 |
| F16·F17 | C05 server sync·C06 복구·C07 화면 반영 | C08·O05 복원 회귀 |
| F18 | C07 | C08, 앱은 N02/N03 |
| F19 | B01 계약·B05 요청 경계 | B05·C08 |
| F20·F22·F23·F29 | E03 | E08, 물리 파일/backup 회귀 O04/O05 |
| F21 | E04 조정·E03 파일 소유 | E08 |
| F24·F25 | E05 저장/조회·E06 화면 | E08 |
| F26·F27 | E02·E06 관리 화면 | E08, U02/U03 실제 조건 |
| F28 | E07, C03/E03 소유 port | E08·O05 현재 정책 |
| F30·F31 | E01, E02 관리자 guard | E08·O03 감사/로그 분리 |
| F32 | N01, N02/N03 OS adapter | N06·실앱 자격 저장 확인 |
| F33·F34 | N02·N03 | 각 실앱 기능, 알림 N06 |
| F35·F36·F37 | N04·N05·N06 | N06, U04 |
| F38·F39·F40 | B02·B03·B06 | G0·C08·O01 재부팅 |
| F41 | B01/B02 계약·빌드, O01 release | G0·O01 |
| F42 | B04, 작업별 E03/E07/N05 | C08·E08·N06 해당 handler |
| F43 | B02 안전 logger·O03 운영 보관 | 모듈 로그 assertion·O03 |
| F44 | O02 | O02 VM/부하 |
| F45·F46 | O04·O05 | 1차 DB checkpoint, 2차 첨부/정책 checkpoint |
| F47 | O01, N02/N03 실제 앱 접속 | O01·N06/U04 |

| 통합 게이트 | 필요한 증거 | 외부 조건 |
| --- | --- | --- |
| G0 기반 | B01~B06 계약/검증·실부팅·migration·권한 입력·로그 마스킹 | 공식 호환 패키지 고정, 미확정 기능 비활성 |
| G1 로컬 메신저 | C01~C08의 실제 파일 DB·두 브라우저·교차 서버·재시작·응답 유실·cursor 복구 | dev 인증은 local gate만 통과 |
| G2 1차 실서비스 | G1 + O01~O05 실환경 검증 | U01, TLS 신뢰·허용망·VM/복구 시험 |
| G3 2차 | E01~E08 + 첨부 포함 O04/O05 재검증 | U02·U03, 현재 정책으로 삭제/복원·감사 확인 |
| G4 앱·알림 | N01~N06의 공통 계약·실기기 기능·OS 상태별 관찰 | U04. 달성 불가 상태는 실패/조건부로 기록 |

G2의 완료가 G3 개발의 논리적 선행인 것은 아니다. U01이 대기 중이면 G1 통과 후 내부 확장 개발을 진행할 수 있다. G2/G3/G4 최종 완료는 외부 조건과 실제 시험이 모두 만족해야 한다.

## 6-luna 작업 배정과 인계

worker에게 한 번에 하나의 카드와 아래 정보를 준다. 서로의 대화 전체나 미완성 구현을 추측해서 쓰게 하지 않는다.

| 배정 항목 | 전달할 의미 |
| --- | --- |
| 작업 ID·기능 ID·목적 | 구현할 책임과 해결할 사용자/운영 문제 |
| 기준 상태 | 사용할 코드 snapshot·계약 revision·이미 통합된 선행 결과·기존 사용자 변경 |
| 소유 영역·동시 작업 | 자기 모듈/시험 책임과 같은 시간에 다른 worker가 소유하는 경계 |
| goal·non-goal·변경 범위 | 성공 동작과 제외할 책임, 신규/변경/폐기할 행동과 조건 |
| 입력·출력·공개 port | 각 항목의 의미·오류/권한·부작용·원자성·호출 순서 |
| 검증·로그 | 실행할 정상/거부/경계/복구 case, 허용 필드·상관관계·순서·비밀값 검사 |
| 실제 verify 진입점 | B02가 등록하고 실행 확인한 해당 모듈 명령·통합 gate. 아직 없는 명령을 성공으로 보고하지 않음 |
| 선행·외부 대기 | fake로 가능한 범위·실통합에 필요한 provider/정책/입력 |
| 완료 보고 | 달성한 행동·공개 계약·실행 증거·남은 한계·필요한 공유 통합 변경 |

worker의 수행 순서는 현황 확인 → 자기 계약·실패 조건의 시험 → 구현 → 모듈 검증 → 로그 assertion → 인계다. 구현과 시험을 같은 행동 기준으로 작성하고 assertion을 약화해 통과시키지 않는다. 원자성/재시작 시험은 실제 파일 DB·격리 프로세스로 수행하며 production에 테스트 전용 export를 만들지 않는다.

공유 변경은 **필요 계약/스키마·기존 의미·새 의미·영향 소비자·검증**을 부모에게 제안한다. 부모가 공유 원천·manifest/lock·migration·bootstrap을 통합하고 새 revision을 전달한다. worker가 다른 owner 코드를 대신 고쳐 충돌을 숨기지 않는다.

반환된 결과는 `개발 완료 → 모듈 검증 완료 → 실제 통합 완료` 상태를 구분한다. 오케스트레이터는 diff/소유 경계·부작용·시험 결과를 검토하고 공통 자산을 통합한 뒤 관통 시험을 수행한다. 전달 payload 전체를 로그에 넣거나 모의 성공을 실제 성공으로 표시하면 해당 gate는 통과하지 못한다.

인계에는 최소한 목적/goal의 달성 여부, 실제 input/output 의미의 일치, 추가/변경/폐기한 행동, 테스트 실행·관찰, 로그 확인, 미검증/대기·재개 위치를 남긴다. 변경 파일 목록은 보조 증거일 뿐 인계 본문을 대신하지 않는다.

## 중단·재개와 완료 기준

공통 계약 부재·다른 owner 수정 필요·외부 입력 미확정이면 영향을 받는 행동만 보류하고 가능한 독립 시험·port 구현은 계속한다. 범위를 임의 확장하지 않고 부족한 계약과 필요한 결정을 부모에게 전달한다.

부모는 PMT `start/note/verify/end`로 점유·기준·검증을 기록한다. worker는 PMT·lock을 변경하지 않는다. 컨텍스트 재개는 Item 기록·계약 revision·직전 검증과 남은 조건으로 이어간다. `start --delegate` 전에는 범위·완료 기준·실제 verify 명령이 채워져 있어야 한다.

현재는 계획 카드가 준비되는 단계다. 구현 착수 시 PMT Work/Item으로 카드와 필요한 test Item을 등록하고 소유 경계를 확정한다. 실패 횟수만으로 완료/기능 포기를 결정하지 않으며 원인·남은 상태·재개 방법을 기록한다. 커밋·push·배포·인프라 변경은 당시 사용자 요청 범위에 따른다.

통합 게이트는 시험 통과 조건이다. 사용자에게 같은 허가를 반복해서 받는 절차가 아니다. 이미 지시한 실행·배포·환경 변경의 허가는 유지하며, 그 범위 안에서 검증과 실행을 이어간다.

각 단계는 행동 assertion·DB/파일/화면 결과·로그를 함께 만족해야 완료다. 마지막 정상 backup·원래 사용자 변경·구 요구 이력을 보존하고, 구 실행 경로 폐기는 새 경로 통합·검증·rollback 가능성 확인 후 별도 범위로 정한다.
