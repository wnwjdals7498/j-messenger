# 메신저 구현 계획

## 목표

Rocky Linux 10 VM의 Node 서버와 웹 UI를 먼저 만든다. 메일 서버 계정으로 인증하고 **같은 메일 서버에 속한 사용자끼리만** 개인·단체 대화를 한다. 파일, 읽음, 보존 기간, Windows·Android 앱, 종료 상태 알림은 후속 단계다. 접속은 허용된 사설망으로 제한한다.

1차 통합 완료: **실제 메일 서버 계정으로 HTTPS 로그인한 두 브라우저가 VM 서버를 통해 메시지를 주고받고, 새로고침·서버 재시작 뒤에도 기록이 남는다.** 메일 서버 종류가 확정되기 전에는 개발용 계정만 쓰며 통합 완료로 표시하지 않는다.

## 역할 분담

| 누구 | 하는 일 |
| --- | --- |
| Claude (planner) | 결정, 작업 명세(`docs/tasks/*.md`), `.ctx/TASKS.md` 배치 교체, 막힘 해소, 배치 검토, VM·호스트 인프라(sudo 필요한 모든 일) |
| OpenCode + 작은 모델 (executor) | `.ctx/TASKS.md`의 작업을 위에서부터 하나씩 구현·검증·커밋. 질문하지 않고, 불명확하면 blocked로 멈춤 |
| 사람 | VM 콘솔 비밀번호 입력, 메일 서버 정보 제공(P01), 인증서 신뢰 설치, 최종 확인 |

작업 흐름과 규칙은 [AGENTS.md](../AGENTS.md)와 ctx-relay 스킬이 정한다. 환경 값은 [env.md](env.md)가 정본이다.

## 결정 기록

아래는 Claude가 확정한 값이다. executor는 다시 논의하지 않고 그대로 따른다. 바꿀 때는 planner가 이 표와 관련 명세를 함께 고친다.

### 인프라

| ID | 결정 | 근거 |
| --- | --- | --- |
| E1 | VM은 Hyper-V Internal 스위치 `JMessengerInternal` + 호스트 NAT `JMessengerNat` 10.77.0.0/24. 호스트 10.77.0.1, VM 10.77.0.10 고정 | 회사 LAN(FortiGate) IP 점유·충돌 회피. 노트북 네트워크가 바뀌어도 주소 불변 |
| E2 | WSL(NAT 모드) → VM은 호스트 IPv4 forwarding. 예약 작업이 1분마다 복구 | WSL 어댑터가 재시작마다 새로 생김. 실측으로 확인 |
| E3 | VM 1 vCPU, RAM 1 GiB 고정, 스왑 2 GiB, 20 GiB 디스크 | 요구된 최소 환경. 설치만 2 GiB |
| E4 | 관리자 `jjm`(Claude 전용), 앱 계정 `jmsg`(sudo 없음). executor는 `ssh jm-vm`만 쓴다 | 작은 모델에게 root 권한을 주지 않음 |
| E5 | 서버는 `jmsg`의 systemd **사용자** 서비스 `j-messenger`(linger). 재시작은 sudo 없이 `systemctl --user` | 배포 작업에서 sudo 제거 |
| E6 | 배포는 WSL에서 `tar`를 SSH로 보내고 VM에서 `npm ci --omit=dev` | rsync 불필요, VM은 NAT로 npm 접근 가능 |
| E7 | VM 방화벽: 10.77.0.0/24, 172.16.0.0/12만 ssh·3000 허용. HTTPS는 3443 | 호스트·WSL 외 접근 차단. 사용자 서비스는 1024 미만 포트 불가 |

### 공통 코드 규칙

| ID | 결정 |
| --- | --- |
| C1 | Node 22 (WSL 22.22.2, VM 22.23.2). TypeScript는 Node 타입 제거로 직접 실행. ts-node·tsx·Babel·빌드 산출물 없음(웹은 Vite 빌드) |
| C2 | TypeScript 5.9.3 strict. 로컬 import는 `.ts` 확장자 포함. enum·namespace·생성자 매개변수 속성·데코레이터 금지(`erasableSyntaxOnly`). 타입 import는 `import type` |
| C3 | 테스트는 `node:test` + `node:assert/strict`. 테스트 파일은 별도 선행 작업에서 만들고, 구현 작업은 테스트 파일을 수정하지 못한다 |
| C4 | 새 의존성 금지. 허용 패키지는 명세에 버전까지 적힌 것뿐: vite 7.3.6, typescript 5.9.3, happy-dom 20.14.5, (서버) ws 8.21.3 |
| C5 | UI 문구는 한국어, 코드·주석·커밋·`.ctx` 파일은 영어. LF, UTF-8, 2칸 들여쓰기, 작은따옴표, 세미콜론 |
| C6 | 시각은 UTC ISO 8601(`Z`)로 저장·전송, 화면은 Asia/Seoul. 시간 `HH:mm`(24시간), 날짜 구분선 `YYYY-MM-DD` |

