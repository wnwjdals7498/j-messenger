# 기반·운영 구현 계획

이 계획은 [기능 목록](../09-feature-list.md)과 [기능 명세](../10-feature-specifications.md)의 기반·운영 기능을 병렬 구현 가능한 책임 카드로 나눈다. 경로 표기는 소유 영역을 식별한다. 실제 폴더·명령·의존성은 구현 시 존재 여부와 공식 호환 근거를 확인한다. 이 문서는 구현 완료나 실환경 검증을 뜻하지 않는다.

공통 통합 규칙: B01→B02는 직렬 게이트다. B03·B05는 B02 통과 뒤 병렬, B04는 B03 뒤, B06는 B04·B05 뒤 진행한다. 계약 모듈·루트 manifest/lock·migration 순번/적용·bootstrap 결합은 오케스트레이터 단일 writer가 소유한다. 작업자는 맡은 책임의 코드와 시험만 변경하고 공유 자산 변경이 필요하면 변경할 계약과 이유를 부모에게 전달한다. 명령은 저장소에 실제로 연결된 뒤에만 사용한다. 실환경 메일·TLS·허용망·release는 U01 조건을 확인하는 별도 게이트다.

단계 체크포인트와 전체 완료는 별도 판정한다. 1차 체크포인트는 DB-only backup/restore와 미활성 files/retention의 영향 없음만 확인한다. 2차 복구 재검증은 E03 files와 E07 retention 구현 완료 뒤 첨부 manifest 일관성·현재 정책 재적용·삭제 worker 중지를 포함한다. 어느 체크포인트도 해당 기능 전체나 전체 재구축 완료를 뜻하지 않는다. 전체 완료는 해당 요구 단계의 기능 카드·실환경 조건·복구/운영 증거까지 모두 충족할 때만 판정하며, 이 카드를 다른 시점에 재사용해도 미실행·미구현 게이트는 미완료로 남긴다.

### B01
공통 계약과 공개 port 동결 · 담당: 6-luna worker(계약 초안·시험), 오케스트레이터(공유 원천 통합·동결) · 기능: F19, F41

| 항목 | 명세 |
| --- | --- |
| 목적 | 서버·클라이언트·작업자가 공유할 계약을 worker가 구체화하고 오케스트레이터가 공유 원천으로 통합·동결해 독립 작업의 충돌을 막는다. |
| 추가/수정/삭제범위 | 추가: contracts의 HTTP 성공·오류·이벤트 기본 계약, 기능 모듈 공개 API와 공통 port의 책임 경계. 수정: 계약 의미가 기존 통신 기준과 충돌하는 항목. 삭제: 없음. |
| goal | 실행 스키마·타입·OpenAPI의 원천과 공개 API, 오류 전달·버전 원칙이 동결되어 구현자들이 같은 계약을 참조한다. FeatureLog와 UnitOfWork 계약은 업무 쓰기 성공 사건을 commit 이후에만 내보내며 rollback된 쓰기의 success 사건을 폐기한다. |
| non-goal | 업무 규칙 구현, DB 스키마·migration 작성, 런타임 라우트 등록, UI 구현, 추후 기능의 세부 계약 확정. |
| 목표-input | 기존 요구·통신·모듈 문서, 기능 소유자와 선행 조건, 공개 계약 변경 제안. |
| 목표-output | 검토 가능한 계약 정의·공개 port 목록·오류 및 버전 규칙·승인된 변경 결정과 구현 대기 항목, commit/rollback 이후 사건 방출 의미. |
| 구현동작·실패처리 | 6-luna worker가 기존 HTTP envelope와 이벤트 의미를 보존한 계약 초안·시험을 만들고, 오케스트레이터가 공유 원천에 통합해 동결한다. FeatureLog는 commit 성공 뒤 success를 발행하고 rollback 시 관련 success를 버린다. 모호하거나 충돌하는 제안은 임의 확정하지 않고 보류 사유·영향 기능을 기록한다. |
| 코드동작확인 Test방식 | 계약 시험에서 유효/무효 입력의 parse·serialize, 오류 code와 HTTP 의미, 이벤트 버전·필수 필드, 생성 타입과 스키마 일치를 assertion한다. 알 수 없는 필드/버전·누락·형식 오류와 호환 경계를 시험한다. |
| 코드동작확인 로깅방식 | 계약 검증 사건에 계약·schema 버전, 검사 종류, 결과·요청/작업 correlation을 허용한다. 필드 값·본문·토큰·원시 입력은 금지하고 계약 생성→검증→실패 순서를 확인한다. |
| 선행·병렬제약 | 사전 구현 선행 없음. worker는 초안·계약 시험을 맡고 공유 계약 원천 통합·동결은 오케스트레이터만 수행한다. B02~B06와 C01~C08, E01~E08, N01~N06의 착수 기준이며 변경은 통합 조정 후 배포한다. |
| 완료증거 | worker 계약 시험과 FeatureLog/UoW commit·rollback 사건 검증, 오케스트레이터 통합·동결 승인, 각 소유자 확인 및 미확정 사항이 남아 있다. |

