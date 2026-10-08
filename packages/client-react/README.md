# @j-messenger/client-react

기존 `MessengerApp`과 props/client/file bridge 타입을 제공한다. core/contracts를 정확히0.2.0으로 사용하며 React·React DOM19.3.0은 host의 peer dependency다. 같은 React 인스턴스를 공유하려면 host도 정확한 버전으로 설치한다.

component가 CSS를 포함하고 `@j-messenger/client-react/styles.css`로도 스타일을 가져올 수 있다. CSS side effect를 보존한다. 현재 component의 native 로그인/서버 선택 흐름을 보존했으며 그룹웨어 shell·로그인 ownership·공식 UI 토큰 적용은 별도 후속이다. 패키지 build 성공을 그룹웨어 화면 인수로 계산하지 않는다.

build/check 후 j-groupware의 guarded `scripts/registry-publish.mjs --package <이 패키지 경로>`를 사용해 loopback registry에 게시한다. 같은 버전은 다시 게시하지 않는다.
