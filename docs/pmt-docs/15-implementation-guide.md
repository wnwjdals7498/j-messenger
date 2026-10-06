# 구현 정리·시험 환경·모듈 통신

기준일: 2026-10-06. 코드 기준은 `9d13adfe74bb7bd9bf8e468801e4fec378b82760`이다. 이 문서는 현재 구현을 설명한다. 목표 설계는01~11, 실제 VM 실행 기록은[13](13-vm-deployment.md), Android 실행 기록은[14](14-android-web-app.md)를 따른다. 이 문서 작업에서는 VM을 재배포하지 않았다.

## 작업 내용과 현재 결과

| 영역 | 구현·확인한 내용 | 남은 범위 |
| --- | --- | --- |
| 공통·서버 | TypeBox 계약, 단일 Fastify 프로세스, SQLite migration/transaction/outbox, 세션·대화·메시지·파일·읽음·sync·보존·안전한 로그 | 실제 메일 인증·관리자 근거, 운영 부하·장기 회전·전체 복구 운용 |
| Web | React 공통 화면, HTTP 명령·조회, WS 사건, 같은 ID 재전송, snapshot/cursor 복구, 파일 선택·저장 | 실제 사용자 규모의 성능·다양한 브라우저/IME |
| VM | Rocky Linux lab의 Nginx443→Node3443, TLS 검증, systemd 자동 시작·persistent journal·재부팅 영속 확인 | Nginx 설치 이후 재부팅, 장기간 운용·재해 복구 |
| Windows | Tauri shell source와 공통 Web 번들·타입 검사 | Rust/MSVC native 컴파일·실행·OS 파일/자격 증명·종료 알림 |
| Android | Web assets 내장 APK, VM 직접 API/WSS, 앱별 CA, content URI 선택·SAF 저장·Back/IME/회전 | 실물·다른 버전·한글 IME별 조합·5MB 기기 왕복·종료 푸시·Store release |

이번 구현에서 PC 중계를 제거하고 VM이 Web/API/WSS를 받도록 바꿨다. 실환경에서 발견한 보존 집계 로그 누락, ready 뒤 history 중복 조회, 읽음 실패의 즉시 반복, Android의 IME Back과 가로 화면 잘림도 수정했다. Web과 Android는 업무 데이터를 VM에 저장하며 Android의 내장 화면은 APK 재빌드·재설치로 갱신한다.

코드 commit과 실행 배치를 구분한다. 분석 소스는9d13adf, VM의 기록된 활성 release는 `8924f05-20261006T014845Z`(로그 수정 포함), 시험 APK는 SHA-256 `0386e735411cfdcbce4a2c5b314131110da97900ef420b0da4995074ffdf5989`다. 새 코드 커밋만으로 기존 VM Web 번들이 자동 갱신되지는 않는다.

## 시험 환경 구축

### Windows 로컬 Web·서버

Node22.18 이상과 npm, 설치된 Edge 또는 Chrome이 필요하다. 실측 환경은 Node24.16.0/npm11.13.0이다. 저장소 루트에서 실행한다.

```powershell
npm ci
npm run build
$env:NODE_ENV='development'
$env:AUTH_MODE='development-fixed'
$env:HOST='127.0.0.1'
$env:PUBLIC_ORIGIN='http://127.0.0.1:3000'
node apps/server/dist/main.js
```

`http://127.0.0.1:3000/`에서 Web과 API가 같은 origin을 사용한다. 저장소 루트 cwd에서 시작해야 기본 `data/`·`apps/web/dist` 경로가 맞는다. 현재 `npm start`는 server workspace cwd에서 실행되므로 위 direct Node 명령을 사용하거나 설정의 절대 경로를 명시한다. `deploy/local.env.example`은 설정 예시이며 자동으로 읽지 않는다. 환경 변수를 실행 프로세스에 전달한다.3001은 사용하지 않는다.

| 개발 계정 | 의미 |
| --- | --- |
| dev-a / alice·bob·carol | 같은 서버의 대화·참여 권한 시험 |
| dev-b / mallory | 다른 서버의 격리 시험 |
| 개발 암호 dev-only | 공개 lab fixture. 실제 메일 인증 성공을 뜻하지 않음 |

검증은 별도 콘솔에서 수행한다. `test:e2e`는 자체 시험 서버·분리 브라우저를 사용하며 실제 업무 DB를 복구/초기화하는 명령이 아니다.

```powershell
npm run check
npm run format:check
npm run test:e2e
```

### 준비된 j-messenger-lab VM 재현

VM OS는 Rocky Linux10.2, 런타임은 Node22.23.2/npm10.9.8이다. `jmsg`는 앱·데이터·user service를 소유하며 sudo가 없다. `jjm`은 관리 작업용이다. 아래 배포 절차는 이미 준비한 계정·Node·SSH·사설망·firewall의 `jm-clients` 존을 전제로 한다. 새 VM 생성 이력은 `docs/env.md`/`docs/vm-runbook.md`에 있고 현재 상태와 대조해야 한다.

