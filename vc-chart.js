// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// vc-chart.js — Vanna/Charm 계산 및 Greek 차트 렌더
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Vanna / Charm 계산 (safeT 클램핑으로 수치 안정화)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function calculateVannaCharm(strikes, spotPrice, expDate) {
  const [y, m, d] = expDate.split('-').map(Number);
  const utcHour = (m >= 4 && m <= 10) ? 20 : 21;
  const expiryClose = new Date(Date.UTC(y, m - 1, d, utcHour, 0, 0));
  const msToExp = expiryClose - new Date();
  const T = msToExp > 0 ? msToExp / (1000*60*60*24*365) : 1/8760;
  const sqrtT = Math.sqrt(T);
  const r = 0.045;
  let totalVanna = 0, totalCharm = 0;
  strikes.forEach(s => {
    const K = s.strike;
    const sigma = s.iv > 0 ? s.iv : 0.20;
    const lnSK = Math.log(spotPrice / K);
    const d1 = (lnSK + (r + sigma*sigma/2)*T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    const nd1 = Math.exp(-d1*d1/2) / Math.sqrt(2*Math.PI);
    const netOI = s.callOI - s.putOI;
    const vanna = nd1 * (d2 / sigma) * netOI * 100 * spotPrice;
    totalVanna += isFinite(vanna) ? vanna : 0;
    const charm = -nd1 * (r/(sigma*sqrtT) - d2/(2*T)) * netOI * 100;
    totalCharm += isFinite(charm) ? charm : 0;
  });
  return { totalVanna: totalVanna/1e6, totalCharm: totalCharm/1e6 };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Greek 힘의 균형 계산
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function calcForceBalance(vc, d, vix, vvix) {
  const { totalVanna, totalCharm } = vc;
  const { localGEX, totalGEX, flipZone, spotPrice } = d;

  // Vanna 활성도: VIX 변화율 × Vanna 절대값
  const vixHistory = priceHistory.slice(-5).map(h=>h.vix).filter(Boolean);
  const vixChange = vixHistory.length >= 2
    ? (vixHistory[vixHistory.length-1] - vixHistory[0]) / vixHistory[0] * 100
    : 0;

  // 각 Greek 강도 (0~100%)
  const vannaStrength = Math.min(Math.abs(totalVanna) / 50 * 100, 100);
  const charmStrength = Math.min(Math.abs(totalCharm) / 20 * 100, 100);
  const gexStrength = Math.min(Math.abs(localGEX/1e6) / 50 * 100, 100);

  // Vanna 활성화 여부 (VIX 움직임 필요)
  const vannaActive = Math.abs(vixChange) > 0.5;
  const vannaDir = totalVanna < 0 ? 'sell' : 'buy'; // 음수Vanna = VIX상승시 매도

  // Charm 활성화 여부 (시간 기반)
  const now = new Date();
  const est = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const estHour = est.getHours() + est.getMinutes()/60;
  const isAfternoon = estHour >= 13 && estHour < 16;
  const charmDir = totalCharm < 0 ? 'buy' : 'sell';
  const charmActive = isAfternoon;

  // GEX 방향
  const gexDir = totalGEX >= 0 ? 'pin' : 'trend';

  // Flip Zone 거리
  const flipDist = flipZone ? Math.abs(spotPrice - flipZone) / spotPrice * 100 : 999;
  const flipDanger = flipDist < 1.0;

  return {
    vanna: { strength: vannaStrength, dir: vannaDir, active: vannaActive, value: totalVanna, vixChange },
    charm: { strength: charmStrength, dir: charmDir, active: charmActive, value: totalCharm },
    gex: { strength: gexStrength, dir: gexDir, value: localGEX/1e6 },
    flipDist, flipDanger, flipZone,
    estHour, isAfternoon
  };
}

function getBarColor(pct) {
  if (pct >= 70) return 'var(--red)';
  if (pct >= 40) return 'var(--yellow)';
  return 'var(--green)';
}

function renderGreekMetrics(force) {
  const { vanna, charm, gex, flipDist, flipDanger, flipZone } = force;

  // ── Vanna 신호등 ──
  // 5분 전 대비 절대값 변화로 판단
  const vannaHistory = vcHistory.slice(-5).map(h => Math.abs(h.vanna)).filter(v => v > 0);
  let vannaSignal = '⚪'; // 데이터 부족
  let vannaArrow = '';
  if (vannaHistory.length >= 2) {
    const prev = vannaHistory[0];
    const curr = vannaHistory[vannaHistory.length - 1];
    const chg = (curr - prev) / prev * 100;
    if (chg > 5)       { vannaSignal = '🔴'; vannaArrow = ' ↑'; } // 강해짐 (더 위험)
    else if (chg < -5) { vannaSignal = '🟢'; vannaArrow = ' ↓'; } // 약해짐 (완화)
    else               { vannaSignal = '🟡'; vannaArrow = ' →'; } // 비슷
  }

  // ── Charm 신호등 ──
  // 오후 1시(ET) 이후 활성화, 음수(매수드리프트)면 초록
  const charmSignal = charm.active
    ? (charm.dir === 'buy' ? '🟢' : '🔴')
    : '⚪';
  const charmArrow = charm.active ? ' 활성' : ' 대기';

  // ── GEX 신호등 ──
  const gexSignal = gex.dir === 'pin' ? '🟢' : '🔴';
  const gexArrow = gex.dir === 'pin' ? ' 피닝' : ' 추세증폭';

  // ── Vanna 값 색상 ──
  const vannaColor = vanna.dir === 'sell' ? 'var(--red)' : 'var(--green)';
  const charmColor = charm.dir === 'buy'  ? 'var(--green)' : 'var(--red)';
  const gexColor   = gex.dir === 'pin'   ? 'var(--green)' : 'var(--red)';

  // ── 지배 Greek 판단 ──
  let dominant = '';
  const vannaAbs = Math.abs(vanna.value);
  const charmAbs = Math.abs(charm.value);
  if (gex.dir === 'pin' && Math.abs(gex.value) > 500)
    dominant = 'GEX 피닝 지배 — 큰 방향성 어려움';
  else if (vanna.active && vannaAbs > charmAbs * 5)
    dominant = `Vanna ${vanna.dir === 'sell' ? '매도' : '매수'} 압력 지배`;
  else if (charm.active && charmAbs > 200)
    dominant = `Charm ${charm.dir === 'buy' ? '매수' : '매도'} 드리프트 작동`;
  else
    dominant = '뚜렷한 지배 Greek 없음';

  // ── DOM 업데이트 ──
  const set = (id, val) => { const el=document.getElementById(id); if(el) el.innerHTML=val; };
  const setStyle = (id, prop, val) => { const el=document.getElementById(id); if(el) el.style[prop]=val; };

  // dot 색상: 부호 기준 (양수=초록, 음수=빨강)
  setStyle('gmc-vanna-dot', 'background', vanna.value >= 0 ? 'var(--green)' : 'var(--red)');
  setStyle('gmc-charm-dot', 'background', charm.value >= 0 ? 'var(--green)' : 'var(--red)');
  setStyle('gmc-gex-dot',   'background', gex.value   >= 0 ? 'var(--green)' : 'var(--red)');

  set('gmc-vanna-signal', vannaSignal);
  set('gmc-vanna-val', `<span style="color:${vannaColor}">${vanna.value >= 0 ? '+' : ''}${vanna.value.toFixed(0)}M</span>`);
  set('gmc-vanna-desc', `${vanna.dir === 'sell' ? 'VIX↑ 매도압력' : 'VIX↑ 매수압력'}${vannaArrow}${vanna.vixChange !== 0 ? ` · VIX ${vanna.vixChange>0?'+':''}${vanna.vixChange.toFixed(1)}%` : ''}`);

  set('gmc-charm-signal', charmSignal);
  set('gmc-charm-val', `<span style="color:${charmColor}">${charm.value >= 0 ? '+' : ''}${charm.value.toFixed(0)}M</span>`);
  set('gmc-charm-desc', `${charm.dir === 'buy' ? '매수 드리프트' : '매도 드리프트'}${charmArrow}`);

  set('gmc-gex-signal', gexSignal);
  set('gmc-gex-val', `<span style="color:${gexColor}">${gex.value > 0 ? '+' : ''}${gex.value.toFixed(0)}M</span>`);
  set('gmc-gex-desc', `로컬 GEX${gexArrow}`);

  set('gmc-dominant-val', dominant);
  set('gmc-flip-desc', flipZone
    ? (flipDanger
      ? `<span style="color:var(--red);font-weight:600">⚡ Flip Zone ${flipDist.toFixed(1)}% 극근접</span>`
      : `Flip Zone ${flipDist.toFixed(1)}% 하방`)
    : 'Flip Zone 없음'
  );
}

// 레거시 호환용
function renderForceSidebar(force) {
  renderGreekMetrics(force);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VannaCharm 차트 렌더 (CBOE 기반 누적)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 멀티페인 차트 헬퍼
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let vcPaneVC = null, vcPaneVV = null, vcPaneOBV = null;
let vcZoomLevel = 4; // 기본 2H (16시간 전체 기준 8배)
let vcTotalSlots = 150;  // 144슬롯(04:00~16:00 ET) + 6슬롯(30분) 여유

// 시간범위 → zoom 레벨 변환 (전체 16시간 기준)
const VC_RANGE_ZOOM = { '2h': 8, '4h': 4, '8h': 2, '1d': 1, 'all': 0.5 };
const VC_RANGE_LABEL = { '2h': '2H', '4h': '4H', '8h': '8H', '1d': '1D', 'all': 'ALL' };

function setVCRange(range) {
  vcZoomLevel = VC_RANGE_ZOOM[range] || 4;
  const lbl = document.getElementById('vc-zoom-val');
  if (lbl) lbl.textContent = VC_RANGE_LABEL[range] || range.toUpperCase();
  const sl = document.getElementById('vc-zoom-slider');
  if (sl) sl.value = vcZoomLevel * 2;
  ['2h','4h','8h','1d','all'].forEach(r => {
    const btn = document.getElementById('vcrange-' + r);
    if (btn) btn.className = 'vc-range-btn' + (r === range ? ' active' : '');
  });
  updateVCZoom(); // 너비·스크롤만 조정 (차트 재생성 불필요)
}

function onVCSlider(val) {
  vcZoomLevel = parseFloat(val) / 2;
  const lbl = document.getElementById('vc-zoom-val');
  if (lbl) lbl.textContent = vcZoomLevel.toFixed(1) + '×';
  ['2h','4h','8h','1d','all'].forEach(r => {
    const btn = document.getElementById('vcrange-' + r);
    if (btn) btn.className = 'vc-range-btn';
  });
  updateVCZoom(); // 너비·스크롤만 조정 (차트 재생성 불필요)
}

// ── 확대/스크롤만 조정 (차트 재렌더 없음) ──
function updateVCZoom() {
  const wrap = document.getElementById('vc-multipane-wrap');
  const inner = document.getElementById('vc-multipane-inner');
  if (!wrap || !inner) return;

  const baseW = wrap.clientWidth || window.innerWidth - 56;
  const newW = Math.round(baseW * vcZoomLevel);

  // inner + 각 pane-wrap 너비 동시 설정
  inner.style.width = newW + 'px';
  ['vc-pane-vc-wrap', 'vc-pane-vv-wrap', 'vc-pane-obv-wrap'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.width = newW + 'px';
  });

  // Chart.js 인스턴스에 크기 변경 알림 (재렌더 없이 resize만)
  if (vcPaneVC)  vcPaneVC.resize();
  if (vcPaneVV)  vcPaneVV.resize();
  if (vcPaneOBV) vcPaneOBV.resize();

  // 현재 시간 위치 계산 → 화면 중앙에 오도록 스크롤
  // PRE_START_EST=4(ET 04:00), vcTotalSlots 사용 (renderVCChart 지역변수 참조 제거)
  const nowMs = Date.now();
  const etOff = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).includes('EDT') ? 4 : 5;
  const todayEstStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const preMs = new Date(`${todayEstStr}T${String(4 + etOff).padStart(2, '0')}:00:00Z`).getTime();
  const totalMs = vcTotalSlots * 5 * 60000;  // 전역 vcTotalSlots 사용
  const nowRatio = Math.max(0, Math.min(1, (nowMs - preMs) / totalMs));

  // 현재 시간이 화면 중앙에 오도록
  const nowPx = newW * nowRatio;
  const scrollTarget = Math.max(0, nowPx - baseW / 2);

  requestAnimationFrame(() => {
    wrap.scrollLeft = scrollTarget;
  });
}

function syncVCPanes(scrollLeft) {
  // 멀티페인 wrap이 하나이므로 별도 동기화 불필요
}

function destroyVCPanes() {
  if (vcPaneVC)  { try { vcPaneVC.destroy(); }  catch(_){} vcPaneVC  = null; }
  if (vcPaneVV)  { try { vcPaneVV.destroy(); }  catch(_){} vcPaneVV  = null; }
  if (vcPaneOBV) { try { vcPaneOBV.destroy(); } catch(_){} vcPaneOBV = null; }
  [['vc-pane-vc','vc-pane-vc-wrap'],['vc-pane-vv','vc-pane-vv-wrap'],['vc-pane-obv','vc-pane-obv-wrap']].forEach(([canvasId, wrapId]) => {
    const wrapEl = document.getElementById(wrapId);
    if (wrapEl) wrapEl.innerHTML = `<canvas id="${canvasId}"></canvas>`;
  });
}

function renderVCChart() {
  // DOM이 아직 준비 안 됐으면 재시도
  if (!document.getElementById('vc-pane-vc')) {
    setTimeout(renderVCChart, 50);
    return;
  }

  if (vcHistory.length === 0) {
    const bar   = document.getElementById('vc-signal-bar');
    const icon  = document.getElementById('vc-signal-icon');
    const txtEl = document.getElementById('vc-signal-text');
    if (bar && icon && txtEl) {
      icon.textContent  = '—';
      txtEl.textContent = '데이터 누적 중... (KST 17:00(EDT)/18:00(EST) 프리마켓부터 5분 Cron 자동 적재)';
      txtEl.style.color = 'var(--text3)';
    }
    return;
  }

  // ── 전체 고정 시간축 (UTC ISO 기준으로 생성, 표시는 toKST 변환) ──
  // 프리마켓 시작: EST 04:00 = UTC 09:00 (EDT) 또는 UTC 08:00 (EST)
  // 브라우저 toKST()가 자동 변환하므로 UTC 기준으로 슬롯만 생성
  const PRE_START_EST = 4; // 04:00 EST
  const TOTAL_SLOTS = 192;
  vcTotalSlots = TOTAL_SLOTS;

  // 오늘 날짜(EST 기준) + 04:00 EST의 UTC 시각 계산
  // ※ new Date(toLocaleString(...)) 방식은 브라우저마다 날짜 파싱이 달라 하루 오차 발생
  //   → toLocaleDateString('en-CA')를 직접 사용해 YYYY-MM-DD 추출
  const todayStrEST = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  // "2026-04-17T04:00:00" + America/New_York → UTC ISO 배열 생성
  const preStartUTC = new Date(`${todayStrEST}T${String(PRE_START_EST).padStart(2,'0')}:00:00`);
  // EST offset: EDT=-4, EST=-5 → UTC = localTime + offset
  // 브라우저 독립적으로: America/New_York 04:00를 UTC로 변환
  const preStartUtcMs = (() => {
    // 더미 날짜 string을 뉴욕 시각으로 파싱
    const s = `${todayStrEST}T04:00:00`;
    // toLocaleString 역산 (브라우저 타임존 무관)
    const d = new Date(s + ' EST'); // 대략적 파싱
    // 정확한 방법: Intl.DateTimeFormat 활용
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    // 오늘 00:00 UTC 기준으로 찾기
    let probe = new Date(`${todayStrEST}T00:00:00Z`);
    // 뉴욕 04:00에 해당하는 UTC 찾기 (브루트포스: ±1분 이내)
    // 실제 오프셋: EDT=UTC-4, EST=UTC-5
    const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' });
    const offsetH = etStr.includes('EDT') ? 4 : 5;
    return new Date(`${todayStrEST}T${String(PRE_START_EST + offsetH).padStart(2,'0')}:00:00Z`).getTime();
  })();

  // 5분 간격 UTC ISO 배열 (TOTAL_SLOTS개)
  const fullAxisISO = [];
  for (let i = 0; i < TOTAL_SLOTS; i++) {
    fullAxisISO.push(new Date(preStartUtcMs + i * 5 * 60000).toISOString());
  }

  // 표시용 KST 레이블 (toKST 사용)
  const labels = fullAxisISO.map(iso => toKST(iso));

  // 데이터 매핑: KV의 iso 키(정확히 5분 간격이 아닐 수 있음) → 가장 가까운 슬롯에 매핑
  const dataMap = {};
  vcHistory.forEach(h => {
    if (!h.iso) {
      // 구버전 데이터 (time 키): 스킵하거나 추정
      return;
    }
    const hMs = new Date(h.iso).getTime();
    // 가장 가까운 슬롯 인덱스
    const idx = Math.round((hMs - preStartUtcMs) / (5 * 60000));
    if (idx >= 0 && idx < TOTAL_SLOTS) {
      dataMap[fullAxisISO[idx]] = h;
    }
  });

  const vannaD = fullAxisISO.map(iso => dataMap[iso]?.vanna ?? null);
  const charmD = fullAxisISO.map(iso => dataMap[iso]?.charm ?? null);
  // VOLD: vcHistory에 vold 필드 없으면 window._lastVold 최신값 사용
  const voldD  = fullAxisISO.map(iso => dataMap[iso]?.vold != null ? dataMap[iso].vold / 1e6 : null);

  // VV 누적 (개장 시 리셋 — EST 09:30 = UTC+4 또는 UTC+5)
  const etOffset = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).includes('EDT') ? 4 : 5;
  const openUTC = new Date(`${todayStrEST}T${String(9 + etOffset).padStart(2,'0')}:30:00Z`).toISOString();
  let vvCum = 0;
  const vvD = fullAxisISO.map(iso => {
    if (iso >= openUTC && fullAxisISO[fullAxisISO.indexOf(iso) - 1] < openUTC) vvCum = 0;
    const v = dataMap[iso]?.vv;
    if (v != null) vvCum += v;
    return dataMap[iso] != null ? vvCum : null;
  });

  // ── inner/wrap 너비 설정 (OI 차트 동일 방식) ──
  const wrap = document.getElementById('vc-multipane-wrap');
  const inner = document.getElementById('vc-multipane-inner');
  const baseW = wrap ? (wrap.clientWidth || window.innerWidth - 56) : 800;
  const chartW = Math.round(baseW * vcZoomLevel);
  if (inner) inner.style.width = chartW + 'px';
  ['vc-pane-vc-wrap','vc-pane-vv-wrap','vc-pane-obv-wrap'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.width = chartW + 'px';
  });

  const mFmt = v => {
    if (v == null) return '';
    const abs = Math.abs(v), sign = v < 0 ? '-' : '';
    if (abs >= 1000) return sign + (abs/1000).toFixed(1) + 'B';
    return sign + abs.toFixed(1) + 'M';
  };

  // ── 끝점 레이블 플러그인 (offsetY: 양수=아래, 음수=위) ──
  const endLabelPlugin = (datasetIdx, labelFn, color, offsetY = -12) => ({
    id: `endLabel_${datasetIdx}`,
    afterDraw(chart) {
      const ds = chart.data.datasets[datasetIdx];
      if (!ds) return;
      const data = ds.data;
      let lastIdx = -1;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] != null) { lastIdx = i; break; }
      }
      if (lastIdx < 0) return;
      const meta = chart.getDatasetMeta(datasetIdx);
      const pt = meta.data[lastIdx];
      if (!pt) return;
      const { ctx, chartArea } = chart;
      const label = labelFn(data[lastIdx]);
      ctx.save();
      ctx.font = 'bold 11px Arial';
      const tw = ctx.measureText(label).width;
      const x = Math.min(pt.x + 4, chartArea.right - tw - 4);
      const y = pt.y + offsetY; // 위 또는 아래
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x - 2, y - 9, tw + 6, 18);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0d1117';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x, y);
      ctx.restore();
    }
  });

  // ── sticky y축 플러그인 (OI 차트와 동일 방식) ──
  const stickyYPlugin = (wrapId, yColor, fmtFn) => ({
    id: `stickyY_${wrapId}`,
    afterDraw(chart) {
      const w = document.getElementById(wrapId);
      if (!w) return;
      const yScale = chart.scales['y'];
      if (!yScale) return;
      const scrollX = w.scrollLeft;
      if (scrollX <= 0) return;
      const { ctx, chartArea, height } = chart;
      ctx.save();
      const axisW = yScale.right;
      ctx.fillStyle = '#161b22';
      ctx.fillRect(scrollX, 0, axisW, height);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = yColor;
      ctx.font = '10px monospace';
      yScale.ticks.forEach((tick, i) => {
        const y = yScale.getPixelForTick(i);
        ctx.fillText(fmtFn(tick.value), scrollX + axisW - 4, y);
      });
      ctx.strokeStyle = '#30363d';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(scrollX + axisW, chartArea.top);
      ctx.lineTo(scrollX + axisW, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    }
  });

  // ── 세션 수직선 플러그인 ──
  const sessionPlugin = (labels) => ({
    id: 'sessionLine',
    afterDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x) return;
      // 개장 시각 KST (EST 09:30 → KST 변환)
      const openKST = window._openKST;
      const openIdx = labels.findIndex(t => t >= openKST);
      if (openIdx < 0) return;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4,4]);
      const x = scales.x.getPixelForValue(openIdx);
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '9px monospace';
      ctx.fillText('개장', x + 3, chartArea.top + 10);
      ctx.restore();
    }
  });

  const commonOpts = (color, fmtCb) => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1,
        titleColor: '#e6edf3', bodyColor: '#8b949e', padding: 8,
        filter: item => item.parsed.y !== null,
        callbacks: { label: item => fmtCb(item) }
      }
    },
    scales: {
      x: {
        ticks: { color: '#6e7681', font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
        grid: { color: 'rgba(48,54,61,.4)' }
      },
      y: {
        position: 'left',
        ticks: { color, font: { size: 10 } },
        grid: { color: 'rgba(48,54,61,.4)' },
        afterDataLimits(s) {
          const r = s.max - s.min;
          const pad = r === 0 ? (Math.abs(s.max) * 0.3 || 0.01) : r * 0.2;
          s.min -= pad; s.max += pad;
        }
      }
    }
  });

  destroyVCPanes();

  // ── 페인1: Vanna + Charm ──
  const cvEl = document.getElementById('vc-pane-vc');
  if (cvEl) {
    const opts = commonOpts('#8b949e', item => `${item.dataset.label}: ${mFmt(item.parsed.y)}`);
    opts.scales.y.ticks.callback = mFmt;
    const lastVanna = vannaD.filter(v=>v!=null).slice(-1)[0];
    const lastCharm = charmD.filter(v=>v!=null).slice(-1)[0];
    vcPaneVC = new Chart(cvEl, {
      type: 'line', data: {
        labels,
        datasets: [
          { label:'Vanna', data: vannaD, borderColor:'#bc8cff', backgroundColor:'rgba(188,140,255,.08)', fill:true, borderWidth:2, pointRadius:0, pointHoverRadius:3, tension:0.3, spanGaps:true },
          { label:'Charm', data: charmD, borderColor:'#58a6ff', backgroundColor:'transparent', fill:false, borderWidth:2, pointRadius:0, pointHoverRadius:3, tension:0.3, spanGaps:true },
        ]
      },
      options: opts,
      plugins: [
        sessionPlugin(labels),
        endLabelPlugin(0, v => `Vanna: ${mFmt(v)}`, '#bc8cff', -14), // Vanna 위쪽
        endLabelPlugin(1, v => `Charm: ${mFmt(v)}`, '#58a6ff', +14), // Charm 아래쪽
        stickyYPlugin('vc-pane-vc-wrap', '#8b949e', mFmt),
      ]
    });
  }

  // ── 페인2: VV ──
  const vvEl = document.getElementById('vc-pane-vv');
  const hasVV = vvD.some(v => v != null);
  if (vvEl) {
    if (!hasVV) {
      vvEl.parentElement.innerHTML = '<div style="height:220px;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:12px">VV — Cron 적재 대기</div>';
    } else {
      const opts = commonOpts('#d29922', item => `VV 누적: ${item.parsed.y?.toFixed(4) ?? '—'} pt`);
      opts.scales.y.ticks.callback = v => v?.toFixed(3);
      opts.scales.y.grid = { color: ctx => ctx.tick.value === 0 ? 'rgba(255,255,255,0.25)' : 'rgba(48,54,61,.4)' };
      const lastVV = vvD.filter(v=>v!=null).slice(-1)[0] ?? 0;
      vcPaneVV = new Chart(vvEl, {
        type: 'line', data: {
          labels,
          datasets: [{
            label: 'VV 누적',
            data: vvD,
            segment: {
              borderColor: ctx => (ctx.p1?.parsed?.y ?? 0) >= 0 ? '#d29922' : '#6b4c0a',
              backgroundColor: ctx => (ctx.p1?.parsed?.y ?? 0) >= 0 ? 'rgba(210,153,34,0.15)' : 'rgba(107,76,10,0.20)',
            },
            fill: 'origin',
            borderWidth: 2, pointRadius: 0, pointHoverRadius: 3, tension: 0, spanGaps: true,
          }]
        },
        options: opts,
        plugins: [
          sessionPlugin(labels),
          endLabelPlugin(0, v => `VV: ${v >= 0 ? '+' : ''}${v?.toFixed(4)}`, lastVV >= 0 ? '#d29922' : '#6b4c0a', -14),
          stickyYPlugin('vc-pane-vv-wrap', '#d29922', v => v?.toFixed(3)),
        ]
      });
    }
  }

  // ── 페인3: OBV ──
  const obvEl = document.getElementById('vc-pane-obv');
  const hasVOLD = voldD.some(v => v != null);
  if (obvEl) {
    if (!hasVOLD) {
      obvEl.parentElement.innerHTML = '<div style="height:220px;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:12px">OBV — Cron 적재 대기 (서버 1분 Cron)</div>';
    } else {
      const opts = commonOpts('#3fb950', item => `OBV: ${item.parsed.y != null ? (item.parsed.y >= 0 ? '+' : '') + item.parsed.y.toFixed(2) + 'M' : '—'}`);
      opts.scales.y.ticks.callback = v => {
        if (v == null) return '';
        const abs = Math.abs(v), sign = v < 0 ? '-' : '+';
        if (abs >= 1000) return sign + (abs/1000).toFixed(1) + 'B';
        return sign + abs.toFixed(1) + 'M';
      };
      opts.scales.y.grid = { color: ctx => ctx.tick.value === 0 ? 'rgba(255,255,255,0.25)' : 'rgba(48,54,61,.4)' };
      const lastVOLD = voldD.filter(v => v != null).slice(-1)[0] ?? 0;
      vcPaneOBV = new Chart(obvEl, {
        type: 'line', data: {
          labels,
          datasets: [{
            label: 'OBV',
            data: voldD,
            segment: {
              borderColor: ctx => (ctx.p1?.parsed?.y ?? 0) >= 0 ? '#3fb950' : '#f85149',
              backgroundColor: ctx => (ctx.p1?.parsed?.y ?? 0) >= 0 ? 'rgba(63,185,80,0.12)' : 'rgba(248,81,73,0.12)',
            },
            fill: 'origin',
            borderWidth: 2, pointRadius: 0, pointHoverRadius: 3, tension: 0, spanGaps: true,
          }]
        },
        options: opts,
        plugins: [
          sessionPlugin(labels),
          endLabelPlugin(0, v => `OBV: ${v >= 0 ? '+' : ''}${v?.toFixed(2)}M`, lastVOLD >= 0 ? '#3fb950' : '#f85149', -14),
          stickyYPlugin('vc-pane-obv-wrap', '#3fb950', v => {
            if (v == null) return '';
            const abs = Math.abs(v), sign = v < 0 ? '-' : '+';
            if (abs >= 1000) return sign + (abs/1000).toFixed(1) + 'B';
            return sign + abs.toFixed(1) + 'M';
          }),
        ]
      });
    }
  }

  // 스크롤 이벤트 → 차트 재드로우 (sticky y축 갱신)
  if (wrap) {
    wrap._vcScrollHandler && wrap.removeEventListener('scroll', wrap._vcScrollHandler);
    wrap._vcScrollHandler = () => {
      if (vcPaneVC)  vcPaneVC.draw();
      if (vcPaneVV)  vcPaneVV.draw();
      if (vcPaneOBV) vcPaneOBV.draw();
    };
    wrap.addEventListener('scroll', wrap._vcScrollHandler, { passive: true });
  }

  // zoom/스크롤 적용
  requestAnimationFrame(() => updateVCZoom());
}