### B02
workspace 검증 기반·설정/로그 최소 골격 · 담당: 기반 구현자 · 기능: F38, F41, F43

| 항목 | 명세 |
| --- | --- |
| 목적 | 구성 검증·공통 logger·workspace 품질 확인의 최소 실행 기반을 제공한다. |
| 추가/수정/삭제범위 | 추가: platform 설정 해석·logger port와 안전한 기본 동작, workspace 검증 연결점. 수정: 실제 생성되는 manifest·설정에 필요한 검증 규칙. 삭제: 없음. |
| goal | 잘못되거나 운영에서 금지된 설정은 서비스 시작 전에 실패하고, 허용된 metadata만 구조화 로그로 기록하며 검증 결과가 재현 가능하다. |
| non-goal | 루트 manifest·lock의 독자 변경, 메일/TLS 실환경 설정, VM journal 정책 적용, release 배포·운영 로그 추출 UI. |
| 목표-input | B01 공개 port·계약, 실행 환경·설정 원천, 배포 모드, 로거 허용 필드·금지 데이터 정책. |
| 목표-output | 검증된 불변 설정 값, 시작 거부를 설명하는 안전한 오류, 주입 가능한 logger와 시험 관찰 결과. |
| 구현동작·실패처리 | 설정은 시작 시 한 번 파싱·검증하고 소비 모듈에 검증된 값만 제공한다. 필수 값 누락·경로 충돌·production dev 인증은 시작 불가로 처리한다. 전체 환경·설정·원시 오류를 출력하지 않는다. 기능 비활성 시 그 경로의 조립을 허용하지 않는다. |
| 코드동작확인 Test방식 | 단위·조립 시험에서 유효/누락/형식 오류/충돌/운영 dev 모드/비활성 기능을 주입한다. 검증 객체의 필드·시작 거부·listener/worker 미생성·비활성 경로 응답을 assertion한다. |
| 코드동작확인 로깅방식 | config validated/failed와 logger 사건의 순서를 확인한다. 모드·활성 기능 분류·허용된 키 이름·사유 code·requestId만 허용하고 값·경로·환경 전체·비밀값·입력 문자열은 캡처에 없는지 검사한다. |
| 선행·병렬제약 | B01, B02 완료 후 B03·B05 병렬 가능. 공유 manifest/lock·검증 명령 등록은 오케스트레이터만 변경한다. B03/B05는 안정화된 config/logger port를 주입받는다. |
| 완료증거 | 유효/오류 설정의 시험 결과, 비밀값 노출 검사, 실제 연결된 검증 진입점과 사용법, 아직 미지원 실행 환경이 구분되어 있다. |

### B03
DB/UoW/outbox·migration 기반 · 담당: 저장 기반 구현자 · 기능: F39

