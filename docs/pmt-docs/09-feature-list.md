# 필요한 기능 목록

작성일: 2026-10-02. 현재 재구축 문서에서 **47개 기능**을 추출했다. 기능별 [목표·입출력 의미·Test·로깅 명세](10-feature-specifications.md)를 연결한다. 목록은 구현 완료 상태를 의미하지 않는다.

## 분류 기준

입력은 사용자 입력뿐 아니라 검증된 세션 문맥·DB 상태·정책·실행 조건을 포함한다. 출력은 API 응답·화면 변화·저장 결과·후속 작업·실패 결과를 포함한다. 폴더 배치·코드 스타일·프레임워크 선택은 기능이 아닌 구현 제약이며 기존 구조·코드 규칙을 따른다.

| 단계 | 의미 |
| --- | --- |
| 기반 | 첫 사용자 기능부터 필요한 내부·운영 기능 |
| 1차 | Web·메일 인증·개인/단체 대화·저장·재접속 |
| 2차 | 파일·읽음·관리자 보존 정책 |
| 3차 | Windows·Android·기기 알림 |

출처 약칭: **요구**=[01](01-requirements.md), **구조**=[02](02-architecture.md), **모듈**=[03](03-modules.md), **통신**=[04](04-communication.md), **코드**=[05](05-code-rules.md), **운영**=[06](06-operations.md), **전환**=[07](07-rebuild-plan.md). `R`은 사용자 요구, `내부/운영`은 그 요구를 실현하는 설계 책임이다.

## 기능 목록

