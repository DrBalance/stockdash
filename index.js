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

wss.on('connection', (ws) => {
  console.log('[WS] 클라이언트 연결 — 총 ' + wss.clients.size + '개');
  try {
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

// 장 상태 판별 — 서버에서 한 번만 계산, prices WS로 전달
// 클라이언트는 이 값을 그대로 사용 (타임존 판단 중복 방지)
// 'AFTER' 통일 (Yahoo의 'POST'와 다름에 주의)
function getMarketState() {
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
      const updated = {};
      for (const trade of msg.data) {
        const sym = trade.s, price = trade.p;
        if (!sym || price == null) continue;
        const prev = state.prices[sym];
        state.prices[sym] = {
          price,
          prevClose:   prev?.prevClose ?? null,
          change: prev?.prevClose != null
            ? +((price - prev.prevClose) / prev.prevClose * 100).toFixed(2)
            : null,
          marketState: getMarketState(),  // 'PRE' | 'REGULAR' | 'AFTER' | 'CLOSED'
          updatedAt:   new Date().toISOString(),
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
      const r = await fetch(
        'https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?interval=1d&range=5d',
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
      );
      const j = await r.json();
      const meta = j?.chart?.result?.[0]?.meta;
      if (meta?.chartPreviousClose) {
        if (!state.prices[sym]) state.prices[sym] = {};
        state.prices[sym].prevClose = meta.chartPreviousClose;
      }
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
    'https://query1.finance.yahoo.com/v8/finance/chart/' + encoded + '?interval=1m&range=1d',
    { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) throw new Error('Yahoo ' + symbol + ' HTTP ' + r.status);
  const j = await r.json();
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('Yahoo ' + symbol + ' no meta');
  return meta.regularMarketPrice ?? meta.regularMarketVolume ?? null;
}

async function cronMarket() {
  const today = todayEST();
  const nowIso = new Date().toISOString();

  let vixNow = null;
  try { vixNow = await fetchYahooQuote('^VIX'); console.log('[Cron] VIX:', vixNow); }
  catch (e) { console.warn('[Cron] VIX 실패:', e.message); }

  let vvixNow = null;
  try { vvixNow = await fetchYahooQuote('^VVIX'); console.log('[Cron] VVIX:', vvixNow); }
  catch (e) { console.warn('[Cron] VVIX 실패:', e.message); }

  let uvolNow = null, dvolNow = null, voldNow = null;
  const ms = getMarketState();

  try { uvolNow = await fetchYahooQuote('C:UVOL'); console.log('[Cron] UVOL:', uvolNow); }
  catch (e) { console.warn('[Cron] UVOL 실패:', e.message); }
  try { dvolNow = await fetchYahooQuote('C:DVOL'); console.log('[Cron] DVOL:', dvolNow); }
  catch (e) { console.warn('[Cron] DVOL 실패:', e.message); }

  if (uvolNow != null && dvolNow != null) {
    const calculated = uvolNow - dvolNow;
    if (ms === 'PRE') {
      voldNow = 0;                                                    // 프리장: 초기화
    } else if (ms === 'REGULAR') {
      voldNow = calculated;                                           // 장중: 실시간
    } else {
      voldNow = calculated !== 0 ? calculated : state.market.vold;   // AFTER/CLOSED: 0이면 이전값 유지
    }
    console.log('[Cron] VOLD:', voldNow, '(' + ms + ')');
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
    vix:       vixNow  != null ? parseFloat(vixNow.toFixed(2))  : state.market.vix,
    vvix:      vvixNow != null ? parseFloat(vvixNow.toFixed(2)) : state.market.vvix,
    vv:        vv      != null ? vv                             : state.market.vv,
    vold:      voldNow != null ? Math.round(voldNow)            : state.market.vold,
    uvol:      uvolNow != null ? Math.round(uvolNow)            : state.market.uvol,
    dvol:      dvolNow != null ? Math.round(dvolNow)            : state.market.dvol,
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

  const parsed = allOptions.filter(o => {
    const m = o.option.trim().match(/(\d{6})[CP]/);
    return m && m[1] === todayKey;
  }).map(o => {
    const m = o.option.trim().match(/(\d{6})([CP])(\d+)/);
    if (!m) return null;
    return { strike: parseInt(m[3]) / 1000, type: m[2], iv: o.iv, oi: o.open_interest, volume: o.volume };
  }).filter(Boolean);

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

  const msToExp = new Date(todayISO) - new Date();
  const T = Math.max(msToExp / (1000 * 60 * 60 * 24 * 365), 1 / 365);
  const safeT = Math.max(T, 0.5 / 365);
  const r_rate = 0.045;
  let totalVanna = 0, totalCharm = 0;

  for (const s of strikes) {
    s.iv = s.ivN > 0 ? s.ivSum / s.ivN : 0;
    const sigma = s.iv > 0 ? s.iv : 0.20;
    const sqrtT = Math.sqrt(T);
    const safeSqrtT = Math.sqrt(safeT);
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
    const charm = -nd1 * (r_rate / (sigma * safeSqrtT) - d2 / (2 * safeT)) * netOI * 100;
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
    exp: todayISO, spotPrice, strikes, upStrikes, dnStrikes, flipZone, putWall, callWall,
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
cron.schedule('* * * * *', async () => {
  try { await cronMarket(); } catch (e) { console.error('[Cron Market]', e.message); }
});
cron.schedule('*/15 * * * *', async () => {
  try { await cronGreeks(); } catch (e) { console.error('[Cron Greeks]', e.message); }
});
cron.schedule('5 16 * * 1-5', async () => {
  try { await updatePrevClose(); } catch (e) { console.error('[prevClose]', e.message); }
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
app.get('/api/quotes',    (req, res) => res.json(state.prices));
app.get('/api/market',    (req, res) => res.json(state.market));
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
    uptime:          process.uptime(),
    now:             new Date().toISOString(),
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 서버 시작
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.listen(PORT, () => {
  console.log('[Server] StockDash v2.0 — port ' + PORT);
  connectFinnhub();
  cronMarket().catch(e => console.error('[Init] market:', e.message));
  setTimeout(() => {
    cronGreeks().catch(e => console.error('[Init] greeks:', e.message));
    updatePrevClose().catch(e => console.error('[Init] prevClose:', e.message));
  }, 3000);
});
