# 나라장터(G2B) 입찰공고정보 프록시 서버

data.go.kr 서비스키를 브라우저에 노출하지 않고, 안전보건관리계획서 자동생성 화면(HTML)이
나라장터 공고를 검색할 수 있게 해주는 중계 서버입니다.

## 왜 필요한가

- data.go.kr은 브라우저에서 오는 직접 요청(CORS)을 허용하지 않는 경우가 많습니다.
- 서비스키를 프론트엔드 코드에 넣으면 화면 소스에 그대로 노출되어 유출 위험이 있습니다.
- 이 서버가 대신 data.go.kr을 호출하고, 결과만 정리해서 브라우저로 돌려줍니다.

## 실행 방법

```bash
cd server
npm install
cp .env.example .env
```

`.env` 파일을 열어 `NARA_SERVICE_KEY`에 data.go.kr에서 발급받은 **일반 인증키(Decoding)** 를 붙여넣으세요.

```bash
npm start
```

정상 기동 시 다음이 출력됩니다.

```
[nara-bid-proxy] 서버 실행 중 → http://localhost:8787
```

## 발주처별 양식 등록·재사용

data.go.kr 검색과는 별개로, 이 서버는 **발주처마다 다른 안전보건관리계획서 항목 구성**을 `templates.json`에 저장합니다.

- `GET /api/templates` — 저장된 모든 발주처 양식 스키마 조회
- `POST /api/templates` — 화면에서 AI가 새 발주처 양식 원문을 분석해 만든 스키마를 등록/갱신
- `DELETE /api/templates/:id` — 잘못 등록된 양식 제거

화면(STEP 01)에서 "새 발주처 양식 등록"으로 원문을 붙여넣고 등록하면 자동으로 이 서버에 저장되며,
이후 같은 서버를 쓰는 누구나 그 발주처를 다시 선택할 수 있습니다. `templates.json`은 데이터베이스이므로
정기적으로 백업하는 것을 권장합니다.

## 확인

```bash
curl http://localhost:8787/health
curl "http://localhost:8787/api/bids?keyword=울타리&days=14"
```

## 안전보건관리계획서 화면과 연결하기

`안전보건관리계획서_자동생성_시스템.html`을 열고 STEP 01 화면의 "프록시 서버 주소"란에
`http://localhost:8787`을 입력하면 화면에서 바로 검색이 됩니다. 서비스키는 화면에 입력할 필요가
없습니다(서버 .env에만 존재).

## 배포 시 주의사항

- `.env`는 절대 커밋하지 마세요(`.gitignore`에 포함).
- 운영 환경에서는 `ALLOWED_ORIGINS`에 실제 프론트엔드 도메인만 지정해 CORS를 제한하세요.
- data.go.kr 호출량은 하루 단위로 제한되어 있으니(활용신청 시 부여된 트래픽), 캐싱 또는
  호출 빈도 제한을 추가로 고려하세요.
- 이 서버는 "공사" 입찰공고(getBidPblancListInfoCnstwk01) 하나만 연결되어 있습니다. 물품/용역
  공고까지 확장하려면 같은 패턴으로 `/api/bids-goods`, `/api/bids-service` 라우트를 추가하고
  각각의 data.go.kr 오퍼레이션 명을 바꿔 넣으면 됩니다.
