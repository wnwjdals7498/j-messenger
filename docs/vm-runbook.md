# 메신저 VM 생성·접속

현재 환경 값은 [env.md](env.md)가 정본이다. 이 문서는 같은 환경을 처음부터 다시 만드는 절차다. 모든 PowerShell 명령은 **관리자 PowerShell**에서, 저장소 루트에서 실행한다.

## 고정 구성

| 항목 | 값 |
| --- | --- |
| VM | `j-messenger-lab`, Gen 2, 1 vCPU, 설치 중 RAM 2 GiB → 설치 후 1 GiB 고정, 20 GiB VHDX, 고정 MAC `00155D004206` |
| 네트워크 | Internal 스위치 `JMessengerInternal`, 호스트 `10.77.0.1/24`, NAT `JMessengerNat` `10.77.0.0/24`, VM `10.77.0.10` |
| DNS | 8.8.8.8, 1.1.1.1 |
| 관리자 / 앱 계정 | `jjm`(wheel) / `jmsg`(sudo 없음) |

Rocky 공식 문서 기준으로 텍스트 설치는 RAM 2 GB, 최소 서버 구성은 1 GB다. 그래서 1 GiB는 설치 후 운영 값으로만 쓴다. CPU는 x86_64-v3(AVX2 등)가 필요하다. 호스트 Ryzen 7 5700U는 이 조건을 충족한다. 호스트 여유 메모리가 부족하면 VM 시작이 `unable to allocate 2048 MB of RAM (0x800705AA)`로 실패한다. 이때는 다른 프로그램을 닫거나 `-InstallMemoryMB 1536`을 쓴다.

## 1. ISO 준비

```powershell
New-Item -ItemType Directory -Force D:\ISO | Out-Null
curl.exe -fL -o D:\ISO\Rocky-10.2-x86_64-minimal.iso https://download.rockylinux.org/pub/rocky/10/isos/x86_64/Rocky-10.2-x86_64-minimal.iso
(Get-FileHash D:\ISO\Rocky-10.2-x86_64-minimal.iso -Algorithm SHA256).Hash
```

해시를 `https://download.rockylinux.org/pub/rocky/10/isos/x86_64/CHECKSUM`의 값과 대조한다. 10.2 minimal의 값은 `aac6ac3ce781b91a91ce78463405f66c611a5dca4b3840c79e5e01d97302f6c8`이다.

## 2. 스위치·NAT·VM 생성

```powershell
.\scripts\New-MessengerVm.ps1 -Phase Create -IsoPath D:\ISO\Rocky-10.2-x86_64-minimal.iso
Start-VM -Name j-messenger-lab
vmconnect.exe localhost j-messenger-lab
```

스크립트는 기존 VM을 덮어쓰지 않고, 비어 있지 않은 VM 경로에는 만들지 않는다. 스위치와 NAT가 이미 있으면 그대로 쓴다.

## 3. Rocky 설치 화면

| 화면 | 입력 |
| --- | --- |
| Software Selection | Minimal Install |
| Installation Destination | 20 GiB 디스크, 자동 파티션 |
| Network & Host Name | 호스트명 `j-messenger-lab`. IPv4 Manual: 주소 `10.77.0.10`, netmask `255.255.255.0`, gateway `10.77.0.1`, DNS `8.8.8.8`. 자동 연결 켜기 |
| User Creation | `jjm`, 관리자로 설정 체크, 비밀번호 설정 (저장소에 적지 않음) |
| Root | 잠금 유지 |

설치가 끝나면 **Reboot 대신 VM을 끈다**(`Stop-VM j-messenger-lab`). 첫 부팅 장치가 아직 ISO라서 재부팅하면 설치 화면으로 다시 들어간다.

## 4. 설치 후 고정·경로 설정

```powershell
.\scripts\New-MessengerVm.ps1 -Phase Finalize
.\scripts\New-MessengerVm.ps1 -Phase Route -Persist
Start-VM -Name j-messenger-lab
```

- **Finalize:** ISO 분리, 디스크 부팅, RAM 1 GiB 고정, 자동 체크포인트 끔.
- **Route -Persist:** WSL과 VM 스위치 어댑터의 IPv4 forwarding을 켠다. 또 예약 작업 `j-messenger WSL-VM forwarding`을 등록한다. 이 작업은 SYSTEM 권한으로 부팅 시와 1분마다 실행된다.

## 5. WSL 준비 (한 번만)

