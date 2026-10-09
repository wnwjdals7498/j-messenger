# Task 25 MS-07 공통 UI 토큰 검증

`client-react`의 CSS에 공통 `--jgw-*` 색상·간격·표면 토큰을 적용했다.
키보드 focus를 표시하고 380px 이하 로그인·입력 화면의 여백과 overflow를
조정했다. 기존 native 로그인 및 서버 선택 흐름은 유지한다.

Node 22.18.0·24.19.0에서 각각 `npm run check --workspace=@j-messenger/client-react`
13개 시험과 typecheck가 통과했다. build 산출물을 loopback 전용 registry의
`@j-messenger/client-react@0.2.2`로 게시하고 앱 및 그룹웨어 소비자를 정확한
버전으로 고정했다. 0.2.0과 중간 0.2.1 버전은 덮어쓰지 않았다.

그룹웨어의 `node --test tests/ui/browser.test.mjs`도 두 런타임에서 통과했다.
설치한 0.2.2의 공개 JavaScript·CSS를 실제 Chromium에서 렌더링해 공통 토큰,
360px·1440px overflow, 키보드 focus를 확인했다. 메신저 API는 fixture이므로
실제 메신저 연결·제품 전체 UI·고객 VM 인수를 통과한 것으로 계산하지 않는다.

실행 로그는 `/workspace/.suite-runtime/j-groupware/`의
`task25-ms-final-ui22.log/.exit`, `task25-ms-final-ui24.log/.exit`,
`task25-ms-public-ui-final-build22.log/.exit`,
`task25-ui-public-final22.log/.exit`, `task25-ui-public-final24.log/.exit`다.
모두 exit 0이다. 초기 브라우저 경로 실패와 캐시는 별도로 보존했다.

추가로 기존 fresh registry consumer 시험의 0.2.0 고정 전제를 각 패키지의
현재 정확 버전으로 바꿨다. Node 22/24에서 source pack SHA-512와 registry
integrity 일치, 신규 소비자 설치·공개 타입 검사·브라우저 build·CSS 공통 토큰
보존·React 단일 인스턴스·중복 버전 게시 거절을 각각 확인했다. 최종 읽기
전용 소비자 실행 로그는 `task25-ms-registry-owned-final22.log/.exit`와
`task25-ms-registry-owned-final24.log/.exit`이며 각 1개 시험·exit 0이다.