1. WSL Ubuntu에 `jm-vm`(jmsg)·`jm-vm-admin`(jjm) SSH alias와 host key를 준비한다. `BatchMode=yes`, `StrictHostKeyChecking=yes`를 유지해 지정 hostname을 확인한다.
2. Windows에서 `npm run build`, `./deploy/package-lab.ps1`을 실행한다. 출력의 release·archive·SHA-256을 한 배치의 입력으로 보관한다. archive에는 필요한 dist/manifest/lock만 들어간다.
3. archive를 jmsg의 `app/releases/<release>.tar.gz`, `deploy/install-lab.sh`을 실행 가능한 관리 경로에 전달한다. jmsg로 `bash install-lab.sh <release> <sha256>`을 실행한다. 스크립트가 checksum·계정·hostname을 검사하고 DB snapshot·env/unit 사본·release symlink·readiness를 처리한다. 기존 서비스의 TLS·cursor key·data 경로를 유지한다.
4. TLS가 없는 최초 lab은 WSL jjm의 `deploy/prepare-lab-tls.sh`로 CA/CSR 서명을 준비하고 jmsg의 `deploy/enable-lab-tls.sh`로 backend TLS를 적용한다. CA 개인키는 WSL에, leaf 개인키는 VM에 둔다. 현재 CA가 있으면 동일 CA를 재사용한다.
5. 관리 계정에서 공식 Rocky AppStream의 Nginx와 SELinux 관리 도구를 준비한다. `deploy/nginx-lab.conf`를 `/home/jjm/.local/share/j-messenger-lab/nginx-lab.conf`에 전달하고 root로 `deploy/configure-vm-web.sh`에 그 경로를 전달한다. jmsg로 `deploy/use-vm-web-origin.sh`을 실행한다.443만 사설 출발지에 허용하고 이전 외부3443 허용을 제거한다.
6. `deploy/configure-lab-journal.sh`에 관리 경로의 `journald-lab.conf`를 전달해 persistent journal 설정을 적용한다. 이 작업은 VM 전체 journald 설정에 영향을 주므로 기존 값의 snapshot을 먼저 유지한다.

현재 접속 경로는 **브라우저/Android → `https://10.77.0.10:443` Nginx → 같은 VM의 `https://127.0.0.1:3443` Node**다. Nginx도 upstream CA/hostname을 검증한다. Web/API/WSS Origin은 `https://10.77.0.10`이고 PC 프로그램이 요청을 대신 전달하지 않는다.

공개 CA를 `.tools/vm-deploy/tls/ca.crt`에 준비하고 fingerprint를[13의 승인 값](13-vm-deployment.md)과 대조한다. Windows 현재 사용자 Root 신뢰는 `deploy/trust-lab-ca.ps1`로 명시 승인한 CA에만 적용한다. 시스템 전체 저장소·개인키를 등록하거나 TLS 검증을 끄지 않는다. leaf 만료일은2026-11-05 UTC다. 재발급 시 Node·Nginx leaf copy를 함께 갱신하고 Nginx를 reload한다.

```powershell
wsl -d Ubuntu -- ssh -o BatchMode=yes -o StrictHostKeyChecking=yes jm-vm hostname
wsl -d Ubuntu -- ssh -o BatchMode=yes -o StrictHostKeyChecking=yes jm-vm 'systemctl --user is-active j-messenger'
node scripts/verify-vm.mjs --base-url https://10.77.0.10 --ca .tools/vm-deploy/tls/ca.crt --tag new-review-run
```

마지막 명령은 새 시험 대화·메시지·파일을 만든다. 매 실행에 새 tag를 사용하고 일반 보존 정책을 적용한다. 실제 메일 서버가 없으므로 VM도 `AUTH_MODE=development-fixed`인 lab이다. 서비스·release·데이터 경로는[13](13-vm-deployment.md)에 기록했다.

### Android Pixel_10

Android Studio의 JBR21, SDK platform36/BuildTools36.0.0/platform-tools/emulator, 지정 `Pixel_10` AVD와 VM까지의 사설망 경로가 필요하다. 실측 기기는 Android17/API37·x86_64·16KB page image, WebView149.0.7827.5였다. 프로젝트는 compile/target36·min24, Gradle9.3.1·AGP9.1.0·WebKit1.17.1·Activity1.13.0을 사용한다.

공개 CA 파일을 위 경로에 준비한다. Gradle이 X509 SHA-256을 검사해 debug resource에만 복사한다. release는 시스템 CA를 사용한다. 그 뒤 AVD를 부팅하고 실행한다.