| ID | 기능 | 담당 모듈 | 단계 | 근거 | 선행 조건 |
| --- | --- | --- | --- | --- | --- |
| [F01](10-feature-specifications.md#f01) | 허용 메일 서버 목록·주소 해석 | identity | 1차 | R02·R03, 요구·통신 | 등록 서버 설정 |
| [F02](10-feature-specifications.md#f02) | 메일 계정 로그인·사용자 등록 | identity | 1차 | R02, 요구·통신 | U01: 실제 메일 통합 |
| [F03](10-feature-specifications.md#f03) | 세션 검증·현재 사용자 확인 | identity | 1차 | R02·R03, 모듈·통신 | F02 |
| [F04](10-feature-specifications.md#f04) | 로그아웃·세션 및 로컬 상태 폐기 | identity·client-core | 1차 | R03·R05, 모듈·통신 | F03·F14 |
| [F05](10-feature-specifications.md#f05) | 서버 격리·대화 참여 권한 검사 | identity·conversations | 기반 | R03, 모듈·코드 | 검증된 세션·참여 관계 |
| [F06](10-feature-specifications.md#f06) | 같은 서버 사용자 조회 | identity | 1차 | R03·R04, 요구·통신 | F03·F05 |
| [F07](10-feature-specifications.md#f07) | 개인 대화 생성·기존 대화 재사용 | conversations | 1차 | R04·R05, 모듈·통신 | F05·F06 |
| [F08](10-feature-specifications.md#f08) | 단체 대화 생성 | conversations | 1차 | R04·R05, 요구·모듈·통신 | F05·F06 |
| [F09](10-feature-specifications.md#f09) | 참여 대화 목록·대화 선택 | conversations·client-react | 1차 | R04, 모듈·통신 | F07/F08 |
| [F10](10-feature-specifications.md#f10) | 메시지 기록·이전/이후 페이지 조회 | messages | 1차 | R04·R05, 통신 | F05·저장 기록 |
| [F11](10-feature-specifications.md#f11) | 메시지 작성·입력 검증 | client-react·messages | 1차 | R04·R12, 요구·코드 | 메시지 길이·IME 규칙 |
| [F12](10-feature-specifications.md#f12) | 메시지·중복키·이벤트 원자 저장 | messages·platform | 1차 | R04·R05, 모듈·통신 | F05·F11·F39 |
| [F13](10-feature-specifications.md#f13) | 전송 재시도·중복/충돌/만료 판정 | messages·client-core | 1차 | R05, 모듈·통신 | F12 |
| [F14](10-feature-specifications.md#f14) | 실시간 연결·인증·연결 수명 관리 | realtime | 1차 | R03·R05, 통신 | F03·F05·F47 |
| [F15](10-feature-specifications.md#f15) | commit된 이벤트 배포 | realtime·platform | 1차 | R04·R05, 모듈·통신 | F12·F14·F42 |
| [F16](10-feature-specifications.md#f16) | cursor 기반 증분 동기화 | platform·client-core | 1차 | R03·R05, 통신 | F05·F15 |
| [F17](10-feature-specifications.md#f17) | 전체 갱신·이벤트 병합·재접속 복구 | client-core | 1차 | R04·R05, 모듈·통신 | F09·F10·F14·F16 |
| [F18](10-feature-specifications.md#f18) | 한국어·시간·반응형·안전한 화면 표시 | client-react | 1차 | R12, 요구·코드 | 화면 모델·시간대 규칙 |
| [F19](10-feature-specifications.md#f19) | 요청 스키마·Origin·빈도 제한 | contracts·platform | 기반 | R02·R03, 통신·코드 | 계약·허용 Origin·제한 설정 |
| [F20](10-feature-specifications.md#f20) | 제한된 파일 업로드 | files | 2차 | R06, 통신·코드 | U03·F05 |
| [F21](10-feature-specifications.md#f21) | 준비된 파일을 메시지에 연결 | files·messages | 2차 | R06, 모듈·통신 | F12·F20 |
| [F22](10-feature-specifications.md#f22) | 참여자 파일 다운로드 | files | 2차 | R03·R06, 통신 | F05·F21 |
| [F23](10-feature-specifications.md#f23) | 임시·미연결·고아 파일 정리 | files | 2차 | R06, 통신·운영 | F20·F42 |
| [F24](10-feature-specifications.md#f24) | 읽음 위치 단조 증가 갱신 | receipts | 2차 | R07, 모듈·통신 | F05·F10 |
| [F25](10-feature-specifications.md#f25) | 읽음 조회·동기화·화면 표시 | receipts·client-core/client-react | 2차 | R07, 통신 | F24·F15·F17 |
| [F26](10-feature-specifications.md#f26) | 해당 메일 서버 관리자 확인 | identity | 2차 | R08, 요구·모듈 | U02 |
| [F27](10-feature-specifications.md#f27) | 보존 정책 조회·변경 | retention | 2차 | R08, 통신·운영 | U02·U03·F26·F30 |
| [F28](10-feature-specifications.md#f28) | 만료 메시지·첨부 접근 차단·삭제 | retention·messages/files | 2차 | R08, 모듈·통신 | F27·F42 |
| [F29](10-feature-specifications.md#f29) | 물리 파일 삭제·실패 재개 | files | 2차 | R06·R08, 통신 | F23/F28·F42 |
| [F30](10-feature-specifications.md#f30) | 관리자 변경·작업 감사 기록 | audit | 기반/2차 | R08, 모듈·운영 | 검증된 관리 행위·트랜잭션 |
| [F31](10-feature-specifications.md#f31) | 서버별 감사 열람·보관 관리 | audit | 2차 | R03·R08, 통신·운영 | F26·F30 |
| [F32](10-feature-specifications.md#f32) | 네이티브 세션·자격 증명 보호 | identity·앱 어댑터 | 3차 | R02·R09, 통신 | F03·OS 보호 저장소 |
| [F33](10-feature-specifications.md#f33) | Windows 클라이언트 기능 연결 | desktop·client-core/client-react | 3차 | R09, 구조·모듈 | U04·F32·2차 기능 |
| [F34](10-feature-specifications.md#f34) | Android 클라이언트 기능 연결 | android | 3차 | R09, 구조·모듈 | U04·F32·2차 기능 |
| [F35](10-feature-specifications.md#f35) | 알림 기기 등록·해제 | notifications | 3차 | R09·R10, 모듈·통신 | U04·F32·기기 계약 확정 |
| [F36](10-feature-specifications.md#f36) | 알림 작업 적재·전달·재시도 | notifications | 3차 | R10·R11, 모듈·통신 | U04·F35·F42 |
| [F37](10-feature-specifications.md#f37) | 앱 상태별 OS 알림·결과 판정 | 앱·notifications | 3차 | R10·R11, 전환 | U04·F36·실기기 |
| [F38](10-feature-specifications.md#f38) | 설정 검증·기능 활성화 조건 검사 | platform | 기반 | 내부/운영, 운영 | 실행 환경·정책 |
| [F39](10-feature-specifications.md#f39) | DB 초기화·migration·무결성 유지 | platform | 기반 | R03·R04, 구조·모듈 | DB 파일·순번 migration |
| [F40](10-feature-specifications.md#f40) | 서비스 시작·종료·health·재부팅 복구 | bootstrap·platform | 기반 | R01·R04, 운영 | F38·F39·F42 |
| [F41](10-feature-specifications.md#f41) | 계약·빌드 검증·release 배치·호환 rollback | scripts·deploy·contracts | 기반 | 내부/운영, 코드·운영·전환 | 새 workspace·공식 호환 버전 |
| [F42](10-feature-specifications.md#f42) | 영속 작업 실행·재시도·중단 복구 | platform·작업 소유 모듈 | 기반 | R05·R08·R10, 모듈 | 독립 job·시계·작업 port |
| [F43](10-feature-specifications.md#f43) | 운영 로그 생성·비밀값 제외·보관·열람 | platform·deploy | 기반 | 내부/운영, 운영 | logger·journal·접근 권한 |
| [F44](10-feature-specifications.md#f44) | 자원 관측·디스크 보호·성능 판정 | platform·deploy | 기반 | R01·R04·R05, 운영·전환 | 실제 자원·부하 fixture |
| [F45](10-feature-specifications.md#f45) | 일관된 백업·보관·정상본 보호 | platform·deploy | 기반/2차 | R04·R08, 운영 | DB·파일·백업 저장소 |
| [F46](10-feature-specifications.md#f46) | 복원·현재 보존 재적용·접속 재개 | platform·deploy | 기반/2차 | R03·R04·R08, 운영 | 정상 백업·현재 운영 정책 |
| [F47](10-feature-specifications.md#f47) | 사설망 허용·TLS 접속 검증 | deploy·앱 어댑터 | 기반/3차 | R01·R02·R09, 요구·운영 | 인증서·허용망, 앱은 U04 |

## 요구사항별 추적

| 요구 | 기능 |
| --- | --- |
| R01 중앙 서버·허용망 | F38~F47 |
| R02 메일 인증 | F01~F04·F19·F32·F47 |
| R03 서버 격리 | F01·F03~F10·F14~F16·F19~F22·F26~F27·F31·F35·F46 |
| R04 개인·단체·영속 기록 | F07~F12·F15·F17·F39~F41·F44~F46 |
| R05 중복 방지·복구 | F12~F17·F42 |
| R06 파일 | F20~F23·F29·F33~F34 |
| R07 읽음 | F24~F25·F33~F34 |
| R08 관리자 보존 | F26~F31·F42·F45~F46 |
| R09 다중 클라이언트 | F32~F35·F47 |
| R10 종료 알림 | F35~F37·F42 |
| R11 중계·비용 조건 검토 | F36~F37 |
| R12 한국어·시간·입력 | F11·F18·F33~F34 |

U01~U04가 필요한 기능은 구조·모의 시험을 먼저 작성할 수 있다. 실제 메일·관리자·파일 정책·앱 알림 완료 판정은 해당 조건이 확정된 뒤 수행한다. 네이티브 기기 API와 OS 알림 구현 방식은 확정 전 계약으로 둔다. 그룹 참여자 변경, 주소록 연동, Web 알림 등 원문 제외 기능은 목록에 추가하지 않았다.
