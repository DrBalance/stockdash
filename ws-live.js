// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ws-live.js — 시간 유틸, 장 상태 관리, WebSocket, VIX 다이버전스
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 시간 유틸
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// UTC ISO → KST "HH:MM" (저장 기준: UTC ISO, 표시 기준: KST)
function toKST(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul'
  });
}

// 섬머타임 감지 (미국 동부 기준) — 개장선 표시용
function isEDT() {
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' });
  return etStr.includes('EDT');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 헤더 시계 + 장 상태 관리 (1초 주기)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const MARKET_STATE_STYLE = {
  REGULAR: { label:'정규장',     dot:'#3fb950', bg:'rgba(63,185,80,.12)',   color:'#3fb950' },
  PRE:     { label:'프리마켓',   dot:'#d29922', bg:'rgba(210,153,34,.12)',  color:'#d29922' },
  AFTER:   { label:'애프터마켓', dot:'#f0883e', bg:'rgba(240,136,62,.12)',  color:'#f0883e' },
  CLOSED:  { label:'마감',       dot:'#6e7681', bg:'rgba(110,118,129,.12)', color:'#6e7681' },
};

function getMarketStateClient() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    weekday: 'short', hour: '2-digit', minute: '2-digit'
  }).formatToParts(now);
  const get = type => +fmt.find(p => p.type === type).value;
  const dow = fmt.find(p => p.type === 'weekday').value;
  const h   = get('hour') + get('minute') / 60;
  if (dow === 'Sat' || dow === 'Sun') return 'CLOSED';
  if (h >= 4   && h <  9.5)          return 'PRE';
  if (h >= 9.5 && h <  16)           return 'REGULAR';
  if (h >= 16  && h <  20)           return 'AFTER';
  return 'CLOSED';
}

function updateMarketStateBadge(state) {
  const s = MARKET_STATE_STYLE[state] || MARKET_STATE_STYLE.CLOSED;
  const badge = document.getElementById('market-state-badge');
  const dot   = document.getElementById('market-state-dot');
  const label = document.getElementById('market-state-label');
  if (badge) { badge.style.background = s.bg; badge.style.color = s.color; }
  if (dot)   { dot.style.background = s.dot; }
  if (label) { label.textContent = s.label; }
}

