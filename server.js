// ============================================================
// 나라장터(G2B) 입찰공고정보 API 프록시 서버
//
// 역할
//  - data.go.kr 서비스키를 서버(.env)에만 보관하고, 브라우저에는 절대 노출하지 않는다.
//  - 브라우저 fetch가 data.go.kr을 직접 호출하면 CORS 정책에 막히므로,
//    이 서버가 대신 호출한 뒤 CORS 허용 헤더를 붙여 프론트엔드로 돌려준다.
//  - data.go.kr이 인증 오류 시 XML로 응답하는 경우가 있어, JSON/XML 모두 처리해
//    프론트엔드가 항상 JSON만 받도록 정규화한다.
// ============================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_FILE = path.join(__dirname, "templates.json");

const app = express();
const PORT = process.env.PORT || 8787;
const SERVICE_KEY = process.env.NARA_SERVICE_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (!SERVICE_KEY) {
  console.error("[FATAL] .env 파일에 NARA_SERVICE_KEY가 설정되어 있지 않습니다.");
  console.error("        .env.example을 복사해 .env를 만들고 발급받은 서비스키를 넣어주세요.");
  process.exit(1);
}

// ---------------- CORS / BODY PARSER ----------------
app.use(
  cors({
    origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true, // 비어있으면 전체 허용(개발용)
  })
);
app.use(express.json({ limit: "2mb" }));

// ---------------- 공통 유틸 ----------------

// data.go.kr 서비스키는 이미 퍼센트 인코딩된 상태로 발급되는 경우가 많다.
// URLSearchParams에 그대로 넣으면 다시 인코딩되어(이중 인코딩) 인증에 실패하므로,
// 서비스키만 쿼리스트링에 직접 붙이고 나머지 파라미터만 URLSearchParams로 구성한다.
function buildUrl(baseUrl, params) {
  const usp = new URLSearchParams(params);
  return `${baseUrl}?serviceKey=${SERVICE_KEY}&${usp.toString()}`;
}

// data.go.kr은 인증 오류 등에서 JSON 대신 XML을 반환하는 경우가 있다.
// 두 경우 모두 처리해 프론트엔드에는 항상 { ok, items, raw } 형태의 JSON만 내려준다.
function parseNaraResponse(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed);
    const header = json?.response?.header;
    const body = json?.response?.body;
    if (header && header.resultCode !== "00") {
      return { ok: false, message: header.resultMsg || "나라장터 API 오류", raw: json };
    }
    let items = body?.items || [];
    if (items && !Array.isArray(items)) items = [items];
    return { ok: true, items, totalCount: body?.totalCount || items.length, raw: json };
  }
  // XML 오류 응답 처리 (인증키 오류 등)
  const authMsg = trimmed.match(/<returnAuthMsg>(.*?)<\/returnAuthMsg>/)?.[1];
  const errMsg = trimmed.match(/<errMsg>(.*?)<\/errMsg>/)?.[1];
  const resultMsg = trimmed.match(/<resultMsg>(.*?)<\/resultMsg>/)?.[1];
  return {
    ok: false,
    message: authMsg || errMsg || resultMsg || "나라장터 API가 XML 오류 응답을 반환했습니다.",
    raw: trimmed.slice(0, 500),
  };
}

function yyyymmddhhmm(date) {
  const p = n => String(n).padStart(2, "0");
  return (
    date.getFullYear().toString() +
    p(date.getMonth() + 1) +
    p(date.getDate()) +
    p(date.getHours()) +
    p(date.getMinutes())
  );
}

// 발주처별 안전보건관리계획서 양식 스키마 저장소.
// 프론트엔드가 원문 텍스트를 AI로 분석해 만든 JSON 스키마를 여기 저장해두면,
// 이 서버를 쓰는 모든 사용자가 같은 발주처 양식을 다시 분석할 필요 없이 재사용한다.
function loadTemplates() {
  try {
    return JSON.parse(fs.readFileSync(TEMPLATES_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveTemplates(all) {
  fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(all, null, 2), "utf8");
}
if (!fs.existsSync(TEMPLATES_FILE)) saveTemplates({});

// ---------------- 라우트 ----------------

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "nara-bid-proxy", time: new Date().toISOString() });
});

