# 개발·실행 환경 정의

마지막 실측: 2026-09-23 (Claude). 값이 바뀌면 이 문서와 `.ctx/STATE.md` notes를 함께 고친다.

## 구성도

```text
Windows 11 호스트 (192.168.0.66, 회사 LAN · 인터넷)
│
├─ vEthernet (WSL (Hyper-V firewall))  172.20.208.1/20  ← WSL NAT, 재부팅마다 대역이 바뀔 수 있음
│    └─ WSL Ubuntu 22.04  eth0 172.20.x.x  (OpenCode, Node 22, 개발 서버)
│
└─ vEthernet (JMessengerInternal)       10.77.0.1/24     ← 호스트 전용 스위치 + NAT(JMessengerNat)
     └─ VM j-messenger-lab  eth0 10.77.0.10/24  gw 10.77.0.1  DNS 8.8.8.8, 1.1.1.1
```

- WSL → VM: WSL 기본 경로(172.20.208.1)로 호스트에 간 뒤, 호스트가 두 vEthernet 사이를 **IPv4 forwarding**으로 넘긴다. NAT를 거치지 않아서 VM은 WSL의 실제 주소(172.20.x.x)를 출발지로 본다.
- forwarding은 WSL이나 Windows를 재시작하면 꺼진다. 예약 작업 `j-messenger WSL-VM forwarding`(SYSTEM, 부팅 시 + 1분마다)이 다시 켠다. 수동 복구: 관리자 PowerShell에서 `.\scripts\New-MessengerVm.ps1 -Phase Route`.
- VM → 인터넷: 호스트 NAT `JMessengerNat`(10.77.0.0/24) 경유. dnf·npm이 동작한다.
- VM은 회사 LAN에 직접 연결되지 않는다. IP 충돌이 없고 회사망 정책의 영향을 받지 않는다.

## 호스트 (Windows)

| 항목 | 값 |
| --- | --- |
| OS | Windows 11 Pro 10.0.26200, Hyper-V 활성 |
| CPU / RAM | Ryzen 7 5700U (x86_64-v3 충족) / 13.8 GB. 여유 메모리가 적어 VM 설치 때 2 GiB 할당이 실패한 적 있음 |
| 저장소 | `D:\workspace\test-space\github\j-messenger` |
| VM 파일 | `C:\Users\Public\Documents\Hyper-V\j-messenger-lab\` |
| 설치 ISO | `D:\ISO\Rocky-10.2-x86_64-minimal.iso` (SHA256 `aac6ac3c…f6c8`, 공식 CHECKSUM 일치) |
| 브라우저 → WSL 개발 서버 | `http://localhost:5173` (WSL localhost 전달, 실측 성공) |
| 브라우저 → VM | `http://10.77.0.10:3000` (호스트 10.77.0.1은 VM 방화벽 허용 대역) |

## WSL (개발·OpenCode 실행)

| 항목 | 값 |
| --- | --- |
| 배포판 / 사용자 | Ubuntu 22.04.5, `jjm`, systemd 사용, WSL 2.3.26, NAT 모드(.wslconfig 없음) |
| 저장소 경로 | `/mnt/d/workspace/test-space/github/j-messenger` |
| Node / npm | v22.22.2 / 10.9.7 (`/usr/bin/node`). TypeScript는 Node의 타입 제거로 바로 실행 |
| Python | `python3` 3.10.12. **`python`은 Windows pyenv shim이므로 쓰지 않는다** |
| OpenCode | v2.0.14 (`~/.opencode/bin/opencode`), 모델 게이트웨이 freellmapi `127.0.0.1:3001` |
| 스킬 | `~/.config/opencode/skills/ctx-relay` → `~/j-skills/ctx-relay` |
| SSH 키 | `~/.ssh/id_ed25519_jm` (VM 전용) |
| VM 관리자 비밀번호 파일 | 없음. 관리자 `jjm`의 비밀번호는 사용자만 안다. SSH는 키 인증만 |

WSL 포트:

| 포트 | 용도 |
| --- | --- |
| 5173 | 웹 개발 서버 (Vite, `npm --prefix web run dev`) |
| 3000 | 서버 개발 실행 (서버 단계부터) |
| 3001 | **freellmapi 사용 중. 바인드·종료·호출 금지** |

## VM j-messenger-lab (운영 서버)

| 항목 | 값 |
| --- | --- |
| OS | Rocky Linux 10.2 Minimal, 커널 6.12, SELinux Enforcing |
| 자원 | Gen 2, 1 vCPU, RAM 1 GiB 고정(사용 가능 884 MB), 스왑 2 GiB, 디스크 20 GiB(LVM, / 16 GiB) |
| Hyper-V | 스위치 `JMessengerInternal`, 고정 MAC `00155D004206`, 자동 체크포인트 끔, Secure Boot(MS UEFI CA) |
| 네트워크 | NetworkManager 프로필 `jm-internal`(수동, 자동 연결). 설치 때 만든 `eth0`(DHCP) 프로필은 자동 연결 끔 |
| 호스트명 / 시간대 | `j-messenger-lab` / Asia/Seoul (서버 데이터 시각은 UTC 저장) |
| Node | v22.23.2 (AppStream `nodejs`), npm 10.9.8 |
| 기타 패키지 | tar, hyperv-daemons(KVP로 호스트에 IP 보고) |

