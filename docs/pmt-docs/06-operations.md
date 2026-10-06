# 운영·로그·데이터 관리

## 실행과 설정

기본 운영은 [기존 VM](../env.md)의 `jmsg` 계정과 systemd 사용자 서비스다. 새 구조에서는 개발 호스트/CI에서 빌드하여 서버 JS·workspace 의존 패키지·웹 정적 파일·운영 의존성을 release 묶음으로 배치한다. VM에서 Vite·타입 검사·브라우저 테스트를 실행하지 않는다.

```text
/home/jmsg/
├─ app/releases/<release-id>/       # server·공유 package·web/dist·manifest
├─ app/current -> releases/...     # 현재 실행 버전
├─ data/j-messenger.sqlite         # 업무·outbox·감사 데이터
├─ data/files/                     # 비공개 객체 파일
├─ data/tmp/                       # 미완료 업로드
├─ data/backups/                   # 복구 snapshot, 저장 공간 상한 적용
└─ .config/j-messenger/server.env   # 0600, Git 제외
```

시작 순서: 설정 검증 → DB 버전 확인·migration → 모듈 조립 → HTTPS/WSS → 복구 worker → ready. 종료 순서: ready 해제·신규 요청 중단 → 진행 중 작업 제한 시간 내 종료 → 소켓 종료 → DB 종료. 미처리 작업은 DB에 남겨 재시작한다. 서비스 종료 유예 기본 30초다.

운영은 HTTPS 3443, 개발은 web 5173·server 3000을 사용한다. 3001은 기존 모델 게이트웨이이므로 바인드·종료·호출하지 않는다. 인증서와 허용망은 실제 배포 전에 확인하고 HTTP·개발 인증을 운영 편의상 열어 두지 않는다.

| 설정 그룹 | 키·규칙 |
| --- | --- |
| 서버 | `NODE_ENV`, `HOST`, `PORT`, `PUBLIC_ORIGIN`, `WEB_DIST`, `RELEASE_ID` |
| 데이터 | `DB_PATH`, `FILE_ROOT`, `TEMP_ROOT`, `BACKUP_ROOT`; 서로 분리한 절대 경로 |
| 인증 | `AUTH_MODE`, `MAIL_SERVERS`, `SESSION_DAYS`, `TLS_CERT_PATH`, `TLS_KEY_PATH`, `CURSOR_SIGNING_KEY`; production의 dev 인증 거부 |
| 후속 기능 | `FILES_ENABLED`, `RETENTION_ENABLED`, `NOTIFICATIONS_ENABLED`; 필요한 정책·어댑터 미설정 시 시작 실패 |
| 제한·로그 | `LOG_LEVEL=info`, `AUDIT_RETENTION_DAYS=90`, 파일 크기·서버별 quota; 검증된 설정 객체로 주입 |

기능 비활성 상태의 경로는 등록하지 않고 404를 반환한다. 로그·오류에 환경 변수 전체를 출력하지 않는다. 인증서 검증·SELinux·방화벽을 끄는 해결책은 사용하지 않는다.

## 로그를 어디에 남기는가

| 종류 | 저장 위치·형식 | 보관·관리 |
| --- | --- | --- |
| 앱 실행·요청·오류 | Pino JSON 1행 → stdout/stderr → journald | 목표 최대 14일, VM journal 전체 256 MiB, 최소 여유 공간 1 GiB; 먼저 도달한 제한 적용 |
| 보안·관리 감사 | SQLite `audit_events` | 기본 90일, 하루 1회 제한 배치 정리; 정상 API에 수정·개별 삭제 기능 없음 |
| 메시지·파일 | 업무 테이블·files 저장소 | 메일 서버별 보존 정책. 운영 로그에 본문 복사 금지 |
| 개발 로그 | 터미널 | Git·업무 DB에 저장하지 않음 |
| 지원용 추출 | 권한 제한한 임시 JSONL | 요청한 시간·requestId만 추출, 민감정보 재검사 후 공유, 기본 7일 내 삭제 |

