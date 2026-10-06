# VM 설정 선택과 구축 방법

기준일: 2026-10-06. 전용 Rocky Linux10 메신저 VM을 준비하는 방법이다. VM 이름·IP·HTTP/HTTPS·포트·redirect를 하나의 프로필에서 선택한다. 현재 실행 중인 `j-messenger-lab`의 기록은[13](13-vm-deployment.md)이며, 이 문서의 새 도구를 개발하면서 실제 VM 설정을 변경하지 않았다.

## 1. 선택할 값과 동작

저장소 루트에서 실행한다. 대화형 터미널에서 각 항목의 기본값을 그대로 쓰거나 새 값을 입력할 수 있다.

```powershell
npm run setup:vm
```

| 설정 | 의미·선택 |
| --- | --- |
| vmName | Windows Hyper-V 표시 이름. 다른 VM을 생성할 때 새 이름 선택 |
| hostname | Linux hostname과 backend TLS의 DNS SAN 이름 |
| vmIp | 게스트에 실제 할당할 사설 IPv4. 공개 접속 URL에도 사용 |
| networkPrefix / gateway / dns | WinNAT 서브넷·Windows host gateway·게스트 DNS |
| switchName / natName | Internal Switch와 기존/신규 NAT 이름 |
| interfaceName | 게스트 NIC. 실제 `ip -brief link` 결과로 선택 |
| protocol / publicPort | 외부 HTTP 또는 HTTPS와 공개 포트 |
| backendProtocol / backendPort | 같은 VM loopback의 Node HTTP 또는 HTTPS·포트 |
| redirectHttp / httpPort | HTTPS 선택 시 별도 HTTP 포트의308 redirect 사용 여부 |
| appUser | sudo 없는 앱 계정. 기본jmsg, home은 `/home/<appUser>` |
| sshAppAlias / sshAdminAlias | WSL의 앱/관리자 SSH alias |
| allowedSources / firewallZone | 접속 허용 사설 CIDR 목록과 전용 firewalld zone |

일반적인 선택은 외부HTTPS443→내부HTTPS3443이다. 외부HTTPS→내부HTTP loopback도 가능하다. HTTP 시험은 외부HTTP→내부HTTP로 선택할 수 있으며 WS를 사용한다. HTTP는 통신을 암호화하지 않고 cookie의 Secure flag도 끈다. 현재 도구는 메일 서버 없는 **development-fixed lab**용이며 운영 메일 인증 설정기가 아니다.

기존env가 production 또는 mail 인증이면 적용 전에 거부한다. 운영 인증을 개발 계정으로 자동 전환하지 않는다.

이름/주소에 shell 문법을 넣거나 사설망 밖 주소·network/broadcast·다른 서브넷 gateway·겹치는 포트·3001을 지정하면 생성 전에 거부한다. 외부 hostname 대신IP로 접속하는 구성이며 DNS 공개 도메인 hosting은 추가 설계 범위다.

반복 실행은[JSON 예시](../../deploy/vm-profile.example.json)를 복사해 선택값을 저장한다.

```powershell
node scripts/setup-vm.mjs --config deploy/vm-profile.example.json --output .tools/vm-setup/my-plan
```

`--output`은 새 폴더여야 한다. 생성된 `profile.json`·`profile.env`·`plan.json`·`nginx.conf`·`create-vm.ps1`과 게스트 스크립트를 확인한다. **이 명령은 계획 파일만 생성한다.** Hyper-V 생성, 네트워크·서비스 적용, 인증서 신뢰 등록은 아래의 별도 명령이다. 프로필을 수정했다면 새 bundle을 만들고 다시 검토한다.

## 2. Hyper-V와 OS 준비

Windows Hyper-V, 관리자 PowerShell, 공식 Rocky Linux10 Minimal ISO, Node22.18 이상과 npm이 필요하다. WinNAT는 Internal Switch/gateway/prefix를 준비하지만 게스트IP를 자동 할당하지 않으므로 OS 설치에서 수동 설정한다. [Microsoft 공식 NAT 구축](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/setup-nat-network)

생성된 bundle의 `create-vm.ps1`을 관리자 PowerShell에서 실행한다.

```powershell
& .tools/vm-setup/my-plan/create-vm.ps1 -IsoPath D:/ISO/Rocky-10.2-x86_64-minimal.iso
```

선택한 VM 이름·IP·gateway·prefix·switch/NAT가 `New-MessengerVm.ps1`에 전달된다. 기본 디스크 폴더는 VM 이름별로 분리되고 다른 VM에는 이름에서 계산한 별도 MAC을 사용한다. 기존 VM/디스크 덮어쓰기를 거부하고 이미 사용 중인 MAC도 검사한다. 기존 lab의 기본 MAC은 호환성을 유지한다.

