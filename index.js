// StockDash Server — Railway (Node.js)
// 데이터 소스:
//   현재가(SPY/QQQ 등) → Finnhub WebSocket (실시간)
//   VIX/VVIX/VOLD     → Yahoo Finance (1분 Cron)
//   옵션체인/Greeks    → CBOE (15분 Cron)

import express from 'express';
import cors from 'cors';
import { WebSocket } from 'ws';
import cron from 'node-cron';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 인메모리 상태 저장소
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const state = {
  // 현재가 (Finnhub WebSocket)
  prices: {},          // { SPY: { price, prevClose, updatedAt }, ... }

  // VIX/VVIX/VOLD (Yahoo 1분 Cron)
  market: {
    vix:       null,
    vvix:      null,
    vv:        null,   // VIX velocity (pt/min)
    vold:      null,   // UVOL - DVOL
    uvol:      null,
    dvol:      null,
    updatedAt: null,
  },

  // VIX 히스토리 (VV 계산용, 당일)
  vixHistory: [],      // [{ iso, price }]
  vixHistoryDate: '',  // 'YYYY-MM-DD' (날짜 바뀌면 초기화)

  // VannaCharm / Greeks (CBOE 15분 Cron)
  greeks: {},          // { SPY: { vanna, charm, gex, flipZone, ... }, QQQ: {...} }

  // 0DTE 스트라이크 테이블
  strikes: {},         // { SPY: [...], QQQ: [...] }

  // Vanna/Charm 시계열 (당일)
  vcHistory: {},       // { SPY: [{ iso, vanna, charm, vix, vold, spot }] }
  vcHistoryDate: '',
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 유틸
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function nowEST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function todayEST() {
  return nowEST().toLocaleDateString('en-CA'); // 'YYYY-MM-DD'
}

function estHour() {
  const n = nowEST();
  return n.getHours() + n.getMinutes() / 60;
}

function isMarketHours() {
  const h = estHour();
  const dow = nowEST().getDay();
  return dow >= 1 && dow <= 5 && h >= 9.5 && h < 16;
}

function isExtendedHours() {
  const h = estHour();
  const dow = nowEST().getDay();
  return dow >= 1 && dow <= 5 && h >= 4 && h < 20;
}

// Black-Scholes 정규분포 PDF
function normPDF(x) {
  return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. Finnhub WebSocket — 현재가 실시간 구독
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const WATCH_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'GLD', 'SLV'];
let finnhubWs = null;
let finnhubReconnectTimer = null;

function connectFinnhub() {
  if (!FINNHUB_TOKEN) {
    console.warn('[Finnhub] FINNHUB_TOKEN 없음 — WebSocket 비활성화');
    return;
  }

  console.log('[Finnhub] WebSocket 연결 시도...');
  finnhubWs = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_TOKEN}`);

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

      for (const trade of msg.data) {
        const sym = trade.s;
        const price = trade.p;
        if (!sym || price == null) continue;

        const prev = state.prices[sym];
        state.prices[sym] = {
          price,
          prevClose: prev?.prevClose ?? null,
          change:    prev?.prevClose != null ? +((price - prev.prevClose) / prev.prevClose * 100).toFixed(2) : null,
          updatedAt: new Date().toISOString(),
        };
      }
    } catch (e) {
      console.warn('[Finnhub] 메시지 파싱 오류:', e.message);
    }
  });

  finnhubWs.on('close', () => {
    console.warn('[Finnhub] 연결 종료 — 30초 후 재연결');
    scheduleReconnect();
  });

  finnhubWs.on('error', (e) => {
    console.warn('[Finnhub] 오류:', e.message);
    finnhubWs.terminate();
  });
}

function scheduleReconnect() {
  if (finnhubReconnectTimer) return;
  finnhubReconnectTimer = setTimeout(() => {
    finnhubReconnectTimer = null;
    connectFinnhub();
  }, 30000);
}

// 장 마감 후 prevClose 업데이트 (Yahoo에서 종가 가져오기)
async function updatePrevClose() {
  for (const sym of WATCH_SYMBOLS) {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
      );
      const j = await r.json();
      const meta = j?.chart?.result?.[0]?.meta;
      if (meta?.chartPreviousClose) {
        if (!state.prices[sym]) state.prices[sym] = {};
        state.prices[sym].prevClose = meta.chartPreviousClose;
      }
    } catch (e) {
      console.warn(`[prevClose] ${sym} 실패:`, e.message);
    }
  }
  console.log('[prevClose] 업데이트 완료');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. Yahoo Finance — VIX / VVIX / VOLD 조회
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fetchYahooQuote(symbol) {
  // ^VIX, ^VVIX → %5EVIX, %5EVVIX
  // C:UVOL, C:DVOL → C%3AUVOL, C%3ADVOL
  const encoded = encodeURIComponent(symbol);
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1m&range=1d`,
    { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) throw new Error(`Yahoo ${symbol} HTTP ${r.status}`);
  const j = await r.json();
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`Yahoo ${symbol} no meta`);

  // UVOL/DVOL는 regularMarketVolume에 값이 들어옴 (장중)
  const price = meta.regularMarketPrice ?? meta.regularMarketVolume ?? null;
  return price;
}