function startClock() {
  function tick() {
    const now = new Date();
    const etEl  = document.getElementById('clock-et');
    const kstEl = document.getElementById('clock-kst');
    if (etEl)  etEl.textContent  = now.toLocaleTimeString('en-GB', {
      hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone:'America/New_York'
    }) + ' ET';
    if (kstEl) kstEl.textContent = now.toLocaleTimeString('en-GB', {
      hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone:'Asia/Seoul'
    }) + ' KST';
    const newState = getMarketStateClient();
    if (newState !== window._marketState) {
      const prevState = window._marketState;
      window._marketState = newState;
      updateMarketStateBadge(newState);
      console.log('[Clock] 장 상태 변경:', prevState, '→', newState);

      // CLOSED → PRE 전환: 라이브 모드 복귀
      if (prevState === 'CLOSED' && newState === 'PRE') {
        console.log('[Clock] 프리마켓 시작 — 라이브 모드 전환');
        load0DTE();
        if (!auto0DTEInterval) {
          auto0DTEInterval = setInterval(load0DTE, 60000);
        }
        connectWS();
      }
    }
  }
  tick(); // 즉시 1회 실행
  setInterval(tick, 1000);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CLOSED 전용 프로시저 — WS 없이 1회성 조회로 화면 구성
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function loadClosed() {
  const sym = document.getElementById('sym-select-0dte')?.value || 'SPY';
  current0DTESym = sym;
  setStatus('updating');

  try {
    // 1. 현재가/등락률
    let price = null, change = null;
    try {
      const quotes = await fetch(`${PROXY}/api/quotes`).then(r => r.json());
      const d = quotes[sym];
      if (d?.price != null) { price = d.price; change = d.change; }
    } catch (e) { console.warn('[loadClosed] 현재가 실패:', e.message); }

    // 2. VIX/VVIX
    try {
      const m = await fetch(`${PROXY}/api/market`).then(r => r.json());
      if (m.vix  != null) vixVal  = m.vix;
      if (m.vvix != null) vvixVal = m.vvix;
      window._lastVixJson = {
        VIX:  { price: m.vix,  pctChange: m.vixChangePct  ?? null },
        VVIX: { price: m.vvix, pctChange: m.vvixChangePct ?? null },
      };
    } catch (e) { console.warn('[loadClosed] VIX 실패:', e.message); }

    // 3. 옵션 데이터 (다음 거래일) + render0DTE 재활용
    const d0 = await fetch(`${PROXY}/api/gex0dte?symbol=${sym}`).then(r => r.json());
    if (d0.error) throw new Error(d0.error);

    window._lastPriceJson = { price, prevChange: change, marketState: 'CLOSED' };

    // render0DTE가 참조하는 currentD 사전 설정
    currentD = {
      strikes:   d0.strikes || [],
      spotPrice: d0.spotPrice,
      flipZone:  d0.flipZone,
      putWall:   d0.putWall,
      callWall:  d0.callWall,
      localGEX:  (d0.localGEX || 0) * 1e6,
      totalGEX:  (d0.totalGEX || 0) * 1e6,
      pcr:       d0.pcr,
      exp:       d0.exp,
      sym,
      upStrikes: d0.upStrikes || [],
      dnStrikes: d0.dnStrikes || [],
    };
    currentStrikes = currentD.strikes;
    const timeStr = new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul'
    });
    render0DTE(d0, price, 'CLOSED', null, null, timeStr);

    // 4. 마감 고지 메시지 덮어쓰기
    const liveEl = document.getElementById('judgment-live-content-0dte');
    if (liveEl) liveEl.innerHTML = `<div class="live-event le-info"><span class="le-time">—</span><span class="le-msg">장 마감 — ${d0.exp} 다음 거래일 데이터입니다. ET 04:00 프리마켓 시작 시 실시간으로 전환됩니다.</span></div>`;

    setStatus('live');
  } catch (e) {
    console.error('[loadClosed] 실패:', e.message);
    document.getElementById('main-area-0dte').innerHTML =
      `<div class="empty-state">로드 실패<br><small>${e.message}</small></div>`;
    setStatus('error');
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  startClock(); // 가장 먼저 — window._marketState 초기화
  if (window._marketState === 'CLOSED') {
    loadClosed(); // CLOSED 전용 — WS 없음, 자동갱신 없음
  } else {
    load0DTE();
    auto0DTEInterval = setInterval(load0DTE, 60000);
    connectWS();
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WebSocket 연결 관리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let _ws = null;
let _wsReconnectTimer = null;

function connectWS() {
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;
  console.log('[WS] 연결 시도...');
  const wsEl = document.getElementById('ws-status-text');
  if (wsEl) wsEl.textContent = '연결 중...';

  _ws = new WebSocket(WS_URL);

  _ws.onopen = () => {
    console.log('[WS] 연결 성공');
    if (wsEl) { wsEl.textContent = '🟢 WS LIVE'; wsEl.style.color = 'var(--green)'; }
    setStatus('live');
    if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
  };

  _ws.onmessage = (e) => {
    try {
      const { type, data, ts } = JSON.parse(e.data);
      if      (type === 'init')   onWSInit(data);
      else if (type === 'prices') onWSPrices(data);
      else if (type === 'market') onWSMarket(data);
      else if (type === 'greeks') onWSGreeks(data);
    } catch (err) { console.warn('[WS] 파싱 오류:', err.message); }
  };

  _ws.onclose = () => {
    console.warn('[WS] 연결 종료 — 10초 후 재연결');
    if (wsEl) { wsEl.textContent = '🔴 WS 끊김'; wsEl.style.color = 'var(--red)'; }
    setStatus('error');
    if (!_wsReconnectTimer) {
      _wsReconnectTimer = setTimeout(() => { _wsReconnectTimer = null; connectWS(); }, 10000);
    }
  };

  _ws.onerror = (e) => { console.warn('[WS] 오류'); _ws.close(); };
}

// ── init: 연결 즉시 전체 상태 수신 ──
function onWSInit({ prices, market }) {
  if (prices) onWSPrices(prices);
  if (market) onWSMarket(market);

  // CLOSED 시 상황판단 메시지 창에 고지
  const ms = window._marketState || 'REGULAR';
  if (ms === 'CLOSED') {
    const sym = document.getElementById('sym-select-0dte')?.value || 'SPY';
    const nextDay = prices?.[sym]?.nextTradingDay || market?.nextTradingDay || null;
    const liveEl = document.getElementById('judgment-live-content-0dte');
    if (liveEl) {
      const dayStr = nextDay
        ? ` ${nextDay} 프리마켓 (ET 04:00)`
        : ' 다음 거래일 프리마켓 (ET 04:00)';
      liveEl.innerHTML = `<div class="live-event le-info"><span class="le-time">—</span><span class="le-msg">장 마감 — 다음 거래일 데이터입니다.${dayStr} 시작 시 실시간으로 전환됩니다.</span></div>`;
    }
  }
}

// ── prices: Finnhub 거래 발생 시 푸시 ──
function onWSPrices(prices) {
  const sym = document.getElementById('sym-select-0dte')?.value || 'SPY';
  const d = prices[sym];
  if (!d || d.price == null) return;

  const newSpot = d.price;
  // 장 상태는 1초 시계(startClock)에서 관리 — 여기서는 읽기만
  const state = window._marketState || 'REGULAR';
  const LABELS = { PRE:'프리마켓', REGULAR:'정규장', AFTER:'애프터마켓', CLOSED:'마감' };

  window._lastPriceJson = {
    price:       newSpot,
    prevClose:   d.prevClose,
    prevChange:  d.change,
    marketState: state,
  };

  const SHORT = { PRE:'프리', REGULAR:'정규', AFTER:'애프터', CLOSED:'마감' };
  const CLS   = { PRE:'pre-market', REGULAR:'', AFTER:'after-market', CLOSED:'' };

  // 현재가 메트릭 카드 업데이트
  const spotEl = document.getElementById('metric-spot-0dte');
  if (spotEl && newSpot) {
    const pctStr = d.change != null ? `${d.change > 0 ? '+' : ''}${d.change.toFixed(2)}%` : '';
    const badgeCls = { PRE:'pre', REGULAR:'regular', AFTER:'after', CLOSED:'closed' }[state] || 'closed';
    spotEl.querySelector('.spot-state-badge').className = `spot-state-badge ${badgeCls}`;
    spotEl.querySelector('.spot-state-badge').textContent = LABELS[state] || state;
    spotEl.querySelector('.val').textContent = `$${newSpot.toFixed(2)}`;
    spotEl.querySelector('.lbl').textContent = pctStr;
    const colorCls = d.change > 0 ? ' green' : d.change < 0 ? ' red' : '';
    spotEl.className = 'metric blue' + (CLS[state] ? ' '+CLS[state] : '') + colorCls;
    spotEl.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center';
  }

  // OI차트 현재가 수직선만 별도 업데이트 (차트 전체 재렌더 없이)
  if (chartInst && newSpot) {
    chartInst._spotPrice = newSpot;
    chartInst.draw();
  }
}

// ── market: 1분 Cron VIX/VVIX/VOLD/VV ──
function onWSMarket(data) {
  // VIX
  if (data.vix != null) {
    vixVal = data.vix;
    vixPriceHistory.push(vixVal);
    if (vixPriceHistory.length > 120) vixPriceHistory.shift();
    const vixDiv = detectVIXDivergence(vixPriceHistory, 'VIX');
    pushDivergenceEvent(vixDiv, 'VIX');
  }
  // VVIX
  if (data.vvix != null) {
    vvixVal = data.vvix;
    vvixPriceHistory.push(vvixVal);
    if (vvixPriceHistory.length > 120) vvixPriceHistory.shift();
    const vvixDiv = detectVIXDivergence(vvixPriceHistory, 'VVIX');
    pushDivergenceEvent(vvixDiv, 'VVIX');
  }
  // VV
  if (data.vv != null && vcHistory.length > 0) {
    vcHistory[vcHistory.length - 1].vv = data.vv;
  }
  // VOLD
  if (data.vold != null) {
    window._lastVold = data.vold;
  } else if (window._marketState === 'CLOSED') {
    window._lastVold = null; // CLOSED 시 — 표시
  }

  window._lastVixJson = {
    VIX:  {
      price: data.vix,
      pctChange: data.vixChangePct ?? null,
    },
    VVIX: {
      price: data.vvix,
      pctChange: data.vvixChangePct ?? null,
    },
  };
  window._lastMarket = data;

  updateVIXMetrics();
}

// ── greeks: 15분 Cron Greeks 업데이트 ──
function onWSGreeks(data) {
  // 현재 선택된 심볼과 일치하면 currentD 업데이트
  const sym = document.getElementById('sym-select-0dte')?.value || 'SPY';
  if (data.symbol === sym && currentD) {
    currentD.flipZone = data.flipZone ?? currentD.flipZone;
    currentD.putWall  = data.putWall  ?? currentD.putWall;
    currentD.callWall = data.callWall ?? currentD.callWall;
    currentD.totalGEX = (data.totalGEX ?? 0) * 1e6;
    currentD.localGEX = (data.localGEX ?? 0) * 1e6;
    currentD.pcr      = data.pcr      ?? currentD.pcr;
    console.log('[WS Greeks]', sym, 'vanna=', data.vanna, 'charm=', data.charm);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RSI 계산 (Wilder RMA 방식, Pine Script 동일)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function calcRSI(prices, length = 14) {
  if (prices.length < length + 1) return [];
  const rsiArr = new Array(prices.length).fill(null);
  // 초기 SMA 시드
  let gains = 0, losses = 0;
  for (let i = 1; i <= length; i++) {
    const chg = prices[i] - prices[i - 1];
    if (chg > 0) gains += chg; else losses -= chg;
  }
  let avgGain = gains / length;
  let avgLoss = losses / length;
  rsiArr[length] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  // Wilder RMA
  for (let i = length + 1; i < prices.length; i++) {
    const chg = prices[i] - prices[i - 1];
    const g = chg > 0 ? chg : 0;
    const l = chg < 0 ? -chg : 0;
    avgGain = (avgGain * (length - 1) + g) / length;
    avgLoss = (avgLoss * (length - 1) + l) / length;
    rsiArr[i] = avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsiArr;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 피벗 고점/저점 감지 (Pine Script pivothigh/pivotlow 동일)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function findPivots(arr, left = 5, right = 5) {
  const highs = [], lows = [];
  for (let i = left; i < arr.length - right; i++) {
    if (arr[i] == null) continue;
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i || arr[j] == null) continue;
      if (arr[j] >= arr[i]) isHigh = false;
      if (arr[j] <= arr[i]) isLow = false;
    }
    if (isHigh) highs.push({ idx: i, val: arr[i] });
    if (isLow)  lows.push({ idx: i, val: arr[i] });
  }
  return { highs, lows };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VIX/VVIX RSI 다이버전스 감지
// Pine Script 로직 충실히 변환:
//   Bearish: 가격 HH + RSI LH → VIX 모멘텀 약화 (시장 하락 압력 완화)
//   Bullish: 가격 LL + RSI HL → VIX 모멘텀 강화 (시장 하락 압력 재개)
// rangeLower=5, rangeUpper=60 (피벗 간 최소/최대 봉 수)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const divState = {
  VIX:  { bear: 0, bull: 0 },
  VVIX: { bear: 0, bull: 0 },
};

function detectVIXDivergence(prices, symKey, rangeLower = 5, rangeUpper = 60) {
  if (prices.length < 30) return null; // 데이터 부족

  const rsiArr = calcRSI(prices, 14);
  const LEFT = 5, RIGHT = 5;
  const pricePivots = findPivots(prices, LEFT, RIGHT);
  const rsiPivots   = findPivots(rsiArr,  LEFT, RIGHT);

  // 최신 피벗 기준 (끝에서 가장 최근 2개)
  const lastPH  = pricePivots.highs.slice(-1)[0];
  const prevPH  = pricePivots.highs.slice(-2)[0];
  const lastPL  = pricePivots.lows.slice(-1)[0];
  const prevPL  = pricePivots.lows.slice(-2)[0];
  const lastRH  = rsiPivots.highs.slice(-1)[0];
  const prevRH  = rsiPivots.highs.slice(-2)[0];
  const lastRL  = rsiPivots.lows.slice(-1)[0];
  const prevRL  = rsiPivots.lows.slice(-2)[0];

  const inRange = (a, b) => {
    const bars = Math.abs(a.idx - b.idx);
    return bars >= rangeLower && bars <= rangeUpper;
  };

  let bearCond = false, bullCond = false;

  // Bearish: 가격 HH + RSI LH (VIX 상승 모멘텀 약화)
  if (lastPH && prevPH && lastRH && prevRH && inRange(lastPH, prevPH)) {
    const priceHH = lastPH.val > prevPH.val;
    const rsiLH   = lastRH.val < prevRH.val;
    bearCond = priceHH && rsiLH;
  }

  // Bullish: 가격 LL + RSI HL (VIX 하락 모멘텀 약화 → 반등 가능)
  if (lastPL && prevPL && lastRL && prevRL && inRange(lastPL, prevPL)) {
    const priceLL = lastPL.val < prevPL.val;
    const rsiHL   = lastRL.val > prevRL.val;
    bullCond = priceLL && rsiHL;
  }

  const state = divState[symKey];
  if (bearCond) {
    state.bear++;
    state.bull = 0;
    return { type: 'bear', count: state.bear };
  }
  if (bullCond) {
    state.bull++;
    state.bear = 0;
    return { type: 'bull', count: state.bull };
  }
  // 신호 없으면 카운터 유지 (연속성 기록)
  return null;
}

// VIX 히스토리 (다이버전스용, 최대 120개)
let vixPriceHistory  = [];
let vvixPriceHistory = [];

// 다이버전스 이벤트 → 실시간 판단 패널에 추가
function pushDivergenceEvent(div, symKey) {
  if (!div) return;
  const now = new Date();
  const timeStr = toKST(now.toISOString());
  const countStr = div.count > 1 ? ` (${div.count}회 연속)` : ' (1회)';

  let cls, msg;
  if (symKey === 'VIX') {
    if (div.type === 'bear') {
      cls = 'le-good';
      msg = `🟢 VIX Bearish Divergence${countStr} — VIX 상승 모멘텀 약화. 하락 압력 완화 가능. Vanna 구조 확인 권장`;
    } else {
      cls = 'le-warn';
      msg = `🔴 VIX Bullish Divergence${countStr} — VIX 하락 모멘텀 약화. 변동성 재상승 주의`;
    }
  } else {
    if (div.type === 'bear') {
      cls = 'le-good';
      msg = `🟢 VVIX Bearish Divergence${countStr} — VVIX 모멘텀 약화. VIX 상승 선행 압력 완화`;
    } else {
      cls = 'le-warn';
      msg = `🔴 VVIX Bullish Divergence${countStr} — VVIX 재상승 가능. VIX 선행 급등 주의`;
    }
  }

  liveEvents.unshift({ time: timeStr, cls, msg });
  if (liveEvents.length > 15) liveEvents = liveEvents.slice(0, 15);
}

function updateVIXMetrics() {
  const vm = document.getElementById('metric-vix');
  if (vm && vixVal != null) {
    const pctChange = window._lastVixJson?.VIX?.pctChange;
    const pctStr = pctChange != null
      ? ` <span style="font-size:12px;opacity:.75">(${pctChange>0?'+':''}${pctChange.toFixed(1)}%)</span>` : '';
    vm.querySelector('.val').innerHTML = vixVal.toFixed(2) + pctStr;
    vm.className = 'metric ' + (vixVal>30?'danger':vixVal>20?'warn':'yellow');
  }

  // VV 업데이트
  const vvEl = document.getElementById('metric-vv');
  if (vvEl && vcHistory.length > 0) {
    const lastVV = vcHistory.filter(h => h.vv != null).slice(-1)[0]?.vv;
    if (lastVV != null) {
      const sign = lastVV >= 0 ? '+' : '';
      const color = lastVV > 0.05 ? 'var(--red)' : lastVV < -0.05 ? 'var(--green)' : 'var(--text3)';
      vvEl.textContent = `VV ${sign}${lastVV.toFixed(3)}`;
      vvEl.style.color = color;
    }
  }

  // VOLD 메트릭 카드 업데이트 (OBV 대체)
  const voldCard    = document.getElementById('metric-obv');
  const voldValEl   = document.getElementById('metric-obv-val');
  const voldSlopeEl = document.getElementById('metric-obv-slope');
  const vold = window._lastVold ?? null;
  if (voldValEl) {
    if (vold != null) {
      const fmt = v => {
        const abs = Math.abs(v), sign = v < 0 ? '-' : '+';
        if (abs >= 1e9) return sign + (abs/1e9).toFixed(2) + 'B';
        if (abs >= 1e6) return sign + (abs/1e6).toFixed(2) + 'M';
        if (abs >= 1e3) return sign + (abs/1e3).toFixed(0) + 'K';
        return String(Math.round(v));
      };
      voldValEl.textContent = fmt(vold);
      if (voldSlopeEl) {
        const dir = vold > 0 ? '↑ 매수우위' : vold < 0 ? '↓ 매도우위' : '→ 중립';
        voldSlopeEl.textContent = dir;
        voldSlopeEl.style.color = vold > 0 ? 'var(--green)' : vold < 0 ? 'var(--red)' : 'var(--text3)';
      }
      if (voldCard) voldCard.className = 'metric ' + (vold > 0 ? 'green' : vold < 0 ? 'red' : '');
    } else {
      // CLOSED 또는 데이터 없음 — 표시
      voldValEl.textContent = '—';
      if (voldSlopeEl) { voldSlopeEl.textContent = ''; }
      if (voldCard) voldCard.className = 'metric';
    }
  }
}
