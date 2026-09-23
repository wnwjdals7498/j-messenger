# 메신저 구현 계획

## 목표

Rocky Linux 10 VM의 Node 서버와 웹 UI를 먼저 만든다. 메일 서버 계정으로 인증하고 **같은 메일 서버에 속한 사용자끼리만** 개인·단체 대화를 한다. 파일, 읽음, 보존 기간, Windows·Android 앱과 종료 상태 알림은 후속 단계다. 접속은 허용된 사설망으로 제한한다.

1차 통합 완료: **실제 메일 서버 계정으로 HTTPS 로그인한 두 브라우저가 VM 서버를 통해 메시지를 주고받고, 새로고침·서버 재시작 뒤에도 기록이 남는다.** 메일 서버 종류와 공식 인증 수단이 정해지기 전에는 개발용 가짜 계정만 쓰며 통합 완료로 표시하지 않는다.

## 먼저 확정할 입력

| 항목 | 기준 | 확정 방법 |
| --- | --- | --- |
| 메일 서버 | 미지정 | 제품명·버전, 공식 인증/사용자 조회 문서, 시험 계정 2개와 다른 서버의 계정 1개 |
| 네트워크 | VM 고정 사설 IP, WSL→VM 접속 | 외부 Hyper-V 스위치, 비어 있는 사설 IP/CIDR, 게이트웨이, DNS를 현장값으로 입력 |
| VM | Rocky Linux 10 Minimal, Gen 2, 1 vCPU, 20 GiB | 설치 중 RAM 2 GiB, 설치 후 1 GiB 고정. 불안정하면 2 GiB로 기록·상향 |
| 서버 | Node 단일 프로세스, SQLite, HTTP API + WebSocket | 초기 부하 측정 후 변경할 때만 근거 기록 |
| 웹 | TypeScript + Vite + 기본 DOM/CSS | UI 의존성을 작게 유지 |
| 메시지 | 서버가 ID·순서·시각 부여 | 클라이언트 임시 ID로 재시도 중복 방지 |
| 수치 목표 | 미정 | 실제 이용 인원·동시 접속·파일 크기·보존 기간을 받은 뒤 확정 |

브라우저가 임의로 지정한 메일 서버 주소에 서버가 접속하게 하지 않는다. 서버 관리자가 허용한 메일 서버 ID와 접속 설정만 사용한다. 자격 증명은 인증 어댑터로만 전달하고 메시지 DB·로그에 저장하지 않는다.

## 단계

1. **웹 UI 데모:** 정적 화면과 로컬 가짜 데이터. 인증·전송을 보여 줄 때는 데모임을 표시.
2. **VM 기반:** 고정 IP의 Rocky Minimal 설치, WSL→VM SSH/HTTP 확인. [VM 안내](vm-runbook.md) 사용.
3. **서버 기본 기능:** 개발 계정으로 대화·저장·조회·실시간 수신·재연결 검증.
4. **메일 인증 통합:** 대상 제품 공식 문서에 근거한 어댑터와 메일 서버별 사용자 경계 검증. 이때 1차 완료 판정.
5. **후속 기능:** 파일·읽음·보존 기간, Windows·Android, 종료 상태 알림, 부하·장애 시험.

### API 계약 초안

- GET /health: 상태만 응답. 내부 경로나 인증 정보는 내보내지 않는다.
- POST /session: serverId, username, password를 받고 서버 세션 쿠키 발급. serverId는 허용 목록에서만 선택.
- GET /me, POST /logout: 본인 조회와 세션 폐기.
- GET /conversations, POST /conversations: 본인 대화만 조회·생성. 단체 참여자는 같은 serverId만 허용.
- GET /conversations/:id/messages?before=<id>&limit=50: 과거 메시지 조회. 비참여자 거부.
- POST /conversations/:id/messages: clientMessageId와 text를 받음. 같은 보낸 사람의 중복 ID는 원래 메시지를 반환.
- GET /events: WebSocket 세션 검증 후 본인 대화의 새 메시지만 전송. 재접속 뒤 HTTP 조회로 누락 복구.
- 모든 조회는 serverId와 현재 사용자 권한을 조건에 포함한다. 브라우저가 보낸 사용자 ID·시각은 신뢰하지 않는다.