async function cronMarket() {
  const today = todayEST();
  const nowIso = new Date().toISOString();

  // VIX
  let vixNow = null;
  try {
    vixNow = await fetchYahooQuote('^VIX');
    console.log(`[Cron] VIX: ${vixNow}`);
  } catch (e) {
    console.warn('[Cron] VIX 실패:', e.message);
  }

  // VVIX
  let vvixNow = null;
  try {
    vvixNow = await fetchYahooQuote('^VVIX');
    console.log(`[Cron] VVIX: ${vvixNow}`);
  } catch (e) {
    console.warn('[Cron] VVIX 실패:', e.message);
  }

  // UVOL / DVOL → VOLD
  let uvolNow = null, dvolNow = null, voldNow = null;
  if (isMarketHours()) {
    try {
      uvolNow = await fetchYahooQuote('C:UVOL');
      console.log(`[Cron] UVOL: ${uvolNow}`);
    } catch (e) {
      console.warn('[Cron] UVOL 실패:', e.message);
    }
    try {
      dvolNow = await fetchYahooQuote('C:DVOL');
      console.log(`[Cron] DVOL: ${dvolNow}`);
    } catch (e) {
      console.warn('[Cron] DVOL 실패:', e.message);
    }
    if (uvolNow != null && dvolNow != null) {
      voldNow = uvolNow - dvolNow;
      console.log(`[Cron] VOLD: ${voldNow}`);
    }
  }

  // VV (VIX velocity) 계산
  let vv = null;
  if (vixNow != null) {
    // 날짜 바뀌면 히스토리 초기화
    if (state.vixHistoryDate !== today) {
      state.vixHistory = [];
      state.vixHistoryDate = today;
    }

    if (state.vixHistory.length >= 1) {
      const prev = state.vixHistory[state.vixHistory.length - 1];
      const elapsedMin = (new Date(nowIso) - new Date(prev.iso)) / 60000 || 1;
      vv = parseFloat(((vixNow - prev.price) / elapsedMin).toFixed(4));
    }

    state.vixHistory.push({ iso: nowIso, price: vixNow });
    if (state.vixHistory.length > 200) state.vixHistory = state.vixHistory.slice(-200);
  }

  // state 업데이트
  state.market = {
    vix:       vixNow  != null ? parseFloat(vixNow.toFixed(2))  : state.market.vix,
    vvix:      vvixNow != null ? parseFloat(vvixNow.toFixed(2)) : state.market.vvix,
    vv:        vv      != null ? vv                              : state.market.vv,
    vold:      voldNow != null ? Math.round(voldNow)            : state.market.vold,
    uvol:      uvolNow != null ? Math.round(uvolNow)            : state.market.uvol,
    dvol:      dvolNow != null ? Math.round(dvolNow)            : state.market.dvol,
    updatedAt: nowIso,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. CBOE — 옵션체인 + Greeks 계산 (15분)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fetchCBOEChain(symbol) {
  const r = await fetch(
    `https://cdn.cboe.com/api/global/delayed_quotes/options/${symbol}.json`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.cboe.com/',
      },
      signal: AbortSignal.timeout(12000),
    }
  );
  if (!r.ok) throw new Error(`CBOE ${symbol} HTTP ${r.status}`);
  return await r.json();
}