### 웹 (배치 W)

| ID | 결정 |
| --- | --- |
| W1 | Vite + TypeScript + 순수 DOM. UI 프레임워크·CSS 프레임워크 없음 |
| W2 | 화면 코드는 전역 `document`/`window`를 쓰지 않고 `root.ownerDocument`로 요소를 만든다(`main.ts`만 예외). Node + happy-dom 테스트를 위해서 |
| W3 | 텍스트는 `textContent`로만 넣는다. `innerHTML`류 금지 |
| W4 | 백엔드 경계는 `web/src/types.ts`의 `MessengerApi` 인터페이스. 데모는 메모리 구현 `createDemoApi()`, 서버 연결 단계에서 HTTP 구현을 추가해 교체 |
| W5 | 메시지 최대 4000자(앞뒤 공백 제거 후 `string.length`). Enter 전송, Shift+Enter 줄바꿈, 한글 조합 중(`isComposing`) Enter 무시 |
| W6 | 레이아웃: 데스크톱은 목록 280px + 대화. 640px 이하는 한 화면씩(`data-pane="list"|"chat"`) |
| W7 | 데모 데이터는 명세에 고정된 표본(서버 2, 사용자 5, 대화 3, 메시지 7). 데모 로그인은 표본 아이디 + 비어 있지 않은 아무 비밀번호 |

### 서버 (배치 S 이후, 명세는 웹 배치 완료 후 작성)

| ID | 결정 |
| --- | --- |
| S1 | `node:http` + 직접 만든 작은 라우터. WebSocket은 `ws` 8.21.3. DB는 `node:sqlite`의 `DatabaseSync`(네이티브 빌드 없음), WAL, `foreign_keys=ON` |
| S2 | 설정은 환경 변수: `NODE_ENV`, `HOST`, `PORT`, `DB_PATH`, `WEB_DIST`, `AUTH_MODE`(`dev`는 `NODE_ENV`가 production이 아닐 때만), `MAIL_SERVERS`(허용 메일 서버 JSON) |
| S3 | API: `GET /health`, `POST /api/session`, `GET /api/me`, `POST /api/logout`, `GET/POST /api/conversations`, `GET /api/conversations/:id/messages?before=<id>&limit=50`(최대 100), `POST /api/conversations/:id/messages`, `GET /events`(WebSocket) |
| S4 | 오류 형식 `{"error":{"code","message"}}`. code: bad_request 400, unauthorized 401, forbidden 403, not_found 404, conflict 409, too_large 413, internal 500. 로그인 실패는 계정 존재 여부를 드러내지 않는 401 하나 |
| S5 | 스키마: users(id, server_id, username, display_name, UNIQUE(server_id, username)), sessions(token_hash PK, user_id, expires_at), conversations(id, server_id, title, created_at), members(conversation_id, user_id), messages(id INTEGER PK AUTOINCREMENT, conversation_id, sender_id, client_message_id, text, created_at, UNIQUE(sender_id, client_message_id)), INDEX messages(conversation_id, id) |
| S6 | 세션: 32바이트 난수 base64url 토큰, 쿠키 `jm_session`(HttpOnly, SameSite=Strict, Path=/, 7일, production에서 Secure). DB에는 SHA-256만 저장 |
| S7 | 메시지는 DB 저장 성공 후에만 WebSocket 이벤트 전송. 재접속 시 HTTP로 누락분 조회. 같은 보낸 사람의 같은 `clientMessageId`는 기존 메시지를 반환 |
| S8 | 서버가 `WEB_DIST`의 웹 파일을 같은 출처로 제공. CORS 없음. 변경 요청과 WebSocket은 `Origin` 검사 |
| S9 | 메일 인증은 IMAP over TLS(993) LOGIN 어댑터(`imapflow`, 버전은 A01에서 고정). P01에서 대상 제품이 IMAP을 제공하지 않으면 planner가 다시 결정 |
| S10 | TLS: WSL에서 openssl로 사설 CA를 만들고 서버 인증서 SAN은 `IP:10.77.0.10`. CA는 사람이 Windows 사용자 인증서 저장소에 설치. HTTPS 포트 3443 |

