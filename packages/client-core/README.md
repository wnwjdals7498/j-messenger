# @j-messenger/client-core

메신저 client의 송수신·동일 ID 재시도·snapshot/cursor sync·연결 복구 상태를 소유한다. `@j-messenger/contracts@0.2.0`을 사용하며 이 패키지도 `0.2.0`을 정확히 고정한다.

standalone은 `createMessengerClient`를 사용한다. 이미 로그인한 그룹웨어 세션은 `createGroupwareMessengerClient({origin,csrfToken})`를 사용하며 HTTP는 `/api/messenger/api/v1`, WSS는 `/api/messenger/ws`로 고정된다. origin은 현재 브라우저의 canonical HTTPS origin이어야 한다. 쿠키를 포함하고 변경마다 최신 CSRF를 읽으며 Bearer는 노출하지 않는다. 로그인·로그아웃과 미지원 파일/native 기능은 그룹웨어 shell에서 관리한다.

build/check 후 j-groupware의 guarded `scripts/registry-publish.mjs --package <이 패키지 경로>`로 loopback registry에 게시한다. publishConfig도127.0.0.1:4873이다. 같은 버전을 다시 게시하거나 내용만 고치지 않는다.
