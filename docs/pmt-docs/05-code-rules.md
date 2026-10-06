# 코드 구현과 검증 규칙

## 구현

1. TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ESM을 기준으로 한다. 입력은 `unknown`에서 스키마로 좁히며 `any`, 무근거한 non-null assertion, 광범위한 타입 단언을 금지한다.
2. 서버·공유 패키지는 `NodeNext`와 `tsc` 빌드, 로컬 상대 import는 산출물에 맞는 `.js` 확장자를 쓴다. React JSX는 Vite로 빌드한다. workspace 간 import는 패키지의 공개 exports만 사용한다.
3. `enum`, namespace, 숨은 전역 상태, 순환 import, 서비스 탐색기, import 시 DB 연결·서버 시작을 만들지 않는다. 설정·시계·ID 생성·logger·port를 명시적으로 주입한다.
4. 라우트·React 컴포넌트에 SQL·메일 인증·파일 경로 처리·권한 정책을 넣지 않는다. 오류는 업무 code로 변환하고 transport가 HTTP 상태와 UI 문구로 바꾼다.
5. DB 쓰기는 parameter binding을 사용한다. 동적 정렬·컬럼은 허용 목록으로만 선택한다. 적용한 migration 수정 금지, 새 순번으로 추가한다. 시간은 UTC ISO 8601 `Z`, UI는 Asia/Seoul이다.
6. 서버 자원은 제한한다. 초기 JSON body 64 KiB, 메일 전체 인증 timeout 10초, 동시에 진행하는 메일 인증 최대 4개, 메시지 조회 최대 100건이다. 파일은 별도 스트림 한도를 쓰고 전체 버퍼로 읽지 않는다.
7. 2칸 들여쓰기·작은따옴표·세미콜론·UTF-8·LF를 사용한다. UI와 설명 문서는 한국어, 식별자·오류 code는 영어다. 주석은 구현 반복보다 이유·제약을 설명한다.
8. 사용자 텍스트를 HTML로 해석하지 않는다. React 기본 escaping을 사용하고 `dangerouslySetInnerHTML`·`innerHTML`을 금지한다. 첨부는 안전한 다운로드로 제공하며 사용자 파일명으로 저장 경로를 만들지 않는다.
9. 요청별 `serverId`·참여·관리자 권한 검사는 서버의 필수 조건이다. UI 숨김, 입력 타입, CORS를 권한 검사로 대신하지 않는다. 보존·파일·동기화·실시간 경로에도 동일하게 적용한다.
10. PowerShell 문자열로 Markdown·코드를 쓰지 않고 파일 편집 도구를 사용한다. 원래 있던 사용자 변경을 되돌리거나 자동 stash·reset하지 않는다.

문자열 길이 제한은 [기존 요구](01-requirements.md)의 UTF-16 기준을 따른다. JSON Schema의 `maxLength`만으로 같다고 가정하지 말고, 서버 업무 검증과 각 클라이언트에서 같은 벡터(한글·이모지·조합 문자)로 확인한다.

## 의존성과 공통 코드

- 새 의존성은 목적, 공식 근거, 적용 모듈, Node·Fastify 호환성, 라이선스·보안 점검 결과를 변경 기록에 남기고 manifest와 lockfile을 함께 바꾼다. 필요한 의존성까지 일괄 금지하는 옛 규칙은 적용하지 않는다.
- 1차에는 [기술 목록](02-architecture.md)에 필요한 패키지만 설치한다. Tauri·Android·푸시·파일 관련 도구는 해당 단계에 설치한다.
- 타입·프로토콜은 contracts, 앱 공통 동작은 client-core, 화면 공통은 client-react에 둔다. 서버의 특정 기능을 `shared`나 `utils`로 밀어 넣지 않는다.
- ESLint 경계 규칙으로 앱 역참조, 모듈 내부 경로 참조, test-kit의 production import를 차단한다. 복잡한 framework 추상화보다 작은 port를 사용한다.

## 검증 기준

아래 명령은 새 workspace에서 만들어야 하는 계약이며 **현재 존재하는 명령이 아니다.** 1단계에서 scripts와 CI를 먼저 연결한다. 미구현 workspace를 `--if-present`로 조용히 건너뛰고 전체 성공으로 표시하지 않는다.

| 명령 | 검사 |
| --- | --- |
| `npm run check` | lint·의존 경계, 타입 검사(테스트 포함), 단위·계약·repository 통합 시험 |
| `npm run build` | contracts → client-core/client-react → server/web 순서, 운영 산출물 실행 가능성 |
| `npm run test:e2e` | 두 사용자·서버 격리·재연결·실제 브라우저 주요 흐름 |
| `npm run test:recovery` | 디스크 DB 재시작·commit 직후 종료·중복 요청·백업 복원 |

수정한 책임에 맞는 시험을 고른다. 권한·중복 방지·데이터 손실·로그 비밀값 노출·삭제·복구는 필수 회귀 시험이다. 순수 문서 변경은 링크·일관성·차이 검사로 충분하다.

| 수준 | 반드시 증명할 것 |
| --- | --- |
| 단위 | 메시지 제한·읽음 단조 증가·정규화·정책 계산·오류 변환 |
| 계약 | JSON Schema와 DTO 일치, 알려지지 않은 이벤트 처리, demo/HTTP 공통 벡터 |
| 통합 | 실제 SQLite migration·복합 FK·권한·outbox·동시 재시도·파일 실패 정리 |
| E2E | 두 브라우저 개인·단체 대화, 다른 서버 차단, IME·360px/데스크톱, HTTP/WS 도착 순서 |
| 복구 | 파일 DB와 프로세스 재시작, outbox 중복, 만료 cursor, 삭제 후 재시도, 백업 복구 후 만료 재적용 |
| 운영 | 로그 마스킹·회전·재부팅 보존, 디스크 부족·readiness, 실제 VM 자원 측정 |

테스트 이름·줄 수·파일 수를 기능 품질로 간주하지 않는다. 요구가 바뀌면 테스트도 근거와 함께 고칠 수 있지만 실패를 숨기기 위한 assertion 삭제·skip·mock 대체는 금지한다. production에 테스트 전용 export를 추가하지 않는다. 외부 메일은 contract fake와 실제 제품 통합 시험을 구분하여 결과를 기록한다.

## 변경 완료

완료 기준은 관찰 가능한 동작으로 작성한다. 결과에는 변경 내용, 실제 실행한 검증, 미검증 범위, 관련 문서 변경을 남긴다. 코드를 작성했다는 이유만으로 실제 인증·VM 운영·알림 완료를 표시하지 않는다. 커밋·push·배포는 요청 범위에 따라 수행하며 옛 작업의 자동 연쇄 커밋 규칙을 재사용하지 않는다.
