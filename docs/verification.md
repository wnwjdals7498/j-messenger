# 검증 기록

환경·통합 시험 결과를 남긴다. 작업 카드 단위 결과는 `.ctx/LOG.md`에 있다. 실행 전 계획은 결과로 기록하지 않는다. 자격 증명·개인정보는 적지 않는다.

형식:

```text
## <ID> — <날짜>
- 환경:
- 실행:
- 기대:
- 실제:
- 실패·제약:
- 변경 파일:
```

## E — 2026-09-23 (VM 환경, Claude)

- 환경: Windows 11 Pro 26200, Hyper-V, WSL Ubuntu 22.04(NAT), Rocky Linux 10.2 Minimal VM `j-messenger-lab`.
- 실행:
  1. ISO SHA256을 공식 CHECKSUM과 대조했다.
  2. VM을 생성했다. 처음엔 외부 스위치로 만들었다.
  3. 사용자가 수동으로 설치했다. 네트워크는 회사 DHCP 192.168.0.16이었다.
  4. 콘솔로 SSH 키를 등록하고 sudo를 설정했다.
  5. `Provision-MessengerVm.sh`를 실행했다.
  6. VM을 끈 뒤 NIC를 `JMessengerInternal`로 옮기고 MAC을 고정했다.
  7. Finalize(1 GiB)와 Route -Persist를 실행했다.
  8. 외부 스위치를 제거했다.
- 기대: WSL에서 10.77.0.10으로 SSH·HTTP가 되고, VM에서 인터넷이 되며, 허용하지 않은 포트는 막힌다.
- 실제:
  - `ping 10.77.0.10`: 0% 손실, 0.8 ms
  - `ssh jm-vm id -un`: `jmsg`
  - `ssh jm-vm-admin hostname`: `j-messenger-lab`
  - `curl http://10.77.0.10:3000/health`(임시 서비스): `{"ok":true,"from":"172.20.211.137"}`
  - 3001: 차단
  - VM에서 `ping 8.8.8.8`과 DNS 조회: 성공
  - VM 메모리 884 MB 중 341 MB 사용, 스왑 2 GiB, 디스크 / 16 GiB 중 1.7 GiB 사용
  - 호스트 `이더넷` 192.168.0.66, DNS 8.8.8.8로 복구. 인터넷 정상
  - forwarding을 수동으로 끄자 약 50초 뒤 예약 작업이 다시 켰다
  - Windows `curl.exe http://localhost:5173` → WSL 리스너 응답 성공
- 실패·제약:
  - 처음 VM 시작 때 호스트 메모리가 부족해 2 GiB를 할당하지 못했다(0x800705AA). 사용자가 여유 메모리를 확보한 뒤 설치했다.
  - WSL → VM은 forwarding 없이 시간 초과였다. forwarding과 예약 작업으로 해결했다.
  - Hyper-V `TypeText`는 문자를 잘못된 스캔코드로 보낸다. 가상 키 입력(`TypeKey`)으로 대체했다.
  - `hypervkvpd`는 첫 설치 직후 시작에 실패했고 재부팅 뒤 active가 됐다.
- 변경 파일: `scripts/New-MessengerVm.ps1`, `scripts/Provision-MessengerVm.sh`, `docs/env.md`, `docs/vm-runbook.md`
