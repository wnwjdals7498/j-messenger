# 실행 범위와 구현 상태

기준일: 2026-10-06. [상세계획](11-implementation-plan.md)의 실제 구현 상태를 기록한다. 완료 표시는 실행한 검증 근거가 있는 범위에만 사용한다. 10월 2일 이후 실행이 이어지지 않았으며, 10월 6일 상태 확인 후 6-luna worker 3개로 미완료 구현을 재개했다.

## 이번 사용자 지시

- 현재 대상은 메시지 서버·Web·Windows 앱이다. Android 구현·시험·검증은 이번 실행 범위에서 제외한다.
- 메일 서버가 없으므로 메일 연동 시험·검증은 수행하지 않는다. 메일 인증 port는 확장 경계로 두고 실제 연결 성공을 보고하지 않는다. 로컬 개발 계정으로 세션·권한·메시징을 검증하는 결과는 메일 인증 결과와 구분한다.
- 실제 서버 대상은 Windows Hyper-V의 `j-messenger-lab` VM이다. 과거 환경 문서의 값은 현재 실측 뒤 사용한다.
- 파일 한도는 개당 5MB이며 구현에서는 5,000,000 bytes로 통일한다. 허용 형식은 PNG·JPG/JPEG·WEBP·PDF·TXT·CSV·DOCX·XLSX·ZIP이다. 파일은 실행/inline 렌더 없이 attachment 다운로드로 제공한다.
- 메시지 본문은 생성 후 5일, 파일은 업로드 후 14일 보존한다. **두 기간은 독립**이다. 메시지 본문 만료 시 삭제 사실·첨부 참조만 남겨 아직 유효한 첨부는 파일 만료까지 조회·다운로드한다. 이전 설계의 메시지 만료와 동시 첨부 삭제 규칙은 이번 실행에 적용하지 않는다.
- 서버별 첨부 합계 quota는 VM의 실제 디스크 여유를 확인해 설정한다. quota와 별개로 디스크 여유 보호 규칙을 적용하며, 한도가 없다고 무제한 업로드로 해석하지 않는다.
- 실제 메일 관리자 근거·외부 OS 푸시는 임의로 선택하지 않는다. 미확정 상태는 기능 비활성으로 유지하고 로컬 계약·권한·실패 복구 시험은 독립적으로 진행한다.

## 진행 상태

계약 revision 2에서 cursor와 정렬 위치를 분리했다. `snapshotCursor`/`nextCursor`/`through`/WS ready의 `cursor`는 서버가 검증하는 불투명 토큰이며 client에서 숫자로 비교하지 않는다. `snapshotPosition`/`throughPosition`/`scannedThrough`/ready의 `position`은 이벤트 순서 판단용 10진 문자열이다. WS ready는 `type`·`cursor`·`position`, sync 응답은 변경 목록·다음 토큰·추가 페이지 여부·고정 상한 토큰/위치·스캔 위치를 제공한다. 첫 sync에서 상한 생략 시 서버가 현재 상한을 고정해 반환하며 이후 페이지는 그 `through`를 유지한다.

| 카드/범위 | 상태 | 근거·한계 |
| --- | --- | --- |
| B01 공통 계약 | 단위 검증 통과 | 계약 시험 10개·타입·빌드. revision2 통합 계약까지 반영 |
| B02 설정·로그 | 단위 검증 통과 | 시험 8개·타입·소유 lint. 실제 journal 미검증 |
| B03 DB·outbox | 단위 검증 통과 | 실제 파일 DB 시험 10개·타입·로그·재시작 |
| B04 영속 작업 | 로컬 검증 통과 | 영속 job·lease·재시도·재시작 시험 7개 |
| B05 HTTP 경계 | 로컬 검증 통과 | 인증·Origin·WS·429·404·로그 시험 11개 |
| B06 서비스 조립 | 로컬 검증 통과 | 실제 SQLite·HTTP·WS·파일·독립 보존·재시작 관통 시험 5개 |
| C01 개발 인증·세션 | 로컬 검증 통과 | 개발 계정·hash·세션·디렉터리 시험 8개와 HTTP 결합. 메일 인증과 별개 |
| C02~C05 대화·메시지·실시간·sync | 로컬 검증 통과 | 소유 모듈의 시험과 실제 HTTP/WS 관통. 서버별 격리·중복 방지·signed cursor 확인 |
| C06 client-core | 로컬 검증 통과 | 시험 13개. 실제 서버·브라우저 연결, 새로고침 세션·이력 복구 확인 |
| C07 Web 화면 | 로컬 검증 통과 | React 시험 12개·Web 빌드·실제 Edge. IME 입력·첨부 송수신·360px 화면 확인 |
| C08/E08 로컬 관통 | 로컬 검증 통과 | 서버 관통 5개와 Edge 시나리오 1개. 두 사용자·작은 파일·5MB 파일·새로고침 확인 |
| 파일·읽음·독립 보존·감사 | 로컬 검증 통과 | 5,000,001 bytes 거부, 메시지 본문 5일·파일 14일 독립 만료, 읽음 최대값·감사 권한 시험 |
| 운영 자원·백업·복구 | 함수 검증 통과 | 실제 임시 파일 DB·백업/복구·실패 복구 시험 6개. 운영 서비스 정지·실제 journal·VM 복구는 미검증 |
| Windows 앱 | 소스·Web 번들 검증 | 공통 UI·native source 구현. TypeScript·Web 번들은 통과. Rust/MSVC 미설치로 native 실행 파일 미검증 |
| VM 배포 | 접근 확인 대기 | Hyper-V 조회 권한 거부, WSL SSH 시간 초과. 실제 VM 서비스·디스크는 미확인 |
| 실제 메일 연동 | 현재 범위 제외 | 서버 없음. 메일 시험 결과를 만들지 않음 |
| Android | 현재 범위 제외 | 구현·시험·검증 미수행 |