| 항목 | 명세 |
| --- | --- |
| 목적 | SQLite 연결·짧은 트랜잭션·이벤트 outbox·순번 migration을 업무 모듈에 제공한다. |
| 추가/수정/삭제범위 | 추가: platform DB port, UnitOfWork/TxContext, outbox 최소 저장·읽기 port, migration 실행 기반과 적용 이력 처리. 수정: 없음. 삭제: 없음. |
| goal | 한 프로세스의 DB 쓰기가 명시된 연결 정책으로 영속화되고 업무 변경과 outbox 삽입을 같은 트랜잭션으로 묶을 수 있다. migration 재실행·중단에도 적용 이력과 스키마가 일치한다. |
| non-goal | 업무 테이블·각 모듈 repository 작성, 메시지 payload 저장, 여러 worker/DB 인스턴스, migration 순번의 독자 배정. |
| 목표-input | B01 UnitOfWork/Event port, B02 검증된 DB 설정·logger, 통합 writer가 배정한 migration 순번과 적용 계획. |
| 목표-output | 주입 가능한 DB·트랜잭션·outbox·migration API, 적용 상태와 실패 결과, SQLite 파일에서 재현 가능한 검증 결과. |
| 구현동작·실패처리 | 연결 시 WAL·외래키·내구성·busy timeout 정책을 적용·확인한다. 짧은 쓰기 경합은 제한된 실패 결과로 돌려주고 부분 성공을 노출하지 않는다. migration 실패 시 해당 변경을 rollback하고 ready를 차단한다. 이미 적용된 migration은 재실행하지 않는다. |
| 코드동작확인 Test방식 | 실제 임시 파일 DB로 신규·기존·반복·누락 순번·도중 실패·잠금·재시작 시험을 한다. 업무 row와 outbox의 함께 commit/함께 rollback, 적용 이력·무결성·serverId 복합 관계·증가 cursor 비재사용을 assertion한다. |
| 코드동작확인 로깅방식 | DB open/migration applied·failed/outbox transaction 사건에 schema 버전·migration 식별자·결과·duration·correlation만 허용한다. SQL·binding·DB 경로 금지, open→migration→ready 순서 및 실패 후 ready 부재를 검사한다. |
| 선행·병렬제약 | B02 이후 진행하며 B04보다 선행한다. migration 파일의 순번 배정·적용 순서·실행기는 통합 writer 단일 소유다. 다른 그룹은 migration 추가 전에 정확한 계약 변경 요구를 보낸다. |
| 완료증거 | 파일 DB 시험 결과와 실패 주입 결과, migration 적용 이력, 트랜잭션·outbox 원자성 assertion, 미검증 동시성 한계가 기록되어 있다. |

### B04
영속 job 실행/재시도 기반 · 담당: 작업 실행 기반 구현자 · 기능: F42

| 항목 | 명세 |
| --- | --- |
| 목적 | commit 이후 필요한 작업을 재시작 뒤에도 복구하며 중복·실패를 안전하게 처리한다. |
| 추가/수정/삭제범위 | 추가: platform 작업 저장·claim·재시도·상태 전이 port와 runner. 수정: 없음. 삭제: 없음. |
| goal | 영속 job은 handler의 성공 확인 뒤에만 완료되고 중단·일시 실패·최종 실패·재개가 저장 상태로 관찰된다. |
| non-goal | 파일·알림·보존의 업무 handler, 외부 provider 호출, 업무별 payload 결정, 메모리 큐를 성공 증거로 삼는 처리. |
| 목표-input | B03의 DB/UoW, B01 작업 port, 소유 모듈의 idempotent handler·재시도 정책·시계. |
| 목표-output | job 상태·시도/다음 실행 조건·집계 처리 결과와 재시작 후 이어서 실행 가능한 runner. |
| 구현동작·실패처리 | DB 트랜잭션으로 실행 가능한 job을 claim하고 실행 주체·lease 만료를 기록한다. 활성 lease가 있는 job의 중복 실행을 막고 재시작 후 만료 lease만 회수한다. handler는 트랜잭션 밖에서 수행하고 성공 확인 뒤 완료로 전이한다. 예외·timeout은 backoff 예약, 기준 초과는 같은 job ID의 failed 상태로 보존한다. 외부 side effect 뒤 완료 기록 전 crash는 재실행 안전성을 가진 handler로 복구한다. |
| 코드동작확인 Test방식 | 파일 DB 기반으로 handler 전·후·완료 기록 직전 crash, 중복 claim, 활성/만료 lease와 재시작 회수, backoff 경계, 최대 회차, 최종 실패 후 같은 ID 재개를 주입한다. 상태·호출 횟수·영속 잔존·side effect 중복 방지를 assertion한다. |
| 코드동작확인 로깅방식 | job started/completed/retry/failed/resumed를 jobId·종류·회차·결과·duration·원래 request/correlation으로 연결한다. 업무 payload·본문·파일명·token 금지, 시작→재시도/완료 순서와 최초/최종 집계 정책을 검사한다. |
| 선행·병렬제약 | B03 이후. B06의 시작·종료 조립 전에 API와 복구 준비 상태를 제공한다. 각 작업 handler는 자기 업무 모듈 소유자가 구현한다. |
| 완료증거 | crash·중복·재개 시험의 DB 상태 및 handler 관찰 결과, 재시도/최종 실패 로그 assertion과 runner 한계가 남아 있다. |