계정:

| 계정 | 권한 | 용도 | 접속 |
| --- | --- | --- | --- |
| `jjm` | wheel, 비밀번호 없는 sudo(`/etc/sudoers.d/90-jjm`) | 인프라 관리. Claude·사람만 사용 | WSL `ssh jm-vm-admin` |
| `jmsg` | sudo 없음, linger 켬 | 앱 실행·배포. OpenCode 작업이 쓸 수 있는 유일한 계정 | WSL `ssh jm-vm` |

SSH는 `/etc/ssh/sshd_config.d/10-j-messenger.conf`로 비밀번호 로그인과 root 로그인을 막았다. 콘솔(vmconnect) 로그인은 `jjm` 비밀번호로 가능하다.

앱 배치 (모두 `jmsg` 소유):

| 경로 | 내용 |
| --- | --- |
| `~/app/server` | 서버 코드. 서비스 작업 디렉터리 |
| `~/app/web/dist` | 빌드된 웹 파일 |
| `~/data/j-messenger.sqlite` | SQLite DB |
| `~/.config/j-messenger/server.env` | 환경 파일(0600): `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3000`, `DB_PATH`, `WEB_DIST` |
| `~/.config/systemd/user/j-messenger.service` | 사용자 서비스. `node --disable-warning=ExperimentalWarning src/index.ts`, 실패 시 재시작. 서버 배포 전이라 아직 enable하지 않음 |

서비스 조작(sudo 불필요): `ssh jm-vm 'systemctl --user restart j-messenger'`, 로그 `ssh jm-vm 'journalctl --user -u j-messenger -n 50'`.

방화벽(firewalld):

| 존 | 출발지 | 허용 |
| --- | --- | --- |
| `jm-clients` | 10.77.0.0/24(호스트), 172.16.0.0/12(WSL NAT 대역) | ssh, 3000/tcp |
| `public` | 그 외 | ssh (cockpit 제거) |

## WSL SSH 설정 (`~/.ssh/config`)

```text
Host jm-vm
  HostName 10.77.0.10
  User jmsg
  IdentityFile ~/.ssh/id_ed25519_jm
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  ConnectTimeout 5

Host jm-vm-admin
  HostName 10.77.0.10
  User jjm
  (나머지 동일)
```

## 연결 확인 명령과 2026-09-23 실측 결과

| 경로 | 명령 | 결과 |
| --- | --- | --- |
| 호스트 → VM | `Test-NetConnection 10.77.0.10 -Port 22` | True |
| WSL → VM ICMP | `ping -c2 10.77.0.10` | 0% 손실, 0.8 ms |
| WSL → VM SSH | `ssh jm-vm id -un` / `ssh jm-vm-admin hostname` | `jmsg` / `j-messenger-lab` |
| WSL → VM HTTP | 임시 서비스(`systemd-run --user`, 3000)에 `curl -fsS http://10.77.0.10:3000/health` | `{"ok":true,"from":"172.20.211.137"}` |
| 방화벽 차단 | 3001 임시 서비스에 curl | 연결 실패 (정상) |
| VM → 인터넷 | `ping 8.8.8.8`, `getent hosts rockylinux.org` | 성공 |
| forwarding 자동 복구 | WSL 어댑터 forwarding을 끈 뒤 대기 | 약 50초 뒤 예약 작업이 Enabled로 복구 |
| Windows → WSL 개발 포트 | WSL에서 5173 리슨 → Windows `curl.exe http://localhost:5173` | 성공 |

## 문제 해결 순서

1. `ssh jm-vm` 시간 초과: 관리자 PowerShell에서 `Get-NetIPInterface -AddressFamily IPv4 | ? InterfaceAlias -like 'vEthernet*' | select InterfaceAlias,Forwarding`. Disabled면 `.\scripts\New-MessengerVm.ps1 -Phase Route`.
2. 그래도 안 되면 `Get-VM j-messenger-lab`이 Running인지, 호스트에서 `Test-NetConnection 10.77.0.10 -Port 22`가 되는지 본다. 호스트도 안 되면 VM 콘솔에서 `ip -4 a`와 `nmcli con show`를 확인한다.
3. VM 시작 오류 "unable to allocate … RAM": 호스트 여유 메모리 부족. 브라우저 등을 닫거나 `wsl --shutdown` 뒤 재시도.
4. HTTP만 실패: `ssh jm-vm 'systemctl --user status j-messenger'`, 방화벽 `ssh jm-vm-admin sudo firewall-cmd --zone=jm-clients --list-all`.
