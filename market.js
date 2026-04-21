// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// market.js — Finnhub WS 현재가 / Yahoo VIX·VOLD / 휴장일 / 심볼
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { WebSocket } from 'ws';
import { state, WATCH_SYMBOLS } from './state.js';
import { broadcast } from './broadcast.js';

const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 휴장일 (fetchHolidays에서만 갱신)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let holidaySet = new Set();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. Finnhub WebSocket — 현재가 실시간
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let finnhubWs = null;
let finnhubReconnectTimer = null;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Yahoo 폴백 — 프리/애프터마켓 현재가 폴링
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let yahooFallbackTimer = null;

// ET 기준 시간외 거래 여부 판별 (프리 04:00~09:30 / 애프터 16:00~20:00)
function isExtendedHours() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date());
  const h = +fmt.find(p => p.type === 'hour').value;
  const m = +fmt.find(p => p.type === 'minute').value;
  const total = h * 60 + m;
  return (total >= 240 && total < 570)    // 04:00~09:30 프리마켓
      || (total >= 960 && total < 1200);  // 16:00~20:00 애프터마켓
}

async function pollYahooPrices() {
  const updated = {};
  for (const sym of WATCH_SYMBOLS) {
    try {
      const q = await fetchYahooQuote(sym);
      if (q.price == null) continue;
      const prev = state.prices[sym];
      state.prices[sym] = {
        price:     q.price,
        prevClose: q.prevClose ?? prev?.prevClose ?? null,
        change:    q.changePct,
        updatedAt: new Date().toISOString(),
      };
      updated[sym] = state.prices[sym];
    } catch (e) { console.warn('[YahooPoll]', sym, e.message); }
  }
  if (Object.keys(updated).length > 0) {
    broadcast('prices', updated);
    console.log('[YahooPoll] broadcast:', Object.keys(updated).join(', '));
  }
}

export function connectFinnhub() {
  if (!FINNHUB_TOKEN) {
    console.warn('[Finnhub] FINNHUB_TOKEN 없음');
    return;
  }
  console.log('[Finnhub] WebSocket 연결 시도...');
  finnhubWs = new WebSocket('wss://ws.finnhub.io?token=' + FINNHUB_TOKEN);

  finnhubWs.on('open', () => {
    console.log('[Finnhub] 연결 성공');
    // Yahoo 폴백 중이었으면 중단
    if (yahooFallbackTimer) {
      clearInterval(yahooFallbackTimer);
      yahooFallbackTimer = null;
      console.log('[Finnhub] Yahoo 폴백 중단 — Finnhub 실시간 전환');
    }
    for (const sym of WATCH_SYMBOLS) {
      finnhubWs.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
    }
  });

  finnhubWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'trade' || !Array.isArray(msg.data)) return;

      // ── 임시 확인용 로그 — trade.v 필드 존재 여부 확인 후 제거 ──
      if (!state.obv._sampled) {
        console.log('[Finnhub Sample]', JSON.stringify(msg.data[0]));
        state.obv._sampled = true;
      }

      const updated = {};
      for (const trade of msg.data) {
        const sym = trade.s, price = trade.p, vol = trade.v ?? 0;
        if (!sym || price == null) continue;

        // ── SPY OBV 실시간 누적 (VOLD 대체) ──
        // Finnhub WebSocket trade.v 활용 — 추가 API 호출 없음
        // 가격 상승 시 +vol, 하락 시 -vol, 동일 시 변화 없음
        if (sym === 'SPY' && vol > 0) {
          const prevPrice = state.obv.lastPrice;
          if (prevPrice != null) {
            if (price > prevPrice)      state.obv.value += vol;
            else if (price < prevPrice) state.obv.value -= vol;
          }
          state.obv.lastPrice = price;
        }

        const prev = state.prices[sym];
        state.prices[sym] = {
          price,
          prevClose:  prev?.prevClose ?? null,
          change:     prev?.prevClose != null
            ? +((price - prev.prevClose) / prev.prevClose * 100).toFixed(2)
            : null,
          updatedAt:  new Date().toISOString(),
        };
        updated[sym] = state.prices[sym];
      }
      if (Object.keys(updated).length > 0) broadcast('prices', updated);
    } catch (e) { console.warn('[Finnhub] 파싱 오류:', e.message); }
  });

  finnhubWs.on('close', () => {
    console.warn('[Finnhub] 종료');
    if (isExtendedHours()) {
      // 프리/애프터마켓 → Yahoo 폴백으로 전환
      console.log('[Finnhub] 시간외 거래 감지 → Yahoo 폴백 시작 (30초 간격)');
      pollYahooPrices(); // 즉시 1회 실행
      if (!yahooFallbackTimer) {
        yahooFallbackTimer = setInterval(pollYahooPrices, 30000);
      }
    } else {
      // 정규장 → 기존대로 재연결
      console.warn('[Finnhub] 정규장 → 30초 후 재연결');
      if (!finnhubReconnectTimer) {
        finnhubReconnectTimer = setTimeout(() => {
          finnhubReconnectTimer = null;
          connectFinnhub();
        }, 30000);
      }
    }
  });

  finnhubWs.on('error', (e) => {
    console.warn('[Finnhub] 오류:', e.message);
    finnhubWs.terminate();
  });
}