### B05
HTTP 공통 스키마/Origin/제한 · 담당: HTTP 기반 구현자 · 기능: F19

| 항목 | 명세 |
| --- | --- |
| 목적 | HTTP 경계에서 계약 검증, browser Origin 제한, 요청 빈도·크기 제한을 일관되게 적용한다. |
| 추가/수정/삭제범위 | 추가: 공통 HTTP 등록 port·오류 변환·Origin/제한 정책 연결. 수정: 공통 요청 처리 경계. 삭제: 없음. |
| goal | 잘못된 요청은 업무 handler 전에 거부되고 cookie 기반 로그인·변경·WebSocket handshake는 허용 Origin만 통과하며 응답 형식과 오류가 공통 계약을 따른다. |
| non-goal | 세션을 직접 해석하거나 identity·업무 권한을 구현하는 일, 임의 CORS wildcard, API별 업무 라우트, 네이티브 세션. |
| 목표-input | B01의 스키마·오류 계약, B02 검증 설정/logger, 주입된 SessionResolver, 허용 Origin 및 route별 제한 정책. |
| 목표-output | 검증된 handler 입력과 공통 성공/실패 응답, Origin·요청 제한 판정, SessionResolver가 제공한 인증 문맥. |
| 구현동작·실패처리 | 입력 schema validation·공통 오류 직렬화 후 주입된 resolver로 문맥을 얻는다. 누락/null/불허 Origin과 제한 초과는 안전한 오류로 종료하고 업무 handler를 호출하지 않는다. resolver의 identity 업무는 소유 모듈에 남긴다. |
| 코드동작확인 Test방식 | HTTP 주입 시험에서 유효/무효 schema, 응답 envelope, 허용·불허·누락·null Origin, rate/body 경계, resolver 실패를 검사한다. 각 거부에서 업무 호출·DB 변경·소켓 연결이 없고 내부 경로/stack이 응답되지 않음을 assertion한다. |
| 코드동작확인 로깅방식 | 요청 완료·Origin 거부·rate limited 사건에 서버 requestId·route template·status/error code·duration만 허용한다. URL query·헤더·body·cookie·세션 원문 금지, schema→resolver→handler/거부 순서와 비밀값 비노출을 검사한다. |
| 선행·병렬제약 | B02 뒤 B03과 병렬. B01 계약과 SessionResolver 주입 계약을 소비한다. B06 조립에서 구체 resolver는 identity 소유자가 제공하고 bootstrap writer가 연결한다. |
| 완료증거 | 계약/요청 경계 시험 결과, 실패 요청의 무호출·무쓰기 증거, 로그 allowlist 캡처, 실제 적용 제한의 설정 출처가 남아 있다. |

### B06
서비스 조립·수명주기/health · 담당: 서비스 조립 구현자 · 기능: F40

| 항목 | 명세 |
| --- | --- |
| 목적 | 검증된 설정과 모듈·어댑터·영속 worker를 조립하고 준비·종료 상태를 명확하게 제공한다. |
| 추가/수정/삭제범위 | 추가: bootstrap 시작·종료 순서, health 판정, 신호 처리와 의존 주입. 수정: 준비/종료 상태 연결. 삭제: 없음. |
| goal | 설정·DB/migration·필수 의존성이 준비되기 전 트래픽을 받지 않고 정상 종료·재시작 때 미처리 영속 job과 DB 상태를 보존한다. |
| non-goal | 기능별 업무 규칙, 운영체제 서비스 설치·VM 변경, 실메일 성공 판정, 실제 배포·rollback. |
| 목표-input | B02 설정/logger, B03 DB 준비 상태, B04 runner 상태, B05 HTTP server 경계, 각 모듈 공개 API와 필수 adapter. |
| 목표-output | 생존·준비 health 응답, 시작/ready/stopping/stopped 상태, 종료 결과와 남은 영속 작업 상태. |
| 구현동작·실패처리 | 설정 검증→DB/migration→모듈 조립→listener→복구 worker→ready 순으로 시작한다. 종료 시 ready 해제→신규 요청 중단→제한 시간 내 진행 작업·소켓 정리→DB 종료를 수행한다. 필수 단계 실패는 ready 금지, 미완료 job은 DB에 남긴다. health 응답에 비밀·내부 경로를 포함하지 않는다. |
| 코드동작확인 Test방식 | 시작 단계별 실패 주입, health live/ready 경계, 종료 중 요청·worker 중단, 유예 만료·재시작 시험을 한다. 호출 순서·HTTP 상태·DB 연결 정리·job 잔존 후 재개·메일 장애 중 기존 채팅 가용성을 assertion한다. |
| 코드동작확인 로깅방식 | service starting/ready/stopping/stopped/failed에 release·단계·duration·잔여 job/연결 count·correlation을 허용한다. 시작/종료 순서, 실패 뒤 ready 없음, 환경 전체·경로·비밀값 비노출을 검사한다. |
| 선행·병렬제약 | B04와 B05 완료 후. bootstrap 조립·진입점은 통합 writer가 단일 소유하며 모듈 소유자는 공개 조립 정보만 제공한다. |
| 완료증거 | 조립 순서와 단계 실패 주입 결과, health 상태별 응답, 재시작 뒤 job·DB 복구 결과가 실행 환경과 함께 기록되어 있다. |

