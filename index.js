// StockDash Server — Railway (Node.js) v2.0
// 데이터 소스:
//   현재가(SPY/QQQ 등) → Finnhub WebSocket (실시간) → 클라이언트 WS 푸시
//   VIX/VVIX/VOLD     → Yahoo Finance 1분 Cron → 클라이언트 WS 푸시
//   옵션체인/Greeks    → CBOE 15분 Cron → REST API 제공

import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';
import { LRUCache } from 'lru-cache';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT           = process.env.PORT || 3000;
const FINNHUB_TOKEN  = process.env.FINNHUB_TOKEN;
const WATCH_SYMBOLS  = ['SPY', 'QQQ', 'IWM', 'GLD', 'SLV'];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 인메모리 상태 저장소
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const state = {
  prices:         {},
  market: {
    vix: null, vvix: null, vv: null,
    vold: null, uvol: null, dvol: null,
    updatedAt: null,
  },
  vixHistory: [], vixHistoryDate: '',
  greeks: {}, strikes: {},
  prevStrikes: {},   // 직전 Cron strikes (15분 전)
  baseStrikes: {},   // 당일 첫 번째 Cron strikes (누적 기준)
  baseDate:    '',   // 날짜 바뀌면 baseStrikes 리셋
  vcHistory: {}, vcHistoryDate: '',
  symbols: [],       // 미국 주식 심볼 목록 (매일 자정 갱신)
  symbolsUpdatedAt: null,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Express + HTTP + WebSocket 서버
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(cors());
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.json());

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: new Date().toISOString() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch (_) {}
    }
  }
}

// CLOSED 시 현재가(종가) + VIX/VVIX 1회 fetch
async function fetchClosedMarketData() {
  // 현재가 — Yahoo v8 chart range=1d (chartPreviousClose가 정확한 전일 종가)
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
      if (!state.prices[sym]) state.prices[sym] = {};
      state.prices[sym] = {
        price, prevClose,
        change:         changePct,
        marketState:    'CLOSED',
        nextTradingDay: getNextTradingDay(),
        updatedAt:      new Date().toISOString(),
      };
    } catch (e) { console.warn('[ClosedData] ' + sym + ' 실패:', e.message); }
  }

  // VIX / VVIX
  try {
    const q = await fetchYahooQuote('^VIX');
    if (q.price != null) { state.market.vix = parseFloat(q.price.toFixed(2)); state.market.vixChangePct = q.changePct; }
  } catch (e) { console.warn('[ClosedData] VIX 실패:', e.message); }
  try {
    const q = await fetchYahooQuote('^VVIX');
    if (q.price != null) { state.market.vvix = parseFloat(q.price.toFixed(2)); state.market.vvixChangePct = q.changePct; }
  } catch (e) { console.warn('[ClosedData] VVIX 실패:', e.message); }

  state.market.vold           = null;
  state.market.marketState    = 'CLOSED';
  state.market.nextTradingDay = getNextTradingDay();
  state.market.updatedAt      = new Date().toISOString();
  console.log('[ClosedData] 완료 — nextTradingDay:', getNextTradingDay());
}

