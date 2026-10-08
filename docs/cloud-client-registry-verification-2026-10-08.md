# M2/MS-05 공유 패키지 registry 검증 — 2026-10-08

상태: **게시·정확 버전 소비 검증 완료; 그룹웨어 정식 화면/VM 인수 미완료**. [BFF transport](cloud-bff-client-verification-2026-10-08.md)와 [제품군 S10](../../j-groupware/docs/architecture.md#s10)을 따른다.

`@j-messenger/contracts`, `@j-messenger/client-core`, `@j-messenger/client-react`의 **0.2.0**을 기존 격리 loopback Verdaccio127.0.0.1:4873에 최초 게시했다. 공개 npm/운영 registry에는 게시하지 않았다. 앱/server/root는 private로 보존한다. 공유3개만 배포 파일을 dist/README/CHANGELOG로 제한하고 publishConfig를 loopback으로 고정했다. j-groupware의 guarded publish 함수가 실제 exact-version404를 확인한 뒤 게시하고 이미 있는 버전은 거절한다. 자격 파일은 체크아웃 밖이며 npm cache도 쓰기 가능한 클라우드 경로를 명시했다. 기존 registry 데이터·회원·다른 버전은 바꾸거나 삭제하지 않았다.

React component는 host와 같은 React/React DOM19.3.0 peer를 사용한다. 기존 앱도 해당 버전을 쓰며 소스/기능을 보존했다. CSS export와 sideEffects를 선언해 consumer bundler가 스타일을 포함하도록 했다. [npm package.json의 peer/files/publishConfig](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)와 [Vite CSS 처리](https://vite.dev/guide/features#css)를 확인했으며 새 라이브러리 버전은 추가하지 않았다.

- 전체 메신저 check/build/format 통과. 계약10·core17·React13·서버94·web4·배포11과 desktop 타입/경계를 유지했다.
- 실제 registry consumer 시험 **1/1**, Node24와 최소 Node22.18에서 각각 통과, 실패/skip0. 빈 consumer가 정확0.2.0과 정확 peer/type 버전을 설치했다. 세 패키지의 registry SHA-512와 현재 npm pack 결과/consumer lock이 일치한다. pack allowlist에 src/tests/env/runtime이 없고 host React가 한 개임을 확인했다.
- 실제 설치된 core의 공개 API·그룹웨어 URL/쿠키/Bearer 비노출을 실행했고 공개 component 타입을 TypeScript로 검사했다. 소비자 Vite build는 설치된 component와 CSS를 실제 JS/CSS 산출물로 만들었다. duplicate publish는 immutable guard로 거절된다. 이 consumer의 backend 응답 한 건은 transport fixture이며 실제 로그인/브라우저 UI 인수로 계산하지 않는다.
- 별도 j-groupware checkout은 공개 `@j-messenger/client-core@0.2.0` dev dependency와 lock 무결성을 추가했다. 실제 BFF 시험에서 이 registry 설치본을 사용하며 sibling core source를 가져오지 않는다. offline npm ci도 실제231개 패키지를 설치했다. 해당 전체 BFF 결과는 [그룹웨어 consumer 기록](../../j-groupware/docs/cloud-client-registry-verification-2026-10-08.md)에 남긴다.

원본은 체크아웃 밖 `client-registry-results.log`, `client-registry-node22.log`, `registry-ms-check.log`, `registry-ms-format.log`이다. 최초 guarded publish는 npm 쓰기 cache를 명시하지 않아 CLI254로 중단했고 게시 성공으로 세지 않았다. 외부 cache를 명시한 후 실제 게시/설치/무결성 시험을 실행했다.

새 패키지를 수정할 때는 버전을 올려 immutable 원칙을 지킨다. 검증 명령은 `npm run test:registry`이며 registry와 체크아웃 밖 자격 profile이 없으면 실패하고 skip하지 않는다. 기능 UI 토큰/MS-07·독립 앱 제품 경로 동결/MS-08·정식 그룹웨어 shell·브라우저/VM/전체 인수는 후속이다. 회사 노트북·운영 source/키·PR/main·배포는 변경하지 않았다. Windows PMT 상태/도구는 없어 저장소 증거로 범위를 기록했다.
