# j-messenger-lab 배포·실환경 검증

기준일: 2026-10-06. 기존 VM에 실제 배포했다. **현재 브라우저 직접 접속 주소는 `https://10.77.0.10/`**다. PC 임시 중계는 종료했으며 Nginx 진입점과 Node 앱 서버는 모두 VM에서 실행한다. 메일 서버가 없어 개발 계정 기반 lab이고 운영 메일 인증 성공을 의미하지 않는다. 이 VM 배포 기록은 Windows native 실행 검증을 포함하지 않는다. 이후 사용자가 추가한 Android APK 시험은 [Android 실행 기록](14-android-web-app.md)을 따른다.

## VM 단독 웹 진입점

현재 경로는 브라우저 → VM Nginx `10.77.0.10:443` → 같은 VM Node `127.0.0.1:3443`이다. 웹 파일·API·WSS는 같은 origin을 사용하고 Origin 헤더를 바꾸지 않는다. 기존 사용자 데이터·세션·cursor key를 유지했다. 외부3443 방화벽 허용은 제거했으며443은 기존 private jm-clients 출발지에만 허용한다.

Nginx1.26.3을 Rocky10의 공식 AppStream에서 설치했다. 내부 upstream도 CA와 hostname `j-messenger-lab`을 검증한다. body·응답은 스트리밍하고 Raw URI/query/자격 정보가 남을 수 있는 Nginx 기본 로그는 사용하지 않는다. 요청 사건은 backend의 metadata JSON logger가 소유한다. SELinux는 Enforcing이며 broad network_connect는 off, HTTP-labelled port로 relay하는 정책만 on이다.

PC 중계 PID15828과 이전 PC 미리보기 PID2868을 종료하고 중계 source를 삭제했다. PC 중계가 없는 상태에서 새 주소의 실제 Web/API/WSS16개 검사가 통과했다. 사용자 승인과 Windows 자체 확인 후 공개 CA를 현재 사용자 Root에 등록했다. LocalMachine 저장소·개인키는 변경하지 않았다. Windows 기본 인증서 검증으로 HTTPS 페이지가 정상 응답했고 실제 Codex 브라우저에서도 인증서 경고 없이 VM에 직접 접속했다.

실제 브라우저에서 dev-a/Alice 로그인, VM 대화·첨부 조회, 메시지 전송, 별도 Bob 시험 세션의 메시지 실시간 수신, 새로고침 후 로그인·메시지 복구를 확인했다. 증거 화면은 Git 제외 `data/vm-direct-browser.jpg`이다. 기존 61487의 자동화 차단은 우회하지 않았으며 사용자가 요청한 VM 단독 HTTPS주소에서 새 구성을 검증했다.

현재 사용자 신뢰 등록은 `deploy/trust-lab-ca.ps1`, 승인한 CA만 제거하는 절차는 `deploy/untrust-lab-ca.ps1`이다. 공개 CA SHA-256과 thumbprint를 확인하고 다른 인증서는 다루지 않는다. 서버 인증서를 갱신하면 VM Nginx의 leaf copy도 갱신·reload해야 한다.

## 최초 VM 배포 기록

| 항목 | 실제 값·확인 |
| --- | --- |
| VM·접속 | `j-messenger-lab`, `10.77.0.10`, WSL의 기존 `jm-vm`/`jm-vm-admin` 키 인증. strict host verification 유지 |
| OS·런타임 | Rocky Linux 10.2, Node 22.23.2, npm 10.9.8, systemd 257, SELinux Enforcing |
| 계정·서비스 | sudo 없는 `jmsg`, `j-messenger.service` user unit, enabled·active, linger=yes |
| release | `8924f05-20261006T014845Z`, 기본 커밋 `8924f05`에 실로그 누락 수정 포함. `release.json`의 `runtimeSourceModified=true`로 미커밋 수정을 명시 |
| HTTPS·WSS | `https://10.77.0.10:3443`, IP SAN과 명시적 lab CA 신뢰로 인증서 검증. 검증 비활성화 없음 |
| 데이터 | `/home/jmsg/data/j-messenger.sqlite`, `files/`, `tmp/`, `backups/`. release 교체·재부팅 뒤 유지 |
| 디스크·한도 | 배포 직후 루트 여유 약14.6GB, 첨부는 서버별 2,000,000,000 bytes·개당 5,000,000 bytes |
| 방화벽 | 기존 `jm-clients` 출발지 `10.77.0.0/24`, `172.16.0.0/12`에만 3443/tcp를 runtime·permanent 추가. public 존과 기존 차단 정책 유지 |

최초 배포 때 PC의 `http://127.0.0.1:3000/`와 loopback bridge `http://127.0.0.1:61487/`를 잠시 사용했다. bridge가 VM HTTPS/WSS를 CA·호스트 검증으로 전달했고 Windows 인증서 신뢰 저장소는 변경하지 않았다. 현재는 두 PC 미리보기 프로세스를 종료했으며 위 표의 외부3443 접속은 현재 진입점이 아니다.

