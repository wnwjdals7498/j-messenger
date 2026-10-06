# Android 웹 앱 패키징·Pixel 10 검증

기준일: 2026-10-06. 사용자 요청으로 이전 Android 제외 범위를 이번 작업에서 대체했다. 기존 React Web을 APK에 포함하며 업무 API·WSS와 메시지/파일 저장은 VM이 맡는다. 실제 메일 인증·앱스토어 배포·종료 상태 푸시는 이번 범위 밖이다.

## 구현 범위

| 항목 | 의미 |
| --- | --- |
| 목적 | 웹 기능을 재사용하는 설치형 Android 앱을 Pixel_10에서 실제 검증 |
| 입력 | 빌드된 Web assets, VM HTTPS origin, 검증한 공개 lab CA, Android SDK/JDK, 지정 AVD의 설치·실행 결과 |
| 출력 | 서명된 debug APK, 기기에서 관찰한 로그인/통신/파일/복구 결과, 안전한 시험 요약·화면·미검증 범위 |
| 코드 책임 | `apps/android`는 네이티브 shell·asset/TLS/navigation·파일/수명주기를 소유. `apps/web/src/android-files.ts`는 공개 파일 port 연결. 서버 계약·권한·CORS는 변경하지 않음 |
| UI | Java Activity·Android WebView·WebViewAssetLoader가 APK 내부 HTML/JS/CSS를 `https://10.77.0.10/_app/` 아래 제공 |
| 통신 | 동일 HTTPS origin의 `/api`와 WSS는 실제 VM `https://10.77.0.10`로 연결. PC 중계 없음 |
| 인증 | WebView의 기존 Web cookie 흐름 사용. HttpOnly 세션을 JS bridge나 일반 설정에 노출하지 않음. Android bearer/Keystore 별도 클라이언트의 완료로 보고하지 않음 |
| 파일 | 선택한 content URI의 형식·실제 크기 검사, 최대5,000,000 bytes. 승인된 다운로드 Blob만 origin/main-frame 제한 WebMessage로 전달해 private cache→시스템 저장창→선택한 content URI에 저장 |
| 실패 처리 | 외부 host·cleartext·SSL 오류 거부, 선택/저장 취소 구분, 파일 크기/권한/renderer 실패의 안전한 UI. native credential JS interface는 제공하지 않음 |
| Test | 실제 기기 WebView UI·VM HTTPS fixture·WSS·화면 재생성·IME 가시성/입력영역·회전·시스템 뒤로가기·로그아웃·문서 선택/저장·전체 byte 일치, TS bridge 용량/취소/응답4개 회귀 |
| 로그 | cookie/password/token/body/파일 내용·원본 경로를 기록하지 않음. 시험 이름·건수·정적 실패 code·서버 requestId 등 metadata만 사용 |

debug는 공개 CA SHA-256 `DA1DDD9CB6B2B3C05A3AC9771D45748B7EA888AF10D850A01CBD11896B8B31E0`를 검사해 VM domain에만 신뢰한다. Android OS의 전체 인증서 저장소는 변경하지 않는다. release는 시스템 CA만 사용하며 lab CA를 자동으로 신뢰하지 않는다.

## 실제 환경·빌드

- 지정 AVD `Pixel_10`, serial `emulator-5554`, Android17/API37, x86_64·16KB page image. 실행 중인 프로세스는 초기 ADB에 연결되지 않아 동일 AVD를 software GPU·cold boot로 다시 실행했다. 사용자 data는 wipe하지 않았다.
- 설치 WebView provider `com.google.android.webview` 149.0.7827.5. 다른 Android/실물 기기 시험은 미수행이다.
- Gradle9.3.1·AGP9.1.0·SDK/target36·BuildTools36.0.0·min24·Android Studio JBR21 사용. AndroidX WebKit1.17.1·Activity1.13.0 고정.
- Windows JDK의 Unix-domain 내부 IPC 오류는 짧은 process-only TEMP/TMP/java.io.tmpdir로 해결했다. 재현 스크립트는 `scripts/build-android.ps1`, 기본 임시 폴더는 `D:/jmtmp`이며 전역 사용자 환경 변수는 변경하지 않는다.
- `apps/android/gradlew.bat`과 wrapper를 포함한다. 공식 Gradle9.3.1 all distribution SHA-256은 `17f277867f6914d61b1aa02efab1ba7bb439ad652ca485cd8ca6842fccec6e43`이다.
- APK package는 `com.jmessenger.android.lab`, signed debug build다. 앱·시험 APK는 `apps/android/app/build/outputs/apk/` 아래 생성된다.

전달용 APK는 `data/android/j-messenger-lab-debug.apk`이며 크기는4,105,613 bytes다. SHA-256은 `0386e735411cfdcbce4a2c5b314131110da97900ef420b0da4995074ffdf5989`, companion checksum은 같은 폴더의 `.apk.sha256`이다. `apksigner verify`로 debug 서명(v2)을 검증했고 APK 안의 index·JS·CSS와 `/_app/assets/` 주소를 확인했다. 이 APK는 lab 주소·CA가 고정된 시험용이다. 현재 VM leaf 인증서 만료일은2026-11-05 UTC이며 이후에는 유효한 인증서를 갱신해야 한다.

