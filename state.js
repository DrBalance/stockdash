// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 인메모리 상태 저장소 & 공유 상수
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const WATCH_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'GLD', 'SLV'];

export const state = {
  prices:         {},
  market: {
    vix: null, vvix: null, vv: null,
    vold: null, uvol: null, dvol: null,
    updatedAt: null,
  },
  vixHistory: [], vixHistoryDate: '',
  greeks: {}, strikes: {},

  // ── OI 증감 스냅샷 (인메모리, 재시작 시 초기화됨) ──────────────────
  // strikesHistory[sym] 구조:
  //   base: { iso, date, strikes }  ← 당일 09:00 ET 이후 첫 스냅샷 (DiffCum 기준, 하루 고정)
  //   prev: { iso, strikes }        ← 직전 15분 스냅샷 (Diff15 기준)
  //
  // ── Railway Volume 도입 시 교체 방법 (TODO: 유료 플랜 전환 후 적용) ──
  // 1. Railway 대시보드 → 프로젝트 → Volume 추가 → 마운트 경로: /data
  // 2. greeks.js 상단의 PERSISTENCE_PATH 주석 해제
  // 3. greeks.js의 loadBaseSnap() / saveBaseSnap() 함수 주석 해제 후 cronGreeks에서 호출
  //
  // ── Upstash Redis 도입 시 교체 방법 (Railway Volume 대안, 무료) ─────
  // 1. upstash.com 가입 → Redis DB 생성
  // 2. Railway 환경변수에 UPSTASH_URL / UPSTASH_TOKEN 추가
  // 3. npm install @upstash/redis
  // 4. greeks.js의 Redis 관련 주석 해제
  strikesHistory: {},  // { SPY: { base: {...}, prev: {...} }, QQQ: {...}, IWM: {...} }

  // ── SPY OBV (Finnhub WebSocket 실시간 누적, VOLD 대체) ──
  obv: { value: 0, lastPrice: null, _sampled: false },

  vcHistory: {}, vcHistoryDate: '',
  symbols: [],       // 미국 주식 심볼 목록 (매일 자정 갱신)
  symbolsUpdatedAt: null,
};