### O01
실제 메일/TLS/허용망/release 통합 · 담당: 운영 통합 담당자 · 기능: F02, F41, F47

| 항목 | 명세 |
| --- | --- |
| 목적 | 격리 시험을 넘어 승인된 메일 제품·TLS·허용망·release 경로에서 실제 동작을 판정한다. |
| 추가/수정/삭제범위 | 추가: 배포/실통합 검증 절차·release 증거와 운영 adapter 설정. 수정: 검증 중 확인된 호환·배포 조건. 삭제: 없음. |
| goal | 실제 허용 계정 인증, 허용/비허용 망 판정, TLS 검증, 검증된 산출물 배치·호환 rollback이 각각 관찰 가능한 결과로 남는다. |
| non-goal | U01을 추정으로 채우기, TLS 검증 완화, 방화벽 우회, 사용자 데이터가 있는 운영 VM 변경을 별도 게이트 없이 수행하기. |
| 목표-input | U01 메일 제품/호스트/TLS CA/시험 계정, 인증서·허용망·대상 환경, B06 서비스, B02 설정, B01/F41 release 계약과 검증 산출물. |
| 목표-output | 실계정 2개 인증·같은 서버 대화 및 타 서버 차단 판정, TLS/망 결과, release 및 복구/rollback 증거 또는 미실행 조건. |
| 구현동작·실패처리 | 등록된 endpoint만 TLS 검증으로 연결하고 자격 오류와 접속 장애를 구분한다. 허용 경로만 접속을 수락한다. release는 필수 검사와 DB 호환을 통과한 경우에만 전환한다. U01 미확정·검증 실패는 실통합 미완료로 보존하며 모의 결과를 실환경 성공으로 표시하지 않는다. |
| 코드동작확인 Test방식 | U01 확정 후 격리 실환경에서 두 유효 계정·잘못된 인증·TLS 불일치/timeout, 허용/비허용 출발 경로, 재부팅 후 접속, release 검증 실패·호환 rollback을 assertion한다. 미승인 배포·계정 조건에서는 실행하지 않고 게이트 미충족을 기록한다. |
| 코드동작확인 로깅방식 | identity login 결과·network TLS checked·release activated/rejected를 내부 서버 ID·검사 종류·release/schema·사유·correlation으로 연결한다. 주소·계정·비밀번호·키·인증서 내용 금지. release 검사→활성화→service ready와 ready 후 메일 인증 요청→인증 판정의 순서를 각각 확인하며 메일 인증 성공을 기존 채팅 readiness 조건으로 혼동하지 않는다. |
| 선행·병렬제약 | 서비스 통합 검증은 B06와 C08 로컬 통합 gate 통과 뒤 시작한다. 실환경 release·TLS·허용망 판정은 U01 및 운영 접근 경로 확정 후 별도 gate다. 메일 adapter 개발/contract 시험은 C01과 B01 계약을 소비해 앞서 진행할 수 있으나 실통합 완료 증거로 대체하지 않는다. 외부 기술 사실은 공식 자료 및 기존 S03/S06/S07/S08/S14 근거만 사용한다. |
| 완료증거 | 실제 실행 환경·승인된 조건·계정 수·망/TLS 결과·release ID·실행 결과와 미충족 게이트가 분리 기록되어 있다. C08 로컬 gate와 B06 준비 결과가 선행 증거로 연결되어 있다. |