시험 전용 파일은 `/sdcard/Download/jmessenger-android-fixture.txt`로 만들고 기기 검증은 이름이 일치하는 AVD에만 실행한다. 초기 System UI 미응답 경고는 앱 오류와 분리했다. 시험은 실제 OS의 해당 경고에서 Wait를 선택하고 사라짐을 확인하며 앱 자체 ANR 또는 지속 경고는 실패로 판정한다. 화면 증거는 실제 가시성 확인 후 app-scoped 외부 files/instrumentation에 저장한다.

## 실행 결과

최종 AndroidJUnit 기기 시험 **2개 모두 통과**, 실행시간127.238초다. Alice의 실제 WebView 대화 생성·송신을 Bob의 VM HTTPS 세션에서 확인하고, Bob의 응답을 실제 WSS로 받았다. Activity 재생성 후 세션·기록 복구, 실제 IME 표시·ASCII 입력·composer/send 가시성, 가로/세로 회전, 키보드만 닫는 첫 Back·대화 목록으로 돌아가는 다음 Back, 로그아웃을 확인했다. 파일 시험은32-byte TXT fixture를 실제 시스템 선택기로 고른 뒤 VM 업로드·Bob의 인증 다운로드·시스템 저장창·저장 완료 응답·기기 파일 전체 byte 일치를 확인했다.

웹·공통 코드의128개 시험·타입/lint/형식과 APK·시험 APK 빌드가 통과했다. Android lint는0 errors·2 warnings이며 React의 JavaScript 사용과 고정 Gradle 버전의 최신 버전 안내다. assertion 약화·skip 없이 검증했다. 누적 lab 대화의 history 조회와 서버100/min 정책을 고려해 기기 시나리오 사이65초를 둔다. 버스트 요청 허용량과 실제 부하 평가는 별도다.

시험 결과는 `data/android/instrumentation-result.txt`, 성공 화면은 같은 폴더의 `two-user-live-message.png`·`restored-session.png`·`landscape-session.png`·`file-downloaded.png`다. 최종 VM journal910건에서 금지 field·시험 비밀번호/본문/파일 내용 누출·logging drop은0건이고 Android app crash buffer도0건이다. 안전한 집계만 `data/android/logging-summary.json`에 보관하고 원문 journal은 Git에서 제외한 `.tools/android/`에 둔다. 앱 source는 원문 메시지/파일/자격 증명 logging을 추가하지 않았다. 시험 뒤 회전 설정을 이전 값으로 복구하고 Pixel_10에 앱을 다시 열었다. 사용자 수정 `web/test/login.test.ts`의 SHA-256은 작업 전후 동일하다.

시험 중 첫 WebSocket ready에서 전체 history를 다시 받는 중복을 발견했다. 공통 client는 대화 목록의 서명 snapshot cursor를 보존하고 그 이후 변경을 sync로 회수하도록 수정했다. 대화 수를N이라고 하면 복원당 중복GET N+1개를 줄인다. 같은 cursor codec의 사용자·서버·epoch 검증을 유지하며, 중복 이벤트 병합·ready 이전 변경·재연결 회귀를 확인했다. 읽음 요청 실패 때 즉시 반복하던 React 경로도 중단하고 다음 가시성 사건에서 다시 시도하도록 보완했다. 서버의100/min 제한이나 권한은 완화하지 않았다.

기기에서 발견한 실제 UI 문제도 수정했다. 입력칸에 초점이 있으면 native Back이 먼저 blur·IME 닫기를 처리하여 대화가 유지된다. 다음 Back은 화면 방향과 관계없이 대화 선택을 해제한다. 공통 화면의 최소 높이560px 때문에 가로 화면 아래가 잘리던 문제는 실제 viewport 높이에 맞게 줄어들도록 고쳤다.

검증 범위는 지정 Pixel_10 가상기기다. 실물 기기·다른 Android/WebView 버전·한글 IME별 조합·강제 종료/백그라운드 알림·앱스토어 release 배포는 미검증이며 실제 메일 시험은 서버가 없어 제외한다. Android의5MB 파일 전체 왕복은 별도로 실행하지 않았고, 이번 기기 byte 시험과 기존 Web/VM의5MB 경계 시험을 구분한다.

## 공식 근거

- [APK 내 콘텐츠와 WebViewAssetLoader](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)
- [앱·domain별 TLS trust 설정](https://developer.android.com/privacy-and-security/security-config)
- [AGP9.1 호환 조건](https://developer.android.com/build/releases/agp-9-1-0-release-notes)
- [AndroidX WebKit](https://developer.android.com/jetpack/androidx/releases/webkit), [Activity](https://developer.android.com/jetpack/androidx/releases/activity)
- [OpenJDK Windows Pipe 구현](https://github.com/openjdk/jdk21u/blob/master/src/java.base/windows/classes/sun/nio/ch/PipeImpl.java)
