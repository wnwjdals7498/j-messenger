# @j-messenger/client-react

기존 `MessengerApp`과 props/client/file bridge 타입을 제공한다. core/contracts를 정확히0.2.0으로 사용하며 React·React DOM19.3.0은 host의 peer dependency다. 같은 React 인스턴스를 공유하려면 host도 정확한 버전으로 설치한다.

component가 CSS를 포함하고 `@j-messenger/client-react/styles.css`로도 스타일을 가져올 수 있다. CSS side effect를 보존한다. 0.2.2부터 공통 `--jgw-*` 색상·간격 토큰, 키보드 focus와 작은 화면 처리를 적용한다. native 로그인/서버 선택 흐름은 유지하며 그룹웨어 shell·로그인 ownership은 별도 후속이다. 공개 패키지의 Chromium fixture 검증과 실제 서비스·고객 VM 인수는 구분한다.

build/check 후 j-groupware의 guarded `scripts/registry-publish.mjs --package <이 패키지 경로>`를 사용해 loopback registry에 게시한다. 같은 버전은 다시 게시하지 않는다.