### O02
자원보호·부하판정 · 담당: 성능/운영 담당자 · 기능: F44

| 항목 | 명세 |
| --- | --- |
| 목적 | 작은 서버의 측정값과 쓰기 보호 동작으로 용량 한계 및 초기 부하 목표를 판정한다. |
| 추가/수정/삭제범위 | 추가: 허용된 자원 집계·경고/차단 전이·부하 판정 절차. 수정: 실제 측정에 근거한 상한 조정 제안. 삭제: 없음. |
| goal | 메모리·event loop·요청 지연·DB/WAL·공간·outbox 상태를 집계하고 설정된 공간 경계에서 쓰기를 차단/회복하며 fixture 목표 달성 여부를 증명한다. |
| non-goal | 임의 성능 보장, fixture 없는 벤치마크 결론, 측정 없이 DB worker/별도 DB 도입. |
| 목표-input | 관측 port·디스크 보호 정책, 전환 계획의 부하 fixture/목표, 격리 VM 자원과 실행 ID. |
| 목표-output | 집계 측정, 차단·회복 결과, fixture별 성능 판정과 관측 병목·환경 한계. |
| 구현동작·실패처리 | 제한된 주기로 집계 metadata를 기록한다. 공간 경계 아래에서 새 메시지/업로드 쓰기를 503으로 거절하고 읽기·가능한 정리 작업을 유지한다. 자원 측정 자체 실패는 미관측으로 표시하고 정상으로 간주하지 않는다. |
| 코드동작확인 Test방식 | 경계 공간/측정값을 주입해 쓰기 차단·읽기 유지·공간 회복 후 허용을 assertion한다. 지정 fixture에서 RSS·p95·중복/손실·outbox 해소와 WAL/로그/백업 공간을 측정하고 목표와 직접 비교한다. |
| 코드동작확인 로깅방식 | resources sampled/write blocked/recovered, performance completed에 집계 지표·상태·건수·시험 ID만 허용한다. 사용자 입력·본문 제외, 표본→경고/차단→회복과 부하 완료 순서, 정책과 실측의 일치를 검사한다. |
| 선행·병렬제약 | B02 설정/logger 및 B03 저장 기반 이후 가능; 실VM 부하판정은 B06/O01 준비 뒤 수행한다. 초기 관측 구현은 독립 가능하나 통합 조립은 writer가 담당한다. |
| 완료증거 | 실행 환경/fixture/측정 시점/결과, 경계 주입 시험, 통과/미달 및 병목 원인이 재현 가능하게 남아 있다. |

### O03
journal/로그 회전·열람·audit와 분리 · 담당: 로그 운영 담당자 · 기능: F43

| 항목 | 명세 |
| --- | --- |
| 목적 | 앱 JSON 로그의 안전한 관찰과 journal 보관/열람 권한을 확인하고 업무 감사 기록과 저장 경계를 분리한다. |
| 추가/수정/삭제범위 | 추가: 로그 정책 구현/격리 검증, journal 운영 검증·제한 열람/지원 추출 절차. 수정: logger allowlist·회전 설정 제안. 삭제: 앱 전용 파일 회전이 실제 도입된 경우 journal 단일 소유 정책으로 대체할 때만 폐기. |
| goal | 앱 로그 정책은 격리 환경에서 구현·검증되고, 운영 journal의 실제 회전·재부팅 보존·열람 권한은 O01 운영 접근 경로 이후 별도 적용·확인된다. 감사 이벤트는 별도 업무 저장으로 보존된다. |
| non-goal | journal 전체 vacuum, 업무 audit를 일반 로그로 복제, 앱 계정으로 시스템 설정 변경, 사용자 raw journal 다운로드. |
| 목표-input | 허용 사건·metadata·correlation, 민감값 fixture, journal 기간/공간/권한, audit transaction 조건. |
| 목표-output | 로그 민감값 검사·journal 회전/재부팅 관찰·열람 권한 결과, audit와 실행 로그의 분리 증거. |
| 구현동작·실패처리 | 앱은 JSON 로그만 stdout/stderr에 기록하고 앱별 파일 회전을 소유하지 않는다. journal 정책·권한은 관리자 절차로 확인한다. 추출은 기간/requestId 제한과 재검토를 거치며 logger 장애는 업무 commit을 뒤집지 않고 별도 상태로 보인다. 필수 audit 실패는 해당 관리 변경을 실패시킨다. |
| 코드동작확인 Test방식 | 정상·실패·raw error에 비밀 fixture를 주입해 전체 캡처 비노출을 확인한다. 재부팅 보존·용량 회전·폭주·권한 거부·기간 제한 추출·audit 실패 rollback·logger 장애를 상태와 결과로 assertion한다. |
| 코드동작확인 로깅방식 | logging policy/export와 업무 사건을 분리해 확인한다. 사건/허용 metadata/request 또는 job correlation/순서·outcome만 기록하고 추출 원문·session/cursor·본문·토큰·계정·파일명 금지값을 검사한다. 자기 logger 오류의 무한 재기록이 없는지 확인한다. |
| 선행·병렬제약 | B02 logger 정책을 선행으로 사용한다. 구현·격리 검증은 독립 가능하고 journal 운영 VM 적용·확인은 O01 운영 경로 뒤 수행한다. audit DB schema와 권한 위임은 E01/E02 소유이며 본 카드는 업무 스키마·권한 모델을 변경하지 않는다. |
| 완료증거 | 구현·격리 검증 결과와 운영 VM의 민감값 검사·보관/회전·열람 권한 확인을 별도 기록하고, 미수행 운영 적용을 기능 전체 완료로 표시하지 않는다. |