WinNAT의 다른 prefix를 가진 NAT가 이미 있으면 새 NAT를 만들지 않는다. 기존 NAT의 이름과 prefix를 재사용하거나 별도로 네트워크 전환 계획을 잡는다. 기존 NAT를 자동 삭제하지 않는다. 같은10.77.0.0/24에 두번째 VM을 만든다면 새 이름과 사용하지 않은10.77.0.x를 선택한다.

VM을 시작하고 OS 설치 화면에서 선택한 hostname·IPv4/prefix·gateway·DNS와 관리자 계정을 지정한다. 설치 후 게스트를 종료한 다음 같은 이름/switch/NAT/network 값으로 Finalize/Route를 수행한다. 예시는 현재 lab 기본값이며 새 프로필은 선택한 값으로 바꾼다.

```powershell
./scripts/New-MessengerVm.ps1 -Phase Finalize -VmName j-messenger-lab
Start-VM -Name j-messenger-lab
./scripts/New-MessengerVm.ps1 -Phase Route -VmName j-messenger-lab -Persist
```

Route는 WSL/VM host adapter의 IPv4 forwarding을 설정한다. `-Persist`는 VM 이름별 SYSTEM scheduled task를 등록한다. 관리 권한이 필요한 호스트 변경이며 사용자 선택 없이 이 단계가 실행되지 않는다.

## 3. 관리자 SSH와 게스트 준비

WSL Ubuntu에 OpenSSH·Node22.18 이상·OpenSSL을 준비한다. 앱용SSH key pair는 WSL에서 만들고 **공개키만** 관리자 연결로 게스트에 전달한다. private key는 WSL에 보관한다. OS 설치에서 지정한 관리자 계정으로 먼저 연결 가능해야 한다.

게스트 콘솔에서 host key fingerprint를 확인하고 첫 SSH 연결의 fingerprint와 대조해 known_hosts에 등록한다. 이후 `BatchMode=yes`, `StrictHostKeyChecking=yes`를 유지한다. key 확인 실패를 우회하거나 검증을 끄지 않는다. WSL `~/.ssh/config`에 선택한 두 alias를 등록한다.

```text
Host jm-vm-admin
  HostName <선택한 VM IP>
  User <OS 설치의 관리자 계정>
  IdentityFile <WSL의 관리자 private key>
  StrictHostKeyChecking yes

Host jm-vm
  HostName <같은 VM IP>
  User <선택한 appUser>
  IdentityFile <WSL의 앱 private key>
  StrictHostKeyChecking yes
```

아래부터 WSL shell을 사용한다. Windows bundle은 `/mnt/<drive>/...` 경로로 접근한다. 해당 파일들과 앱 공개키를 관리자 home의 작업 폴더로 복사한다. VM의 OS 설치 IP가 이미 프로필IP와 같아야 한다.

```bash
bundle=/mnt/d/workspace/test-space/github/j-messenger/.tools/vm-setup/my-plan
source "$bundle/vm-profile.sh"
load_vm_profile "$bundle/profile.json"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$JM_SSH_ADMIN" 'mkdir -p ~/.local/share/j-messenger-vm-setup'
scp -r "$bundle" "$JM_SSH_ADMIN:.local/share/j-messenger-vm-setup/"
scp ~/.ssh/id_ed25519_jm.pub "$JM_SSH_ADMIN:.local/share/j-messenger-vm-setup/app.pub"
```

VM의 관리자 콘솔에서 공식 Rocky 저장소의 Node를 먼저 설치한다.

```bash
sudo dnf install -y nodejs
node --version
sudo bash ~/.local/share/j-messenger-vm-setup/my-plan/prepare-vm-guest.sh \
  ~/.local/share/j-messenger-vm-setup/my-plan/profile.json \
  ~/.local/share/j-messenger-vm-setup/app.pub
```

게스트 준비 스크립트는 root·Node 버전·NIC·선택IP를 확인한다. nginx/openssl/tar/SELinux 도구를 설치하고 sudo 없는 앱 계정·private app/data/config 디렉터리·user service linger를 준비한다. 관리자 그룹의 기존 계정을 앱 계정으로 재사용하지 않는다. 공개키가 주어지면 앱의 authorized_keys에 추가하고700/600 권한을 설정한다. SSH daemon의 기존 관리자 로그인 정책은 바꾸지 않는다.

선택한 NetworkManager static profile은 다음 boot에서 활성화되도록 준비하며 현재 SSH 연결을 끊는 `nmcli connection up/down`을 자동 실행하지 않는다. 재부팅 후 `hostname`, `ip -4 address`, route와 두 alias를 확인한다.

## 4. HTTPS 인증서 준비

HTTP→HTTP만 선택했다면 이 단계는 필요 없다. 외부 또는 backend HTTPS가 있으면 IP SAN과 hostname DNS SAN을 가진 leaf와 CA를 준비한다. 새 개발 CA를 만들거나 **기존 CA directory를 명시해서 재사용**할 수 있다.