```powershell
& "$env:LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe" devices -l
./scripts/build-android.ps1 -Test
```

스크립트는 공통 코드/Web을 빌드하고 APK/lint/시험 APK를 생성한다. AVD 이름과 `sys.boot_completed`를 확인한 뒤 fixture·APK를 설치하고 AndroidJUnit의 `OK` 결과까지 검사한다. debug APK는 `apps/android/app/build/outputs/apk/debug/app-debug.apk`다. Windows JDK IPC 문제를 피하기 위해 짧은 `D:/jmtmp`를 process TEMP/TMP/java.io.tmpdir로 쓰고 종료 시 환경 변수를 복구한다. 다른 경로는 `-ShortTemp`, serial은 `-Device`로 전달한다.

ADB가 멈춘 동일 AVD의 재현에는 `emulator -avd Pixel_10 -gpu software -no-snapshot-load -no-snapshot-save`를 사용했다. 사용자 data를 wipe하지 않았다. 시험은 native 선택/저장창을 조작하고 두 시나리오 사이65초를 두어 VM100/min 정책을 준수한다. 상세 조건·APK checksum·결과는[14](14-android-web-app.md)에 있다.

## 모듈별 책임과 통신

외부는 HTTP/WSS, 서버 내부는 bootstrap이 주입한 TypeScript 공개 인터페이스를 사용한다. 단일 Node 프로세스 안에서 모듈끼리 HTTP를 호출하지 않는다. framework·OS·DB는 adapter가 소유한다.

| 소유 모듈 | 입력의 의미 | 공개 동작·상대 | 출력·효과 |
| --- | --- | --- | --- |
| contracts | 요청/사건/오류·ID의 형식 | TypeBox schema, DTO, port, SafeLog 계약 | 프레임워크에 독립적인 런타임 검증·공통 타입 |
| client-react | 사용자 선택·입력·클라이언트 snapshot | client-core 명령/구독, MessengerFileBridge | 상태·오류·pending 표시, 파일/IME/읽음 가시성 |
| client-core | 세션·명령·HTTP 응답·WSS 사건 | fetch/socket/clock/ID port, `/api/v1` | 메모리 snapshot·재시도·세대 격리·cursor sync |
| Web adapter | 브라우저 origin·파일/알림 API | WebSocket factory, optional Android file bridge | 같은 origin의 cookie HTTP/WS, 일반 Blob 저장 |
| Android shell | APK assets·승인 origin·content URI | WebViewAssetLoader, WebMessage, SAF | 로컬 화면 제공, 엄격한 TLS/navigation, 선택/저장·수명주기 |
| bootstrap | 검증된 설정·공통 의존성 | 각 factory·port 주입·HTTP/WS 등록·worker | 단일 application 조립·종료 순서 |
| HTTP | wire 요청·자격 증명·Origin | contracts schema, identity resolver, domain route | RequestContext·정규 오류·응답·requestId |
| identity | 허용 서버·인증 입력·세션 credential | 인증/현재 사용자/디렉터리/세션 폐기 | userId/serverId·권한. 실제 mail adapter는 미연동 |
| conversations | RequestContext·참여자·목록 기준 | identity directory, `requireMember/recheckMember/canAccess` | 대화·참여 ACL·snapshot cursor·활동 시간 |
| messages | 참여 문맥·전송 ID·본문·fileId | conversations port, files.bind, database Tx | 메시지·dedup·파일 연결·outbox의 원자적 commit |
| files | 참여 문맥·metadata·byte stream | conversations ACL, filesystem, jobs | quota/형식/크기 검증, 객체·SHA·만료·인증 다운로드 |
| receipts | 참여 문맥·확인한 메시지 순서 | conversations ACL, messages.validateMessage | 단조 증가 읽음 위치·사건 |
| sync | 서명 cursor·현재 epoch·조회 상한 | database.eventReader, EventHydrator | 허용 사건·다음 cursor·고정 through·reset 오류 |
| realtime | 인증한 socket·마지막 위치 | identity.sessionActive, eventReader, hydrator | ready·poll·WSS·heartbeat·backpressure 종료 |
| retention / audit | 서버별 보존 정책·system 문맥 | messages purge, files, audit, jobs | 본문/파일의 독립 만료·감사. 관리자 정책 route는 비활성 |
| database / jobs | migration·Tx·사건 참조·작업 | SQLite WAL/BEGIN IMMEDIATE, lease runner | durability·rollback·commit 후 callback·멱등 작업 |
| logging | 허용한 사건명·code·집계·ID | contracts allowlist → Pino JSON → journal | 원문/자격 증명 없는 운영 사건 |
| operations | DB·파일·한도·정지한 서비스 상태 | resource sample / offline backup / restore helper | 함수 시험 통과. bootstrap의 완성된 운영 CLI·복구 절차는 미결합 |