wss.on('connection', async (ws) => {
  console.log('[WS] 클라이언트 연결 — 총 ' + wss.clients.size + '개');
  try {
    const ms = getMarketState();
    if (ms === 'CLOSED') {
      await fetchClosedMarketData();
    }
    ws.send(JSON.stringify({
      type: 'init',
      data: { prices: state.prices, market: state.market },
      ts: new Date().toISOString(),
    }));
  } catch (_) {}
  ws.on('close', () => console.log('[WS] 해제 — 총 ' + wss.clients.size + '개'));
  ws.on('error', (e) => console.warn('[WS] 오류:', e.message));
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 유틸
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function nowEST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}
function todayEST() { return nowEST().toLocaleDateString('en-CA'); }
function estHour()  { const n = nowEST(); return n.getHours() + n.getMinutes() / 60; }
function isExtendedHours() {
  const h = estHour(), dow = nowEST().getDay();
  return dow >= 1 && dow <= 5 && h >= 4 && h < 20;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 휴장일 관리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let holidaySet = new Set(); // 'YYYY-MM-DD'

async function fetchHolidays() {
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

// 다음 거래일 계산 ('YYYY-MM-DD' 반환)
function getNextTradingDay(fromDate = new Date()) {
  const d = new Date(fromDate);
  for (let i = 1; i <= 10; i++) {
    d.setDate(d.getDate() + 1);
    const dow = d.getUTCDay();
    const iso = d.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !holidaySet.has(iso)) return iso;
  }
  return null;
}

// 장 상태 판별 — 서버에서 한 번만 계산, prices WS로 전달
function getMarketState() {
  const today = todayEST();
  if (holidaySet.has(today)) return 'CLOSED';  // 휴장일
  const h = estHour(), dow = nowEST().getDay();
  if (dow === 0 || dow === 6)    return 'CLOSED';   // 주말
  if (h >= 4   && h <  9.5)     return 'PRE';      // 프리장
  if (h >= 9.5 && h <  16)      return 'REGULAR';  // 정규장
  if (h >= 16  && h <  20)      return 'AFTER';    // 애프터장
  return 'CLOSED';
}
function normPDF(x) { return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI); }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. Finnhub WebSocket — 현재가 실시간
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let finnhubWs = null;
let finnhubReconnectTimer = null;

function connectFinnhub() {
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
      const ms = getMarketState();
      const updated = {};
      for (const trade of msg.data) {
        const sym = trade.s, price = trade.p;
        if (!sym || price == null) continue;
        const prev = state.prices[sym];
        // CLOSED 시: 현재가 대신 prevClose 사용
        const displayPrice = ms === 'CLOSED'
          ? (prev?.prevClose ?? price)
          : price;
        state.prices[sym] = {
          price:       displayPrice,
          prevClose:   prev?.prevClose ?? null,
          change: prev?.prevClose != null
            ? +((displayPrice - prev.prevClose) / prev.prevClose * 100).toFixed(2)
            : null,
          marketState:     ms,
          nextTradingDay:  ms === 'CLOSED' ? getNextTradingDay() : null,
          updatedAt:       new Date().toISOString(),
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

async function updatePrevClose() {
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
// 2. Yahoo — VIX / VVIX / VOLD (1분 Cron)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fetchYahooQuote(symbol) {
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

async function cronMarket() {
  const ms = getMarketState();
  const today = todayEST();
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

  let uvolNow = null, dvolNow = null, voldNow = null;

  // CLOSED 시: VOLD는 null(—) 처리, VIX는 이전값 유지
  if (ms !== 'CLOSED') {
    try { const q = await fetchYahooQuote('C:UVOL'); uvolNow = q.volume ?? q.price; console.log('[Cron] UVOL:', uvolNow); }
    catch (e) { console.warn('[Cron] UVOL 실패:', e.message); }
    try { const q = await fetchYahooQuote('C:DVOL'); dvolNow = q.volume ?? q.price; console.log('[Cron] DVOL:', dvolNow); }
    catch (e) { console.warn('[Cron] DVOL 실패:', e.message); }

    if (uvolNow != null && dvolNow != null) {
      const calculated = uvolNow - dvolNow;
      if (ms === 'PRE') {
        voldNow = 0;
      } else if (ms === 'REGULAR') {
        voldNow = calculated;
      } else {
        voldNow = calculated !== 0 ? calculated : state.market.vold;
      }
      console.log('[Cron] VOLD:', voldNow, '(' + ms + ')');
    }
  }

  let vv = null;
  if (vixNow != null) {
    if (state.vixHistoryDate !== today) { state.vixHistory = []; state.vixHistoryDate = today; }
    if (state.vixHistory.length >= 1) {
      const prev = state.vixHistory[state.vixHistory.length - 1];
      const elapsedMin = (new Date(nowIso) - new Date(prev.iso)) / 60000 || 1;
      vv = parseFloat(((vixNow - prev.price) / elapsedMin).toFixed(4));
    }
    state.vixHistory.push({ iso: nowIso, price: vixNow });
    if (state.vixHistory.length > 200) state.vixHistory = state.vixHistory.slice(-200);
  }

  state.market = {
    vix:          vixNow  != null ? parseFloat(vixNow.toFixed(2))  : state.market.vix,
    vixChangePct: vixChangePct  != null ? vixChangePct  : state.market.vixChangePct,
    vvix:         vvixNow != null ? parseFloat(vvixNow.toFixed(2)) : state.market.vvix,
    vvixChangePct:vvixChangePct != null ? vvixChangePct : state.market.vvixChangePct,
    vv:           vv      != null ? vv                             : state.market.vv,
    vold:         ms === 'CLOSED' ? null : (voldNow != null ? Math.round(voldNow) : state.market.vold),
    uvol:         uvolNow != null ? Math.round(uvolNow) : state.market.uvol,
    dvol:         dvolNow != null ? Math.round(dvolNow) : state.market.dvol,
    marketState:    ms,
    nextTradingDay: ms === 'CLOSED' ? getNextTradingDay() : null,
    updatedAt: nowIso,
  };

  broadcast('market', state.market);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. CBOE — Greeks 계산 (15분 Cron)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fetchCBOEChain(symbol) {
  const r = await fetch(
    'https://cdn.cboe.com/api/global/delayed_quotes/options/' + symbol + '.json',
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.cboe.com/',
      },
      signal: AbortSignal.timeout(12000),
    }
  );
  if (!r.ok) throw new Error('CBOE ' + symbol + ' HTTP ' + r.status);
  return await r.json();
}

function computeGreeks(cboeJson) {
  const spotPrice  = cboeJson.data.current_price;
  const allOptions = cboeJson.data.options;
  const todayISO   = nowEST().toLocaleDateString('en-CA');
  const todayKey   = todayISO.slice(2,4) + todayISO.slice(5,7) + todayISO.slice(8,10);

  // 오늘 만기 탐색 → 없으면 다음 거래일 만기 탐색
  let targetKey = todayKey;
  let targetISO = todayISO;
  let parsed = allOptions.filter(o => {
    const m = o.option.trim().match(/(\d{6})[CP]/);
    return m && m[1] === todayKey;
  }).map(o => {
    const m = o.option.trim().match(/(\d{6})([CP])(\d+)/);
    if (!m) return null;
    return { strike: parseInt(m[3]) / 1000, type: m[2], iv: o.iv, oi: o.open_interest, volume: o.volume };
  }).filter(Boolean);

  if (parsed.length === 0) {
    // 다음 거래일 만기 탐색
    const nextDay = getNextTradingDay();
    if (nextDay) {
      targetISO = nextDay;
      targetKey = nextDay.slice(2,4) + nextDay.slice(5,7) + nextDay.slice(8,10);
      parsed = allOptions.filter(o => {
        const m = o.option.trim().match(/(\d{6})[CP]/);
        return m && m[1] === targetKey;
      }).map(o => {
        const m = o.option.trim().match(/(\d{6})([CP])(\d+)/);
        if (!m) return null;
        return { strike: parseInt(m[3]) / 1000, type: m[2], iv: o.iv, oi: o.open_interest, volume: o.volume };
      }).filter(Boolean);
      console.log('[Greeks] 오늘 만기 없음 → 다음 거래일', targetISO, '사용');
    }
  }

  if (parsed.length === 0) throw new Error('NO_0DTE_DATA');

  const map = {};
  for (const o of parsed) {
    if (!map[o.strike]) map[o.strike] = { strike: o.strike, callOI: 0, putOI: 0, callVol: 0, putVol: 0, ivSum: 0, ivN: 0 };
    const s = map[o.strike];
    if (o.type === 'C') { s.callOI += o.oi; s.callVol += o.volume; }
    else                { s.putOI  += o.oi; s.putVol  += o.volume; }
    if (o.iv > 0) { s.ivSum += o.iv; s.ivN++; }
  }
  const strikes = Object.values(map).sort((a, b) => a.strike - b.strike);

  // 만기일 16:00 ET(장 마감) 기준으로 T 계산
  // 4~10월(EDT) → UTC+4 = UTC 20:00 / 11~3월(EST) → UTC+5 = UTC 21:00
  function getExpiryCloseUTC(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const utcHour = (m >= 4 && m <= 10) ? 20 : 21; // EDT vs EST
    return new Date(Date.UTC(y, m - 1, d, utcHour, 0, 0));
  }
  const expiryClose = getExpiryCloseUTC(targetISO);
  const msToExp = expiryClose - new Date();
  // 장중: 남은 시간 기준 / 장 마감 후: 최솟값 0DTE 처리 (1시간 = 1/8760)
  const T = msToExp > 0
    ? msToExp / (1000 * 60 * 60 * 24 * 365)
    : 1 / 8760;
  const sqrtT  = Math.sqrt(T);
  const r_rate = 0.045;
  let totalVanna = 0, totalCharm = 0;

  for (const s of strikes) {
    s.iv = s.ivN > 0 ? s.ivSum / s.ivN : 0;
    const sigma = s.iv > 0 ? s.iv : 0.20;
    const d1 = (Math.log(spotPrice / s.strike) + (r_rate + sigma * sigma / 2) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    const nd1 = normPDF(d1);
    const bsGamma = isFinite(nd1) ? nd1 / (spotPrice * sigma * sqrtT) : 0;
    s.gex       = isFinite(bsGamma) ? (s.callOI - s.putOI) * bsGamma * 100 * spotPrice : 0;
    s.callHedge = bsGamma * s.callOI * 100 * spotPrice;
    s.putHedge  = bsGamma * s.putOI  * 100 * spotPrice;
    const netOI = s.callOI - s.putOI;
    const vanna = nd1 * (d2 / sigma) * netOI * 100 * spotPrice;
    totalVanna += isFinite(vanna) ? vanna : 0;
    // Charm: safeT 혼용 제거 — T로 통일
    const charm = -nd1 * (r_rate / (sigma * sqrtT) - d2 / (2 * T)) * netOI * 100;
    totalCharm += isFinite(charm) ? charm : 0;
  }

  let cum = 0, flipZone = null;
  for (const s of strikes) {
    const prev = cum; cum += s.gex; s.cumGex = cum;
    if (!flipZone && ((prev < 0 && cum >= 0) || (prev > 0 && cum <= 0))) flipZone = s.strike;
  }

  const near = strikes.filter(s => Math.abs(s.strike - spotPrice) / spotPrice < 0.10);
  const putWall  = near.reduce((b, s) => s.putOI  > b.putOI  ? s : b, near[0])?.strike;
  const callWall = near.reduce((b, s) => s.callOI > b.callOI ? s : b, near[0])?.strike;
  const localGEX = strikes.filter(s => Math.abs(s.strike - spotPrice) / spotPrice < 0.02).reduce((a, s) => a + s.gex, 0);
  const totalCallOI = strikes.reduce((a, s) => a + s.callOI, 0);
  const totalPutOI  = strikes.reduce((a, s) => a + s.putOI,  0);
  const upStrikes = strikes.filter(s => s.strike > spotPrice && s.strike <= spotPrice * 1.05).sort((a, b) => b.callHedge - a.callHedge).slice(0, 4);
  const dnStrikes = strikes.filter(s => s.strike < spotPrice && s.strike >= spotPrice * 0.95).sort((a, b) => b.putHedge  - a.putHedge).slice(0, 4);

  return {
    exp: targetISO, spotPrice, strikes, upStrikes, dnStrikes, flipZone, putWall, callWall,
    isNextDay:  targetISO !== todayISO, // 다음 거래일 데이터 여부
    localGEX:  parseFloat((localGEX / 1e6).toFixed(2)),
    totalGEX:  parseFloat((cum / 1e6).toFixed(2)),
    vanna:     parseFloat((totalVanna / 1e6).toFixed(2)),
    charm:     parseFloat((totalCharm / 1e6).toFixed(2)),
    pcr:       parseFloat((totalPutOI / Math.max(totalCallOI, 1)).toFixed(3)),
    computedAt: new Date().toISOString(),
    source: 'cboe',
  };
}

async function cronGreeks() {
  const symbols = ['SPY', 'QQQ', 'IWM'];
  const today   = todayEST();
  const nowIso  = new Date().toISOString();
  if (state.vcHistoryDate !== today) { state.vcHistory = {}; state.vcHistoryDate = today; }

  for (const sym of symbols) {
    try {
      const cboeJson = await fetchCBOEChain(sym);
      const result   = computeGreeks(cboeJson);
      state.greeks[sym]  = result;

      // ── OI 증감 계산
      const today = todayEST();
      // baseStrikes: 당일 첫 Cron 기준 (날짜 바뀌면 리셋)
      if (state.baseDate !== today) {
        state.baseStrikes = {};
        state.baseDate    = today;
      }
      const prevMap = {};
      const baseMap = {};
      if (state.prevStrikes[sym]) {
        for (const s of state.prevStrikes[sym]) prevMap[s.strike] = s;
      }
      if (state.baseStrikes[sym]) {
        for (const s of state.baseStrikes[sym]) baseMap[s.strike] = s;
      }
      for (const s of result.strikes) {
        const prev = prevMap[s.strike];
        const base = baseMap[s.strike];
        s.callOIDiff15 = prev ? s.callOI - prev.callOI : 0;
        s.putOIDiff15  = prev ? s.putOI  - prev.putOI  : 0;
        s.callOIDiffCum = base ? s.callOI - base.callOI : 0;
        s.putOIDiffCum  = base ? s.putOI  - base.putOI  : 0;
      }
      // prevStrikes 갱신 (다음 Cron의 15분 전 기준)
      state.prevStrikes[sym] = result.strikes.map(s => ({ strike: s.strike, callOI: s.callOI, putOI: s.putOI }));
      // baseStrikes: 당일 첫 번째 Cron만 저장
      if (!state.baseStrikes[sym]) {
        state.baseStrikes[sym] = result.strikes.map(s => ({ strike: s.strike, callOI: s.callOI, putOI: s.putOI }));
      }

      state.strikes[sym] = result.strikes;
      if (isExtendedHours()) {
        if (!state.vcHistory[sym]) state.vcHistory[sym] = [];
        state.vcHistory[sym].push({ iso: nowIso, vanna: result.vanna, charm: result.charm, vix: state.market.vix, vold: state.market.vold, spot: result.spotPrice });
        if (state.vcHistory[sym].length > 200) state.vcHistory[sym] = state.vcHistory[sym].slice(-200);
      }
      const { strikes, ...summary } = result;
      broadcast('greeks', { symbol: sym, ...summary });
      console.log('[Cron Greeks] ' + sym + ' — vanna=' + result.vanna + ' charm=' + result.charm);
    } catch (e) { console.error('[Cron Greeks] ' + sym + ' 실패:', e.message); }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Cron 스케줄
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VIX/VOLD: 평일 ET 04~20시만 (장 시간)
cron.schedule('* 4-20 * * 1-5', async () => {
  try { await cronMarket(); } catch (e) { console.error('[Cron Market]', e.message); }
}, { timezone: 'America/New_York' });
// Greeks: 평일 ET 04~20시 15분마다
cron.schedule('*/15 4-20 * * 1-5', async () => {
  try { await cronGreeks(); } catch (e) { console.error('[Cron Greeks]', e.message); }
}, { timezone: 'America/New_York' });
// Greeks: CLOSED 진입 시 (ET 20:00) 다음 거래일 데이터 1회 fetch
cron.schedule('0 20 * * 1-5', async () => {
  try { await cronGreeks(); } catch (e) { console.error('[Cron Greeks CLOSED]', e.message); }
}, { timezone: 'America/New_York' });
// prevClose: 장 마감 직후 1회
cron.schedule('5 16 * * 1-5', async () => {
  try { await updatePrevClose(); } catch (e) { console.error('[prevClose]', e.message); }
}, { timezone: 'America/New_York' });
// 휴장일 목록: 매일 자정 ET 갱신
cron.schedule('0 0 * * *', async () => {
  try { await fetchHolidays(); } catch (e) { console.error('[Holiday]', e.message); }
}, { timezone: 'America/New_York' });
// 심볼 목록: 매일 새벽 1시 ET 갱신
cron.schedule('0 1 * * *', async () => {
  try { await fetchSymbols(); } catch (e) { console.error('[Symbols]', e.message); }
}, { timezone: 'America/New_York' });

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REST API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/quote', (req, res) => {
  const sym = (req.query.symbol || 'SPY').toUpperCase();
  const data = state.prices[sym];
  if (!data) return res.json({ symbol: sym, price: null, note: 'no_data_yet' });
  res.json({ symbol: sym, ...data });
});
app.get('/api/quotes', async (req, res) => {
  if (getMarketState() === 'CLOSED') await fetchClosedMarketData();
  res.json(state.prices);
});
app.get('/api/market', async (req, res) => {
  if (getMarketState() === 'CLOSED') await fetchClosedMarketData();
  res.json(state.market);
});
app.get('/api/greeks', (req, res) => {
  const sym = (req.query.symbol || 'SPY').toUpperCase();
  const data = state.greeks[sym];
  if (!data) return res.json({ symbol: sym, note: 'no_data_yet' });
  const { strikes, ...summary } = data;
  res.json({ symbol: sym, ...summary });
});
app.get('/api/strikes', (req, res) => {
  const sym = (req.query.symbol || 'SPY').toUpperCase();
  const data = state.strikes[sym];
  if (!data) return res.json({ symbol: sym, strikes: [], note: 'no_data_yet' });
  res.json({ symbol: sym, strikes: data });
});
app.get('/api/gex0dte', (req, res) => {
  const sym = (req.query.symbol || 'SPY').toUpperCase();
  const greeks  = state.greeks[sym];
  const strikes = state.strikes[sym];
  if (!greeks || !strikes) return res.json({ error: 'no_data_yet', symbol: sym });
  res.json({ ...greeks, strikes, source: 'cron_computed' });
});
app.get('/api/vc_history', (req, res) => {
  const sym = (req.query.symbol || 'SPY').toUpperCase();
  res.json({ symbol: sym, date: todayEST(), history: state.vcHistory[sym] || [] });
});
app.get('/api/options', async (req, res) => {
  const sym = (req.query.symbol || 'SPY').toUpperCase();
  try {
    const data = await fetchCBOEChain(sym);
    res.json({ ...data, source: 'cboe', timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message, symbol: sym }); }
});
app.get('/api/status', (req, res) => {
  res.json({
    ok: true, version: '2.0.0',
    finnhubWs:       finnhubWs?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
    wsClients:       wss.clients.size,
    watchSymbols:    WATCH_SYMBOLS,
    pricesUpdated:   Object.fromEntries(Object.entries(state.prices).map(([k, v]) => [k, v.updatedAt])),
    marketUpdatedAt: state.market.updatedAt,
    greeksSymbols:   Object.keys(state.greeks),
    vixHistoryLen:   state.vixHistory.length,
    symbolsCount:    state.symbols.length,
    symbolsUpdatedAt: state.symbolsUpdatedAt,
    uptime:          process.uptime(),
    now:             new Date().toISOString(),
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 심볼 목록 (Finnhub + ETF 보강)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fetchSymbols() {
  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${FINNHUB_TOKEN}`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!r.ok) throw new Error('Finnhub symbols HTTP ' + r.status);
    const data = await r.json();
    // Common Stock + ETF만, 심볼/이름/타입 정리
    state.symbols = data
      .filter(s => s.type === 'Common Stock' || s.type === 'ETP')
      .map(s => ({
        symbol:      s.symbol,
        name:        s.description || '',
        type:        s.type === 'ETP' ? 'ETF' : 'Stock',
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
    state.symbolsUpdatedAt = new Date().toISOString();
    console.log('[Symbols] 로드 완료:', state.symbols.length, '개');
  } catch (e) {
    console.warn('[Symbols] 실패:', e.message);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 차트 데이터 — Finnhub + LRU 캐시 + 볼린저밴드
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Finnhub resolution → 캐시 TTL (ms)
const CHART_TTL = {
  '5':   60_000,
  '30':  120_000,
  '120': 300_000,
  '240': 300_000,
  'D':   3_600_000,
  'W':   3_600_000,
};

// Finnhub resolution → 조회 기간 (초)
const CHART_FROM_SEC = {
  '5':   5   * 24 * 3600,
  '30':  30  * 24 * 3600,
  '120': 90  * 24 * 3600,
  '240': 180 * 24 * 3600,
  'D':   365 * 24 * 3600,
  'W':   3 * 365 * 24 * 3600,
};

const chartCache = new LRUCache({ max: 200, ttlResolution: 1000 });

// 볼린저밴드 계산 (SMA20 기준, 1σ + 2σ)
function calcBollinger(closes, period = 20) {
  const upper2 = [], lower2 = [], upper1 = [], lower1 = [], mid = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      upper2.push(null); lower2.push(null);
      upper1.push(null); lower1.push(null);
      mid.push(null);
      continue;
    }
    const slice = closes.slice(i - period + 1, i + 1);
    const sma   = slice.reduce((a, b) => a + b, 0) / period;
    const std   = Math.sqrt(slice.reduce((a, b) => a + (b - sma) ** 2, 0) / period);
    mid.push(+sma.toFixed(4));
    upper2.push(+(sma + std * 2).toFixed(4));
    lower2.push(+(sma - std * 2).toFixed(4));
    upper1.push(+(sma + std * 1).toFixed(4));
    lower1.push(+(sma - std * 1).toFixed(4));
  }
  return { upper2, lower2, upper1, lower1, mid };
}

async function fetchChartData(symbol, resolution) {
  const cacheKey = `${symbol}:${resolution}`;
  const cached   = chartCache.get(cacheKey);
  if (cached) return cached;

  const to   = Math.floor(Date.now() / 1000);
  const from = to - (CHART_FROM_SEC[resolution] ?? 30 * 24 * 3600);

  const url = `https://finnhub.io/api/v1/stock/candle`
    + `?symbol=${encodeURIComponent(symbol)}`
    + `&resolution=${resolution}&from=${from}&to=${to}`
    + `&token=${FINNHUB_TOKEN}`;

  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('Finnhub HTTP ' + r.status);
  const j = await r.json();
  if (j.s === 'no_data') throw new Error('no_data');
  if (j.s !== 'ok')      throw new Error('Finnhub: ' + (j.s || 'unknown'));

  const { t, o, h, l, c, v } = j;
  const candles = t.map((ts, i) => ({
    time:   ts,
    open:   +o[i].toFixed(4),
    high:   +h[i].toFixed(4),
    low:    +l[i].toFixed(4),
    close:  +c[i].toFixed(4),
    volume: v[i] ?? 0,
  }));

  const bb = calcBollinger(candles.map(cd => cd.close));
  candles.forEach((cd, i) => {
    cd.bbUpper2 = bb.upper2[i];
    cd.bbLower2 = bb.lower2[i];
    cd.bbUpper1 = bb.upper1[i];
    cd.bbLower1 = bb.lower1[i];
    cd.bbMid    = bb.mid[i];
  });

  const last = candles[candles.length - 1];
  const data = {
    symbol, resolution,
    currentPrice:  last?.close ?? null,
    previousClose: candles.length > 1 ? candles[candles.length - 2].close : null,
    candles,
    updatedAt: new Date().toISOString(),
  };

  chartCache.set(cacheKey, data, { ttl: CHART_TTL[resolution] ?? 60_000 });
  return data;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REST API — 심볼 & 차트
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/symbols', (req, res) => {
  const q = (req.query.q || '').toUpperCase().trim();
  if (!q) return res.json({ count: state.symbols.length, symbols: state.symbols.slice(0, 50) });
  const matched = state.symbols.filter(s =>
    s.symbol.startsWith(q) || s.name?.toUpperCase().includes(q)
  ).slice(0, 30);
  res.json({ count: matched.length, symbols: matched });
});

const VALID_RESOLUTIONS = ['5', '30', '120', '240', 'D', 'W'];
app.get('/api/chart', async (req, res) => {
  const symbol     = (req.query.symbol || 'SPY').toUpperCase();
  const resolution = req.query.resolution || 'D';
  if (!VALID_RESOLUTIONS.includes(resolution))
    return res.status(400).json({ error: 'invalid resolution', valid: VALID_RESOLUTIONS });
  if (!FINNHUB_TOKEN)
    return res.status(503).json({ error: 'FINNHUB_TOKEN 환경변수가 설정되지 않았습니다', symbol });
  try {
    console.log(`[Chart] ${symbol} res=${resolution} 요청`);
    const data = await fetchChartData(symbol, resolution);
    console.log(`[Chart] ${symbol} res=${resolution} 완료 — candles=${data.candles.length}`);
    res.json(data);
  } catch (e) {
    console.error(`[Chart] ${symbol} res=${resolution} 실패:`, e.message);
    res.status(500).json({ error: e.message, symbol, resolution });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 서버 시작
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.listen(PORT, () => {
  console.log('[Server] StockDash v2.0 — port ' + PORT);
  fetchHolidays().then(() => {
    connectFinnhub();
    fetchSymbols().catch(e => console.error('[Init] symbols:', e.message));
    cronMarket().catch(e => console.error('[Init] market:', e.message));
    setTimeout(() => {
      cronGreeks().catch(e => console.error('[Init] greeks:', e.message));
      updatePrevClose().catch(e => console.error('[Init] prevClose:', e.message));
    }, 3000);
  });
});
