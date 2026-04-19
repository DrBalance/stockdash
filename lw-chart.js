// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// lw-chart.js — Lightweight Charts + 볼린저밴드 + 팔레트 + 자동완성
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ══════════════════════════════════════════════════════════
// § 1. 색상 프리셋
// ══════════════════════════════════════════════════════════
const DEFAULT_PRESETS = {
  'TradingView 다크': {
    upColor:'#26a69a', downColor:'#ef5350',
    bbMid:'#f5a623', bb2:'#2196f3', bb1:'#42a5f5',
  },
  '동양식 (빨/파)': {
    upColor:'#ef5350', downColor:'#2962ff',
    bbMid:'#f5a623', bb2:'#ab47bc', bb1:'#ce93d8',
  },
  '서구식 (초/빨)': {
    upColor:'#26a69a', downColor:'#ef5350',
    bbMid:'#ff9800', bb2:'#7e57c2', bb1:'#b39ddb',
  },
};

function _loadPresets() {
  try { const raw = localStorage.getItem('chart_presets'); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}
function _savePresets(presets) {
  localStorage.setItem('chart_presets', JSON.stringify(presets));
}
function _getActivePresetName() {
  return localStorage.getItem('chart_active_preset') || 'TradingView 다크';
}
function _setActivePresetName(name) {
  localStorage.setItem('chart_active_preset', name);
}
function getAllPresets() {
  return { ...DEFAULT_PRESETS, ..._loadPresets() };
}
function getActiveColors() {
  const name = _getActivePresetName();
  return getAllPresets()[name] || DEFAULT_PRESETS['TradingView 다크'];
}

// ══════════════════════════════════════════════════════════
// § 2. 전역 상태
// ══════════════════════════════════════════════════════════
let lwChart        = null;
let lwCandleSeries = null;
let lwVolChart     = null;   // 거래량 전용 별도 차트 인스턴스
let lwVolSeries    = null;
let lwBB = {
  upper2:null, lower2:null, upper1:null, lower1:null, mid:null,
  fill2:null, fill1:null,   // 단순화된 음영 (upper AreaSeries 1개씩)
};

let chartTabVisible    = false;
let chartPendingUpdate = false;
let chartPollTimer     = null;
window._chartPendingData = null;

// 심볼 자동완성
let chartSymbols        = [];
let chartDropdownIdx    = -1;
let _chartSymFetchedFlag = false;

// 종목 탭 [{sym, res, data}]
let chartTabs      = [];
let chartActiveIdx = 0;

function chartActiveTab() { return chartTabs[chartActiveIdx] || null; }

// ══════════════════════════════════════════════════════════
// § 3. 종목 탭 관리
// ══════════════════════════════════════════════════════════
function chartAddTab(sym) {
  if (chartTabs.length >= 4) { alert('최대 4개 종목까지 추가할 수 있습니다.'); return; }
  const inp = document.getElementById('chart-sym-input');
  const s   = (sym || (inp ? inp.value.trim().toUpperCase() : '')) || '';
  chartTabs.push({ sym: s, res: chartActiveTab()?.res || 'D', data: null });
  chartActiveIdx = chartTabs.length - 1;
  renderTabBar();
  if (s) loadChart();
}

function chartSelectTab(idx) {
  chartActiveIdx = idx;
  renderTabBar();
  const tab = chartActiveTab();
  if (!tab) return;
  const inp = document.getElementById('chart-sym-input');
  if (inp) inp.value = tab.sym;
  document.querySelectorAll('.chart-itv-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.res === tab.res);
  });
  if (tab.data) renderLWChart(tab.data);
  else if (tab.sym) loadChart();
}

function chartCloseTab(idx, e) {
  e.stopPropagation();
  chartTabs.splice(idx, 1);
  if (chartTabs.length === 0) {
    chartActiveIdx = 0;
    renderTabBar();
    _resetChart();
    return;
  }
  chartActiveIdx = Math.min(chartActiveIdx, chartTabs.length - 1);
  renderTabBar();
  chartSelectTab(chartActiveIdx);
}