WSL에서 실행한다.

```bash
bash "$bundle/prepare-vm-tls.sh" "$bundle/profile.json" "$bundle/public-tls"
# 기존 lab CA를 재사용할 때의 예시
bash "$bundle/prepare-vm-tls.sh" "$bundle/profile.json" "$bundle/public-tls" \
  /home/jjm/.local/share/j-messenger-lab/tls
```

대상 hostname/IP를 strict SSH로 확인한다. leaf private key는 VM의 앱 계정이 생성하고 CSR만 WSL로 가져와 서명한다. CA private key는 WSL의 private directory0600에 남는다. 공개CA와 leaf만 VM으로 전달한다. IP와 hostname 양쪽을 검증한다. 기본leaf는30일, CA는365일이므로 운영자가 만료 전에 갱신한다.

Windows에는 `public-tls/ca.cer`와 신뢰할 경로에서 확인한 SHA-256을 사용한다. 먼저 `-WhatIf`로 대상을 확인하고 등록한다.

```powershell
./deploy/trust-vm-ca.ps1 -CertificateFile .tools/vm-setup/my-plan/public-tls/ca.cer -ExpectedSha256 <확인한64자리fingerprint> -WhatIf
./deploy/trust-vm-ca.ps1 -CertificateFile .tools/vm-setup/my-plan/public-tls/ca.cer -ExpectedSha256 <동일fingerprint>
```

