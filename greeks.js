// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// greeks.js — CBOE 옵션체인 + Greeks 계산 + Cron 실행
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { state } from './state.js';
import { broadcast } from './broadcast.js';
import { analyzeVanna } from './vanna_analyzer.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// [TODO: Railway Volume 도입 시 아래 주석 해제]
// import fs from 'fs/promises';
// const PERSISTENCE_PATH = '/data/base_strikes.json';
//
// async function loadBaseSnap() {
//   try {
//     const raw = await fs.readFile(PERSISTENCE_PATH, 'utf8');
//     const data = JSON.parse(raw);
//     // 날짜가 오늘과 같을 때만 복구
//     const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
//     for (const sym of Object.keys(data)) {
//       if (data[sym]?.base?.date === todayET) {
//         if (!state.strikesHistory[sym]) state.strikesHistory[sym] = {};
//         state.strikesHistory[sym].base = data[sym].base;
//         console.log('[Greeks] baseSnap 복구:', sym, data[sym].base.iso);
//       }
//     }
//   } catch (_) { /* 파일 없으면 무시 */ }
// }
//
// async function saveBaseSnap() {
//   try {
//     const payload = {};
//     for (const sym of ['SPY', 'QQQ', 'IWM']) {
//       if (state.strikesHistory[sym]?.base) payload[sym] = { base: state.strikesHistory[sym].base };
//     }
//     await fs.writeFile(PERSISTENCE_PATH, JSON.stringify(payload), 'utf8');
//   } catch (e) { console.error('[Greeks] baseSnap 저장 실패:', e.message); }
// }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// [TODO: Upstash Redis 도입 시 아래 주석 해제 (Railway Volume 대안)]
// import { Redis } from '@upstash/redis';
// const redis = new Redis({ url: process.env.UPSTASH_URL, token: process.env.UPSTASH_TOKEN });
//
// async function loadBaseSnap() {
//   const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
//   for (const sym of ['SPY', 'QQQ', 'IWM']) {
//     try {
//       const data = await redis.get('base_snap_' + sym);
//       if (data?.base?.date === todayET) {
//         if (!state.strikesHistory[sym]) state.strikesHistory[sym] = {};
//         state.strikesHistory[sym].base = data.base;
//         console.log('[Greeks] Redis baseSnap 복구:', sym, data.base.iso);
//       }
//     } catch (_) {}
//   }
// }
//
// async function saveBaseSnap(sym) {
//   try {
//     await redis.set('base_snap_' + sym, { base: state.strikesHistory[sym].base }, { ex: 86400 });
//   } catch (e) { console.error('[Greeks] Redis baseSnap 저장 실패:', sym, e.message); }
// }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function normPDF(x) {
  return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
}

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
// CBOE 심볼에서 가장 가까운 만기일 추출
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function nearestExpiry(allOptions) {
  const dates = new Set();
  for (const o of allOptions) {
    const m = o.option.trim().match(/(\d{2})(\d{2})(\d{2})[CP]/);
    if (!m) continue;
    dates.add(`20${m[1]}-${m[2]}-${m[3]}`);
  }
  // 오늘 이후 가장 가까운 날짜 (ET 기준)
  const sorted = [...dates].sort();
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return sorted.find(d => d >= todayET) ?? sorted[0];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Greeks 계산
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function computeGreeks(cboeJson) {
  const spotPrice  = cboeJson.data.current_price;
  const allOptions = cboeJson.data.options;

  // CBOE 응답에서 직접 가장 가까운 만기일 추출
  const targetISO = nearestExpiry(allOptions);
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

  // T 계산 — ET 시각만 사용 (UTC 변환 없음)
  // ET 14:00 이후로는 T = 2시간 고정:
  // Charm = -nd1 * (...) / T 이므로 T→0 시 폭발하는 수학적 특성이 있음.
  // 14:00 이후 Charm 급등은 지표로서 의미없는 노이즈이므로 고정.
  // 원본 데이터(OI, IV)는 그대로이며 Vanna/GEX는 영향 없음.
  const nowET     = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etHour    = nowET.getHours() + nowET.getMinutes() / 60;
  // ET 14:00 이후면 만기까지 2시간 고정, 이전이면 실제 잔존시간
  const hoursToExp = etHour < 14 ? (16 - etHour) : 2;
  const T         = hoursToExp / 24 / 365;
  const sqrtT     = Math.sqrt(T);
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
// ET 시각 헬퍼 — 현재 ET 기준 시/분 반환
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function nowET() {
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false });
  const [h, m] = etStr.split(':').map(Number);
  return { h, m, totalMin: h * 60 + m };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cronGreeks — SPY/QQQ/IWM 15분마다
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function cronGreeks() {
  const symbols  = ['SPY', 'QQQ', 'IWM'];
  const nowIso   = new Date().toISOString();
  const todayET  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const { totalMin } = nowET();
  const isAfterOpen = totalMin >= 9 * 60;  // 09:00 ET 이후 여부

  for (const sym of symbols) {
    try {
      const cboeJson = await fetchCBOEChain(sym);
      const result   = computeGreeks(cboeJson);
      result.analysis = analyzeVanna(result, state.vcHistory[sym] || []);

      // ── strikesHistory 초기화 ──
      if (!state.strikesHistory[sym]) state.strikesHistory[sym] = {};
      const hist = state.strikesHistory[sym];

      // ── prevSnap: 항상 직전 스냅샷으로 교체 ──
      const prevSnap = hist.prev ?? null;

      // ── baseSnap: 당일 09:00 ET 이후 첫 스냅샷만 저장, 이후 고정 ──
      if (isAfterOpen && (!hist.base || hist.base.date !== todayET)) {
        hist.base = {
          date: todayET,
          iso:  nowIso,
          strikes: result.strikes.map(s => ({ strike: s.strike, callOI: s.callOI, putOI: s.putOI })),
        };
        console.log('[Greeks] baseSnap 확정:', sym, nowIso);
        // [TODO: Railway Volume 도입 시] await saveBaseSnap();
        // [TODO: Upstash Redis 도입 시]  await saveBaseSnap(sym);
      }
      const baseSnap = (hist.base?.date === todayET) ? hist.base : null;

      // ── OI 증감 계산 ──
      const prevMap = {}, baseMap = {};
      if (prevSnap) for (const s of prevSnap.strikes) prevMap[s.strike] = s;
      if (baseSnap) for (const s of baseSnap.strikes) baseMap[s.strike] = s;

      for (const s of result.strikes) {
        const prev = prevMap[s.strike];
        const base = baseMap[s.strike];
        // Diff15: prevSnap 없으면 0 (서버 시작 첫 1회, 자연스럽게 처리)
        s.callOIDiff15  = prev ? s.callOI - prev.callOI : 0;
        s.putOIDiff15   = prev ? s.putOI  - prev.putOI  : 0;
        // DiffCum: baseSnap 없으면 null (09:00 ET 이전 프리마켓 구간)
        s.callOIDiffCum = base ? s.callOI - base.callOI : null;
        s.putOIDiffCum  = base ? s.putOI  - base.putOI  : null;
      }

      // ── prevSnap 갱신 (Diff 계산 완료 후) ──
      hist.prev = {
        iso: nowIso,
        strikes: result.strikes.map(s => ({ strike: s.strike, callOI: s.callOI, putOI: s.putOI })),
      };

      // ── state 저장 (Diff 계산 완료 후) ──
      state.greeks[sym]  = result;
      state.strikes[sym] = result.strikes;

      // ── vcHistory 기록 ──
      if (!state.vcHistory[sym]) state.vcHistory[sym] = [];
      state.vcHistory[sym].push({
        iso:   nowIso,
        vanna: result.vanna,
        charm: result.charm,
        vix:   state.market.vix,
        vold:  state.market.vold,
        spot:  result.spotPrice,
      });
      if (state.vcHistory[sym].length > 200) state.vcHistory[sym] = state.vcHistory[sym].slice(-200);

      const { strikes, ...summary } = result;
      broadcast('greeks', { symbol: sym, ...summary });
      console.log('[Cron Greeks] ' + sym + ' — vanna=' + result.vanna + ' charm=' + result.charm
        + ' | Diff15=' + (prevSnap ? 'O' : '최초') + ' DiffCum=' + (baseSnap ? 'O' : '장전'));
    } catch (e) { console.error('[Cron Greeks] ' + sym + ' 실패:', e.message); }
  }
}