배선의 기준은[application.ts](../../apps/server/src/bootstrap/application.ts)다. 상대 내부 파일을 import하거나 상대 소유 테이블을 직접 수정하는 방식으로 기능을 확장하지 않는다. 공통 Tx·eventReader는 platform 공개 기능이며 업무 모듈의 테이블 소유권을 대신하지 않는다.

## 기술적인 방식

- **저장·중복:** 메시지·dedup·첨부 연결·outbox를 같은 SQLite transaction에 쓴다. 같은 clientMessageId와 같은 내용/파일이면 기존 결과를 반환하고, 다른 요청이면 충돌이다. commit 전 사건을 보내지 않는다.
- **사건·복구:** outbox는 Kafka 같은 별도 서버가 아니라 SQLite에 저장한다. realtime이 commit된 사건을 peer별로 조회하고 hydrator가 현재 참여 권한과 데이터 상태를 확인해 보낸다. HMAC-SHA256 cursor는 사용자·서버·epoch·만료에 묶인다. ready 상한으로 sync를 고정하고 buffer/중복/만료 tombstone을 병합한다.
- **클라이언트 상태:** snapshot cursor를 보존해 ready 뒤 중복 history GET N+1개를 줄였다. 세대가 바뀐 응답은 적용하지 않고 logout이 timer·buffer·snapshot을 정리한다. 전송 pending은 메모리이므로 앱 종료를 넘는 영속 전송큐로 간주하지 않는다.
- **인증·격리:** 서버가 세션에서 realm/user를 결정한다. Web·Android WebView는 HttpOnly cookie, 별도 native API는 bearer를 사용한다. cookie/bearer 혼합과 잘못된 Origin을 거부한다. 다른 realm·비참여자에게 데이터를 노출하지 않는다.
- **파일:** metadata 크기를 그대로 신뢰하지 않고 실제 stream 길이·내용 형식·SHA를 확인한다. 임시 객체를 최종 경로로 옮기고 ready를 확정한 다음 messages가 fileId를 연결한다. Web은 Blob 링크, Android는 origin/main-frame 제한 bridge→private cache→SAF로 저장하며 자격 정보는 bridge에 전달하지 않는다.
- **보존·로그:** 메시지 본문5일, 파일14일, 개당5,000,000 bytes, lab 서버별2GB다. 파일은 메시지 본문 만료와 독립이다. 로그·감사·업무 DB는 별도 소유다. journal은 최대14일·256MiB·최소 여유1GiB 정책으로 운영하며 용량에 따라14일보다 먼저 회전할 수 있다.

실제 코드 흐름과 소스 위치는[Archify 워크플로우](16-code-workflows.md)에서 탐색한다.

## 테스트 및 결론

아래는 기록된 실행 결과다. 이번 문서화에서 새 VM 배포·재부팅·Android 시험을 반복하지 않았다.

| 검증 | 실제 결과 | 결론·한계 |
| --- | --- | --- |
| npm run check | 계약10·client13·React13·서버88·Web bridge4, 합계128 통과. 타입·lint·경계 검사 포함 | 계약·도메인·조립·클라이언트 회귀 확인 |
| 형식·빌드 | format:check, Web/서버/공통 번들·Android APK·서명 통과 | Windows native 실행 파일·Store release는 별도 |
| Edge 관통 | 두 세션·IME Enter·정확히5MB byte 일치·새로고침,1 시나리오 통과 | 기록된 Edge 결과. 다중 브라우저 평가 아님 |
| VM | HTTPS/WSS16개·실제 브라우저, 실제 Node service 재부팅 영속1개 통과 | lab 직접 접속·TLS·권한·파일·서비스 유지 확인 |
| Android | Pixel_10 실제2개,127.238초·TXT32-byte 전체 왕복·IME/회전/Back/복구 통과 | 지정 가상기기·ASCII 입력 기준. Android5MB/한글 IME별 조합은 미시험 |
| 로그 | 마지막 VM journal910건의 금지 field·시험 원문/비밀번호·drop0, Android app crash0 | 관측 구간의 내용 검증. 장기 폭주/회전 보장은 아님 |
| 백업·운영 | 임시 DB/파일의 helper 시험, VM 배포 전 SQLite snapshot integrity=ok | 실제 파일 manifest를 포함한 재해 복구 운용은 미완료 |

현재 Web·VM·Android의 핵심 대화/파일 경로는 lab에서 확인했다. 운영 전환 판단에는 실제 메일·관리자 검증, Windows native, 실물/다른 Android, 종료 알림, 규모별 부하와 전체 복구가 더 필요하다. 전체 재구축은 진행 중이다. 기존 사용자 `web/test/login.test.ts`는 작업 전후 hash가 같고 이번 커밋에 포함하지 않는다.
