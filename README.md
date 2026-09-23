# j-messenger

> 상태: VM 환경 구축·연결 검증 완료(2026-09-23). 웹 UI 데모 배치(T1~T31)가 OpenCode 실행 대기 중.

관리포털과 독립된 Node 메신저 학습 프로젝트다. 중앙 서버는 Rocky Linux 10 VM에 두고, Windows·Android·Web 클라이언트를 대상으로 한다. 실제 서비스 접근은 허용된 사설망으로 제한한다.

## 계획한 범위

- 사용자가 입력한 메일 서버 주소와 계정으로 인증하고, 같은 메일 서버의 사용자끼리만 대화한다.
- 개인·단체 대화, 파일 전송, 읽음 상태를 세 클라이언트에서 제공한다.
- 메일 서버 관리자가 메시지·파일 보존 기간을 정하고 만료 자료를 삭제한다.
- Android·Windows는 앱 프로세스가 종료된 상태에도 새 메시지 알림을 받도록 목표를 둔다. Web 알림은 제외한다.
- 외부 푸시 중계 없이 추가 서비스 비용이 들지 않는 방식을 우선 검토한다. 이 조건으로 종료 상태 알림을 충족할 수 없으면 구현 직전에 방식을 다시 결정한다.

## 문서

| 문서 | 내용 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | OpenCode(작은 모델) 작업 규칙. ctx-relay 스킬을 매 요청 처음에 불러옴 |
| [docs/plan.md](docs/plan.md) | 목표, 결정 기록, 배치 순서, planner 절차 |
| [docs/tasks/web.md](docs/tasks/web.md) | 웹 배치 T1~T31 상세 명세 |
| [docs/env.md](docs/env.md) | 호스트·WSL·VM 환경, 포트, 계정, 연결 방법과 실측 결과 |
| [docs/vm-runbook.md](docs/vm-runbook.md) | VM을 처음부터 다시 만드는 절차 |
| [docs/verification.md](docs/verification.md) | 환경·통합 검증 기록 |

OpenCode 실행: WSL에서 저장소 루트로 이동해 `opencode`를 실행하고 `다음 작업 진행`을 입력한다. 메일 서버 제품과 실제 인증 방법, 앱 종료 상태 알림 방식은 아직 확정되지 않았다(plan.md P01).
