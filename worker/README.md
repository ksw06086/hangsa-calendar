# Google Sheets / GitHub Pages 전환

기존 Node.js + SQLite 서버의 API를 Cloudflare Worker로 옮긴다. 정적 화면은 GitHub Pages, 표 데이터는 Google Sheets, 첨부파일은 비공개 Google Drive 폴더에 둔다. 로그인 ID와 비밀번호 해시는 그대로 이전한다. 기존 세션과 텔레그램 임시 링크는 보안상 이전하지 않는다.

## 1. Google 저장소 준비

1. Google Cloud 프로젝트에서 Google Sheets API와 Google Drive API를 사용 설정한다.
2. 서비스 계정을 만들고 JSON 키를 내려받는다. JSON 키는 저장소에 넣지 않는다.
3. 빈 Google 스프레드시트와 전용 Drive 폴더를 만든다. 두 항목을 서비스 계정 이메일에 편집 권한으로 공유한다.
4. 스프레드시트 ID와 Drive 폴더 ID를 `wrangler.toml`의 `SHEETS_SPREADSHEET_ID`, `GOOGLE_DRIVE_FOLDER_ID`에 넣는다. 첫 API 호출 때 데이터 탭이 자동 생성된다.

Worker는 `departments`, `event_types`, `users`, `events`, `history`, `posts`, `files`, `notifications`, `sessions`, `tickets`, `settings` 탭을 사용한다. 각 탭의 첫 행은 열 이름이다.

## 2. Worker 배포

Cloudflare Workers Free 플랜으로 배포할 수 있도록 `wrangler.toml`에 유료 전용 CPU 한도를 지정하지 않는다. Free 플랜은 요청당 CPU가 10ms로 제한된다. 네트워크 대기 시간은 CPU에 포함되지 않지만, 로그인과 비밀번호 변경은 기존 scrypt 해시를 검증·생성하므로 이 제한을 넘길 수 있다. 배포 후 실제 로그인과 비밀번호 변경을 확인해야 하며, Cloudflare `1102` CPU 제한 오류가 나면 현재 인증 방식을 유지하면서 Free 플랜에서 안정적으로 운영할 수 있다고 보장할 수 없다. Cloudflare 계정으로 `npx wrangler login`을 실행하고 `wrangler.toml`의 `ALLOWED_ORIGIN`과 `PUBLIC_URL`을 실제 GitHub Pages 주소에 맞춘다.

- `ALLOWED_ORIGIN`: `https://계정명.github.io`처럼 도메인 원점만 입력한다.
- `PUBLIC_URL`: `https://계정명.github.io/저장소명`처럼 저장소 경로를 포함한다. 끝에 `/`는 붙이지 않는다.

다음 값을 Worker 비밀 변수로 등록하고 배포한다.

```powershell
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT
npx wrangler secret put MIGRATION_SECRET
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_NOTICE_CHAT_ID
npm run deploy:worker
```

`GOOGLE_SERVICE_ACCOUNT` 값에는 서비스 계정 JSON 전체를 넣는다. `MIGRATION_SECRET`은 긴 무작위 값으로 만들고, 동일한 값을 로컬 `.env`의 `SHEETS_MIGRATION_SECRET`에만 넣는다. `.env`와 서비스 계정 JSON은 커밋하지 않는다. 업무 소통방 알림은 확정 요구사항에 따라 사용하지 않는다.

배포 후 `https://Worker주소/api/health`에서 `ok: true`를 확인한다. 이 호출은 Sheets 연결과 탭 생성을 확인한다.

텔레그램 행사 접수 기능을 쓸 경우 BotFather에서 `PUBLIC_URL`에 설정한 사이트 도메인을 해당 봇에 등록한다. Worker가 이전 서버의 `getUpdates` 폴링을 대신하므로 두 서버를 동시에 실행하지 않는다.

## 3. GitHub Pages 배포

GitHub 저장소 Settings → Pages에서 배포 원본을 **GitHub Actions**로 설정한다. 저장소 Settings → Secrets and variables → Actions → Variables에서 다음 변수를 만든다.

- `WORKER_API_URL`: 배포된 Worker의 기본 주소. `/api`를 붙이지 않는다.

데이터 이전이 끝난 뒤 `.github/workflows/pages.yml`을 `main` 또는 `master` 브랜치에 반영한다. GitHub Actions가 `public/`을 Pages로 배포한다. API 주소는 빌드 과정에서 `public/config.js`에 주입된다.

## 4. 기존 SQLite 데이터 이전

1. 새 스프레드시트와 Drive 폴더의 공유 권한, Worker 비밀 변수와 Pages 주소를 먼저 설정한다.
2. 기존 Node 서버를 정지하고 `data/` 폴더를 별도 백업한다.
3. 로컬 `.env`에 `SHEETS_API_URL`(Worker 기본 주소)과 `SHEETS_MIGRATION_SECRET`(Worker 비밀 변수와 동일한 값)을 넣는다.
4. 프로젝트 폴더에서 `npm run migrate:sheets`를 실행한다. `data/calendar.sqlite`는 읽기 전용으로 열고 행사·계정·변경 이력을 Sheets에, 기존 첨부파일을 Drive에 옮긴다.
5. 이전 완료 메시지를 확인한 뒤 Pages 주소에서 `admin`과 기존 부서 계정으로 로그인한다.

이전 중단 후 다시 실행할 수 있다. 완료 표시가 기록된 뒤에는 중복 이전을 차단한다. 알림 대기열은 이전 후 중복 발송되지 않도록 발송 완료 상태로 옮긴다. 로그인 세션과 기존 텔레그램 임시 링크는 새로 발급된다.

첨부 업로드는 8MiB 단위의 Drive 재개 업로드를 사용하므로 Worker 요청 본문 크기 제한에 맞춰 전송한다. Google Drive 저장 용량과 공유 폴더 정책은 해당 Google 계정에서 관리한다.

## 5. 운영 전환

기존 Node 서버와 새 Worker가 같은 Telegram 봇을 동시에 폴링하지 않도록, 전환할 때 기존 서버를 정지한다. Worker는 매분 Telegram 업데이트를 확인하고 알림 전송 대기열을 처리한다. 이전 데이터와 첨부파일을 확인할 때까지 `data/` 백업을 보관한다.