공개CA·fingerprint·CA basic constraints·유효기간을 검사하고 **현재 사용자 Root**에만 등록한다. 시스템 전체 저장소나 private key를 등록하지 않는다. 이 단계는 Windows/브라우저의 신뢰 설정이며 Android 전체 OS trust를 바꾸는 명령이 아니다. [OpenSSL 공식 req](https://docs.openssl.org/3.0/man1/openssl-req/), [verify](https://docs.openssl.org/3.0/man1/openssl-verify/)

## 5. 앱 배포와 웹 설정 적용

Windows에서 bundle을 새 코드로 만든 뒤 배포 archive를 생성한다.

```powershell
npm ci
npm run build
./deploy/package-lab.ps1
```

출력의 release·archive·SHA-256을 보관한다. 프로필을 사용하는 installer용 `vm-profile.mjs/sh`도 archive에 포함된다. archive를 앱 계정의 `~/app/releases/<release>.tar.gz`에 전달하고, 프로필을 앱 계정이 읽을 수 있는 별도 작업 폴더에 전달한다. 해당 폴더에는 profile·installer·profile helper만 필요하며 관리자 home을 앱에 공개하지 않는다.

앱 계정으로 실행한다.

```bash
bash ~/vm-setup/install-lab.sh <release> <archive-sha256> ~/vm-setup/profile.json
```

세번째 인자가 없으면 이전lab 호환 경로, 있으면 선택한 hostname·appUser·home을 검사한다. profile mode는 기존 DB/file/backup 경로·cursor key·세션 관련 설정을 보존하고 release·Web dist·선택한 network/TLS 설정을 반영한다. 데이터는 release 폴더에 넣지 않는다. 서비스 정지 후 실제 기존 DB 경로를 snapshot하고 새 release symlink와 user unit을 적용한다. Node는127.0.0.1에만 listen하고 자체 backend readiness를 확인하므로 Nginx가 아직 없어도 첫 설치가 가능하다. TLS 없이HTTP를 선택했으면 이전Node TLS 경로를 제거한다.

그다음 VM 관리자 콘솔에서 웹 설정을 적용한다.

```bash
sudo bash ~/.local/share/j-messenger-vm-setup/my-plan/apply-vm-web.sh \
  ~/.local/share/j-messenger-vm-setup/my-plan/profile.json
```

적용 전 hostname/IP·app home·설치된release/unit·필수도구·TLS pair/IP/DNS를 확인한다. 전용 메신저 VM의 `/etc/nginx/nginx.conf`를 전체 관리하는 방식이다. 다른사이트를 함께 운영하는 Nginx에 그대로 적용하지 않는다. 기존설정·app env·nginx상태·firewall/SELinux값을 `/root/j-messenger-vm-backups/`의700 snapshot에 보관한다.

Nginx 후보를 `nginx -t`로 확인하고 설정·app env를 적용해 앱/Nginx를 재시작한다. WSS Upgrade와 Origin을 유지하고 TLS backend라면 CA/hostname 검증을 켠다. raw request/error 로그는 사용하지 않고 backend metadata logger를 유지한다. [Nginx 공식 WebSocket proxy](https://nginx.org/en/docs/http/websocket.html), [upstream TLS 검증](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_ssl_verify)

firewall은 선택zone에 사설 source·SSH·공개포트·선택redirect포트를 추가한다. 선택backend 포트는 그zone에서 외부 허용을 제거한다. 기존zone의 다른 source/port는 자동 삭제하지 않으므로 허용 범위를 줄이거나 이전공개포트를 정리할 때 snapshot과 함께 별도 검토한다. SELinux는 Enforcing을 유지하고 HTTP-labelled port/relay만 설정하며 다른유형의 포트를 자동 relabel하지 않는다. [firewalld 공식 CLI](https://firewalld.org/documentation/man-pages/firewall-cmd.html)

readiness가 실패하면 변경한 app env·nginx.conf와 nginx의 이전 활성/enable 상태 복구를 시도한다. firewall/SELinux/인증서 복사·패키지·네트워크 준비는 하나의 원자적 transaction이 아니며 전체 자동 rollback으로 보고하지 않는다. snapshot 경로를 따라 확인한다. 실제 DB를 지우거나 새 cursor key로 무조건 교체하지 않는다.

## 6. 접속·검증·클라이언트 연결

생성된 plan의 `origin`으로 접속한다. 현재lab의 실측 예는 `https://10.77.0.10/`, Nginx443→VM내부TLS3443이다. 다른 프로필이면 주소·port도 달라진다.

```bash
systemctl --user is-active j-messenger       # 앱 계정
journalctl --user -u j-messenger --since '10 minutes ago'   # 비밀값 없는 metadata 확인
sudo nginx -t                              # 관리자
sudo systemctl is-active nginx
```

Windows 저장소 루트에서 선택한origin·공개CA·새tag로 실제 기능을 검사할 수 있다.

```powershell
node scripts/verify-vm.mjs --base-url https://10.77.0.10 --ca .tools/vm-setup/my-plan/public-tls/ca.crt --tag fresh-profile-run
# HTTP 시험 프로필은 해당 http URL을 쓰고 --ca를 생략
```

이 검사는 실제시험 대화·메시지·파일을 만든다. service boot·DB/파일 영속·journal과 TLS/권한/WSS를 나눠 확인한다.14일 journal policy 설치 이력은[13](13-vm-deployment.md)을 따르며 이번 설정도구가 VM 전체journal policy를 자동 변경하지는 않는다.

Web은 선택한origin에서호스팅되므로 같은 API/WSS를 사용한다. **현재 Android lab APK는10.77.0.10 HTTPS origin과 승인CA를 고정**했다. IP/port/CA 변경 또는HTTP 선택이 기존APK에 자동 전달되지 않는다. Android shell과 trust resource를 새 목적지에 맞춰 별도로 재빌드·검증해야 한다. Windows native도 아직실행미검증이다.

## 코드·검증 범위

| 코드 | 책임 |
| --- | --- |
| [setup-vm.mjs](../../scripts/setup-vm.mjs) | 대화형/JSON 선택, 검증된새bundle·계획 생성 |
| [vm-profile.mjs](../../deploy/vm-profile.mjs) | 프로필검증·origin/env/Nginx 생성·기존env 보존patch |
| [New-MessengerVm.ps1](../../scripts/New-MessengerVm.ps1) | 선택한이름/IP/NAT의 Hyper-V 생성·Finalize·Route |
| [prepare-vm-guest.sh](../../deploy/prepare-vm-guest.sh) | 계정·공개키·패키지·선택network profile |
| [prepare-vm-tls.sh](../../deploy/prepare-vm-tls.sh), [trust-vm-ca.ps1](../../deploy/trust-vm-ca.ps1) | CA 분리·SAN검증·지정공개CA의현재사용자신뢰 |
| [install-lab.sh](../../deploy/install-lab.sh), [apply-vm-web.sh](../../deploy/apply-vm-web.sh) | profile-aware release·웹 설정·snapshot/readiness |
| [vm-profile.test.mjs](../../tests/deploy/vm-profile.test.mjs) | 설정·주입/네트워크/포트 거부·실제CLI/env patch·bundle 보존 회귀 |

`npm run test:deploy`, PowerShell parse, Bash syntax, JSON/example CLI와 문서링크를 검증한다. 이번코드 작업은 현재VM 생성/재설정·신규프로필의 실제Nginx/SELinux/firewall/인증서/재부팅 통합 시험을 수행한 것으로 보고하지 않는다. 기존lab의실환경결과와새도구의코드시험을구분한다.

코드 검증 결과: 설정/환경보존/실제CLI11개 통과, `npm run check`의 기존128개와 합계139개·타입/lint/경계 통과. Bash5파일·PowerShell3파일·생성된create-vm.ps1 구문과 문서5개의87개 상대링크를 확인했다. production/mail 환경 거부·기존bundle/임시파일 claimant 보존·새이름/IP/포트의 일관성도 시험했다. 유효한프로필을 생성한 것이 실제Hyper-V나게스트운용 성공을 의미하지는 않는다.
