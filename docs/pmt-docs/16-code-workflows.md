# 코드 워크플로우: Archify

기준일: 2026-10-06. [Archify 공식 v3.0.1](https://github.com/tt-a1i/archify/tree/v3.0.1)의 typed JSON→검증→standalone HTML 방식을 사용했다. 도구 commit은 `2ab3cae7ac2c2a55d7386ca789d03c4fcd31816c`, 분석 코드 commit은 `9d13adfe74bb7bd9bf8e468801e4fec378b82760`이다. 도식은 해당 커밋의 코드 동작을 설명하고 실제 VM 배포 버전은[13](13-vm-deployment.md)을 따른다.

## 도식과 읽는 방법

HTML을 다운로드해 브라우저로 열면 노드·관계·경로·소스 근거를 탐색할 수 있다. Archify 설치가 없어도 읽을 수 있다. 설명은 한국어이고 기본 viewer UI는 영어다. `SRC` 링크는 고정된 GitHub 코드·줄 범위를 가리킨다. JSON은 수정 가능한 원천이며 HTML을 직접 수정해 원천과 어긋나게 만들지 않는다.

| 질문 | Archify HTML | 원천 |
| --- | --- | --- |
| 메시지가 언제 저장되고 상대에게 전달되는가? | [메시지 저장·전달](workflows/message-delivery.html) | [Workflow JSON](workflows/message-delivery.workflow.json) |
| 복원·ready·sync·재연결은 어떤 순서로 호출되는가? | [세션 복원·재연결](workflows/session-recovery.html) | [Sequence JSON](workflows/session-recovery.sequence.json) |
| 파일의 VM 저장과 Android 기기 저장은 누가 맡는가? | [파일 업로드·저장](workflows/file-round-trip.html) | [Workflow JSON](workflows/file-round-trip.workflow.json) |

GitHub에서 바로 보는 미리보기: [메시지](workflows/message-delivery.preview.png)·[복원](workflows/session-recovery.preview.png)·[파일](workflows/file-round-trip.preview.png). HTML의 원천·기능은 같은 JSON에서 생성한다.

### 메시지 저장·전달

1. `MessengerApp.handleSend`가 입력을 확인하고 `client.sendMessage`를 호출한다.
2. client-core는 `clientMessageId`와 메모리 pending을 만들고 메시지 POST를 보낸다.
3. HTTP가 Origin·자격 증명·계약을 확인하고 RequestContext를 만든다. messages가 참여 권한을 확인하고 transaction 안에서도 재검사한다.
4. 같은 ID·같은 본문/파일이면 기존 결과200을 반환한다. 새 요청은 messages·dedup·파일 연결·outbox를 같은 transaction에 저장해201을 반환한다. 다른 요청의 ID 재사용은 충돌이다.
5. HTTP 결과와 WSS 사건 모두 client의 ID 병합으로 반영한다. realtime은 commit된 outbox를 peer별로 poll하고 hydrator의 현재 ACL/데이터 검증 뒤 사건을 보낸다.
6. 일시 실패는 같은 ID로 지연 재시도한다. 권한·입력·만료 등 영구 오류는 실패로 표시한다. 연결이 끊긴 동안의 사건은 sync가 복구한다.

핵심 소스는 `client-core.sendMessage/retryMessage`, `messages.create`, `DatabaseAdapter.run/append`, `realtime.pollPeer`와 bootstrap의 hydrator다. UI pending은 영속 DB가 아니고 WSS 성공을 DB commit과 동일한 사건으로 취급하지 않는다.

### 세션 복원·재연결

1. `resumeSession`이 generation을 바꾸고 `/me`로 기존 세션을 확인한다.401이면 세션 상태를 비운다.
2. 대화 목록과 반환된 대화의 메시지 이력을 읽고 목록의 signed snapshot cursor를 보존한다.
3. WSS 연결의 ready에서 사용자별 cursor/position 상한을 받는다.
4. 저장한 after와 ready의 through로 `/sync`를 요청한다. 서버는 user/server/epoch/만료와 범위를 검사한다. 여러 페이지에도 through를 고정한다.
5. sync 중 WSS 사건은 buffer에 두고 완료 후 순서·중복·snapshot floor·tombstone 규칙으로 병합한다.
6.410은 snapshot을 다시 구축한다. 기존 through가 있으면 그 상한의 sync를 유지하고, 없으면 socket을 닫아 새 ready로 복구한다. close는 상한·jitter가 있는 재연결 대기를 거친다. logout은 timer·buffer·snapshot을 정리한다.

시퀀스의 세로 좌표는 순서이며 측정 latency가 아니다.410·close·401은 각 조건의 대안 경로다. source의 동작을 한 시나리오에서 항상 연속 발생하는 사건으로 해석하지 않는다. 모든 조회/sync return은 HTTP route를 통해 client에 반환된다.

### 파일 업로드·Android 저장

1. Web은 file input, Android는 시스템 선택기의 content URI를 사용한다. client가 참여한 대화에 multipart stream을 전송한다.
2. files는 참여 권한·크기·형식·quota·여유 공간을 확인하고 업로드 예약을 저장한다. 실제 byte 길이·내용 형식·SHA를 확인하며 임시 객체를 최종 경로로 옮긴 뒤 ready로 확정한다.
3. messages가 공개 `files.bind`를 호출해 같은 message transaction에서 첨부를 연결한다.
4. 다운로드도 회원·realm·보존 상태를 검사한 HTTP 응답이다. 일반 Web은 Blob 링크로 저장한다.
5. Android만 승인 Blob을 origin/main-frame 제한 WebMessage로 전달한다. native는 private cache→SAF 저장창→선택한 content URI 순서로 복사한다.
6. 저장 응답은 request ID와 saved/error이며 자격 증명을 전달하지 않는다. 취소/실패/Activity 종료는 자기 임시 파일과 pending을 정리한다.

VM은 업무 파일을, Android는 선택한 기기 사본을 소유한다. 업무 보존 기간과 사용자가 저장한 기기 사본의 수명은 별개다.

## 재생성·검증

저장소 루트에서 공식 도구를 전역 설치 없이 준비하고 JSON과 같은 output 경로를 사용한다.

```powershell
git clone --depth 1 --branch v3.0.1 https://github.com/tt-a1i/archify.git .tools/archify
node .tools/archify/archify/bin/archify.mjs finalize workflow docs/pmt-docs/workflows/message-delivery.workflow.json docs/pmt-docs/workflows/message-delivery.html --repo-root . --quality showcase --out-dir .tools/archify-evidence/new-message-review --json
node .tools/archify/archify/bin/archify.mjs finalize sequence docs/pmt-docs/workflows/session-recovery.sequence.json docs/pmt-docs/workflows/session-recovery.html --repo-root . --quality showcase --out-dir .tools/archify-evidence/new-session-review --json
node .tools/archify/archify/bin/archify.mjs finalize workflow docs/pmt-docs/workflows/file-round-trip.workflow.json docs/pmt-docs/workflows/file-round-trip.html --repo-root . --quality showcase --out-dir .tools/archify-evidence/new-file-review --json
```

clone은 `.tools/archify`가 없을 때만 한다. 새 JSON으로 HTML을 교체할 때마다 새 evidence directory를 써서 이전 증거를 보존한다. `finalize`가 코드 revision·source 줄 범위·schema/layout·전달·provenance·실제 browser-check를 검사한다. exit0과 모든 gate pass를 확인한다. HTML hash와 원천 hash를[검증 요약](workflows/verification.json)에서 확인한다.

shallow clone에 고정 코드 revision이 없으면 `git fetch origin 9d13adfe74bb7bd9bf8e468801e4fec378b82760`으로 해당 객체를 가져온 뒤 검증한다. 원천을 바꿔 재생성했다면 새 capture·검증 요약도 함께 갱신한다.

미리보기 이미지와 provenance 있는 `visual-check` capture를 별도로 검사했다. 상세 source receipt·과거 실패/수정 후보는 Git 제외 `.tools/archify-evidence/`에 둔다. 임시 lock/recovery 파일을 임의 삭제해 검증을 통과시키지 않는다. 코드가 달라지면 `meta.repository.revision`과 해당 sources를 실제 커밋에 맞춰 다시 검증한다.

생성 viewer runtime의 저작권은[Archify/Cocoon MIT license](workflows/ARCHIFY-LICENSE.txt)를 따른다. 도식 검사 결과와 j-messenger의 기능 시험 결과는 각각[검증 요약](workflows/verification.json)과[구현·시험 정리](15-implementation-guide.md)에 기록한다.

검증된 generated HTML은 원본 byte와 upstream 공백을 보존한다. `.gitattributes`의 해당 HTML에만 줄끝 공백 검사 예외를 적용하고 JSON·문서·코드는 기존 UTF-8/LF 규칙을 유지한다. Git blob과 검증 요약의 SHA-256이 같아야 한다.