## 검증 근거와 남은 범위

2026-10-06, Node 24.16.0·npm 11.13.0 환경에서 `npm run check`의 서버 88개·계약 10개·client-core 13개·React 12개, 합계 **123개** 시험이 통과했다. 타입 검사·소유 경계 lint·`npm run format:check`도 통과했다. `npm run build`는 공유 패키지·서버·Web을 빌드하며, desktop의 Vite 빌드는 화면 번들 검증이다. native 실행 파일 빌드와 구분한다.

`npm run test:e2e`는 설치된 Edge의 분리된 임시 브라우저 환경에서 실제 HTTP·WS 서버를 사용한다. Alice/Bob 별도 세션, 메시지 전달, IME Enter 중복 전송 방지, 정확히 5MB 첨부의 byte 일치, 새로고침 복구를 확인했다. 마지막 실행은 시나리오 1개가 13.7초에 통과했다. 초기 로그인 전 `/me` 401 응답만 예외로 허용하며 다른 API 실패·스크립트/console 오류와 360px 수평 넘침을 검사한다. [데스크톱 화면](../../tests/e2e/evidence/desktop-chat.png)과 [좁은 화면](../../tests/e2e/evidence/mobile-chat.png)에 검증 화면을 보관했다. 좁은 화면 검증은 Web의 반응형 시험이며 Android 앱 시험이 아니다.

실제 조립된 서버에서 운영 logger의 JSON sink도 검사했다. 요청 경로·상태와 commit 후 메시지 성공 메타데이터가 있고, 비밀번호·cookie credential·native bearer·메시지 본문·cursor는 로그에 없음을 확인했다. 이는 로컬 로그 내용 검증이며 VM의 journal 수집·보관 검증과 구분한다.

전체 상세계획은 아직 완료가 아니다. 남은 범위는 Windows native 컴파일·실행·OS 자격 증명/파일 대화상자 검증, `j-messenger-lab`의 접근·실제 TLS 배포·용량/부하 측정, 운영 로그 수집·보존·백업/복구 실행 절차 결합이다. 실제 메일 관리자 확인 근거와 종료된 앱의 외부 알림 제공자가 없으므로 관련 기능은 활성화하지 않았다.

Hyper-V 조회는 Windows 권한 거부를 반환했고, 과거 기록의 SSH 주소 연결은 시간 초과했다. 이 결과만으로 VM 전원·실제 서비스 상태를 단정하지 않는다. 개발용 첨부 quota 2,000,000,000 bytes/서버는 임시값이며 실제 VM의 저장 공간을 측정해 운영값을 결정해야 한다.

검증 과정에서 작은 multipart 첨부가 거부되는 문제를 수정했다. 길이가 미확정인 업로드는 최대 5MB를 예약하고 스트림 완료 후 실제 byte 수로 저장한다. 작은 TXT의 업로드·메시지 연결·다운로드도 실제 HTTP 시험으로 확인했다. 전체 검사에서 발생한 5MB Buffer 비교 시간 초과는 모든 byte를 비교하는 `Buffer.equals`로 해결했으며 시험 제한이나 확인 범위는 완화하지 않았다.

## 의존성 근거

공식 npm registry metadata 및 [공식 Fastify TypeBox provider](https://github.com/fastify/fastify-type-provider-typebox)의 호환표를 확인했다. TypeBox 1.3.34·provider 6.1.0, Fastify 5 계열을 선택하며 실제 설치·검증 결과로 고정한다. TypeScript 5.9.3·Vitest 4.1.0은 Node 22/24 호환 환경에서 검증한다. package/lock·공유 설정은 부모가 단일 writer로 통합한다.
