# 공식 기술 근거

확인일: 2026-10-02. 아래는 공식 문서 또는 제품 관리 주체의 공식 저장소다. 블로그·비공식 요약·시장 의견을 기술 근거로 사용하지 않았다. 버전·호환 범위는 실제 패키지를 고정할 때 다시 확인한다.

| ID | 공식 문서 | 설계에 적용한 내용 |
| --- | --- | --- |
| S01 | [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces/), [TypeScript project references](https://www.typescriptlang.org/docs/handbook/project-references.html) | 패키지 작업공간·빌드 경계 |
| S02 | [React Quick Start](https://react.dev/learn), [Vite 7 Guide](https://v7.vite.dev/guide/) | 컴포넌트·상태 구성과 웹 빌드. Vite 7의 Node 요구 범위 확인 |
| S03 | [Fastify 5 migration](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/), [검증·직렬화](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) | Fastify 5의 Node 요구·JSON Schema 기반 입출력 |
| S04 | [공식 TypeBox provider](https://github.com/fastify/fastify-type-provider-typebox), [공식 Swagger plugin](https://github.com/fastify/fastify-swagger), [공식 WebSocket plugin](https://github.com/fastify/fastify-websocket) | 스키마·타입·OpenAPI 연결, WebSocket 및 호환 버전 선택 |
| S05 | [Node 22.18 SQLite](https://nodejs.org/download/release/v22.18.0/docs/api/sqlite.html), [SQLite WAL](https://sqlite.org/wal.html), [SQLite backup](https://www.sqlite.org/backup.html) | 동기 DB API·개발 중 상태, WAL의 제약, 일관된 백업 |
| S06 | [Fastify Logging](https://fastify.dev/docs/latest/Reference/Logging/) | 내장 Pino JSON 로그·직렬화·redact·request ID |
| S07 | [systemd 공식 journald.conf 원문](https://github.com/systemd/systemd/blob/main/man/journald.conf.xml) | 영속 journal, 시간·용량·여유 공간·압축 옵션. 설치된 systemd에 맞춰 적용 |
| S08 | [ImapFlow](https://imapflow.com/docs/) | IMAP 클라이언트 어댑터. 대상 메일 제품의 인증 가능 여부는 별도 확인 |
| S09 | [Tauri 2](https://v2.tauri.app/start/) | 웹 프런트엔드·시스템 WebView·Rust/OS 연동 경계 |
| S10 | [Android Compose](https://developer.android.com/compose) | Android UI 기본안 |
| S11 | [Android background tasks](https://developer.android.com/develop/background-work/background-tasks) | 백그라운드 작업 분류·API 선택·실행 제약 |
| S12 | [Android foreground services](https://developer.android.com/develop/background-work/services/fgs) | 사용자에게 보이는 장기 작업과 foreground service 조건 |
| S13 | [Windows push notifications](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/) | WNS를 사용하는 Windows 푸시 경로. 외부 중계 없는 요구와 별도 검토 |
| S14 | [Vitest](https://vitest.dev/guide/), [Playwright](https://playwright.dev/docs/intro) | 테스트 도구의 설정·브라우저 시험 경로 |

모듈 개수, React/Fastify 채택, API 이름, 재시도·보관·성능 수치는 프로젝트 설계 판단이다. 공식 문서가 이 조합의 성능이나 종료 알림을 보증한다고 해석하지 않는다. 대상 메일 제품, OS 푸시 허용 여부, 실제 패치 버전은 확정 자료가 생기면 이 표에 공식 링크를 추가한다.

2026-10-06 Windows 소스 구현 참고: [Tauri Rust 명령](https://v2.tauri.app/develop/calling-rust/), [Tauri 권한](https://v2.tauri.app/security/capabilities/), [keyring 4.2 Windows 저장소](https://docs.rs/keyring/4.2.0/keyring/v1/), [reqwest TLS](https://docs.rs/reqwest/0.13.5/reqwest/tls/), [tokio-tungstenite TLS](https://docs.rs/crate/tokio-tungstenite/0.30.0). 현재 Native SDK가 없어 실제 Windows 바이너리 검증은 수행하지 못했다.
