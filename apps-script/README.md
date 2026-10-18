# 개인 Gmail Drive 연결

Worker의 시트 저장은 Google 서비스 계정으로 유지하고, 파일 업로드·삭제·저장 공간 조회는 개인 Gmail 소유의 Apps Script 웹 앱을 통해 실행한다. Google 서비스 계정은 개인 Drive 저장 공간을 소유할 수 없기 때문이다.

## Apps Script 웹 앱 만들기

1. 개인 Gmail 계정으로 `https://script.google.com`에 접속해 새 프로젝트를 만든다.
2. 기본 `Code.gs` 내용을 저장소의 `apps-script/Code.gs` 내용으로 교체한다.
3. 프로젝트 설정에서 `appsscript.json` 매니페스트 파일 표시를 켜고, 해당 파일 내용을 `apps-script/appsscript.json` 내용으로 교체한다.
4. 프로젝트 설정의 스크립트 속성에 `DRIVE_UPLOAD_SECRET`을 추가하고, 직접 만든 긴 임의 문자열을 값으로 입력한다. 이 값은 Worker 비밀값에도 똑같이 등록한다.
5. **배포 → 새 배포 → 웹 앱**을 선택한다. 실행 사용자는 **나**, 액세스 권한은 **모든 사용자**로 설정하고 배포한다.
6. Google Drive 접근 권한을 요청하면 허용한다. 배포가 끝나면 `/exec`로 끝나는 웹 앱 URL을 복사한다.

웹 앱은 비밀값을 확인한 뒤에만 동작한다. URL이나 비밀값을 공개하지 않는다.

## Worker 연결

`wrangler.toml`의 `DRIVE_UPLOAD_WEBAPP_URL`을 복사한 웹 앱 URL로 바꾼다. Worker 비밀값을 등록하고 배포한다.

```powershell
npx wrangler secret put DRIVE_UPLOAD_SECRET
npm run deploy:worker
```

비밀값을 물으면 Apps Script 스크립트 속성에 입력한 것과 같은 문자열을 입력한다. `GET https://<Worker 주소>/api/health`가 성공하면 시트와 개인 Drive 연결이 확인된 것이다.

## 기존 이전 이어가기

기본 데이터는 Sheets에 이미 기록되어 있고, 첨부파일 이전이 남아 있다. 연결 확인 뒤 프로젝트 폴더에서 `npm run migrate:sheets`를 다시 실행한다. 이전 상태가 `importing`이면 덮어써서 이어가며, 업로드 완료된 파일은 재업로드하지 않는다.