## 단계와 배치

| 배치 | 내용 | 명세 | 상태 |
| --- | --- | --- | --- |
| E | VM 생성·설치·네트워크·계정·방화벽·연결 검증 | [vm-runbook.md](vm-runbook.md), [env.md](env.md) | 완료 (Claude, 2026-09-23) |
| W | 웹 UI 데모: 뼈대 → lib → 데모 API → 화면 모듈 → 앱 결합 → 스타일 → README | [tasks/web.md](tasks/web.md) T1~T31 | `.ctx/TASKS.md`에 적재됨 |
| S | 서버: /health → DB → 개발 인증 → 세션 → 대화 → 메시지 → WebSocket | 웹 배치 완료 후 작성 | 대기 |
| D | VM 배포: 배포 스크립트, 서비스 enable, 재부팅 뒤 유지 | 배치 S 후 | 대기 |
| I | 웹과 서버 연결: HTTP API 구현, 이벤트 수신·재접속 | 배치 D 후 | 대기 |
| T | HTTPS/WSS, Secure 쿠키, Origin 검사 | 배치 I 후 | 대기 |
| A | 메일 인증 어댑터, 서버 간 사용자 경계, 1차 판정 | P01 입력 후 | 대기 (메일 서버 정보 필요) |

P01(사람 입력): 메일 서버 제품·버전, IMAP 호스트·포트, 시험 계정 2개, 다른 메일 서버 계정 1개. 비밀번호는 저장소에 적지 않는다.

## executor 실행 방법

```bash
cd /mnt/d/workspace/test-space/github/j-messenger
opencode
```

첫 메시지는 `다음 작업 진행`이면 된다. AGENTS.md가 ctx-relay를 불러오게 하고, 작업이 끝나면 다음 `- [ ]` 작업으로 계속 넘어간다. 멈추는 경우는 둘뿐이다: 모든 작업 완료, 또는 `status: blocked`.

## planner 절차

1. **배치 교체:** 모든 작업이 `[x]`이면 `.ctx/TASKS.md`에서 `[x]` 작업을 지우고 다음 배치 작업을 넣는다. ID는 계속 증가(T32부터). `python3 .ctx/ctx.py check`가 OK인지 확인한다.
2. **막힘 해소:** STATE의 `blocked:`와 LOG 끝, `git diff`를 읽고 명세를 고치거나 작업을 쪼갠다. `[!]`를 `[ ]`로 되돌리고 STATE를 idle로 돌린다.
3. **검토:** 배치가 끝나면 각 작업의 `verify:`를 다시 실행하고, 커밋마다 `files:` 밖 변경이 없는지 확인한다. 웹 배치 뒤에는 브라우저로 360px·데스크톱 화면을 직접 본다.

## 후속 기능 묶음

1. 파일: 크기·형식·저장 위치 결정 → 업로드 권한 → 다운로드 권한 → 실패 정리 → UI.
2. 읽음: 대화별 마지막 읽은 ID → API → 이벤트 → UI → 재접속 시험.
3. 보존: 메일 서버 관리자 식별 → 설정 권한 → 만료 메시지 삭제 → 파일 삭제 → 중단 후 재시도.
4. Windows·Android: 계약 재사용 결정 → 앱별 로그인·대화·파일 → 종료 상태 알림의 공식 플랫폼 제약 조사·실기기 시험. 폰은 VM(호스트 전용망)에 바로 닿지 않으므로 이 단계에서 공개 경로를 다시 결정한다.
5. 성능·안정성: 고정 VM·데이터셋 확정 → 동시 접속/지연/메모리/디스크 측정 → 연결 끊김·재시작·중복·순서 시험 → 병목별 변경.

외부 푸시 중계 없이 Android·Windows 종료 상태 알림을 충족할 수 없으면 구현 직전에 방식을 다시 결정한다. 웹 알림과 집 밖 사설 서버 접속은 범위 밖이다.

## 완료 기록

배치·검증 결과는 `.ctx/LOG.md`(작업 단위)와 [verification.md](verification.md)(환경·통합 시험)에 남긴다. 자격 증명·메일 내용·개인정보는 기록하지 않는다.
