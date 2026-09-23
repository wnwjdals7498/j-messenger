# 메신저 VM 생성·접속

## 입력값과 고정 구성

| 값 | 채울 내용 |
| --- | --- |
| 외부 스위치 이름 | 미정 |
| Windows 물리 어댑터 이름(스위치 신규 생성 때만) | 미정 |
| VM 주소/CIDR | 미정. 예: 192.168.50.40/24 |
| LAN 게이트웨이 | 미정. 예: 192.168.50.1 |
| DNS | 미정. 예: 192.168.50.1 |
| 허용할 클라이언트 IP/CIDR | 미정 |

VM 이름은 j-messenger-lab, 2세대, 1 vCPU, 20 GiB VHDX다. 설치 중 RAM 2 GiB, 설치 후 고정 1 GiB를 쓴다. 외부 스위치에 물려 LAN의 사설 IP를 게스트 안에서 직접 설정한다. 이 방식은 WSL이 기본 NAT이든 미러 모드든 LAN 경로로 VM에 접속할 수 있는지 확인하기 쉽다. 호스트·WSL·VM의 실제 방화벽/라우팅 정책에 따라 접속 검증은 필수다.

Rocky 공식 문서는 텍스트 설치에 RAM 2 GiB를 적고, 최소 서버 구성 표에는 1 GiB를 적는다. 따라서 1 GiB는 **설치 후 실험 기준**이며 안정성이 확인된 값이 아니다. 설치·운영 실패 시 2 GiB로 되돌리고 측정값을 남긴다. CPU는 Rocky 10의 x86_64-v3 요건을 충족해야 한다.

## 1. 사전 확인

1. Windows 관리자 PowerShell에서 Hyper-V 활성화 및 외부 스위치 후보 확인: Get-VMSwitch, Get-NetAdapter.
2. LAN 관리자 또는 공유기에서 사용 중이지 않은 사설 IP와 CIDR·게이트웨이·DNS를 확인한다. DHCP 풀과 겹치지 않게 예약하거나 범위 밖을 사용한다.
3. [Rocky 공식 다운로드](https://rockylinux.org/download)에서 10 x86_64 Minimal ISO를 받는다. [공식 설치 안내](https://docs.rockylinux.org/guides/installation/)의 CHECKSUM과 Get-FileHash 결과를 대조한다.
4. 외부 스위치 신규 생성은 물리 어댑터 연결을 잠시 끊을 수 있으므로, 작업 중인 접속을 저장한다. 기존 외부 스위치가 있으면 그것을 사용한다.

## 2. VM 생성

관리자 PowerShell에서, **실제 ISO·스위치·어댑터 이름으로 바꿔** 실행한다.

```powershell
.\scripts\New-MessengerVm.ps1 -Phase Create -IsoPath 'C:\ISO\Rocky-10-x86_64-minimal.iso' -SwitchName 'LabExternal' -AdapterName 'Ethernet'
Get-VM -Name 'j-messenger-lab'
Get-VMMemory -VMName 'j-messenger-lab'
Get-VMProcessor -VMName 'j-messenger-lab'
Start-VM -Name 'j-messenger-lab'
vmconnect.exe localhost 'j-messenger-lab'
```

스위치가 이미 있으면 -AdapterName을 생략한다. 스크립트는 기존 VM을 덮어쓰지 않고, 비어 있지 않은 VM 경로에는 생성하지 않는다. ISO 부팅 뒤 Rocky 설치 화면에서 Minimal 설치·20 GiB 디스크·관리 계정·SSH 서버를 설정한다. 암호나 키는 저장소에 적지 않는다.

## 3. 게스트 고정 IP

Rocky 콘솔에서 연결 프로필 이름을 찾는다.

```bash
nmcli -t -f NAME,DEVICE connection show
```

저장소의 scripts/Configure-GuestNetwork.sh를 게스트에 복사하거나 같은 내용을 콘솔에서 실행한다. IP·게이트웨이·DNS·프로필명을 실제 값으로 교체한다.

```bash
sudo bash Configure-GuestNetwork.sh 192.168.50.40/24 192.168.50.1 192.168.50.1 'System eth0'
ip -4 address show
ip -4 route show
ping -c 2 192.168.50.1
```

예시 주소를 그대로 쓰지 않는다. 초기에는 콘솔에서 파일을 직접 옮기기 어려우므로, 동일한 NetworkManager 설정을 콘솔의 nmtui에서 입력해도 된다. 재부팅 뒤 같은 IP가 유지되는지 확인한다.

## 4. 설치 후 1 GiB로 고정

게스트를 정상 종료한 뒤 VM 상태가 Off인지 확인하고 관리자 PowerShell에서 실행한다.

```powershell
.\scripts\New-MessengerVm.ps1 -Phase Finalize -VmName 'j-messenger-lab'
Get-VMMemory -VMName 'j-messenger-lab'
Start-VM -Name 'j-messenger-lab'
```

Finalize는 동적 메모리를 끄고 1 GiB로 맞추며 ISO를 분리하고 디스크를 첫 부팅 장치로 둔다. 메모리 부족이나 서비스 재시작이 관측되면 정상 종료 후 Set-VMMemory -VMName 'j-messenger-lab' -DynamicMemoryEnabled $false -StartupBytes 2GB로 올리고 검증 기록에 남긴다.

## 5. 접속·서비스 검증

Windows에서 Test-NetConnection 192.168.50.40 -Port 22, WSL에서 다음을 확인한다.

```bash
ip route
ssh <게스트-사용자>@192.168.50.40
curl -fsS http://192.168.50.40:3000/health
```

서버 구현 전에는 SSH까지만 확인한다. HTTP는 개발용 /health 확인에만 쓴다. 실제 메일 계정의 비밀번호를 보내기 전에는 계획의 T01~T04에서 HTTPS/WSS·인증서 신뢰·세션 보호를 완료한다. 게스트 방화벽에서는 **허용된 클라이언트 주소만** 서비스 포트에 접근시킨다. 실패 시 게스트 주소·게이트웨이, Windows/WSL 경로, 게스트 방화벽 순서로 확인한다. WSL 접속이 막히면 VM 구성 완료로 표시하지 않는다.

## 근거

- [Rocky Linux 10 최소 사양](https://docs.rockylinux.org/guides/minimum_hardware_requirements/)
- [Rocky Linux 10 설치와 ISO 검증](https://docs.rockylinux.org/guides/installation/)
- [Hyper-V Linux용 보안 부팅 템플릿](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/learn-more/Generation-2-virtual-machine-security-settings-for-Hyper-V)
- [WSL 네트워크 모드와 호스트 접근](https://learn.microsoft.com/en-us/windows/wsl/networking)
