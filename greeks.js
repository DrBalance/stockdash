// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// greeks.js — CBOE 옵션체인 + Greeks 계산 + Cron 실행
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { state } from './state.js';
import { nowEST, todayEST, getTargetTradingDay, isExtendedHours, normPDF } from './utils.js';
import { broadcast } from './broadcast.js';
import { analyzeVanna } from './vanna_analyzer.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CBOE 옵션체인 fetch
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function fetchCBOEChain(symbol) {
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Greeks 계산
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function computeGreeks(cboeJson) {
  const spotPrice  = cboeJson.data.current_price;
  const allOptions = cboeJson.data.options;
  // ET 기준으로 현재 유효한 거래 세션 날짜 결정
  const targetISO = getTargetTradingDay();
  if (!targetISO) throw new Error('NO_0DTE_DATA');
  const targetKey = targetISO.slice(2,4) + targetISO.slice(5,7) + targetISO.slice(8,10);

  const parsed = allOptions.filter(o => {
    const m = o.option.trim().match(/(\d{6})[CP]/);
    return m && m[1] === targetKey;
  }).map(o => {
    const m = o.option.trim().match(/(\d{6})([CP])(\d+)/);
    if (!m) return null;
    return { strike: parseInt(m[3]) / 1000, type: m[2], iv: o.iv, oi: o.open_interest, volume: o.volume };
  }).filter(Boolean);

  console.log('[Greeks] 대상 만기일:', targetISO, '옵션 수:', parsed.length);
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
  // 4~10월(EDT) → UTC 20:00 / 11~3월(EST) → UTC 21:00
  function getExpiryCloseUTC(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const utcHour = (m >= 4 && m <= 10) ? 20 : 21;
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
    s.vanna = isFinite(vanna) ? parseFloat((vanna / 1e6).toFixed(4)) : 0;
    totalVanna += isFinite(vanna) ? vanna : 0;
    // Charm: T로 통일
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
    isNextDay:  targetISO !== todayISO,
    localGEX:  parseFloat((localGEX / 1e6).toFixed(2)),
    totalGEX:  parseFloat((cum / 1e6).toFixed(2)),
    vanna:     parseFloat((totalVanna / 1e6).toFixed(2)),
    charm:     parseFloat((totalCharm / 1e6).toFixed(2)),
    pcr:       parseFloat((totalPutOI / Math.max(totalCallOI, 1)).toFixed(3)),
    computedAt: new Date().toISOString(),
    source: 'cboe',
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cronGreeks — SPY/QQQ/IWM 15분마다
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function cronGreeks() {
  const symbols = ['SPY', 'QQQ', 'IWM'];
  const today   = todayEST();
  const nowIso  = new Date().toISOString();
  if (state.vcHistoryDate !== today) { state.vcHistory = {}; state.vcHistoryDate = today; }

  for (const sym of symbols) {
    try {
      const cboeJson = await fetchCBOEChain(sym);
      const result   = computeGreeks(cboeJson);
      // ── Vanna 분석 시그널
      result.analysis = analyzeVanna(result, state.vcHistory[sym] || []);
      state.greeks[sym] = result;

      // ── OI 증감 계산
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
        s.callOIDiff15  = prev ? s.callOI - prev.callOI : 0;
        s.putOIDiff15   = prev ? s.putOI  - prev.putOI  : 0;
        s.callOIDiffCum = base ? s.callOI - base.callOI : 0;
        s.putOIDiffCum  = base ? s.putOI  - base.putOI  : 0;
      }
      // prevStrikes 갱신
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