필드·오류 형식·길이 제한은 S02에서 고정한다. WebSocket을 유일한 전달 경로로 쓰지 않는다.

### 고정 구성과 데이터 소유

- web은 브라우저 코드·정적 빌드 결과만 가진다. server는 API·인증·WebSocket·빌드된 웹 파일 제공을 맡는다. VM은 배포 코드와 SQLite 파일을 보관한다.
- 운영 브라우저는 VM의 **같은 HTTPS 출처**에서 웹과 API에 접속한다. 개발 중 Vite는 WSL에서만 사용한다. 운영에서 Vite 개발 서버나 임의 CORS 허용을 사용하지 않는다.
- SQLite에는 메일 서버의 내부 ID, 사용자 외부 식별자, 대화 참여 관계, 메시지 서버 ID·임시 ID·본문·생성 시각을 둔다. 비밀번호는 두지 않는다. 메시지 본문·토큰은 로그에 남기지 않는다.
- DB 파일 경로, 포트, 메일 서버 접속 정보, TLS 키 경로는 VM 환경 설정에서 주입한다. 예시 파일에는 비밀값을 쓰지 않는다. 운영 프로세스는 전용 비관리 계정으로 실행한다.
- 메시지 저장이 성공한 뒤에만 WebSocket 이벤트를 보낸다. 이벤트 누락은 HTTP 재조회로 복구한다. 서버 시각은 UTC로 저장한다.
- 개발 계정은 명시적인 개발 모드에서만 활성화한다. 실제 메일 서버 인증을 붙이기 전, 관리자 허용 서버 목록과 사용자 식별자 규칙을 P01에서 확정한다.

## WSL OpenCode 작업 규칙

- **아래 카드 한 개씩** 실행한다. 한 카드가 끝나기 전 다음 카드를 합치지 않는다.
- 매번 카드 ID, 허용 파일, 완료 조건만 넘긴다. 기존 파일을 먼저 읽고 범위 밖은 수정하지 않는다.
- 변경 파일 목록·검증·미해결 사항을 보고하게 한다. 사람이 diff와 검증을 확인한 뒤 다음 카드로 간다.
- 실패하면 해당 카드만 수정한다. 구조 변경이 필요하면 먼저 계약과 영향을 기록한다.
- 새 패키지, 인증 우회, DB 교체, 네트워크 노출 확대는 카드에서 명시하지 않으면 진행하지 않는다.

프롬프트 틀:

```text
j-messenger/docs/plan.md의 <카드 ID>만 수행하라.
허용 파일: <카드의 파일>.
선행 카드의 결과를 읽고 완료 조건을 직접 검증하라.
범위 밖 파일을 수정하지 말고 변경 파일·검증 결과·남은 문제를 보고하라.
```

## 작은 작업 카드

각 카드는 단독 검토가 가능한 변경이다. 완료 조건의 검증 결과는 카드 종료 때 남긴다.

