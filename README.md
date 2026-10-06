# j-messenger

메일 서버 계정으로 인증하고 같은 메일 서버 사용자끼리 개인·단체 대화하는 사설망 메신저다. Web을 먼저 구현하고 파일·읽음·보존 정책, Windows·Android로 확장한다.

**2026-10-06: 재구축 구현·통합 검증 진행 중.** 새 서버·웹은 `apps/`와 `packages/`에서 실행한다. 기존 `web/`는 비교용 이력이다. 메일 서버가 없어 실제 메일 연동 시험은 제외했고, 현재 대상은 Web·Windows다.

## 로컬 실행

Node 22.18 이상이 필요하다. 저장소 루트에서 다음 순서로 실행한다.

```powershell
npm ci
npm run build
npm start
```

브라우저에서 `http://127.0.0.1:3000`을 연다. 현재 개발 인증 계정은 서버 `dev-a`의 `alice`·`bob`·`carol`, 서버 `dev-b`의 `mallory`다. 개발 암호는 `dev-only`다. 운영 인증이나 실제 메일 인증 성공을 의미하지 않는다.

메시지 본문은 5일, 첨부는 14일 보존한다. 첨부는 개당 5MB, 개발용 합계 한도는 서버별 2GB다. 실제 VM의 용량을 확인하기 전에는 이 한도를 운영 실측값으로 보지 않는다. 실행 데이터는 Git에서 제외한 `data/`에 저장한다.

```powershell
npm run check
npm run test:e2e
npm run build --workspace=@j-messenger/desktop
```

브라우저 시험은 먼저 `npm run build`를 실행하고 설치된 Edge 또는 Chrome이 있는 환경에서 진행한다. Windows 화면 번들과 네이티브 실행 파일은 별도다. 네이티브 빌드는 Rust·Microsoft C++ Build Tools가 준비된 뒤 `npm run bundle --workspace=@j-messenger/desktop`으로 수행한다. 현재 네이티브 바이너리·설치 패키지·VM 배포·앱 프로세스 종료 상태 알림은 검증되지 않았다. [실행 현황](docs/pmt-docs/12-execution-status.md)에 제한과 근거를 기록한다.

| 문서 | 내용 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 현재 작업 규칙과 필수 경계 |
| [재구축 설계](docs/pmt-docs/README.md) | 요구사항, 폴더·기술, 모듈, 통신, 확장, 코드·운영 기준 |
| [전환 계획](docs/pmt-docs/07-rebuild-plan.md) | 단계별 산출물·검증·기존 자산 처리 |
| [기존 환경](docs/env.md) | 과거 호스트·WSL·VM 실측, 재사용 전 확인 |
| [기존 검증 기록](docs/verification.md) | 환경 구축 시험 이력 |

이전 `docs/plan.md`, `docs/tasks/`, `.ctx/`는 이력으로 보존한다. 다음 작업은 현재 설계와 PMT 완료 기준에 따라 정하며, 이전 T번호 작업을 자동 재개하지 않는다.
