# j-messenger 작업 기준

기존 메일 계정으로 같은 메일 서버 사용자끼리 대화하는 사설망 메신저다. 답변과 문서는 한국어로 간결하게 작성한다. 기술 정보는 공식 문서·공식 저장소에서만 확인한다.

## 작업 시작

1. 사용자 요청과 `git status`를 확인하고 기존 변경을 보존한다.
2. [설계 목차](docs/pmt-docs/README.md)와 아래 표에서 이번 작업에 필요한 문서를 읽는다.
3. `proj-mgmt-tool-v2`로 프로젝트 `j-messenger`를 재개하고 범위·완료 기준을 정한 Item을 시작한다. PMT 문서 루트는 `D:/workspace/test-space/github/docs`이며 상태는 그 아래 `projects/j-messenger/`에 있다. 같은 작업에서는 session을 고정한다.
4. 새 구조는 목표 설계다. 실제 파일·의존성·명령이 만들어졌는지 확인한 뒤 사용한다.

## 참조 문서

| 작업 | 기준 |
| --- | --- |
| 범위·우선순위·완료 판정 | [요구사항](docs/pmt-docs/01-requirements.md) |
| 폴더·프레임워크·의존 방향 | [구조와 기술](docs/pmt-docs/02-architecture.md) |
| 기능 분리·데이터 소유·확장 | [모듈](docs/pmt-docs/03-modules.md) |
| API·이벤트·인증·동작 예제 | [통신과 동작](docs/pmt-docs/04-communication.md) |
| 구현·테스트·의존성 추가 | [코드 규칙](docs/pmt-docs/05-code-rules.md) |
| 로그·보존·배포·백업·복구 | [운영](docs/pmt-docs/06-operations.md) |
| 재구축 순서·구 자산 처리 | [전환 계획](docs/pmt-docs/07-rebuild-plan.md) |
| 기술 사실 확인 | [공식 근거](docs/pmt-docs/08-official-references.md) |
| 구현할 기능·선행 조건 | [기능 목록](docs/pmt-docs/09-feature-list.md) |
| 기능별 입출력·Test·로깅 확인 | [기능 명세서](docs/pmt-docs/10-feature-specifications.md) |
| 행동 기반 구현 범위·6-luna 병렬 실행 | [상세계획](docs/pmt-docs/11-implementation-plan.md) |
| 최신 실행 범위·구현 상태 | [실행 현황](docs/pmt-docs/12-execution-status.md) |
| 실제 VM 배포·TLS·journal·접속 | [VM 실행 기록](docs/pmt-docs/13-vm-deployment.md) |
| Android Web APK·Pixel10 검증 | [Android 실행 기록](docs/pmt-docs/14-android-web-app.md) |

## 반드시 지킬 경계

- 서버는 기능별 모듈을 가진 단일 프로세스로 시작한다. 모듈 간 공개 인터페이스만 호출하며 상대 내부 파일·테이블을 직접 다루지 않는다.
- 계약은 `packages/contracts`, 클라이언트 공통 동작은 `client-core`, 공통 화면은 `client-react`가 소유한다. framework·DB·OS 세부 구현은 어댑터 안에 둔다.
- 모든 사용자 데이터는 `serverId`로 격리한다. 서버가 세션에서 사용자·서버를 결정하고 대화 참여·관리자 권한을 검사한다.
- 메시지와 outbox는 같은 트랜잭션으로 저장한다. 전송은 commit 후, 재시도는 같은 clientMessageId, 재연결은 cursor sync로 복구한다.
- 메시지 본문·파일·비밀번호·토큰은 운영 로그에 남기지 않는다. 로그·감사·업무 데이터의 보존 정책을 구분한다.
- 메일 인증 정보·관리자 확인·파일 정책·종료 알림의 미확정 조건은 [U01~U04](docs/pmt-docs/01-requirements.md)를 따른다. 모의 시험을 실제 통합 성공으로 보고하지 않는다.

## 변경과 검증

- TypeScript strict·ESM, UTF-8·LF, 파일 편집 도구를 사용한다. 구체 규칙과 검증 명령은 코드 규칙을 따른다.
- 기능 변경은 계약·소유 모듈·migration·관련 시험·참조 문서를 함께 맞춘다. 새 의존성은 목적과 공식 호환 근거를 남긴다.
- 테스트는 동작·권한·실패 복구를 확인한다. assertion 약화·skip으로 통과시키지 않는다. 문서만 바꾸면 링크·일관성·변경 범위를 검사한다.
- PMT `note`·`verify`·`end`로 실제 결과와 검증 한계를 기록한다. 범위 밖 구현이나 다음 배치를 자동으로 계속하지 않는다.
- 병렬 구현은 상세계획의 소유권·계약 동결·선행·통합 게이트를 따른다. 인계는 목적·행동·입출력 의미·시험·로그·완료 증거로 작성하며 파일 편집 지시만으로 대신하지 않는다. 서브에이전트는 자기 책임만 구현하고 PMT·공유 계약·lock·migration 순번·bootstrap은 오케스트레이터가 통합한다.
- 사용자 변경 삭제, 자동 stash·reset, 요청 없는 push·배포를 하지 않는다. 3001 포트는 사용·종료·호출하지 않는다. 호스트·VM 변경은 해당 작업 범위에서만 수행한다.

## 이전 문서의 지위

이 파일은 2026-10-02에 전면 교체했다. `docs/plan.md`, `docs/tasks/`, `.ctx/`, `scripts/verify.mjs T<n>`는 구 설계 이력이며 현재 작업 큐가 아니다. ctx-relay 자동 실행, planner 전용 파일 금지, 테스트 수정 일괄 금지, 자동 연쇄 커밋 규칙은 적용하지 않는다.

현재 사용자 지시 → 이 파일 → `docs/pmt-docs/` → 작업별 명세 순서로 따른다. 기존 `docs/env.md`·`docs/vm-runbook.md`는 과거 환경 기록이므로 실제 상태를 재확인한다.
