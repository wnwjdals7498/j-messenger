# j-messenger 웹
데모 모드는 브라우저 메모리의 표본 데이터로 동작하고 서버에 연결하지 않는다.

## 실행 (WSL)
`ash
cd /mnt/d/workspace/test-space/github/j-messenger
npm --prefix web install
npm --prefix web run dev
`
Windows 브라우저에서 http://localhost:5173 을 연다.

## 데모 계정
| 서버 | 아이디 (A사 메일) | 비밀번호 |
|------|----------------------|----------|
| A사 메일 | alice, bob, carol | 비어 있지 않은 아무 값 |
| B사 메일 | dave, erin | 비어 있지 않은 아무 값 |

## 확인 절차
1. alice로 로그인
2. 팀 채널 선택
3. 메시지 3개와 날짜 구분선 2개 확인
4. 메시지 전송
5. 목록 맨 위로 이동 확인
6. 브라우저 폭 360px에서 목록↔대화 전환(← 버튼) 확인
7. 로그아웃

## 명령

pm --prefix web test (전체 테스트)

pm --prefix web run build (타입 검사 + 빌드, 결과는 web/dist)