function renderTabBar() {
  const bar = document.getElementById('ctab-bar');
  if (!bar) return;
  let html = chartTabs.map((t, i) => `
    <div class="ctab ${i === chartActiveIdx ? 'active' : ''}" onclick="chartSelectTab(${i})">
      <span>${t.sym || '—'}</span>
      <span class="ctab-x" onclick="chartCloseTab(${i}, event)">✕</span>
    </div>`).join('');
  html += `<button class="ctab-add" onclick="chartAddTab()">＋ 종목 추가</button>`;
  bar.innerHTML = html;
}

function _resetChart() {
  const empty   = document.getElementById('chart-empty');
  const overlay = document.getElementById('chart-overlay-btns');
  const info    = document.getElementById('chart-info-bar');
  if (empty)   { empty.style.display = 'flex'; empty.innerHTML = '<div style="font-size:32px;opacity:.3">📈</div><div>심볼을 입력하고 조회하세요</div>'; }
  if (overlay) overlay.style.display = 'none';
  if (info)    info.style.display = 'none';
  if (lwChart) {
    lwChart.remove();
    lwChart = null; lwCandleSeries = null;
    lwBB = { upper2:null, lower2:null, upper1:null, lower1:null, mid:null, fill2:null, fill1:null };
  }
  if (lwVolChart) {
    lwVolChart.remove();
    lwVolChart = null; lwVolSeries = null;
  }
}

// ══════════════════════════════════════════════════════════
// § 4. 심볼 자동완성
// ══════════════════════════════════════════════════════════
async function initChartSymbols() {
  if (_chartSymFetchedFlag) return;
  _chartSymFetchedFlag = true;
  try {
    const res  = await fetch(API_BASE + '/api/symbols?q=');
    const data = await res.json();
    chartSymbols = data.symbols || (Array.isArray(data) ? data : []);
  } catch { chartSymbols = []; }
}

function onChartSymInput(val) {
  const q  = val.trim().toUpperCase();
  const dd = document.getElementById('chart-sym-dropdown');
  if (!dd) return;
  chartDropdownIdx = -1;
  if (!q) { dd.style.display = 'none'; return; }
  const matches = chartSymbols.filter(s => s.symbol?.startsWith(q)).slice(0, 8);
  if (chartSymbols.length === 0) {
    _fetchSymbolsRemote(q).then(list => { chartSymbols = list; _renderDropdown(list.slice(0, 8)); });
    return;
  }
  _renderDropdown(matches);
}

async function _fetchSymbolsRemote(q) {
  try {
    const res  = await fetch(API_BASE + '/api/symbols?q=' + encodeURIComponent(q));
    const data = await res.json();
    return data.symbols || (Array.isArray(data) ? data : []);
  } catch { return []; }
}

function _renderDropdown(list) {
  const dd = document.getElementById('chart-sym-dropdown');
  if (!dd) return;
  if (!list.length) { dd.style.display = 'none'; return; }
  dd.innerHTML = list.map(item => {
    const sym  = item.symbol || item;
    const desc = item.name   || item.description || '';
    return `<div class="_chart-dd-item"
      style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border)"
      data-sym="${sym}"
      onmouseenter="this.style.background='var(--bg3)'"
      onmouseleave="this.style.background=''"
      onclick="selectChartSym('${sym}')">
      <div style="font-size:13px;font-weight:700;font-family:var(--mono);color:var(--text)">${sym}</div>
      ${desc ? `<div style="font-size:11px;color:var(--text3)">${desc}</div>` : ''}
    </div>`;
  }).join('');
  dd.style.display = 'block';
}

function highlightDropdown() {
  document.querySelectorAll('._chart-dd-item').forEach((el, i) => {
    el.style.background = i === chartDropdownIdx ? 'var(--bg3)' : '';
  });
}