Pino 로깅·redact와 journald 옵션의 기술 근거는 [S06·S07](08-official-references.md)이다. 보관 일수·용량은 공식 기본값이 아니라 이 프로젝트의 초기 운영 정책이다.

앱이 파일 로그를 동시에 쓰거나 자체 logrotate를 돌리지 않는다. journal 저장·압축·회전은 systemd가 맡는다. `Storage=persistent`, `SystemMaxUse=256M`, `SystemKeepFree=1G`, `MaxRetentionSec=14day`, `Compress=yes`를 운영 목표로 한다. 이 옵션은 **앱별이 아닌 VM journal 전체**에 적용된다. 관리자 배포 작업에서 적용 범위·설치 버전 지원·재부팅 후 보존을 확인한다. 앱 계정은 `/etc`를 수정하지 않는다.

기본 journal 저장소는 `/var/log/journal/`이며 영속 설정이 없으면 재부팅 보존을 보장할 수 없다. 용량 제한과 rate limit 때문에 14일 전체가 남는다고 보장하지 않는다. journal 전체를 vacuum해서 다른 서비스 기록을 지우지 않으며 정기 용량 점검과 systemd 회전 정책으로 관리한다.

## 로그 필드와 금지 데이터

공통 필드는 `time`(UTC), `level`, `service`, `release`, `module`, `event`, `requestId`다. 해당될 때만 `serverId`, `userId`, `conversationId`, `messageId`, `durationMs`, `statusCode`, `errorCode`, `jobId`, `attempt`를 추가한다. job도 원래 requestId 또는 독립 correlation ID로 연결한다. requestId는 서버가 생성하며 외부 문자열을 그대로 받아 쓰지 않는다.

기능별 확인 사건은 [기능 명세서](10-feature-specifications.md)를 따른다. `featureId`는 기능 목록의 식별자, `outcome`은 처리 판정이다. 필요한 사건에만 내부 `eventId`, `fileId`, `deviceId`, `auditId`, `backupId`, 정책/schema 버전, 처리/실패/무시 건수, byte 수, 안전한 사유 code를 allowlist로 추가한다. 자원 집계는 메모리·event-loop/요청 지연·DB/WAL/여유 공간·작업 대기 등의 수치만 포함한다. sessionId·cursor 원문·실기기 개인정보·추출 원문은 기록하지 않는다. UI 진단은 로컬/시험 수집으로 한정하고 원격 수집 API를 추가하지 않는다.

```json
{"time":"2026-10-02T03:00:00.000Z","level":30,"service":"j-messenger","release":"example","module":"messages","event":"message.accepted","requestId":"r-123","serverId":"corp-a","messageId":"83","durationMs":8}
```

- 기록 금지: 비밀번호, cookie·Authorization·세션 원문/해시, 푸시 토큰, 메일 프로토콜 원문, 메시지 본문, 첨부 내용·원본 파일명, 전체 요청·응답 body, 전체 설정.
- 요청 URL 대신 route template만 기록한다. query·헤더를 기본 수집하지 않는다. logger는 허용 필드만 직렬화하고 민감 키 redact를 추가 방어로 둔다.
- 이메일·표시명 대신 내부 ID를 사용한다. 인증 실패의 IP·계정은 기본 로그에서 제외하고 필요 시 수명 제한 HMAC 식별자를 사용한다. raw Error의 message·cause에 자격 증명이 없는지 정제한 뒤 제한된 stack만 남긴다.
- `info`: 시작·종료·요청 완료·작업 요약. `warn`: 재시도·요청 제한·공간 부족. `error`: 최종 실패·불변식 위반. 운영 `debug`는 사건별 시간 제한을 두며 비밀값 금지 규칙을 유지한다.
- 재시도마다 같은 stack을 무제한 출력하지 않는다. 최초·최종 실패와 집계 수를 남기며 WebSocket heartbeat·건별 파일 chunk는 기록하지 않는다.

audit는 `actorId`, `serverId`, `action`, `targetType`, `targetId`, `outcome`, `requestId`, `occurredAt`, 허용된 변경 요약을 기록한다. 역할 변경·보존 정책 변경·삭제 배치·복원 실행을 남긴다. 설정 변경과 필수 audit 삽입은 같은 트랜잭션이며 audit 실패 시 해당 관리 변경도 실패한다. 같은 호스트 DB이므로 변조 불가능한 저장소라고 주장하지 않는다.