/**
 * GET /api/bids
 * 쿼리 파라미터:
 *   keyword    (선택) 공고명에 포함될 검색어 - bidNtceNm
 *   days       (선택, 기본 14) 최근 며칠간 등록된 공고를 조회할지
 *   numOfRows  (선택, 기본 10)
 *   pageNo     (선택, 기본 1)
 *
 * 대상 API: 나라장터 입찰공고정보서비스 - 공사(getBidPblancListInfoCnstwk01)
 */
app.get("/api/bids", async (req, res) => {
  try {
    const { keyword = "", numOfRows = "10", pageNo = "1" } = req.query;
    const days = parseInt(req.query.days || "14", 10);

    const end = new Date();
    const begin = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

    const params = {
      type: "json",
      numOfRows,
      pageNo,
      inqryDiv: "1", // 1: 공고게시일시 기준
      inqryBgnDt: yyyymmddhhmm(begin),
      inqryEndDt: yyyymmddhhmm(end),
    };
    if (keyword) params.bidNtceNm = keyword;

    const url = buildUrl(
      "https://apis.data.go.kr/1230000/ad/BidPublicInfoService01/getBidPblancListInfoCnstwk01",
      params
    );

    const upstream = await fetch(url);
    const text = await upstream.text();
    const parsed = parseNaraResponse(text);

    if (!parsed.ok) {
      return res.status(502).json({ ok: false, error: parsed.message });
    }

    const items = parsed.items.map(it => ({
      title: it.bidNtceNm || "",
      agency: it.ntceInsttNm || it.dminsttNm || "",
      bidNtceNo: it.bidNtceNo || "",
      workType: it.indstrytyNm || "",
      budget: it.presmptPrce ? Number(it.presmptPrce).toLocaleString() + "원" : "",
      period: it.cntrctPd || "",
      location: it.rgstTyNm || it.prtcptPsblRgnNm || "",
      closeDate: it.bidClseDt || "",
      raw: it,
    }));

    res.json({ ok: true, totalCount: parsed.totalCount, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "프록시 서버 내부 오류: " + err.message });
  }
});

/**
 * GET /api/templates
 * 저장된 모든 발주처 양식 스키마를 반환한다. (프론트엔드 내장 템플릿과 병합해서 사용)
 */
app.get("/api/templates", (req, res) => {
  res.json({ ok: true, templates: loadTemplates() });
});

/**
 * POST /api/templates
 * 프론트엔드가 AI로 분석한 양식 스키마 { id, name, sections:[...] } 를 등록/갱신한다.
 */
app.post("/api/templates", (req, res) => {
  const tpl = req.body;
  if (!tpl || typeof tpl !== "object" || !tpl.id || !tpl.name || !Array.isArray(tpl.sections)) {
    return res.status(400).json({ ok: false, error: "id, name, sections(배열)가 필요합니다." });
  }
  const all = loadTemplates();
  all[tpl.id] = { ...tpl, updatedAt: new Date().toISOString() };
  saveTemplates(all);
  res.json({ ok: true, templates: all });
});

/**
 * DELETE /api/templates/:id
 * 잘못 등록된 양식을 제거한다.
 */
app.delete("/api/templates/:id", (req, res) => {
  const all = loadTemplates();
  delete all[req.params.id];
  saveTemplates(all);
  res.json({ ok: true, templates: all });
});

app.listen(PORT, () => {
  console.log(`[nara-bid-proxy] 서버 실행 중 → http://localhost:${PORT}`);
  console.log(`  헬스체크        : GET /health`);
  console.log(`  공고 검색       : GET /api/bids?keyword=울타리&days=14`);
  console.log(`  양식 목록 조회  : GET /api/templates`);
  console.log(`  양식 등록       : POST /api/templates`);
});