function onChartSymKeydown(e) {
  const dd    = document.getElementById('chart-sym-dropdown');
  const items = document.querySelectorAll('._chart-dd-item');
  if      (e.key === 'ArrowDown')  { e.preventDefault(); chartDropdownIdx = Math.min(chartDropdownIdx + 1, items.length - 1); highlightDropdown(); }
  else if (e.key === 'ArrowUp')    { e.preventDefault(); chartDropdownIdx = Math.max(chartDropdownIdx - 1, 0); highlightDropdown(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (chartDropdownIdx >= 0 && items[chartDropdownIdx]) selectChartSym(items[chartDropdownIdx].dataset.sym);
    else { if (dd) dd.style.display = 'none'; loadChart(); }
  }
  else if (e.key === 'Escape') { if (dd) dd.style.display = 'none'; chartDropdownIdx = -1; }
}

function selectChartSym(sym) {
  const inp = document.getElementById('chart-sym-input');
  const dd  = document.getElementById('chart-sym-dropdown');
  if (inp) inp.value = sym;
  if (dd)  dd.style.display = 'none';
  chartDropdownIdx = -1;
  loadChart();
}

// ══════════════════════════════════════════════════════════
// § 5. 시간단위 버튼
// ══════════════════════════════════════════════════════════
function setChartInterval(btn) {
  document.querySelectorAll('.chart-itv-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const res = btn.dataset.res || '5';
  const tab = chartActiveTab();
  if (tab) tab.res = res;
  if (tab?.sym) loadChart();
}

// ══════════════════════════════════════════════════════════
// § 6. 메인 로드
// ══════════════════════════════════════════════════════════
function _stopChartPoll() {
  if (chartPollTimer) { clearInterval(chartPollTimer); chartPollTimer = null; }
}

async function loadChart() {
  const inp = document.getElementById('chart-sym-input');
  const sym = (inp ? inp.value.trim().toUpperCase() : '') || chartActiveTab()?.sym || '';
  if (!sym) return;

  const res = chartActiveTab()?.res
    || document.querySelector('.chart-itv-btn.active')?.dataset.res
    || '5';

  if (chartTabs.length === 0) {
    chartTabs.push({ sym, res, data: null });
    chartActiveIdx = 0;
    renderTabBar();
  } else {
    chartTabs[chartActiveIdx].sym = sym;
    chartTabs[chartActiveIdx].res = res;
    renderTabBar();
  }

  _stopChartPoll();
  await fetchAndRenderChart(false);

  const ms = window._marketState || getMarketStateClient();
  if (ms !== 'CLOSED') {
    chartPollTimer = setInterval(() => fetchAndRenderChart(true), 30000);
  }
}

// ══════════════════════════════════════════════════════════
// § 7. Fetch + 렌더 조율
// ══════════════════════════════════════════════════════════
async function fetchAndRenderChart(silent) {
  const tab = chartActiveTab();
  if (!tab?.sym) return;

  if (!silent) {
    const empty = document.getElementById('chart-empty');
    if (empty) {
      empty.style.display = 'flex';
      empty.innerHTML = `<div class="spinner"></div><div style="font-size:13px;color:var(--text3)">${tab.sym} 데이터 로딩 중...</div>`;
    }
  }

  try {
    const url  = `${API_BASE}/api/chart?symbol=${encodeURIComponent(tab.sym)}&resolution=${tab.res}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!data.candles?.length) throw new Error('데이터 없음');

    tab.data = data;

    if (!chartTabVisible) {
      window._chartPendingData = data;
      chartPendingUpdate = true;
      return;
    }
    renderLWChart(data);

  } catch (e) {
    if (!silent) {
      const empty = document.getElementById('chart-empty');
      if (empty) {
        empty.style.display = 'flex';
        empty.innerHTML = `<div style="font-size:28px;opacity:.4">⚠️</div><div style="font-size:13px;color:var(--red)">로드 실패: ${e.message}</div>`;
      }
    }
  }
}

// ══════════════════════════════════════════════════════════
// § 8. LW Chart 렌더링 (핵심)
// ══════════════════════════════════════════════════════════
function renderLWChart(data) {
  if (!data) { data = window._chartPendingData; window._chartPendingData = null; }
  if (!data?.candles?.length) return;

  const wrap      = document.getElementById('chart-lw-wrap');
  const empty     = document.getElementById('chart-empty');
  const overlayBtns = document.getElementById('chart-overlay-btns');
  if (!wrap) return;

  if (empty)      empty.style.display = 'none';
  if (overlayBtns) overlayBtns.style.display = 'flex';

  const colors = getActiveColors();

  // ── 차트 초기화 (최초 1회) ──
  if (!lwChart) {
    // ── 메인 차트 (캔들 + 볼린저밴드) ──
    lwChart = LightweightCharts.createChart(wrap, {
      width:  wrap.clientWidth,
      height: 480,
      layout:   { background:{ color:'#131722' }, textColor:'#b2b5be' },
      grid:     { vertLines:{ color:'#1e222d' }, horzLines:{ color:'#1e222d' } },
      crosshair:{ mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor:'#2a2e39', autoScale: true },
      timeScale:        { borderColor:'#2a2e39', timeVisible:true, secondsVisible:false, borderVisible: true },
    });

    // 캔들
    lwCandleSeries = lwChart.addCandlestickSeries({
      upColor:colors.upColor, downColor:colors.downColor,
      borderUpColor:colors.upColor, borderDownColor:colors.downColor,
      wickUpColor:colors.upColor, wickDownColor:colors.downColor,
    });

    // 볼린저밴드 라인 옵션 헬퍼
    const bbLineOpts = (color, lw=1) => ({
      color, lineWidth:lw,
      priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false,
    });

    // ±2σ 음영 (upper에서 아래로 채움, lower가 경계) — 배경 덮기 트릭 없이 단순 Area
    // upper2 AreaSeries: upper2 값에서 시작해 lower2 값까지 채움
    // LW Charts AreaSeries는 "value → 0" 방향으로만 채우므로
    // upper2를 topLine, lower2를 baseLine 역할로 쓰려면 두 시리즈를 겹침
    // 실제로는 upper2 AreaSeries(연파랑) 위에 lower2 AreaSeries(배경색 아님, 투명)를 쌓는 대신
    // upper2 Area를 낮은 opacity, lower2 Area를 배경색과 동일하게 — 이 방식은 pane 분리 후에도
    // 캔들 pane 안에서만 동작하므로 거래량 pane을 침범하지 않음
    lwBB.fill2 = lwChart.addAreaSeries({
      topColor:    _hex2rgba(colors.bb2, 0.12),
      bottomColor: _hex2rgba(colors.bb2, 0.12),
      lineColor: 'transparent', lineWidth: 0,
      priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false,
    });
    // lower2 덮개: 캔들 pane 내부에서만 lower2 이하를 배경색으로 채움
    lwBB.fill2mask = lwChart.addAreaSeries({
      topColor:    '#131722',
      bottomColor: '#131722',
      lineColor: 'transparent', lineWidth: 0,
      priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false,
    });
    // ±1σ 음영
    lwBB.fill1 = lwChart.addAreaSeries({
      topColor:    _hex2rgba(colors.bb1, 0.20),
      bottomColor: _hex2rgba(colors.bb1, 0.20),
      lineColor: 'transparent', lineWidth: 0,
      priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false,
    });
    lwBB.fill1mask = lwChart.addAreaSeries({
      topColor:    '#131722',
      bottomColor: '#131722',
      lineColor: 'transparent', lineWidth: 0,
      priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false,
    });

    // 2σ 외곽선
    lwBB.upper2 = lwChart.addLineSeries({ ...bbLineOpts(colors.bb2), title:'' });
    lwBB.lower2 = lwChart.addLineSeries({ ...bbLineOpts(colors.bb2), title:'' });
    // 1σ 보조선 (반투명)
    lwBB.upper1 = lwChart.addLineSeries({ ...bbLineOpts(_hex2rgba(colors.bb1, 0.6)), title:'' });
    lwBB.lower1 = lwChart.addLineSeries({ ...bbLineOpts(_hex2rgba(colors.bb1, 0.6)), title:'' });
    // 중간선 (SMA20)
    lwBB.mid    = lwChart.addLineSeries({ ...bbLineOpts(colors.bbMid, 1.5), title:'' });

    // ── 거래량 차트 (완전 별도 DOM 요소) ──
    // wrap 아래에 vol-wrap이 없으면 동적으로 생성
    let volWrap = document.getElementById('chart-vol-wrap');
    if (!volWrap) {
      volWrap = document.createElement('div');
      volWrap.id = 'chart-vol-wrap';
      volWrap.style.cssText = 'width:100%;height:110px;background:#131722;border-top:1px solid #1e222d;';
      wrap.parentNode.insertBefore(volWrap, wrap.nextSibling);
    }

    lwVolChart = LightweightCharts.createChart(volWrap, {
      width:  volWrap.clientWidth,
      height: 110,
      layout:   { background:{ color:'#131722' }, textColor:'#b2b5be' },
      grid:     { vertLines:{ color:'#1e222d' }, horzLines:{ color:'#1e222d' } },
      crosshair:{ mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor:'#2a2e39', scaleMargins:{ top:0.1, bottom:0 } },
      timeScale:        { borderColor:'#2a2e39', timeVisible:true, secondsVisible:false, visible:false },
      handleScroll: false,
      handleScale:  false,
    });

    lwVolSeries = lwVolChart.addHistogramSeries({
      priceFormat: { type:'volume' },
      priceScaleId: 'right',
    });

    // 두 차트 timeScale 동기화
    lwChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (range && lwVolChart) lwVolChart.timeScale().setVisibleLogicalRange(range);
    });
    lwVolChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (range && lwChart) lwChart.timeScale().setVisibleLogicalRange(range);
    });

    // ResizeObserver — 두 차트 동시 리사이즈
    new ResizeObserver(() => {
      if (lwChart   && wrap.clientWidth    > 0) lwChart.applyOptions({ width: wrap.clientWidth });
      const vw = document.getElementById('chart-vol-wrap');
      if (lwVolChart && vw && vw.clientWidth > 0) lwVolChart.applyOptions({ width: vw.clientWidth });
    }).observe(wrap);

  } else {
    // 색상만 갱신 (차트 재사용)
    lwCandleSeries.applyOptions({
      upColor:colors.upColor, downColor:colors.downColor,
      borderUpColor:colors.upColor, borderDownColor:colors.downColor,
      wickUpColor:colors.upColor, wickDownColor:colors.downColor,
    });
    lwBB.upper2?.applyOptions({ color: colors.bb2 });
    lwBB.lower2?.applyOptions({ color: colors.bb2 });
    lwBB.upper1?.applyOptions({ color: _hex2rgba(colors.bb1, 0.6) });
    lwBB.lower1?.applyOptions({ color: _hex2rgba(colors.bb1, 0.6) });
    lwBB.mid?.applyOptions({ color: colors.bbMid });
    lwBB.fill2?.applyOptions({ topColor:_hex2rgba(colors.bb2,0.12), bottomColor:_hex2rgba(colors.bb2,0.12) });
    lwBB.fill1?.applyOptions({ topColor:_hex2rgba(colors.bb1,0.20), bottomColor:_hex2rgba(colors.bb1,0.20) });
    // mask는 항상 배경색 고정이므로 색상 갱신 불필요
    lwChart.applyOptions({ width: wrap.clientWidth });
  }

  // ── 데이터 세팅 ──
  const candles = data.candles;
  lwCandleSeries.setData(candles.map(c => ({ time:c.time, open:c.open, high:c.high, low:c.low, close:c.close })));

  // 거래량 — 별도 차트에 세팅
  lwVolSeries.setData(candles.map(c => ({
    time:c.time, value:c.volume||0,
    color: c.close >= c.open ? _hex2rgba(colors.upColor,0.40) : _hex2rgba(colors.downColor,0.40),
  })));

  // 볼린저밴드 (null 필터링)
  const bbFilter = (key) => candles.filter(c => c[key] != null).map(c => ({ time:c.time, value:c[key] }));
  lwBB.upper2.setData(bbFilter('bbUpper2'));
  lwBB.lower2.setData(bbFilter('bbLower2'));
  lwBB.upper1.setData(bbFilter('bbUpper1'));
  lwBB.lower1.setData(bbFilter('bbLower1'));
  lwBB.mid.setData(bbFilter('bbMid'));

  // 음영: fill2(upper2 → 아래), fill2mask(lower2 → 아래, 배경색으로 덮기)
  // — 이제 캔들 pane에만 존재하므로 거래량 pane 침범 없음
  lwBB.fill2?.setData(bbFilter('bbUpper2'));
  lwBB.fill2mask?.setData(bbFilter('bbLower2'));
  lwBB.fill1?.setData(bbFilter('bbUpper1'));
  lwBB.fill1mask?.setData(bbFilter('bbLower1'));

  // 두 차트 타임스케일 동기화 후 맞춤
  lwChart.timeScale().fitContent();
  setTimeout(() => {
    if (lwVolChart) lwVolChart.timeScale().setVisibleLogicalRange(
      lwChart.timeScale().getVisibleLogicalRange()
    );
    lwCandleSeries?.priceScale()?.applyOptions({ autoScale: true });
  }, 50);

  // ── 가격 표시 ──
  const last      = candles[candles.length - 1];
  const refClose  = data.previousClose || candles[0].open;
  const change    = last.close - refClose;
  const changePct = (change / refClose) * 100;

  const priceEl  = document.getElementById('chart-price-display');
  const changeEl = document.getElementById('chart-change-display');
  const badgeEl  = document.getElementById('chart-status-badge');
  if (priceEl) priceEl.textContent = '$' + last.close.toFixed(2);
  if (changeEl) {
    const sign = change >= 0 ? '+' : '';
    changeEl.textContent = `${sign}${change.toFixed(2)} (${sign}${changePct.toFixed(2)}%)`;
    changeEl.style.color = change >= 0 ? 'var(--green)' : 'var(--red)';
  }
  if (badgeEl) {
    const ms    = window._marketState || getMarketStateClient();
    const msMap = { REGULAR:'정규장', PRE:'프리마켓', AFTER:'애프터', CLOSED:'장마감' };
    const tab   = chartActiveTab();
    badgeEl.textContent = `${tab?.sym || ''} · ${msMap[ms] || ms}`;
    badgeEl.style.color = ms === 'REGULAR' ? 'var(--green)' : 'var(--text3)';
  }

  // ── 정보 바 ──
  const bar = document.getElementById('chart-info-bar');
  if (bar) {
    bar.style.display = 'flex';
    const fmtVol  = v => v >= 1e6 ? (v/1e6).toFixed(2)+'M' : v >= 1e3 ? (v/1e3).toFixed(1)+'K' : String(v);
    const resLabel = { '5':'5분','30':'30분','120':'2시간','240':'4시간','D':'일봉','W':'주봉' };
    bar.innerHTML = [
      `<span>단위: <b style="color:var(--text)">${resLabel[data.resolution] || data.resolution}</b></span>`,
      `<span>캔들: <b style="color:var(--text)">${candles.length}개</b></span>`,
      `<span>고가: <b style="color:var(--green)">$${Math.max(...candles.map(c=>c.high)).toFixed(2)}</b></span>`,
      `<span>저가: <b style="color:var(--red)">$${Math.min(...candles.map(c=>c.low)).toFixed(2)}</b></span>`,
      `<span>거래량(최종): <b style="color:var(--text)">${fmtVol(last.volume||0)}</b></span>`,
      data.updatedAt ? `<span>업데이트: <b style="color:var(--text3)">${new Date(data.updatedAt).toLocaleTimeString('ko-KR',{timeZone:'America/New_York'})} ET</b></span>` : '',
    ].filter(Boolean).join('');
  }
}

// ══════════════════════════════════════════════════════════
// § 9. 공통 헬퍼
// ══════════════════════════════════════════════════════════
function _hex2rgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ══════════════════════════════════════════════════════════
// § 10. 확대/축소 버튼
// ══════════════════════════════════════════════════════════
function chartZoom(dir) {
  if (!lwChart) return;
  const ts    = lwChart.timeScale();
  const range = ts.getVisibleLogicalRange();
  if (!range) return;
  const len  = range.to - range.from;
  const step = len * 0.2 * (-dir);
  const newRange = { from: range.from + step, to: range.to - step };
  ts.setVisibleLogicalRange(newRange);
  if (lwVolChart) lwVolChart.timeScale().setVisibleLogicalRange(newRange);
}

function chartFit() {
  if (!lwChart) return;
  lwChart.timeScale().fitContent();
  setTimeout(() => {
    lwCandleSeries?.priceScale()?.applyOptions({ autoScale: true });
    if (lwVolChart) lwVolChart.timeScale().setVisibleLogicalRange(
      lwChart.timeScale().getVisibleLogicalRange()
    );
  }, 50);
}

function chartFitPrice() {
  if (!lwChart) return;
  lwCandleSeries?.priceScale()?.applyOptions({ autoScale: true });
}

// ══════════════════════════════════════════════════════════
// § 11. 색상 팔레트 패널
// ══════════════════════════════════════════════════════════
function togglePalette(e) {
  e.stopPropagation();
  const panel = document.getElementById('palette-panel');
  if (!panel) return;
  const isOpen = panel.classList.contains('open');
  panel.classList.toggle('open', !isOpen);
  if (!isOpen) renderPalettePanel();
}

document.addEventListener('click', () => {
  document.getElementById('palette-panel')?.classList.remove('open');
});

function renderPalettePanel() {
  const list   = document.getElementById('pp-preset-list');
  const active = _getActivePresetName();
  const all    = getAllPresets();

  list.innerHTML = Object.entries(all).map(([name, c]) => {
    const isDefault = DEFAULT_PRESETS[name];
    const isActive  = name === active;
    return `<div class="pp-preset ${isActive ? 'active' : ''}" onclick="applyPreset('${name}')">
      <div class="pp-swatch">
        <span style="background:${c.upColor}"></span>
        <span style="background:${c.downColor}"></span>
        <span style="background:${c.bbMid}"></span>
      </div>
      <span class="pp-name">${name}</span>
      ${!isDefault ? `<span class="pp-del" onclick="deletePreset(event,'${name}')">삭제</span>` : ''}
    </div>`;
  }).join('');

  const c = getActiveColors();
  document.getElementById('pp-up').value    = c.upColor;
  document.getElementById('pp-down').value  = c.downColor;
  document.getElementById('pp-bbmid').value = c.bbMid;
  document.getElementById('pp-bb2').value   = c.bb2;
  document.getElementById('pp-bb1').value   = c.bb1;
  document.getElementById('pp-save-name').value = active;
}

function applyPreset(name) {
  _setActivePresetName(name);
  renderPalettePanel();
  if (lwChart) {
    const tab = chartActiveTab();
    if (tab?.data) renderLWChart(tab.data);
  }
}

function previewColors() {
  const c = _readPickerColors();
  if (!lwChart) return;
  lwCandleSeries?.applyOptions({
    upColor:c.upColor, downColor:c.downColor,
    borderUpColor:c.upColor, borderDownColor:c.downColor,
    wickUpColor:c.upColor, wickDownColor:c.downColor,
  });
  lwBB.upper2?.applyOptions({ color: c.bb2 });
  lwBB.lower2?.applyOptions({ color: c.bb2 });
  lwBB.upper1?.applyOptions({ color: _hex2rgba(c.bb1, 0.6) });
  lwBB.lower1?.applyOptions({ color: _hex2rgba(c.bb1, 0.6) });
  lwBB.mid?.applyOptions({ color: c.bbMid });
  lwBB.fill2?.applyOptions({ topColor:_hex2rgba(c.bb2,0.12), bottomColor:_hex2rgba(c.bb2,0.12) });
  lwBB.fill1?.applyOptions({ topColor:_hex2rgba(c.bb1,0.20), bottomColor:_hex2rgba(c.bb1,0.20) });
}

function _readPickerColors() {
  return {
    upColor:  document.getElementById('pp-up')?.value    || '#26a69a',
    downColor:document.getElementById('pp-down')?.value  || '#ef5350',
    bbMid:    document.getElementById('pp-bbmid')?.value || '#f5a623',
    bb2:      document.getElementById('pp-bb2')?.value   || '#2196f3',
    bb1:      document.getElementById('pp-bb1')?.value   || '#42a5f5',
  };
}

function savePreset() {
  const name = document.getElementById('pp-save-name')?.value.trim();
  if (!name) { alert('프리셋 이름을 입력하세요'); return; }
  const user = _loadPresets();
  user[name] = _readPickerColors();
  _savePresets(user);
  _setActivePresetName(name);
  renderPalettePanel();
}

function deletePreset(e, name) {
  e.stopPropagation();
  if (!confirm(`"${name}" 프리셋을 삭제할까요?`)) return;
  const user = _loadPresets();
  delete user[name];
  _savePresets(user);
  if (_getActivePresetName() === name) _setActivePresetName('TradingView 다크');
  renderPalettePanel();
}