## 열람·장애 대응

앱 담당자는 `journalctl --user -u j-messenger --since ... --until ... -o cat`으로 제한된 구간을 본다. 운영체제 권한이 실제로 허용하는지 배포 시 확인한다. 인프라 관리자는 서비스 실행·저장소를, 메일 서버 관리자는 자기 서버의 감사 API만 열람한다. 사용자에게 raw journal 다운로드 기능을 제공하지 않는다.

readiness는 DB 접근·migration 상태·필수 경로 쓰기 가능성을 확인한다. 메일 서버 장애는 로그인 장애로 별도 집계하며 기존 채팅까지 무조건 내려가지 않게 한다. 측정값은 메모리·event loop 지연·요청 p95·DB/WAL 크기·디스크 여유·outbox 최장 대기·파일 삭제 실패·마지막 백업 성공이다. 초기에는 주기적인 집계 로그로 남기고 외부 관측 서버는 필요할 때 추가한다.

디스크 여유 20% 미만은 경고, 10% 미만 또는 1 GiB 미만이면 업로드·새 메시지 저장을 중단하고 503으로 명확히 알린다. 읽기·보존 정리·복구 작업은 가능한 범위에서 유지한다. 진단 logger 장애는 stderr와 운영 상태에 드러내되 이미 commit한 메시지를 실패로 바꾸지 않는다. 필수 감사 저장 실패와 업무 DB 저장 실패는 해당 쓰기를 실패 처리한다. 로그 폭주와 journal 유실도 운영 시험에 포함한다.

## 백업·복원·삭제

1. 매일 DB의 일관된 snapshot과 파일 manifest를 만든다. 1차 DB는 SQLite online backup API를 사용한다. WAL 운영 중 `.sqlite` 파일 하나만 복사하지 않는다([S05](08-official-references.md)).
2. 파일 도입 뒤에는 짧은 유지보수 구간에서 메시지·첨부 쓰기와 물리 삭제 worker를 멈추고, DB snapshot 및 참조 파일 묶음이 완성된 뒤 재개한다. 단순히 두 경로를 따로 복사해서 일관성을 가정하지 않는다.
3. 초기 보관은 일일본 최대 7개·로컬 합계 2 GiB다. 용량 초과 시 오래된 유효본부터 정리하되 마지막 정상본을 없애며 새 백업을 성공 처리하지 않는다. 파일 규모가 상한을 넘으면 별도 사설 저장소·용량 계획을 정한 뒤 기능을 확대한다.
4. 같은 VM의 백업은 VM·디스크 손실 대비가 아니다. 다른 장치의 사설 저장소에 암호화된 정상본을 확보하기 전까지 그 한계를 기록한다. 복호화 키는 백업과 분리하고 원문·로그·Git에 넣지 않는다.
5. 복원은 서비스 차단 → snapshot·파일 복원 → DB 무결성·참조 검사 → **현재 정책**으로 만료 삭제 → 모든 세션 폐기·cursor 초기화 → 기능 확인 → 접속 허용 순서다. 최신 보존 정책을 별도 운영 기록과 대조하여 오래된 백업 정책으로 되돌리지 않는다.
6. 보존 삭제는 서비스에서 즉시 접근 불가 처리하고 물리 파일은 재시도하여 삭제한다. 백업 잔존은 최대 백업 보관 기간까지 가능함을 관리자에게 명시한다. 더 엄격한 삭제가 필요하면 backup 보관도 함께 줄인다. 일반 파일 삭제를 디스크 완전 소거라고 표현하지 않는다.

초기 복구 목표는 RPO 24시간·RTO 1시간이며 보장 수치가 아니다. 배포 전 격리된 복원 시험의 데이터 크기·시간·누락을 남긴다. rollback은 앱 버전과 DB 호환성을 함께 판정하며 파괴적인 migration을 자동 역실행하지 않는다.