export function getFinnhubWsState() {
  return finnhubWs?.readyState;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. Yahoo Finance — quote 헬퍼
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function fetchYahooQuote(symbol) {
  const encoded = encodeURIComponent(symbol);
  const r = await fetch(
    'https://query1.finance.yahoo.com/v8/finance/chart/' + encoded + '?interval=1d&range=1d',
    { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) throw new Error('Yahoo ' + symbol + ' HTTP ' + r.status);
  const j = await r.json();
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('Yahoo ' + symbol + ' no meta');
  const price     = meta.regularMarketPrice ?? null;
  const prevClose = meta.chartPreviousClose ?? null;
  const changePct = (price != null && prevClose != null)
    ? +((price - prevClose) / prevClose * 100).toFixed(2)
    : null;
  const volume = meta.regularMarketVolume ?? null;
  return { price, prevClose, changePct, volume };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CLOSED 시 현재가(종가) + VIX/VVIX 1회 fetch
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function fetchClosedMarketData() {
  for (const sym of WATCH_SYMBOLS) {
    try {
      const r = await fetch(
        'https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?interval=1d&range=1d',
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
      );
      const j = await r.json();
      const meta = j?.chart?.result?.[0]?.meta;
      if (!meta) continue;
      const price     = meta.regularMarketPrice ?? null;
      const prevClose = meta.chartPreviousClose ?? null;
      const changePct = (price != null && prevClose != null)
        ? +((price - prevClose) / prevClose * 100).toFixed(2)
        : null;
      console.log(`[ClosedData] ${sym} price=${price} prevClose=${prevClose} changePct=${changePct}`);
      state.prices[sym] = {
        price, prevClose,
        change:    changePct,
        updatedAt: new Date().toISOString(),
      };
    } catch (e) { console.warn('[ClosedData] ' + sym + ' 실패:', e.message); }
  }

  try {
    const q = await fetchYahooQuote('^VIX');
    if (q.price != null) { state.market.vix = parseFloat(q.price.toFixed(2)); state.market.vixChangePct = q.changePct; }
  } catch (e) { console.warn('[ClosedData] VIX 실패:', e.message); }
  try {
    const q = await fetchYahooQuote('^VVIX');
    if (q.price != null) { state.market.vvix = parseFloat(q.price.toFixed(2)); state.market.vvixChangePct = q.changePct; }
  } catch (e) { console.warn('[ClosedData] VVIX 실패:', e.message); }

  state.market.vold      = null;
  state.market.updatedAt = new Date().toISOString();
  console.log('[ClosedData] 완료');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// prevClose 업데이트 (장 마감 후 1회)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function updatePrevClose() {
  for (const sym of WATCH_SYMBOLS) {
    try {
      const q = await fetchYahooQuote(sym);
      if (!state.prices[sym]) state.prices[sym] = {};
      state.prices[sym].prevClose = q.prevClose;
      state.prices[sym].change    = q.changePct;
      console.log(`[prevClose] ${sym} price=${q.price} prevClose=${q.prevClose} change=${q.changePct}`);
    } catch (e) { console.warn('[prevClose] ' + sym + ' 실패:', e.message); }
  }
  console.log('[prevClose] 완료');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cronMarket — VIX / VVIX / VV (평일 04~20시 매분)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function cronMarket() {
  const nowIso = new Date().toISOString();

  let vixNow = null, vixChangePct = null;
  try {
    const q = await fetchYahooQuote('^VIX');
    vixNow = q.price; vixChangePct = q.changePct;
    console.log('[Cron] VIX:', vixNow, '(' + vixChangePct + '%)');
  } catch (e) { console.warn('[Cron] VIX 실패:', e.message); }

  let vvixNow = null, vvixChangePct = null;
  try {
    const q = await fetchYahooQuote('^VVIX');
    vvixNow = q.price; vvixChangePct = q.changePct;
    console.log('[Cron] VVIX:', vvixNow, '(' + vvixChangePct + '%)');
  } catch (e) { console.warn('[Cron] VVIX 실패:', e.message); }

  // VIX Velocity (VV)
  let vv = null;
  if (vixNow != null) {
    if (state.vixHistory.length >= 1) {
      const prev = state.vixHistory[state.vixHistory.length - 1];
      const elapsedMin = (new Date(nowIso) - new Date(prev.iso)) / 60000 || 1;
      vv = parseFloat(((vixNow - prev.price) / elapsedMin).toFixed(4));
    }
    state.vixHistory.push({ iso: nowIso, price: vixNow });
    if (state.vixHistory.length > 200) state.vixHistory = state.vixHistory.slice(-200);
  }

  state.market = {
    ...state.market,
    vix:           vixNow      != null ? parseFloat(vixNow.toFixed(2))  : state.market.vix,
    vixChangePct:  vixChangePct  != null ? vixChangePct                 : state.market.vixChangePct,
    vvix:          vvixNow     != null ? parseFloat(vvixNow.toFixed(2)) : state.market.vvix,
    vvixChangePct: vvixChangePct != null ? vvixChangePct                : state.market.vvixChangePct,
    vv:            vv          != null ? vv                             : state.market.vv,
    updatedAt: nowIso,
  };

  broadcast('market', state.market);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cronMarketOBV — SPY OBV broadcast (정규장 09~16시)
// Finnhub WebSocket에서 실시간 누적된 OBV를 1분마다 broadcast
// UVOL/DVOL 야후 미제공으로 OBV로 대체 — 추가 API 호출 없음
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function cronMarketOBV() {
  const obv = state.obv.value;
  console.log('[Cron] OBV:', obv);
  state.market = {
    ...state.market,
    vold: obv,   // 기존 vold 필드 재사용 — 클라이언트 호환 유지
    uvol: null,
    dvol: null,
  };
  broadcast('market', state.market);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 휴장일 관리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function fetchHolidays() {
  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/stock/market-holiday?exchange=US&token=${FINNHUB_TOKEN}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const j = await r.json();
    holidaySet = new Set(
      (j.data || []).filter(h => !h.atNormalTime).map(h => h.eventDay)
    );
    console.log('[Holiday] 로드 완료:', holidaySet.size, '일');
  } catch (e) {
    console.warn('[Holiday] 로드 실패:', e.message);
  }
}

export function getHolidaySet() { return holidaySet; }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 심볼 목록 (Finnhub + ETF)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function fetchSymbols() {
  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${FINNHUB_TOKEN}`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!r.ok) throw new Error('Finnhub symbols HTTP ' + r.status);
    const data = await r.json();
    state.symbols = data
      .filter(s => s.type === 'Common Stock' || s.type === 'ETP')
      .map(s => ({
        symbol: s.symbol,
        name:   s.description || '',
        type:   s.type === 'ETP' ? 'ETF' : 'Stock',
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
    state.symbolsUpdatedAt = new Date().toISOString();
    console.log('[Symbols] 로드 완료:', state.symbols.length, '개');
  } catch (e) {
    console.warn('[Symbols] 실패:', e.message);
  }
}