61487의 브라우저 자동 검증은 사용자 재허용 뒤에도 저장된 차단 설정으로 거절됐다. 차단을 우회하지 않았으며 이 주소/스크립트는 현재 사용하지 않는다. 이후 사용자가 명시적으로 PC 중계 역할을 VM으로 옮기도록 요청해 VM 단독 진입점을 별도 구성했다. 이는 현재 HTTPS 직접 접속 작업의 근거이며 과거 GUI 성공으로 보고하지 않는다.

## 배치·보존

`deploy/package-lab.ps1`은 package/lock, 필요한 workspace manifest, 검증된 dist만 묶는다. 사용자 데이터·환경 파일·키·node_modules는 넣지 않는다. `deploy/install-lab.sh`는 대상 이름·계정·archive checksum을 검사하고 release마다 새 폴더에 추출·설치한다. VM에서는 `npm ci --omit=dev --ignore-scripts`를 사용했다. `app/current` symlink로 활성화하며 기존 TLS·cursor key·data 경로를 유지한다.

기존 unit/env는 `.config/j-messenger/deploy-snapshots/<release>/`에 보존했다. 수정 release 전 서비스를 정지하고 SQLite backup API로 `pre-upgrade.sqlite`를 만들었다. integrity=ok·외래키 오류=0을 확인했다. **파일 manifest를 결합한 전체 백업이나 재해 복원 성공은 아니다.** 이전 release도 보존했으며 실제 rollback·전체 백업/복원 운용은 후속 범위다.

최종 archive SHA-256: `7aaa48253be667eb37794cf6c407c6dba0a6228dfc4eee0f2d29628e6e715d4a`.

## TLS·로그

CA 개인키는 WSL `jjm`의 Linux 홈 아래 0600으로 보관하고 VM·Git·Windows 신뢰 저장소로 복사하지 않았다. VM leaf 개인키와 server.env도 0600이다. 공개 CA는 도구의 명시적 신뢰 입력으로만 쓴다. leaf 인증서는 **2026-11-05 UTC 만료**이므로 그 전에 재발급해야 한다.

CA SHA-256 fingerprint: `DA:1D:DD:9C:B6:B2:B3:C0:5A:3A:C9:77:1D:45:74:8B:7E:A8:88:AF:10:D8:50:A0:1C:BD:11:89:6B:8B:31:E0`.

관리자 계정으로 VM 전체 journald에 persistent·UID 분리·256MiB 상한·최소 여유1GiB·최대14일·압축을 적용했다. jmsg는 자기 서비스 로그를 읽는다. 다른 서비스 로그를 vacuum하거나 수동 삭제하지 않았다. 14일 전체 보관을 보장하지 않으며 장기간 회전·폭주/공간 부족 시험은 미수행이다.

실환경에서 보존 worker의 `messageCount`·`fileCount`가 logger allowlist에 없어 사건이 누락됐다. 두 집계 필드를 허용하고 모든 bootstrap 시나리오의 로그 누락 회귀 검사를 추가했다. 수정 후 로컬 시험 **123개**·타입/lint/build가 통과했고 VM에서도 집계 사건·누락=0을 확인했다.

## 실제 검증

- 초기 HTTP/WS **13개**, 최종 HTTPS/WSS **16개** 통과. 두 세션·개인/단체 대화·중복 메시지1건·다른 서버/비참여자404·읽음 최대값·signed cursor·실시간 commit 사건·Origin·native bearer 분리를 확인했다.
- 작은 TXT와 정확히 5MB의 업로드→메시지 연결→다른 사용자 다운로드에서 전체 byte 일치를 확인했다. 5,000,001 bytes는413, 허용하지 않은 형식은400이었다.
- 기본 신뢰·다른 CA·잘못된 호스트 이름에서 TLS가 거절됐다. 잘못된 이름도 같은 VM IP에 고정했으며 다른 외부 사이트를 호출하지 않았다.
- 실제 VM 재부팅으로 boot ID가 `6eada147-9d86-4a27-aa76-b1e77250a111`에서 `f96fe808-f107-4479-9498-b86ef12344d7`로 바뀌었다. 앱 자동 시작과 기존 메시지·5MB 첨부의 전체 byte 유지 시험 **1개**가 통과했다.
- 이전·이후 `service.ready`와 보존 집계 사건이 journal에 남았다. 수정 release의173개 JSON 사건에서 금지 필드·시험 비밀번호/본문/원본 파일명 노출이 없었다. 현재 boot의37개 JSON 사건에서 누락=0을 별도로 확인했다. 이후 요청으로 건수는 증가한다.
- Hyper-V 관리 조회 권한 거절은 남지만 SSH·서비스·네트워크·재부팅 검증에는 영향이 없었다. Windows 호스트의 VM 자동 시작 설정은 이번에 확인/변경하지 않았다.

재검증은 `scripts/verify-vm.mjs`에 실제 origin·공개 CA 파일·새 run tag를 전달한다. JSON 출력에는 결과·건수만 포함하고 session/cookie/token/body/파일명은 넣지 않는다. 재부팅 확인 fixture ID는 메모리 또는 Git 제외 `.tools`에만 보존한다.
