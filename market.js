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

export function connectFinnhub() {
  if (!FINNHUB_TOKEN) {
    console.warn('[Finnhub] FINNHUB_TOKEN 없음');
    return;
  }
  console.log('[Finnhub] WebSocket 연결 시도...');
  finnhubWs = new WebSocket('wss://ws.finnhub.io?token=' + FINNHUB_TOKEN);

  finnhubWs.on('open', () => {
    console.log('[Finnhub] 연결 성공');
    for (const sym of WATCH_SYMBOLS) {
      finnhubWs.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
    }
  });

  finnhubWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'trade' || !Array.isArray(msg.data)) return;
      const updated = {};
      for (const trade of msg.data) {
        const sym = trade.s, price = trade.p;
        if (!sym || price == null) continue;
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
    console.warn('[Finnhub] 종료 — 30초 후 재연결');
    if (!finnhubReconnectTimer) {
      finnhubReconnectTimer = setTimeout(() => {
        finnhubReconnectTimer = null;
        connectFinnhub();
      }, 30000);
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
// cronMarketVold — UVOL/DVOL (정규장 09~16시만)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function cronMarketVold() {
  let uvolNow = null, dvolNow = null;
  try { const q = await fetchYahooQuote('C:UVOL'); uvolNow = q.volume ?? q.price; console.log('[Cron] UVOL:', uvolNow); }
  catch (e) { console.warn('[Cron] UVOL 실패:', e.message); }
  try { const q = await fetchYahooQuote('C:DVOL'); dvolNow = q.volume ?? q.price; console.log('[Cron] DVOL:', dvolNow); }
  catch (e) { console.warn('[Cron] DVOL 실패:', e.message); }

  if (uvolNow != null && dvolNow != null) {
    const vold = Math.round(uvolNow - dvolNow);
    console.log('[Cron] VOLD:', vold);
    state.market = {
      ...state.market,
      vold,
      uvol: Math.round(uvolNow),
      dvol: Math.round(dvolNow),
    };
    broadcast('market', state.market);
  }
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