### O04
일관된 backup·보관 · 담당: 백업 운영 담당자 · 기능: F45

| 항목 | 명세 |
| --- | --- |
| 목적 | DB와 참조 파일을 함께 복구할 수 있는 일관 snapshot으로 보관하며 정상 복구본을 보호한다. |
| 추가/수정/삭제범위 | 추가: DB-only 및 DB+파일 단계별 online snapshot·manifest 조정·보관 상한·정상본 보호 책임. 수정: 백업 검증 결과와 운영 기록. 삭제: 없음. |
| goal | 구현·격리 검증은 1차 체크포인트에서 DB-only 복구본과 files/retention 비활성 무영향을 확인한다. 2차는 E03/E07 완료 뒤 첨부 참조 manifest와 삭제 worker 조정까지 검증한다. 운영 VM의 일정·저장소 적용은 별도 운영 게이트이며, 모든 단계에서 실패·용량 부족 때 마지막 정상본을 유지한다. |
| non-goal | SQLite 파일 단독 복사, 백업이 별도 장치에 있다고 가정, 키와 백업 동시 보관, 삭제 자료의 백업 잔존을 즉시 제거한다고 보장. |
| 목표-input | B03 DB/backup port, 단계별 기능 활성 상태, 2차에는 E03 첨부 manifest·쓰기/삭제 조정과 E07 retention 정책, 보관 상한·일정·암호화 키 분리 운영조건. |
| 목표-output | 단계와 활성 기능 범위가 명시된 검증 backup ID·DB snapshot·(2차) 첨부 manifest/보관 상태, 실패 원인과 마지막 정상본 유지 결과. |
| 구현동작·실패처리 | 1차는 WAL DB의 online backup API로 일관 snapshot을 만들고 files·retention 비활성 상태 및 영향 없음을 기록한다. 2차 재검증은 E03/E07 완료 뒤 첨부 쓰기·물리 삭제 worker를 멈춰 DB·manifest·참조 파일의 일관 구간을 만든다. 초과 용량은 오래된 유효본부터 정리하고 마지막 정상본을 남기며 새본 검증 실패는 성공 처리하지 않는다. |
| 코드동작확인 Test방식 | 1차는 WAL 파일 DB snapshot·복원·미활성 기능 무영향, 중단·검증 손상·용량 초과를 주입해 정상본 보존을 assertion한다. 2차는 E03/E07 완료 뒤 첨부 변경 중 snapshot 및 삭제 worker 중지, manifest 참조 일치·복구 후 현재 정책 상태를 확인한다. 두 결과를 하나의 미구분 통과로 합치지 않는다. |
| 코드동작확인 로깅방식 | backup started/completed/failed/pruned에 backupId·schema 버전·건수/byte·duration·검증 결과·correlation만 허용한다. 파일 경로·명칭·키·본문 금지, 시작→검증→완료/정리 순서와 완료 후 실제 복구 가능 여부를 대조한다. |
| 선행·병렬제약 | B03 DB 기반 이후 1차 DB-only checkpoint 가능. 2차 첨부 검증은 E03/E07 완료 뒤 수행하고 E04 연결 의미와 조정한다. O04는 E08을 선행으로 요구하지 않으며 migration 순번을 배정하지 않고 B03 공개 backup port를 소비한다. |
| 완료증거 | 1차 DB-only checkpoint, 2차 첨부/정책 재검증, 운영 VM 적용 상태를 구분한 backup ID·검증 범위·보관 전후 정상본·실제 restore 검사와 별도 장치 사본 여부/한계가 남아 있다. 미실행 단계는 미완료로 표시한다. |

