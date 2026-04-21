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


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 휴장일 Set + fetch
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const holidaySet = new Set(); // 'YYYY-MM-DD'

async function fetchHolidays() {
  try {
   /* const r = await fetch(
      `https://finnhub.io/api/v1/stock/market-holiday?exchange=US&token=${FINNHUB_TOKEN}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const j = await r.json();
    (j.data || [])
      .filter(h => !h.atNormalTime)
      .forEach(h => holidaySet.add(h.eventDay)); */
    const r = await fetch(`${PROXY}/api/holidays`,
    { signal: AbortSignal.timeout(8000) }
    );
    const j = await r.json();
    (j.holidays || []).forEach(d => holidaySet.add(d));
    console.log('[Holiday] 로드 완료:', holidaySet.size, '일');
  } catch (e) {
    console.warn('[Holiday] 로드 실패 — 휴장일 체크 없이 진행:', e.message);
  }
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

  // ── 1. ET 시각 분해 (섬머타임 자동 처리) — 먼저 계산
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    weekday: 'short', hour: '2-digit', minute: '2-digit',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const get = type => fmt.find(p => p.type === type)?.value ?? '';
  const dow      = get('weekday');
  const h        = +get('hour') + +get('minute') / 60;
  const todayISO = `${get('year')}-${get('month')}-${get('day')}`;
  window._etHour = h;

  // ── 2. isTradingDay — holidaySet 의존, 위 계산 이후
  const isTradingDay = dow !== 'Sat' && dow !== 'Sun' && !holidaySet.has(todayISO);

  // ── 3. marketState 계산
  let newState = 'CLOSED';
  if (isTradingDay) {
    if      (h >= 4   && h < 9.5) newState = 'PRE';
    else if (h >= 9.5 && h < 16)  newState = 'REGULAR';
    else if (h >= 16  && h < 20)  newState = 'AFTER';
  }

  // ── 4. targetISO 계산
  let newTargetISO;
  if (isTradingDay && h < 20) {
    newTargetISO = todayISO;
  } else {
    const d = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    for (let i = 1; i <= 10; i++) {
      d.setDate(d.getDate() + 1);
      const dw  = d.getDay();
      const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (dw >= 1 && dw <= 5 && !holidaySet.has(iso)) { newTargetISO = iso; break; }
    }
  }

  // ── 5. 전역변수 일괄 할당 — isTradingDay 확정 이후
  window._todayISO   = todayISO;
  window._isExtended = isTradingDay && h >= 4 && h < 20;  // ✅ 이제 안전

  // ── 6. 시계 UI 업데이트
  const kstStr = now.toLocaleTimeString('en-GB', {
    hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone:'Asia/Seoul'
  });
  const etEl  = document.getElementById('clock-et');
  const kstEl = document.getElementById('clock-kst');
  if (etEl)  etEl.textContent  = now.toLocaleTimeString('en-GB', {
    hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone:'America/New_York'
  }) + ' ET';
  if (kstEl) kstEl.textContent = kstStr + ' KST';
  window._kstStr = kstStr;

  // ── 7. 09:30 ET → KST
  const minsTo930 = (9.5 - h) * 60;
  window._openKST = new Date(now.getTime() + minsTo930 * 60000)
    .toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Seoul' });

  // ── 8. 상태 변화 감지 → 이벤트 발행
  const stateChanged  = newState     !== window._marketState;
  const targetChanged = newTargetISO !== window._targetISO;

  if (stateChanged || targetChanged) {
    const prevState = window._marketState;
    window._marketState = newState;
    window._targetISO   = newTargetISO;

    updateMarketStateBadge(newState);
    console.log('[Clock] 장 상태 변경:', prevState, '→', newState, '| target:', newTargetISO);

    window.dispatchEvent(new CustomEvent('marketStateChanged', {
      detail: { marketState: newState, prevState, targetISO: newTargetISO }
    }));
  }
}
  tick(); // 즉시 1회 실행
  setInterval(tick, 1000);
}