```bash
ssh-keygen -t ed25519 -N '' -C 'jjm@wsl j-messenger' -f ~/.ssh/id_ed25519_jm
cat >> ~/.ssh/config <<'EOF'

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
  IdentityFile ~/.ssh/id_ed25519_jm
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  ConnectTimeout 5
EOF
chmod 600 ~/.ssh/config
cat ~/.ssh/id_ed25519_jm.pub
```

## 6. VM 콘솔에서 키 등록과 sudo 설정

vmconnect에서 `jjm`으로 로그인한 뒤 실행한다. 공개키는 5단계 출력값으로 바꾼다. 긴 줄은 vmconnect 메뉴 Clipboard → Type clipboard text로 붙여 넣을 수 있다. Claude는 Hyper-V `Msvm_Keyboard`로 키를 하나씩 입력했다. `TypeText`는 문자가 깨지므로 쓰지 않는다.

```bash
install -d -m 700 ~/.ssh && echo '<공개키 한 줄>' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
echo 'jjm ALL=(ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/90-jjm >/dev/null && sudo chmod 0440 /etc/sudoers.d/90-jjm && sudo visudo -cq && echo SUDO_OK
```

비밀번호 없는 sudo는 실험용 VM의 관리 자동화를 위한 선택이다. 그 대신 SSH는 키 인증만 허용하고, `jjm` 키는 WSL에만 둔다.

## 7. VM 설정 (WSL에서)

```bash
cd /mnt/d/workspace/test-space/github/j-messenger
ssh jm-vm-admin "sudo bash -s -- '$(cat ~/.ssh/id_ed25519_jm.pub)'" < scripts/Provision-MessengerVm.sh
```

`Provision-MessengerVm.sh`는 여러 번 실행해도 결과가 같다. 하는 일:
- 호스트명·시간대 설정
- `nodejs`·`tar`·`hyperv-daemons` 설치
- `jmsg` 계정과 SSH 키, linger 설정
- 앱 디렉터리, `server.env`, 사용자 서비스 유닛 생성
- SSH 비밀번호 로그인 차단
- 방화벽 존 `jm-clients` 생성
- 고정 IP 프로필 `jm-internal` 생성 (다음 부팅부터 적용)

네트워크 프로필을 바꾼 경우에는 `ssh jm-vm-admin sudo reboot`로 한 번 재부팅한다.

IP를 나중에 바꿀 때는 VM 안에서 `sudo bash Configure-GuestNetwork.sh <IPv4/CIDR> <gateway> <DNS> jm-internal`을 쓴다. 바꾼 값은 env.md, `~/.ssh/config`, 방화벽에도 반영한다.

## 8. 연결 검증

```bash
ping -c2 10.77.0.10
ssh jm-vm id -un                       # jmsg
ssh jm-vm-admin hostname               # j-messenger-lab
ssh jm-vm 'systemd-run --user --unit jm-smoke --collect /usr/bin/node -e "require(\"node:http\").createServer((q,s)=>s.end(\"ok\")).listen(3000)"'
curl -fsS http://10.77.0.10:3000/      # ok
ssh jm-vm 'systemctl --user stop jm-smoke'
```

Windows에서는 `Test-NetConnection 10.77.0.10 -Port 22`로 확인한다. 결과는 [verification.md](verification.md)에 남긴다.

## 되돌리기 (환경 전체 삭제)

아래 명령은 VM 디스크와 설정을 되돌릴 수 없게 지운다. 실행 전에 필요한 데이터가 없는지 확인한다.

```powershell
Stop-VM j-messenger-lab -TurnOff -ErrorAction SilentlyContinue
Remove-VM j-messenger-lab -Force
Remove-Item -Recurse -Force "$env:PUBLIC\Documents\Hyper-V\j-messenger-lab"
Unregister-ScheduledTask -TaskName 'j-messenger WSL-VM forwarding' -Confirm:$false
Remove-NetNat -Name JMessengerNat -Confirm:$false
Remove-VMSwitch -Name JMessengerInternal -Force
```

## 근거

- [Rocky Linux 10 최소 사양](https://docs.rockylinux.org/guides/minimum_hardware_requirements/)
- [Rocky Linux 10 설치와 ISO 검증](https://docs.rockylinux.org/guides/installation/)
- [Hyper-V Linux용 보안 부팅 템플릿](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/learn-more/Generation-2-virtual-machine-security-settings-for-Hyper-V)
- [WSL 네트워크 모드와 호스트 접근](https://learn.microsoft.com/en-us/windows/wsl/networking)
- [Windows Server 2019 Hyper-V에서 Rocky 10 부팅 실패(x86_64-v3)](https://forums.rockylinux.org/t/rocky-linux-10-x-install-iso-wont-boot-on-windows-server-2019/20613)