function computeGreeks(cboeJson) {
  const spotPrice = cboeJson.data.current_price;
  const allOptions = cboeJson.data.options;

  // EST 기준 오늘 날짜 → 0DTE 만기 키
  const nowE = nowEST();
  const todayISO = nowE.toLocaleDateString('en-CA');
  const todayKey = `${todayISO.slice(2,4)}${todayISO.slice(5,7)}${todayISO.slice(8,10)}`;

  // 0DTE 필터
  const parsed = allOptions.filter(o => {
    const m = o.option.trim().match(/(\d{6})[CP]/);
    return m && m[1] === todayKey;
  }).map(o => {
    const m = o.option.trim().match(/(\d{6})([CP])(\d+)/);
    if (!m) return null;
    return {
      strike: parseInt(m[3]) / 1000,
      type:   m[2],
      iv:     o.iv,
      gamma:  o.gamma,
      oi:     o.open_interest,
      volume: o.volume,
    };
  }).filter(Boolean);

  if (parsed.length === 0) throw new Error('NO_0DTE_DATA');

  // 스트라이크별 집계
  const map = {};
  for (const o of parsed) {
    if (!map[o.strike]) map[o.strike] = {
      strike: o.strike,
      callOI: 0, putOI: 0,
      callVol: 0, putVol: 0,
      ivSum: 0, ivN: 0,
    };
    const s = map[o.strike];
    if (o.type === 'C') { s.callOI += o.oi; s.callVol += o.volume; }
    else                { s.putOI  += o.oi; s.putVol  += o.volume; }
    if (o.iv > 0) { s.ivSum += o.iv; s.ivN++; }
  }
  const strikes = Object.values(map).sort((a, b) => a.strike - b.strike);

  // BS Greeks 계산
  const msToExp = new Date(todayISO) - new Date();
  const T = Math.max(msToExp / (1000 * 60 * 60 * 24 * 365), 1 / 365);
  const safeT = Math.max(T, 0.5 / 365);
  const r_rate = 0.045;
  let totalVanna = 0, totalCharm = 0;

  for (const s of strikes) {
    s.iv = s.ivN > 0 ? s.ivSum / s.ivN : 0;
    const K = s.strike;
    const sigma = s.iv > 0 ? s.iv : 0.20;
    const sqrtT = Math.sqrt(T);
    const safeSqrtT = Math.sqrt(safeT);
    const d1 = (Math.log(spotPrice / K) + (r_rate + sigma * sigma / 2) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    const nd1 = normPDF(d1);
    const bsGamma = isFinite(nd1) ? nd1 / (spotPrice * sigma * sqrtT) : 0;

    s.gex        = isFinite(bsGamma) ? (s.callOI - s.putOI) * bsGamma * 100 * spotPrice : 0;
    s.callHedge  = bsGamma * s.callOI * 100 * spotPrice;
    s.putHedge   = bsGamma * s.putOI  * 100 * spotPrice;

    const netOI  = s.callOI - s.putOI;
    const vanna  = nd1 * (d2 / sigma) * netOI * 100 * spotPrice;
    totalVanna  += isFinite(vanna) ? vanna : 0;
    const charm  = -nd1 * (r_rate / (sigma * safeSqrtT) - d2 / (2 * safeT)) * netOI * 100;
    totalCharm  += isFinite(charm) ? charm : 0;
  }

  // GEX 집계
  let cum = 0, flipZone = null;
  for (const s of strikes) {
    const prev = cum;
    cum += s.gex;
    s.cumGex = cum;
    if (!flipZone && ((prev < 0 && cum >= 0) || (prev > 0 && cum <= 0))) {
      flipZone = s.strike;
    }
  }

  const near      = strikes.filter(s => Math.abs(s.strike - spotPrice) / spotPrice < 0.10);
  const putWall   = near.reduce((b, s) => s.putOI  > b.putOI  ? s : b, near[0])?.strike;
  const callWall  = near.reduce((b, s) => s.callOI > b.callOI ? s : b, near[0])?.strike;
  const localGEX  = strikes.filter(s => Math.abs(s.strike - spotPrice) / spotPrice < 0.02)
                           .reduce((a, s) => a + s.gex, 0);
  const totalCallOI = strikes.reduce((a, s) => a + s.callOI, 0);
  const totalPutOI  = strikes.reduce((a, s) => a + s.putOI,  0);
  const pcr         = totalPutOI / Math.max(totalCallOI, 1);

  const upStrikes = strikes.filter(s => s.strike > spotPrice && s.strike <= spotPrice * 1.05)
                           .sort((a, b) => b.callHedge - a.callHedge).slice(0, 4);
  const dnStrikes = strikes.filter(s => s.strike < spotPrice && s.strike >= spotPrice * 0.95)
                           .sort((a, b) => b.putHedge  - a.putHedge).slice(0, 4);

  return {
    exp:        todayISO,
    spotPrice,
    strikes,
    upStrikes,
    dnStrikes,
    flipZone,
    putWall,
    callWall,
    localGEX:   parseFloat((localGEX / 1e6).toFixed(2)),
    totalGEX:   parseFloat((cum / 1e6).toFixed(2)),
    vanna:      parseFloat((totalVanna / 1e6).toFixed(2)),
    charm:      parseFloat((totalCharm / 1e6).toFixed(2)),
    pcr:        parseFloat(pcr.toFixed(3)),
    computedAt: new Date().toISOString(),
    source:     'cboe',
  };
}

async function cronGreeks() {
  const symbols = ['SPY', 'QQQ', 'IWM'];
  const today   = todayEST();
  const nowIso  = new Date().toISOString();

  // vc_history 날짜 초기화
  if (state.vcHistoryDate !== today) {
    state.vcHistory    = {};
    state.vcHistoryDate = today;
  }

  for (const sym of symbols) {
    try {
      const cboeJson = await fetchCBOEChain(sym);
      const result   = computeGreeks(cboeJson);

      state.greeks[sym]  = result;
      state.strikes[sym] = result.strikes;

      // vc_history append (04:00~20:00 EST)
      if (isExtendedHours()) {
        if (!state.vcHistory[sym]) state.vcHistory[sym] = [];
        state.vcHistory[sym].push({
          iso:   nowIso,
          vanna: result.vanna,
          charm: result.charm,
          vix:   state.market.vix,
          vold:  state.market.vold,
          spot:  result.spotPrice,
        });
        if (state.vcHistory[sym].length > 200) {
          state.vcHistory[sym] = state.vcHistory[sym].slice(-200);
        }
      }

      console.log(`[Cron Greeks] ${sym} 완료 — vanna=${result.vanna} charm=${result.charm} gex=${result.totalGEX}`);
    } catch (e) {
      console.error(`[Cron Greeks] ${sym} 실패:`, e.message);
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Cron 스케줄 등록
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VIX/VVIX/VOLD: 1분마다
cron.schedule('* * * * *', async () => {
  try { await cronMarket(); } catch (e) { console.error('[Cron Market]', e.message); }
});

// CBOE Greeks: 15분마다
cron.schedule('*/15 * * * *', async () => {
  try { await cronGreeks(); } catch (e) { console.error('[Cron Greeks]', e.message); }
});

// prevClose 업데이트: 매일 장 마감 후 16:05 EST
cron.schedule('5 16 * * 1-5', async () => {
  try { await updatePrevClose(); } catch (e) { console.error('[prevClose]', e.message); }
}, { timezone: 'America/New_York' });

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 라우터
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/quote?symbol=SPY
// 현재가 (Finnhub WebSocket 수신값)
app.get('/api/quote', (req, res) => {
  const sym  = (req.query.symbol || 'SPY').toUpperCase();
  const data = state.prices[sym];
  if (!data) return res.json({ symbol: sym, price: null, note: 'no_data_yet' });
  res.json({ symbol: sym, ...data });
});

// GET /api/quotes — 전체 감시 종목 현재가 일괄
app.get('/api/quotes', (req, res) => {
  res.json(state.prices);
});

// GET /api/market — VIX/VVIX/VOLD/VV
app.get('/api/market', (req, res) => {
  res.json(state.market);
});

// GET /api/greeks?symbol=SPY — Vanna/Charm/GEX
app.get('/api/greeks', (req, res) => {
  const sym = (req.query.symbol || 'SPY').toUpperCase();
  const data = state.greeks[sym];
  if (!data) return res.json({ symbol: sym, note: 'no_data_yet' });
  // strikes는 용량이 크므로 기본 제외 (별도 엔드포인트)
  const { strikes, upStrikes, dnStrikes, ...summary } = data;
  res.json({ symbol: sym, ...summary, upStrikes, dnStrikes });
});

// GET /api/strikes?symbol=SPY — 전체 스트라이크 테이블 (차트용)
app.get('/api/strikes', (req, res) => {
  const sym = (req.query.symbol || 'SPY').toUpperCase();
  const data = state.strikes[sym];
  if (!data) return res.json({ symbol: sym, strikes: [], note: 'no_data_yet' });
  res.json({ symbol: sym, strikes: data });
});

// GET /api/vc_history?symbol=SPY — Vanna/Charm 시계열
app.get('/api/vc_history', (req, res) => {
  const sym     = (req.query.symbol || 'SPY').toUpperCase();
  const history = state.vcHistory[sym] || [];
  res.json({ symbol: sym, date: todayEST(), history });
});

// GET /api/options?symbol=SPY — CBOE 옵션체인 원본 (클라이언트 직접 요청 시)
app.get('/api/options', async (req, res) => {
  const sym = (req.query.symbol || 'SPY').toUpperCase();
  try {
    const data = await fetchCBOEChain(sym);
    res.json({ ...data, source: 'cboe', timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message, symbol: sym });
  }
});

// GET /api/status — 서버 상태 확인
app.get('/api/status', (req, res) => {
  res.json({
    ok:             true,
    version:        '1.0.0',
    finnhubWs:      finnhubWs?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
    watchSymbols:   WATCH_SYMBOLS,
    pricesUpdated:  Object.fromEntries(
      Object.entries(state.prices).map(([k, v]) => [k, v.updatedAt])
    ),
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
app.listen(PORT, () => {
  console.log(`[Server] StockDash 서버 시작 — port ${PORT}`);

  // Finnhub WebSocket 연결
  connectFinnhub();

  // 서버 시작 시 즉시 1회 실행
  cronMarket().catch(e => console.error('[Init] market 초기화 실패:', e.message));

  setTimeout(() => {
    cronGreeks().catch(e => console.error('[Init] greeks 초기화 실패:', e.message));
    updatePrevClose().catch(e => console.error('[Init] prevClose 초기화 실패:', e.message));
  }, 3000); // 3초 후 (market 조회 완료 대기)
});
