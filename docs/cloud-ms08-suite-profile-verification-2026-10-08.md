# MS-08 제품군 서버 패키징 검증

실행일: 2026-10-08. 이 기록은 `j-groupware-internal-messenger` 전용 빌드·패키징 경로만 다룬다. 기존 기본 build/check와 독립 Web·desktop·Android 소스 및 제품 경로는 유지했다. 운영 설치·배포와 native 실행 파일 빌드는 수행하지 않았다.

## 전용 프로필

`deploy/suite-profile.json`과 `deploy/build-suite-profile.mjs`가 `@j-messenger/contracts`와 `@j-messenger/server`만 빌드한다. 산출물에는 서버 실행 파일(dist), 계약 dist, 각 workspace manifest, PostgreSQL migration, 서버 service unit, 프로필 설정 및 전용 root package manifest가 들어간다. PostgreSQL migration은 서버 초기화에 필요한 런타임 파일이다. 전용 root manifest는 server와 contracts의 `file:` 의존성만 선언한다.

산출물에는 `apps/web`, `apps/desktop`, `apps/android`, `packages/client-core`, `packages/client-react`가 포함되지 않는다. 이 client 패키지들은 기존 MS-05 registry 배포 경로에 남는다. 소스 저장소와 기존 `npm run build`·`npm run check` 작업 목록은 수정하지 않았다. standalone 소스는 계속 저장소에 존재한다.

제품군 서버는 내부 API/BFF transport로 실행하며 프로필 런타임은 `AUTH_MODE=j-auth`, `DATABASE_DRIVER=postgres`를 요구한다. 서버의 정적 UI route는 `AUTH_MODE=j-auth`에서 등록하지 않아 `/`와 `/index.html`은 404다. 이 모드에서 `WEB_DIST`는 사용하지 않는다.

패키징은 빌드 전에 기존 출력 파일을 거절한다. 압축 파일은 목적지와 같은 디렉터리의 권한 제한 임시 디렉터리에 만들고 exclusive hard link로 게시하므로, 게시 경쟁이 생겨도 기존 목적지를 덮어쓰지 않는다. 회귀시험은 기존 파일의 바이트가 그대로 보존되는지 확인한다.

## 검증

`npm run test:suite-profile`을 Node 22.18.0과 Node 24.19.0에서 각각 실행했다. 각 런에서 실제 contracts/server build와 `.tar.gz` 생성을 수행하고, 압축 해제 후 포함·제외 경로를 검사했다. 패키징된 `application.js`를 실제 workspace dependency tree와 연결해 import했다. 두 환경 모두 두 테스트 통과했다. 이 test의 import check는 설치된 workspace dependency tree를 사용하며 cold install을 단독으로 증명하지 않는다.

별도 cold-install 검증은 `/tmp/jm-suite-cold-20261008/suite.tar.gz`를 새 디렉터리에 풀어 `node_modules`가 없는 상태에서 수행했다. Node 22.18.0에서 `npm install --omit=dev --ignore-scripts --no-audit --no-fund --registry=http://127.0.0.1:4873`와 지정된 user config/cache를 사용해 130개 package를 설치했다. 생성된 lockfile에는 136개 package entry가 있고 `@j-auth/token-verifier`는 server manifest와 lockfile에서 모두 0.1.0이며 lockfile integrity가 내부 registry metadata와 일치했다. 설치된 의존성을 사용해 `application.js`를 실행했고 Node 22.18.0과 24.19.0에서 `/` 및 `/index.html` 404, `/health/ready` 200을 확인했다. 기존 workspace 의존성 symlink는 사용하지 않았다. archive는 99개 파일, 146586 bytes, SHA-256 `b60d6c395215fb717ccb2a422fc92dd23bfb74782f981c8d57fb4a73ba276813`이다. 이 검증은 전용 테스트 DB와 ephemeral loopback port를 사용했으며 3001은 사용하지 않았다. 운영 설치를 수행한 것은 아니다.

추출본 cold-install tree에서 실행한 서버와 별개로, 기존 smoke test도 actual PostgreSQL test DB의 고유 schema와 실제 j-auth tenant/Keycloak origin 설정으로 실행했다. 수신 포트는 OS가 할당한 loopback ephemeral port였다. 테스트는 인증이 필요한 route를 호출하지 않아 Keycloak token 검증 동작의 재시험을 뜻하지 않는다. 각 실행 종료 후 테스트 schema만 제거했다.

검증 로그 및 JSON 결과는 다음 외부 임시 경로에 남겼다.

- `/tmp/jm-suite-profile-tests-node22.log`
- `/tmp/jm-suite-profile-tests-node24.log`
- `/tmp/jm-suite-profile-http-node22.json` 및 `/tmp/jm-suite-profile-http-node22.log`
- `/tmp/jm-suite-profile-http-node24.json` 및 `/tmp/jm-suite-profile-http-node24.log`
- `/tmp/jm-suite-cold-20261008/` (cold-install archive, extracted tree, private npm output, exact runtime versions, and sanitized HTTP results)
- `/tmp/jm-suite-cold-20261008/test-node22.log` 및 `test-node24.log` (각 exact Node 버전에서 2/2 통과)

ESLint와 Prettier 검사는 추가된 build script·suite profile test·HTTP smoke script·profile JSON에서 통과했다. PMT 상태 변경과 Windows PMT 경로 기록은 해당 도구 경로가 이 환경에 없어 수행하지 않았다. 실제 서비스 설치, 운영 배포, 고객 VM 인수 및 native executable 빌드는 이 검증 범위 밖이다.

전용 프로필을 합친 뒤 기존 `npm run check` 전체와 실제 PostgreSQL 회귀 21/21을 Node 24.19.0에서 다시 실행해 통과했다. groupware의 실제 Keycloak·PostgreSQL·메신저 BFF 회귀도 125/125 통과했다. 외부 결과는 `.suite-runtime/j-messenger-pg/ready-suite-check.log`, `ready-postgres-full-results.json`, `.suite-runtime/j-groupware/ready-bff-full-results.json`에 남겼다.