| ID | 선행 | 허용 파일 / 할 일 | 완료 조건·검증 |
| --- | --- | --- | --- |
| P01 | 없음 | docs/plan.md: 메일 제품·공식 문서·시험 계정 조건 기록 | 인증 수단·사용자 식별자 기록, 비밀값 제외 |
| P02 | 없음 | docs/vm-runbook.md: IP/CIDR·게이트웨이·DNS·스위치명 기록 | LAN과 IP 중복 없음 확인 |
| U01 | 없음 | web/package.json, web/index.html, web/src/main.ts: Vite/TS 시작 | 개발 서버가 제목 표시 |
| U02 | U01 | web/src/styles.css: 화면 폭·색·타이포·포커스 | 360px·데스크톱에서 넘침 없음 |
| U03 | U01 | web/src/demo-data.ts: 서버/대화/메시지 타입·표본 | 타입 검사, 같은 서버의 표본 |
| U04 | U02,U03 | web/src/sidebar.ts: 대화 목록·선택 | 선택 표시, 키보드 조작 |
| U05 | U03 | web/src/message-list.ts: 날짜·발신자·본문 | 본문을 HTML로 해석하지 않음 |
| U06 | U04,U05 | web/src/main.ts: 목록·본문 결합 | 대화 전환 시 해당 메시지만 표시 |
| U07 | U06 | web/src/composer.ts: 입력·빈값/길이 제한·데모 전송 | Enter/버튼 동작, 중복 제출 방지 |
| U08 | U06 | web/src/login.ts: 서버 선택·계정 입력 | 비밀번호 감춤, 미입력 오류, 데모 표시 |
| U09 | U08 | web/src/styles.css, web/src/main.ts: 좁은 화면 전환 | 360px에서 목록↔대화 이동 |
| U10 | U09 | web/README.md: 실행·화면 확인 절차 | WSL에서 설치·실행 재현 |
| V01 | P02 | scripts/New-MessengerVm.ps1: 입력·충돌·권한 검사 | 구문 검사, 기존 VM/스위치 보호 |
| V02 | V01 | scripts/New-MessengerVm.ps1: Gen 2·1 vCPU·2 GiB 설치·20 GiB VHDX | Hyper-V 속성 조회 |
| V03 | V02 | scripts/Configure-GuestNetwork.sh: 정적 IPv4 | 재부팅 뒤 주소 유지 |
| V04 | V03 | docs/vm-runbook.md: 설치·1 GiB 전환·접속 결과 | WSL에서 고정 IP로 SSH·HTTP |
| S01 | U10 | server/package.json, server/src/index.ts: /health | WSL에서 HTTP 200 |
| S02 | S01 | docs/api.md: 요청/응답·오류·한도 계약 | 권한·예시·형식 확정 |
| S03 | S02 | server/src/db.ts: SQLite 열기·WAL·마이그레이션 진입 | 빈 DB 생성·재실행 |
| S04 | S03 | server/migrations/001_init.sql: 사용자·대화·참여자·메시지 | 외래키·고유키·인덱스 확인 |
| S05 | S04 | server/src/auth/provider.ts: 인증 인터페이스 | 성공·실패·장애 결과 타입 검사 |
| S05b | S05 | server/src/auth/dev.ts: 개발 구현 | 운영 모드에서 개발 구현 차단 |
| S06 | S05b | server/src/session.ts: 세션 발급·조회 | 만료·HttpOnly·SameSite 확인 |
| S06b | S06 | server/src/session.ts: 세션 폐기 | 로그아웃 뒤 재사용 거부 |
| S07 | S06 | server/src/routes/session.ts: 로그인·내 정보·로그아웃 | 실패에 계정 존재 여부 노출 없음 |
| S08 | S07 | server/src/conversations.ts: 본인 대화 조회 | 비참여자 대화 제외 |
| S08b | S08 | server/src/conversations.ts: 대화 생성 | 다른 serverId 참여자 거부 |
| S09 | S08 | server/src/messages.ts: 저장·중복키 | 같은 임시 ID 재시도에 행 1개 |
| S10 | S09 | server/src/routes/messages.ts: 메시지 페이지 | 비참여자 차단, 순서·페이지 안정 |
| S10b | S10 | server/src/routes/messages.ts: 전송 API | 비참여자 차단, 중복 응답 동일 |
| S11 | S10b | server/src/events.ts: 본인 대화 WebSocket | 타 사용자 이벤트 없음 |
| I01 | S07,U10 | web/src/api.ts: 세션 API 연결 | 로그인/로그아웃 반영, 데모와 분리 |
| I02 | I01,S10 | web/src/api.ts, main.ts: 목록·메시지 연결 | 새로고침 뒤 기록 동일 |
| I03 | I02,S11 | web/src/events.ts: 수신·재접속 조회 | 단절 중 메시지 복구 |
| D01 | V04,S01 | docs/deploy.md: VM Node 설치 버전·전용 계정·디렉터리 | 공식 배포 경로와 버전 기록, 비관리 계정 확인 |
| D02 | D01,S11 | server/src/static.ts: 빌드된 웹 파일 제공 | VM에서 웹·API가 같은 출처 |
| D03 | D02 | deploy/j-messenger.service: 재시작·환경 파일·DB 경로 | VM 재부팅 뒤 서비스 기동·기록 유지 |
| D04 | D03,T02 | docs/deploy.md: 허용 IP·게스트 방화벽 절차 | 허용 주소 접속, 그 외 주소 차단 |
| I04 | I03,D04,T04b | docs/verification.md: VM의 두 브라우저 시험 | 송수신·새로고침·재시작 기록 |
| T01 | V04 | docs/tls.md: 사설망 서버 이름·인증서 발급/신뢰 절차 | 두 브라우저·WSL에서 신뢰된 HTTPS 연결 |
| T02 | T01,S07,D03 | server/src/security.ts: HTTPS/WSS 연결 | HTTP 자격 증명 거부 |
| T03 | T02 | server/src/session.ts: 운영 Secure 쿠키 | HTTPS에서만 세션 유지 |
| T04 | T03 | server/src/security.ts: HTTP 변경 요청 Origin/CSRF 검사 | 다른 Origin 변경 요청 거부 |
| T04b | T04,S11 | server/src/events.ts: WebSocket Origin 검사 | 다른 Origin 연결 거부 |
| A01 | P01,S05,T04b | server/src/auth/<제품>.ts: 공식 인증 어댑터 | 정상/오류/장애/시간 초과 검증 |
| A02 | A01,S08 | 인증 어댑터, docs/verification.md: 사용자 경계 | 다른 메일 서버 계정·대화 차단 |
| A03 | A02,I04,T04b | docs/verification.md, README.md: 1차 판정 | 실제 메일 계정 2개·HTTPS VM 경로 성공 |