// ── 장 상태 전환 처리 (tick 밖으로 분리)
window.addEventListener('marketStateChanged', ({ detail }) => {
  const { marketState, prevState, targetISO } = detail;

  // CLOSED → PRE: 라이브 모드 전환
  if (prevState === 'CLOSED' && marketState === 'PRE') {
    console.log('[Market] 프리마켓 시작 — 라이브 모드 전환');
    load0DTE();
    if (!auto0DTEInterval) {
      auto0DTEInterval = setInterval(load0DTE, 60000);
    }
    connectWS();
  }

  // AFTER → CLOSED: 장 종료, 다음 거래일로 전환
  if (prevState === 'AFTER' && marketState === 'CLOSED') {
    console.log('[Market] 장 종료 — CLOSED 모드 전환, 다음 거래일:', targetISO);
    if (auto0DTEInterval) { clearInterval(auto0DTEInterval); auto0DTEInterval = null; }
    loadClosed();
  }

  // PRE → REGULAR: 정규장 시작
  if (prevState === 'PRE' && marketState === 'REGULAR') {
    console.log('[Market] 정규장 시작');
    // WS는 이미 연결 중 — 필요시 추가 처리
  }

  // REGULAR → AFTER: 정규장 종료
  if (prevState === 'REGULAR' && marketState === 'AFTER') {
    console.log('[Market] 애프터마켓 시작');
    // WS 유지 — 필요시 추가 처리
  }
});

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

    // targetISO를 서버 응답으로 보정 (서버가 더 정확할 수 있음)
    if (d0.exp && d0.exp !== window._targetISO) {
      console.log('[loadClosed] targetISO 보정:', window._targetISO, '→', d0.exp);
      window._targetISO = d0.exp;
    }

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

    // 화면 표시 시간 — 헤더 시계에서 읽기 (직접 계산 안 함)
    render0DTE(d0, price, 'CLOSED', null, null, window._kstStr);

    // 4. 마감 고지 메시지
    const liveEl = document.getElementById('judgment-live-content-0dte');
    if (liveEl) liveEl.innerHTML = `<div class="live-event le-info"><span class="le-time">—</span><span class="le-msg">장 마감 — 다음 거래일(${window._targetISO}) 데이터입니다. 당일 프리마켓 시작 시 실시간으로 전환됩니다.</span></div>`;

    setStatus('live');
  } catch (e) {
    console.error('[loadClosed] 실패:', e.message);
    document.getElementById('main-area-0dte').innerHTML =
      `<div class="empty-state">로드 실패<br><small>${e.message}</small></div>`;
    setStatus('error');
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  await fetchHolidays(); // holidaySet 먼저 — startClock보다 앞에
  startClock();          // window._marketState, window._targetISO 초기화
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
    const liveEl = document.getElementById('judgment-live-content-0dte');
    if (liveEl) {
      const targetISO = window._targetISO;
      const dayStr = targetISO
        ? ` ${targetISO} 프리마켓 (ET 04:00)`
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
    window._lastVold = null;
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
  let gains = 0, losses = 0;
  for (let i = 1; i <= length; i++) {
    const chg = prices[i] - prices[i - 1];
    if (chg > 0) gains += chg; else losses -= chg;
  }
  let avgGain = gains / length;
  let avgLoss = losses / length;
  rsiArr[length] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
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
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const divState = {
  VIX:  { bear: 0, bull: 0 },
  VVIX: { bear: 0, bull: 0 },
};

function detectVIXDivergence(prices, symKey, rangeLower = 5, rangeUpper = 60) {
  if (prices.length < 30) return null;

  const rsiArr = calcRSI(prices, 14);
  const LEFT = 5, RIGHT = 5;
  const pricePivots = findPivots(prices, LEFT, RIGHT);
  const rsiPivots   = findPivots(rsiArr,  LEFT, RIGHT);

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

  if (lastPH && prevPH && lastRH && prevRH && inRange(lastPH, prevPH)) {
    bearCond = lastPH.val > prevPH.val && lastRH.val < prevRH.val;
  }
  if (lastPL && prevPL && lastRL && prevRL && inRange(lastPL, prevPL)) {
    bullCond = lastPL.val < prevPL.val && lastRL.val > prevRL.val;
  }

  const state = divState[symKey];
  if (bearCond) { state.bear++; state.bull = 0; return { type: 'bear', count: state.bear }; }
  if (bullCond) { state.bull++; state.bear = 0; return { type: 'bull', count: state.bull }; }
  return null;
}

// VIX 히스토리 (다이버전스용, 최대 120개)
let vixPriceHistory  = [];
let vvixPriceHistory = [];

// 다이버전스 이벤트 → 실시간 판단 패널에 추가
function pushDivergenceEvent(div, symKey) {
  if (!div) return;
  const timeStr = window._kstStr || toKST(new Date().toISOString());
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

  // VOLD 메트릭 카드 업데이트
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
      voldValEl.textContent = '—';
      if (voldSlopeEl) { voldSlopeEl.textContent = ''; }
      if (voldCard) voldCard.className = 'metric';
    }
  }
}