### O05
restore·현재 정책 재적용/세션폐기 · 담당: 복구 운영 담당자 · 기능: F46

| 항목 | 명세 |
| --- | --- |
| 목적 | 검증된 백업을 복원하고 과거 상태의 권한·보존 정책이 현재 접속에 노출되지 않도록 통제한다. |
| 추가/수정/삭제범위 | 추가: 단계별 서비스 차단 상태의 복원 검증·현재 정책 적용·세션/cursor 무효화·접속 재개 게이트. 수정: 복구 실행 증거·감사 연결. 삭제: 없음. |
| goal | 1차 checkpoint는 DB-only 복원·무결성과 files/retention 비활성 무영향을 확인한다. 2차는 E03/E07 완료 뒤 첨부 manifest, 현재 정책의 만료 재적용, 삭제 worker 중지/재개를 확인한다. 어느 쪽도 전체 기능 완료를 대신하지 않는다. |
| non-goal | 손상 백업으로 접속 허용, 백업 당시 정책을 현재 정책으로 간주, 일반 파일 삭제를 완전 소거로 표현, 자동 파괴적 migration rollback. |
| 목표-input | O04 단계별 검증 백업 ID, 1차 DB-only 또는 2차 첨부 manifest, 현재 운영 보존 정책/버전, 차단 상태, B03 무결성 검사 및 B04 작업 재개 조건, 승인된 운영 주체. |
| 목표-output | 단계별 복원 데이터·무결성 판정·(2차) 만료 처리·세션/cursor 무효화 결과, 기능 재검증 및 재개/거부 상태. |
| 구현동작·실패처리 | 구현·격리 검증에서는 접속 차단→snapshot 복원→무결성 검사→해당 checkpoint 정책 적용→세션 폐기/cursor 초기화→기능 확인 순서를 강제한다. 1차는 DB-only와 비활성 files/retention 무영향만 검증한다. 2차는 E03/E07 이후 첨부 manifest와 삭제 worker를 조정해 현재 정책을 적용한다. 운영 VM 적용은 별도 승인된 운영 게이트로 분리하며 실패하면 차단을 유지한다. |
| 코드동작확인 Test방식 | 1차 격리 시험에서 정상/손상 DB, 비활성 기능 무영향, 기존 세션/cursor 무효화·기능 확인을 assertion한다. 2차는 E03/E07 완료 뒤 누락 파일·구 정책 backup·삭제 worker 정지/재개, manifest·현재 정책·세션 상태를 assertion한다. 운영 VM 적용 여부를 별도 증거로 판정한다. |
| 코드동작확인 로깅방식 | restore started/validated/completed/failed에 backupId·단계·현재 정책/schema 버전·검사/삭제 건수·duration·correlation만 허용한다. 경로·원본 데이터·키 금지, 운영 audit와 실행 증거 연결 및 기능 확인 뒤에만 completed가 기록됨을 검사한다. |
| 선행·병렬제약 | O04의 해당 단계 정상 백업과 B03/B04 복구 port가 선행한다. 1차는 DB-only 가능, 2차는 E03/E07 완료를 기다린다. O05는 E08을 선행으로 요구하지 않으며 O04→O05 완료 증거를 E08에 전달한다. bootstrap 접속 차단/재개는 B06 조립과 조정한다. |
| 완료증거 | 1차 DB-only 및 2차 첨부/정책 복구 검증, 운영 VM 적용 상태를 각각 분리해 기록한다. 환경·backup ID·정책 버전·폐기 세션·기능 재검증·RPO/RTO와 한계가 남고, 후속 E08이 인수할 수 있다. |