<제품>은 P01에서 실제 이름으로 바꾼다. 카드 범위의 파일명은 첫 카드에서 조금 조정할 수 있지만 여러 기능을 한 카드에 묶지 않는다. 자동 검증은 권한·중복·복구처럼 실패 영향이 큰 부분에 집중한다.

V01~V03의 스크립트 초안은 이 계획과 함께 제공한다. 카드 완료 표시는 현장 입력값을 넣어 실제 VM과 WSL 경로를 검증한 뒤에만 한다.

## 후속 카드 묶음

1. 파일: 크기·형식·저장 위치 결정 → 업로드 권한 → 다운로드 권한 → 실패 정리 → UI.
2. 읽음: 대화별 마지막 읽은 ID → API → 이벤트 → UI → 재접속 시험.
3. 보존: 메일 서버 관리자 식별 → 설정 권한 → 만료 메시지 삭제 → 파일 삭제 → 중단 후 재시도.
4. Windows·Android: 계약 재사용 결정 → 앱별 로그인·대화·파일 → 종료 상태 알림의 공식 플랫폼 제약 조사·실기기 시험.
5. 성능·안정성: 고정 VM·데이터셋 확정 → 동시 접속/지연/메모리/디스크 측정 → 연결 끊김·재시작·중복·순서 시험 → 병목별 변경.

각 묶음은 실행 전에 하나의 결과·소수 파일·명시적 검증을 가진 카드로 다시 쪼갠다. 외부 푸시 중계 없이 Android·Windows 종료 상태 알림을 충족할 수 없는 경우 구현 직전에 방식을 다시 결정한다. 웹 알림과 집 밖 사설 서버 접속은 범위 밖이다.

## 완료 기록

카드마다 docs/verification.md에 ID, 환경, 실제 명령/화면, 기대값, 실제값, 실패 원인을 적는다. 자격 증명·메일 내용·개인정보는 기록하지 않는다. VM 부하 시험은 1 GiB 고정 상태와 동일 데이터·접속 조건에서 비교한다.
