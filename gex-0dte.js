// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// gex-0dte.js — 0DTE 로드/렌더, OI Top5, 판단 패널
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function load0DTE() {
  const sym = document.getElementById('sym-select-0dte').value;
  // 심볼 변경 시 vcHistory 초기화 (다른 심볼 데이터 섞임 방지)
  if (current0DTESym && current0DTESym !== sym) {
    vcHistory = [];
    priceHistory = [];
  }
  current0DTESym = sym;
  setStatus('updating');
  try {
    // 병렬: 서버 0DTE (+ 첫 로드 시 시계열 로드)
    // 현재가/VIX는 loadQuote()에서 30초마다 별도 갱신
    const fetchList = [
      fetch(`${PROXY}/api/gex0dte?symbol=${sym}`).then(r => r.json()),
    ];
    // vcHistory가 비어있으면 KV 시계열 로드
    const isFirstLoad = vcHistory.length === 0;
    if (isFirstLoad) {
      fetchList.push(fetch(`${PROXY}/api/vc_history?symbol=${sym}`).then(r => r.json()));
    }
    const results = await Promise.all(fetchList);
    const d0 = results[0];

    // KV 시계열 로드 처리
    if (isFirstLoad && results[1] && !results[1].error) {
      const kvHistory = results[1].history || [];
      if (kvHistory.length > 0) {
        vcHistory = kvHistory.map(p => ({
          iso:      p.iso,      // UTC ISO (신규 포맷)
          time:     p.iso ? toKST(p.iso) : p.time, // 표시용 (구버전 호환)
          vanna:    p.vanna,
          charm:    p.charm,
          vix:      p.vix,
          vv:       p.vv   ?? null,
          vold:     p.vold ?? null,
          spot:     p.spot,
        }));
        console.log(`[load0DTE] KV 시계열 로드: ${vcHistory.length}포인트`);
      }
    }

    if (d0.error) throw new Error(d0.error);

    // 현재가/VIX는 WS에서 관리 — 캐시값 사용
    const priceJson  = window._lastPriceJson || {};
    const newSpot    = priceJson.price || d0.spotPrice;
    const preMarketPct = priceJson.preMarketChangePercent;
    const prevClose    = priceJson.prevClose;

    const marketState = window._marketState || 'REGULAR';

    // KST 시간 문자열 (화면 표시용)
    const now = new Date();
    const nowIsoStr = now.toISOString(); // UTC ISO — 저장 기준
    const timeStr = toKST(nowIsoStr);   // KST 표시용

    priceHistory.push({ time: timeStr, price: newSpot, marketState, vix: vixVal, vvix: vvixVal, ts: now.getTime() });
    if (priceHistory.length > 60) priceHistory.shift();

    vcHistory.push({
      iso:   nowIsoStr,  // UTC ISO (차트 매핑 기준)
      time:  timeStr,    // KST 표시용
      vanna: d0.vanna,
      charm: d0.charm,
      vix:   vixVal,
      vv:    null,
      vold:  window._lastVold ?? null,  // WS market Cron에서 수신된 최신 VOLD
      spot:  newSpot,
    });
    if (vcHistory.length > 200) vcHistory.shift();

    // currentD 동기화 (판단 패널 함수들이 사용)
    const strikes = d0.strikes || [];
    currentD = {
      strikes,
      spotPrice: d0.spotPrice,
      flipZone:  d0.flipZone,
      putWall:   d0.putWall,
      callWall:  d0.callWall,
      localGEX:  (d0.localGEX || 0) * 1e6,
      totalGEX:  (d0.totalGEX || 0) * 1e6,
      pcr:       d0.pcr,
      exp:       d0.exp,
      isPreview: d0.isPreview || false,
      sym,
      upStrikes: d0.upStrikes || [],
      dnStrikes: d0.dnStrikes || [],
    };
    currentStrikes = strikes;
    prevSpot = newSpot;

    // 0DTE 영역 렌더
    render0DTE(d0, newSpot, marketState, preMarketPct, prevClose, timeStr);
    renderHeatmap({ ...d0, symbol: sym }, 'heatmap-container');

    // 타임스탬프 표시
    const computedAt = d0.computedAt ? toKST(d0.computedAt) : '—';
    const srcLabel   = d0.source === 'cron_computed' ? '🟢 Cron' : '🟡 On-demand';
    const previewBadge = d0.isPreview ? ` · 📅 ${d0.exp} 미리보기` : '';
    document.getElementById('data-time-0dte').textContent = `${srcLabel} · 계산: ${computedAt} · 조회: ${timeStr}${previewBadge}`;
    setStatus('live');
  } catch(e) {
    console.error('[0DTE]', e);
    setStatus('error');
    document.getElementById('main-area-0dte').innerHTML = `<div class="card"><div class="empty-state"><div class="empty-title">로드 실패</div><div class="empty-sub">${e.message}</div></div></div>`;
  }
}

function toggle0DTEAuto() {
  if (auto0DTEInterval) {
    clearInterval(auto0DTEInterval);
    auto0DTEInterval = null;
    document.getElementById('auto-btn-0dte').className = 'auto-btn';
    document.getElementById('auto-label-0dte').textContent = '자동갱신 OFF';
  } else {
    document.getElementById('auto-btn-0dte').className = 'auto-btn on';
    document.getElementById('auto-label-0dte').textContent = '자동갱신 ON';
    load0DTE();
    auto0DTEInterval = setInterval(load0DTE, 60000);
  }
}

// 0DTE 전용 render
function render0DTE(d0, newSpot, marketState, preMarketPct, prevClose, timeStr) {
  const vc = { totalVanna: d0.vanna, totalCharm: d0.charm };
  const strikes = d0.strikes || [];
  const { spotPrice, flipZone, putWall, callWall, exp, pcr } = d0;
  const localGEX  = (d0.localGEX || 0) * 1e6;
  const totalGEX  = (d0.totalGEX || 0) * 1e6;
  const upStrikes = d0.upStrikes || [];
  const dnStrikes = d0.dnStrikes || [];
  const sym = d0.symbol || current0DTESym;

  const regime = totalGEX >= 0 ? 'positive' : 'negative';
  const alarms = [];
  const flipDist = flipZone ? Math.abs(spotPrice - flipZone) / spotPrice * 100 : null;
  const putDist  = putWall  ? (spotPrice - putWall)  / spotPrice * 100 : null;
  if (!flipZone)            alarms.push({ l:'red',    m:`GEX 전 구간 ${regime==='negative'?'음수':'양수'} — Flip Zone 없음` });
  else if (flipDist < 0.5)  alarms.push({ l:'red',    m:`Flip Zone ($${flipZone}) 극근접 ${flipDist.toFixed(2)}% — 방향 전환 임박` });
  else if (flipDist < 1.5)  alarms.push({ l:'yellow', m:`Flip Zone ($${flipZone}) 근접 ${flipDist.toFixed(2)}%` });
  if (putDist !== null && putDist < 1) alarms.push({ l:'red', m:`Put Wall ($${putWall}) 직하방 — 이탈 시 낙폭 가속` });
  alarms.push(localGEX < 0
    ? { l:'red',   m:`로컬 GEX ${(localGEX/1e6).toFixed(1)}M — 딜러 추세 증폭` }
    : { l:'green', m:`로컬 GEX +${(localGEX/1e6).toFixed(1)}M — 딜러 변동성 억제` });
  if (pcr > 1.5) alarms.push({ l:'red', m:`PCR ${pcr.toFixed(2)} — 풋 편중 심화` });
  else if (pcr < 0.7) alarms.push({ l:'yellow', m:`PCR ${pcr.toFixed(2)} — 콜 편중` });

  const maxUp = Math.max(...upStrikes.map(s => s.callHedge), 1);
  const maxDn = Math.max(...dnStrikes.map(s => s.putHedge),  1);
  const rankCls = i => ['r1','r2','r3','r4'][i] || 'r4';
  const upRows = upStrikes.map((s,i) => {
    const dist = ((s.strike - spotPrice) / spotPrice * 100).toFixed(2);
    const pct  = Math.round(s.callHedge / maxUp * 100);
    return `<div class="hedge-row"><span class="hedge-rank ${rankCls(i)}">${i+1}</span><span class="hedge-strike">$${s.strike}</span><span class="hedge-dist">+${dist}%</span><div class="hedge-bar-wrap"><div class="hedge-bar up" style="width:${pct}%"></div></div><span class="hedge-pressure">${(s.callHedge/1e6).toFixed(1)}M</span></div>`;
  }).join('');
  const dnRows = dnStrikes.map((s,i) => {
    const dist = ((spotPrice - s.strike) / spotPrice * 100).toFixed(2);
    const pct  = Math.round(s.putHedge / maxDn * 100);
    return `<div class="hedge-row"><span class="hedge-rank ${rankCls(i)}">${i+1}</span><span class="hedge-strike">$${s.strike}</span><span class="hedge-dist">-${dist}%</span><div class="hedge-bar-wrap"><div class="hedge-bar dn" style="width:${pct}%"></div></div><span class="hedge-pressure">${(s.putHedge/1e6).toFixed(1)}M</span></div>`;
  }).join('');

  const vixDisplay  = vixVal  ? vixVal.toFixed(2)  : '—';
  const vvixDisplay = vvixVal ? vvixVal.toFixed(2) : '—';
  const fixedItems  = buildFixedJudgment({ strikes, spotPrice, flipZone, putWall, callWall, localGEX, totalGEX, upStrikes, dnStrikes }, vc);
  const chartData   = strikes.filter(s => Math.abs(s.strike - spotPrice) / spotPrice < 0.08);
  const tableData   = strikes.filter(s => Math.abs(s.strike - spotPrice) / spotPrice < 0.10);

  const spotDisplay = newSpot ? newSpot.toFixed(1) : spotPrice.toFixed(1);
  const stateLabel  = { PRE:'프리마켓', REGULAR:'정규장', AFTER:'애프터마켓', CLOSED:'마감' }[marketState] || marketState;
  const stateShort  = { PRE:'프리', REGULAR:'정규', AFTER:'애프터', CLOSED:'마감' }[marketState] || marketState;
  const stateCls    = { PRE:'pre-market', REGULAR:'', AFTER:'after-market', CLOSED:'' }[marketState] || '';
  const badgeCls    = { PRE:'pre', REGULAR:'regular', AFTER:'after', CLOSED:'closed' }[marketState] || 'closed';
  const change      = window._lastPriceJson?.prevChange ?? null;
  const pctStr      = change != null ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '—';

  document.getElementById('main-area-0dte').innerHTML = `
  <div class="card">
    <div class="card-title">${sym} · 0DTE ${exp} · ${stateLabel} · 서버계산(Cron)</div>
    <div class="regime-bar ${regime}">${regime==='positive'?'✚ Positive GEX — 딜러 변동성 억제 (피닝)':'▼ Negative GEX — 딜러 추세 증폭'}</div>
    <div id="alarm-list-0dte"></div>
    <div class="metrics">
      <div class="metric blue ${stateCls}" id="metric-spot-0dte" style="display:flex;flex-direction:column;align-items:center;justify-content:center">
        <div class="spot-state-badge ${badgeCls}">${stateLabel}</div>
        <div class="val">$${spotDisplay}</div>
        <div class="lbl">${pctStr}</div>
      </div>
      <div class="metric ${flipZone?'orange':''}"><div class="val">${flipZone?'$'+flipZone:'없음'}</div><div class="lbl">Flip Zone</div></div>
      <div class="metric ${pcr>1.5?'red':pcr<0.7?'yellow':''}"><div class="val">${pcr.toFixed(2)}</div><div class="lbl">Put/Call</div></div>
      <div class="metric red"><div class="val">${putWall?'$'+putWall:'—'}</div><div class="lbl">Put Wall</div></div>
      <div class="metric green"><div class="val">${callWall?'$'+callWall:'—'}</div><div class="lbl">Call Wall</div></div>
      <div class="metric ${localGEX<0?'red':'green'}"><div class="val">${(localGEX/1e6).toFixed(1)}M</div><div class="lbl">Local GEX</div></div>
      <div class="metric ${vixVal&&vixVal>30?'danger':vixVal&&vixVal>20?'warn':'yellow'}" id="metric-vix"><div class="val">${vixDisplay}${window._lastVixJson?.VIX?.pctChange!=null?`<span style="font-size:12px;opacity:.75;margin-left:3px">(${window._lastVixJson.VIX.pctChange>0?'+':''}${window._lastVixJson.VIX.pctChange.toFixed(1)}%)</span>`:''}</div><div class="lbl">VIX &nbsp;<span id="metric-vv" style="color:var(--text3);font-size:10px;font-family:var(--mono)">VV —</span></div></div>
      <div class="metric" id="metric-obv"><div class="val" id="metric-obv-val" style="font-size:16px">—</div><div class="lbl">VOLD &nbsp;<span id="metric-obv-slope" style="font-size:10px;color:var(--text3);font-family:var(--mono)">—</span></div></div>
      <div class="metric" id="metric-vanna" style="border-color:#bc8cff55"><div class="val" style="color:#bc8cff">${d0.vanna.toFixed(1)}M</div><div class="lbl" style="color:#bc8cff">● Vanna Exp</div></div>
      <div class="metric" id="metric-charm" style="border-color:#58a6ff55"><div class="val" style="color:#58a6ff">${d0.charm.toFixed(1)}M</div><div class="lbl" style="color:#58a6ff">● Charm · VC ${Math.abs(d0.vanna)>0?(Math.abs(d0.charm)/Math.abs(d0.vanna)).toFixed(2):'—'}</div></div>
    </div>

    <div class="judgment-panel" style="margin-top:20px">
      <div class="judgment-fixed">
        <div class="judgment-fixed-title">시장 구조 분석 — 0DTE 핵심 구조</div>
        <div id="judgment-fixed-content-0dte">${fixedItems.map(item=>`<div class="judgment-item ${item.cls}"><span class="ji-icon">${item.icon}</span><span class="ji-text">${item.text}</span></div>`).join('')}</div>
      </div>
      <div class="judgment-live">
        <div class="judgment-live-header">
          <div class="judgment-live-title"><div class="live-dot"></div>실시간 상황 판단</div>
          <div class="judgment-live-nav">
            <div class="jl-nav-btn" onclick="jlScroll0('-1')" title="위로">▲</div>
            <div class="jl-nav-btn" onclick="jlScroll0('1')"  title="아래로">▼</div>
          </div>
        </div>
        <div class="judgment-live-scroll" id="judgment-live-scroll-0dte">
          <div id="judgment-live-content-0dte"><div class="live-event le-info"><span class="le-time">—</span><span class="le-msg">자동갱신 시 실시간 판단이 누적됩니다</span></div></div>
        </div>
      </div>
    </div>

    <div class="hedge-section">
      <div class="hedge-title">딜러 헷지 부담 집중 스트라이크 (γ × OI 기준)</div>
      <div class="hedge-grid">
        <div><div class="hedge-col-label" style="color:var(--green)">▲ 상승 — 콜 헷지 Top4</div>${upRows||'<div style="color:var(--text3);font-size:13px;padding:8px">데이터 없음</div>'}</div>
        <div><div class="hedge-col-label" style="color:var(--red)">▼ 하락 — 풋 헷지 Top4</div>${dnRows||'<div style="color:var(--text3);font-size:13px;padding:8px">데이터 없음</div>'}</div>
      </div>
    </div>
  </div>

  <div class="vc-panel-wrap" style="flex-direction:column">
    <div id="greek-metrics-row" style="display:flex;gap:10px;flex-wrap:wrap;padding:14px 20px 0;border-bottom:1px solid var(--border)">
      <div class="greek-metric-card" id="gmc-vanna"><div class="gmc-header"><span class="gmc-dot" id="gmc-vanna-dot"></span><span class="gmc-name">Vanna</span><span class="gmc-signal" id="gmc-vanna-signal">—</span></div><div class="gmc-value" id="gmc-vanna-val">—</div><div class="gmc-desc" id="gmc-vanna-desc">갱신 후 표시</div></div>
      <div class="greek-metric-card" id="gmc-charm"><div class="gmc-header"><span class="gmc-dot" id="gmc-charm-dot"></span><span class="gmc-name">Charm</span><span class="gmc-signal" id="gmc-charm-signal">—</span></div><div class="gmc-value" id="gmc-charm-val">—</div><div class="gmc-desc" id="gmc-charm-desc">갱신 후 표시</div></div>
      <div class="greek-metric-card" id="gmc-gex"><div class="gmc-header"><span class="gmc-dot" id="gmc-gex-dot"></span><span class="gmc-name">Local GEX</span><span class="gmc-signal" id="gmc-gex-signal">—</span></div><div class="gmc-value" id="gmc-gex-val">—</div><div class="gmc-desc" id="gmc-gex-desc">갱신 후 표시</div></div>
      <div class="greek-metric-card" style="flex:1;min-width:160px" id="gmc-dominant"><div class="gmc-header"><span class="gmc-name" style="color:var(--text2)">◈ 지배 Greek</span></div><div class="gmc-value" id="gmc-dominant-val" style="font-size:13px">—</div><div class="gmc-desc" id="gmc-flip-desc">—</div></div>
    </div>
    <div class="vc-chart-area" style="width:100%;border-right:none">
      <div class="vc-chart-header">
        <div class="vc-chart-title">◈ Greek 실시간 흐름 (서버 계산 · Cron 5분)</div>
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
          <span style="font-size:12px;color:#bc8cff;font-weight:600">● Vanna</span>
          <span style="font-size:12px;color:#58a6ff;font-weight:600">● Charm</span>
          <span style="font-size:12px;color:#d29922;font-weight:600">● VV</span>
          <span style="font-size:12px;color:#3fb950;font-weight:600">● VOLD</span>
        </div>
      </div>
      <!-- 시간범위 버튼 + 슬라이더 -->
      <div class="vc-zoom-row" style="gap:8px;flex-wrap:wrap">
        <div style="display:flex;gap:4px">
          <button class="vc-range-btn active" id="vcrange-2h" onclick="setVCRange('2h')">2H</button>
          <button class="vc-range-btn" id="vcrange-4h" onclick="setVCRange('4h')">4H</button>
          <button class="vc-range-btn" id="vcrange-8h" onclick="setVCRange('8h')">8H</button>
          <button class="vc-range-btn" id="vcrange-1d" onclick="setVCRange('1d')">1D</button>
          <button class="vc-range-btn" id="vcrange-all" onclick="setVCRange('all')">ALL</button>
        </div>
        <input type="range" class="vc-zoom-slider" id="vc-zoom-slider" min="1" max="16" step="1" value="8" oninput="onVCSlider(this.value)">
        <span class="vc-zoom-val" id="vc-zoom-val">2H</span>
        <span style="font-size:11px;color:var(--text3)">← 스크롤 →</span>
      </div>
      <!-- 3-페인 동기화 차트 -->
      <div id="vc-multipane-wrap" style="overflow-x:auto;overflow-y:hidden;width:100%;cursor:grab">
        <!-- 내부 컨테이너: 실제 차트 너비 -->
        <div id="vc-multipane-inner" style="display:inline-block;min-width:100%">
          <!-- 페인1: Vanna + Charm -->
          <div style="position:relative">
            <div style="font-size:10px;color:var(--text3);padding:4px 8px;display:flex;gap:10px">
              <span style="color:#bc8cff">● Vanna</span><span style="color:#58a6ff">● Charm</span>
            </div>
            <div id="vc-pane-vc-wrap" style="position:relative;height:220px">
              <canvas id="vc-pane-vc"></canvas>
            </div>
          </div>
          <div style="height:1px;background:var(--border);margin:0"></div>
          <!-- 페인2: VV -->
          <div style="position:relative">
            <div style="font-size:10px;color:var(--text3);padding:4px 8px">
              <span style="color:#d29922">● VIX Velocity 누적 (Tick 스타일)</span>
            </div>
            <div id="vc-pane-vv-wrap" style="position:relative;height:220px">
              <canvas id="vc-pane-vv"></canvas>
            </div>
          </div>
          <div style="height:1px;background:var(--border);margin:0"></div>
          <!-- 페인3: VOLD -->
          <div style="position:relative">
            <div style="font-size:10px;color:var(--text3);padding:4px 8px">
              <span style="color:#3fb950">● VOLD (UVOL - DVOL, 장중)</span>
            </div>
            <div id="vc-pane-obv-wrap" style="position:relative;height:220px">
              <canvas id="vc-pane-obv"></canvas>
            </div>
          </div>
        </div>
      </div>
      <!-- 신호등 패널 -->
      <div id="vc-signal-bar" style="padding:10px 16px;border-top:1px solid var(--border);font-size:13px;font-weight:600;letter-spacing:.02em;min-height:42px;display:flex;align-items:center;gap:12px;background:rgba(0,0,0,.15)">
        <div id="vc-signal-indicator" style="width:14px;height:14px;border-radius:3px;flex-shrink:0;background:var(--text3)"></div>
        <span id="vc-signal-text" style="color:var(--text2);font-size:13px">데이터 누적 중...</span>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">OI 급변 Top5</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px" id="oi-top5-wrap">
      <div>
        <div style="font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;display:flex;align-items:center;gap:6px">
          <span style="width:6px;height:6px;border-radius:50%;background:var(--blue);display:inline-block"></span>최근 15분
        </div>
        <div class="tbl-wrap"><table>
          <thead><tr><th>Strike</th><th>구분</th><th>변화</th><th>현재 OI</th></tr></thead>
          <tbody id="tbl-top5-15m"></tbody>
        </table></div>
      </div>
      <div>
        <div style="font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;display:flex;align-items:center;gap:6px">
          <span style="width:6px;height:6px;border-radius:50%;background:var(--orange);display:inline-block"></span>누적 (당일)
        </div>
        <div class="tbl-wrap"><table>
          <thead><tr><th>Strike</th><th>구분</th><th>변화</th><th>현재 OI</th></tr></thead>
          <tbody id="tbl-top5-cum"></tbody>
        </table></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">OI 분포 + GEX (0DTE)</div>
    <div class="chart-controls">
      <span class="zoom-label">확대</span>
      <input type="range" class="zoom-slider" id="zoom-slider" min="1" max="6" step="0.5" value="1" oninput="updateZoom(this.value)">
      <span class="zoom-val" id="zoom-val">1×</span>
      <span class="scroll-hint">← 가로 스크롤 →</span>
    </div>
    <div class="chart-scroll-wrap" id="chart-scroll-wrap">
      <div class="chart-inner" id="chart-inner"><canvas id="mainchart"></canvas></div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">스트라이크별 상세 — 현재가 ±10%</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Strike</th><th>Call OI</th><th>Δ15분</th><th>Δ누적</th><th>Put OI</th><th>Δ15분</th><th>Δ누적</th><th>GEX(M)</th><th>IV</th></tr></thead>
      <tbody id="tbl-body-0dte"></tbody>
    </table></div>
  </div>`;

  // 알람 렌더
  const al = document.getElementById('alarm-list-0dte');
  (alarms.length ? alarms : [{ l:'green', m:'특이 리스크 없음' }]).forEach(a => {
    const div = document.createElement('div'); div.className = `alarm ${a.l}`; div.textContent = a.m; al.appendChild(div);
  });

  // 차트 & 테이블
  requestAnimationFrame(() => {
    buildChart(chartData, newSpot || spotPrice, flipZone, putWall, callWall);
  });
  const tbody = document.getElementById('tbl-body-0dte');
  if (tbody) tableData.forEach(s => {
    const isCur = Math.abs(s.strike - (newSpot||spotPrice)) < 0.5;
    const isFlip = s.strike === flipZone, isPW = s.strike === putWall, isCW = s.strike === callWall;
    const tr = document.createElement('tr');
    if (isCur) tr.className = 'cur'; else if (isFlip) tr.className = 'flip';
    let tags = '';
    if (isCur)  tags += `<span class="tag tag-cur">현재가</span>`;
    if (isFlip) tags += `<span class="tag tag-flip">Flip</span>`;
    if (isPW)   tags += `<span class="tag tag-pw">Put Wall</span>`;
    if (isCW)   tags += `<span class="tag tag-cw">Call Wall</span>`;
    const gc = s.gex >= 0 ? '#3fb950' : '#f85149';
    const fmtDiff = (d) => {
      if (d == null || d === 0) return '<span style="color:var(--text3)">—</span>';
      const sign = d > 0 ? '+' : '';
      const color = d > 0 ? 'var(--green)' : 'var(--red)';
      const abs = Math.abs(d);
      const str = abs >= 1000 ? (abs/1000).toFixed(1)+'K' : abs.toString();
      return `<span style="color:${color};font-size:11px">${sign}${d > 0 ? str : '-'+str}</span>`;
    };
    tr.innerHTML = `<td>$${s.strike}${tags}</td><td>${s.callOI.toLocaleString()}</td><td>${fmtDiff(s.callOIDiff15)}</td><td>${fmtDiff(s.callOIDiffCum)}</td><td>${s.putOI.toLocaleString()}</td><td>${fmtDiff(s.putOIDiff15)}</td><td>${fmtDiff(s.putOIDiffCum)}</td><td style="color:${gc};font-weight:600">${s.gex>=0?'+':''}${(s.gex/1e6).toFixed(2)}</td><td>${s.iv>0?(s.iv*100).toFixed(1)+'%':'—'}</td>`;
    tbody.appendChild(tr);
  });

  // OI 급변 Top5 테이블 렌더
  renderOITop5(strikes);

  // 실시간 판단 이벤트 — 프리마켓~장 마감(EST 16:00)까지만 업데이트
  const _nowEST = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const _estH = _nowEST.getHours() + _nowEST.getMinutes() / 60;
  const _isMarketHours = _estH >= 4 && _estH < 16; // 프리마켓 04:00 ~ 장 마감 16:00
  if (_isMarketHours) {
    const ctx0 = { marketState, priceLabel: `[${stateLabel}] $${spotDisplay}`, preMarketPct, prevClose, vix: vixVal };
    const liveEvts = buildLiveJudgment(newSpot || spotPrice, vc, currentD, ctx0, timeStr);
    liveEvts.forEach(ev => { liveEvents.unshift({ time: timeStr, cls: ev.cls, msg: ev.msg }); });
    if (liveEvents.length > 15) liveEvents = liveEvents.slice(0, 15);
  }
  const liveEl = document.getElementById('judgment-live-content-0dte');
  if (liveEl) {
    if (!_isMarketHours && liveEvents.length === 0) {
      liveEl.innerHTML = `<div class="live-event le-info"><span class="le-time">—</span><span class="le-msg">장 마감 — 다음 거래일 프리마켓부터 업데이트됩니다</span></div>`;
    } else {
      liveEl.innerHTML = liveEvents.map(e => `<div class="live-event ${e.cls}"><span class="le-time">${e.time}</span><span class="le-msg">${e.msg}</span></div>`).join('') || `<div class="live-event le-info"><span class="le-time">—</span><span class="le-msg">감지 중...</span></div>`;
    }
  }

  // Greek 힘의 균형
  const force = calcForceBalance(vc, currentD, vixVal, vvixVal);
  renderForceSidebar(force);
  requestAnimationFrame(() => renderVCChart());
}

// ── OI 급변 Top5 테이블 렌더
function renderOITop5(strikes) {
  if (!strikes || strikes.length === 0) return;

  const fmtDiff = (d) => {
    if (d == null || d === 0) return '<span style="color:var(--text3)">—</span>';
    const abs = Math.abs(d);
    const str = abs >= 1000 ? (abs/1000).toFixed(1)+'K' : abs.toLocaleString();
    const sign = d > 0 ? '+' : '-';
    const color = d > 0 ? 'var(--green)' : 'var(--red)';
    return `<span style="color:${color}">${sign}${str}</span>`;
  };

  const badgeCall = `<span class="tag tag-cw" style="font-size:10px;padding:1px 5px">Call</span>`;
  const badgePut  = `<span class="tag tag-pw" style="font-size:10px;padding:1px 5px">Put</span>`;

  // 15분 기준: callOIDiff15, putOIDiff15 절대값으로 정렬
  const rows15 = [];
  for (const s of strikes) {
    if (s.callOIDiff15) rows15.push({ strike: s.strike, type: 'Call', diff: s.callOIDiff15, oi: s.callOI });
    if (s.putOIDiff15)  rows15.push({ strike: s.strike, type: 'Put',  diff: s.putOIDiff15,  oi: s.putOI  });
  }
  rows15.sort((a,b) => Math.abs(b.diff) - Math.abs(a.diff));

  // 누적 기준: callOIDiffCum, putOIDiffCum 절대값으로 정렬
  const rowsCum = [];
  for (const s of strikes) {
    if (s.callOIDiffCum) rowsCum.push({ strike: s.strike, type: 'Call', diff: s.callOIDiffCum, oi: s.callOI });
    if (s.putOIDiffCum)  rowsCum.push({ strike: s.strike, type: 'Put',  diff: s.putOIDiffCum,  oi: s.putOI  });
  }
  rowsCum.sort((a,b) => Math.abs(b.diff) - Math.abs(a.diff));

  const makeRows = (rows) => rows.slice(0,5).map(r => `
    <tr>
      <td>$${r.strike}</td>
      <td style="text-align:left">${r.type === 'Call' ? badgeCall : badgePut}</td>
      <td>${fmtDiff(r.diff)}</td>
      <td>${r.oi.toLocaleString()}</td>
    </tr>`).join('') || `<tr><td colspan="4" style="color:var(--text3);text-align:center">데이터 없음</td></tr>`;

  const t15  = document.getElementById('tbl-top5-15m');
  const tCum = document.getElementById('tbl-top5-cum');
  if (t15)  t15.innerHTML  = makeRows(rows15);
  if (tCum) tCum.innerHTML = makeRows(rowsCum);
}

function jlScroll0(dir) {
  const el = document.getElementById('judgment-live-scroll-0dte');
  if (el) el.scrollBy({ top: parseInt(dir) * 72, behavior: 'smooth' });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 통합 상황판단 — 고정 섹션
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function buildFixedJudgment(d, vc) {
  const { spotPrice, flipZone, putWall, callWall, localGEX, totalGEX, upStrikes, dnStrikes } = d;
  const { totalVanna, totalCharm } = vc;
  const items = [];

  // GEX 구조
  const localM = localGEX / 1e6;
  if (totalGEX >= 0) {
    let pinRange = '';
    if (localM > 3000) pinRange = `예상 피닝 범위 $${(spotPrice*0.997).toFixed(0)} ~ $${(spotPrice*1.003).toFixed(0)} (±0.3%)`;
    else if (localM > 1000) pinRange = `예상 피닝 범위 $${(spotPrice*0.995).toFixed(0)} ~ $${(spotPrice*1.005).toFixed(0)} (±0.5%)`;
    else pinRange = `피닝 범위 넓음 (±1% 이상 가능)`;
    items.push({ cls:'ji-green', icon:'✚', text:`<b>Positive GEX +${localM.toFixed(0)}M</b> — 오늘 큰 방향성 움직임 어렵습니다. ${pinRange}` });
  } else {
    items.push({ cls:'ji-red', icon:'▼', text:`<b>Negative GEX ${localM.toFixed(0)}M</b> — 딜러가 추세를 증폭합니다. 방향 한 번 잡히면 가속 가능` });
  }

  // Vanna / Charm + VC Ratio
  const vcRatio = Math.abs(totalVanna) > 0 ? Math.abs(totalCharm) / Math.abs(totalVanna) : 0;
  const vcRatioStr = vcRatio.toFixed(2);
  const vcDom = vcRatio < 0.15 ? 'Vanna 완전 지배'
              : vcRatio < 0.35 ? 'Vanna 우세, Charm 부차적'
              : vcRatio < 0.65 ? 'Vanna·Charm 균형'
              : vcRatio < 1.0  ? 'Charm 우세'
              : 'Charm 지배';

  if (Math.abs(totalVanna) > 100) {
    if (totalVanna < 0) {
      items.push({ cls:'ji-red', icon:'◈', text:`<b>Vanna ${totalVanna.toFixed(0)}M (음수)</b> — VIX 상승 시 딜러 매도 헷지 강화. VIX가 올라오면 하락 압력 가속됩니다` });
    } else {
      items.push({ cls:'ji-green', icon:'◈', text:`<b>Vanna ${totalVanna.toFixed(0)}M (양수)</b> — VIX 하락 시 딜러 매수 헷지. VIX가 내려오면 상승 지지력 강화됩니다` });
    }
  }

  // Charm 구조 + VC Ratio
  if (Math.abs(totalCharm) > 50) {
    const charmDir = totalCharm < 0 ? '매수 드리프트' : '매도 드리프트';
    const charmCls = totalCharm < 0 ? 'ji-blue' : 'ji-orange';
    items.push({ cls: charmCls, icon:'⏱', text:
      `<b>Charm ${totalCharm.toFixed(0)}M</b> — 오후 1시 이후 ${charmDir} 압력 작동. ` +
      `<b>VC Ratio ${vcRatioStr}</b> (${vcDom}) — ` +
      (vcRatio < 0.35
        ? 'Vanna에 압도되어 Charm 실효성 제한적'
        : vcRatio < 0.65
        ? 'Charm이 부분적으로 방향에 기여 가능'
        : 'Charm이 오후 흐름 주도 가능성 있음')
    });
  }

  // Flip Zone
  if (flipZone) {
    const flipDist = Math.abs(spotPrice - flipZone) / spotPrice * 100;
    if (flipDist < 0.5) {
      items.push({ cls:'ji-red', icon:'⚡', text:`<b>Flip Zone $${flipZone} 극근접 (${flipDist.toFixed(2)}%)</b> — 이탈 시 딜러 방향 전환, 하락 가속 가능. 최우선 경계 레벨` });
    } else if (flipDist < 1.5) {
      items.push({ cls:'ji-yellow', icon:'⚠', text:`<b>Flip Zone $${flipZone} 근접 (${flipDist.toFixed(2)}%)</b> — 이탈 시 딜러 방향 전환. 하락 심화 가능` });
    } else {
      items.push({ cls:'ji-blue', icon:'○', text:`<b>Flip Zone $${flipZone}</b> — 현재가 대비 ${flipDist.toFixed(1)}% 하방. 당장 위협 아님` });
    }
  }

  // Put Wall / Call Wall
  if (putWall) {
    const putDist = (spotPrice - putWall) / spotPrice * 100;
    items.push({ cls:'ji-red', icon:'▼', text:`<b>Put Wall $${putWall}</b> — 하방 ${putDist.toFixed(1)}%. 대규모 풋 헷지 집중. 이탈 시 낙폭 가속` });
  }
  if (callWall) {
    const callDist = (callWall - spotPrice) / spotPrice * 100;
    items.push({ cls:'ji-green', icon:'▲', text:`<b>Call Wall $${callWall}</b> — 상방 ${callDist.toFixed(1)}%. 대규모 콜 헷지 집중. 상단 저항` });
  }

  return items;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 실시간 상황판단 이벤트 생성
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function buildLiveJudgment(newSpot, vc, d, ctx, timeStr) {
  const events = [];
  const { totalVanna, totalCharm } = vc;
  const { flipZone, totalGEX, spotPrice: baseSpot } = d;
  const { marketState, preMarketPct, prevClose, vix: currentVix } = ctx;

  const vixHistory = priceHistory.slice(-5).map(h=>h.vix).filter(Boolean);
  const vixChange = vixHistory.length >= 2
    ? (vixHistory[vixHistory.length-1] - vixHistory[0]) / vixHistory[0] * 100
    : 0;

  const now = new Date();
  const est = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const estHour = est.getHours() + est.getMinutes()/60;

  // 프리마켓 분석
  if (marketState === 'PRE' && prevClose && preMarketPct != null) {
    const abs = Math.abs(preMarketPct);
    if (abs > 0.5) {
      const dir = preMarketPct > 0 ? '상승' : '하락';
      const vannaDesc = totalVanna < 0
        ? `Vanna 음수 구조 — 개장 후 VIX ${preMarketPct>0?'하락':'상승'} 시 ${preMarketPct>0?'매도':'매수'} 압력 가능`
        : `Vanna 양수 구조 — 개장 후 VIX 흐름 주목`;
      events.push({ cls: preMarketPct>0?'le-warn':'le-info', msg:`프리마켓 ${dir} ${abs.toFixed(2)}% — 딜러 헷지 ${dir} 방향 진행 중. ${vannaDesc}` });
    }
  }

  // VIX 변화 감지
  if (Math.abs(vixChange) > 1.0 && totalVanna !== 0) {
    if (vixChange > 0 && totalVanna < 0) {
      events.push({ cls:'le-danger', msg:`VIX +${vixChange.toFixed(1)}% 상승 — Vanna 음수(${totalVanna.toFixed(0)}M) 활성화. 딜러 매도 압력 강화 중` });
    } else if (vixChange < 0 && totalVanna > 0) {
      events.push({ cls:'le-good', msg:`VIX ${vixChange.toFixed(1)}% 하락 — Vanna 양수(${totalVanna.toFixed(0)}M) 활성화. 딜러 매수 지지 강화 중` });
    } else if (vixChange < 0 && totalVanna < 0) {
      events.push({ cls:'le-info', msg:`VIX ${vixChange.toFixed(1)}% 하락 — Vanna 음수지만 VIX 하락으로 매도 압력 완화 중` });
    }
  }

  // Charm 타이밍
  if (estHour >= 13 && estHour < 13.1) {
    const charmMsg = totalCharm < 0 ? '매수 드리프트 시작' : '하락 드리프트 시작';
    events.push({ cls: totalCharm<0?'le-good':'le-warn', msg:`오후 1시 경과 — Charm(${totalCharm.toFixed(0)}M) ${charmMsg}. 시간 압력이 가격에 반영되기 시작합니다` });
  }

  if (estHour >= 15 && estHour < 15.1) {
    events.push({ cls:'le-warn', msg:`마감 1시간 전 — Charm 효과 최대화. 딜러 헷지 청산 물량 주의. 방향성 확대 가능` });
  }

  // Flip Zone 근접
  if (flipZone) {
    const dist = Math.abs(newSpot - flipZone) / newSpot * 100;
    if (dist < 0.3) {
      events.push({ cls:'le-danger', msg:`⚡ Flip Zone $${flipZone} 극근접 (${dist.toFixed(2)}%) — 이탈 시 딜러 방향 전환, 하락 가속 가능` });
    } else if (dist < 0.8) {
      events.push({ cls:'le-warn', msg:`Flip Zone $${flipZone} 근접 (${dist.toFixed(2)}%) — 이탈 여부 주목` });
    }
  }

  // GEX 상태
  if (totalGEX >= 0) {
    const localM = d.localGEX / 1e6;
    if (localM > 2000) {
      events.push({ cls:'le-info', msg:`Positive GEX 강함 (+${localM.toFixed(0)}M) — 현재 변동성 억제 중. 급등락 가능성 낮음` });
    }
  }

  // 기본 메시지
  if (!events.length) {
    events.push({ cls:'le-info', msg:`현재가 $${newSpot.toFixed(2)} — 주요 트리거 없음. 구조 유지 중` });
  }

  return events;
}

function renderJudgmentPanel(fixedItems, liveEvts, timeStr) {
  const fixedEl = document.getElementById('judgment-fixed-content');
  const liveEl = document.getElementById('judgment-live-content');
  if (!fixedEl || !liveEl) return;

  // 고정 섹션 (최초 1회만 렌더)
  if (fixedEl.dataset.rendered !== '1') {
    fixedEl.innerHTML = fixedItems.map(item => `
      <div class="judgment-item ${item.cls}">
        <span class="ji-icon">${item.icon}</span>
        <span class="ji-text">${item.text}</span>
      </div>
    `).join('');
    fixedEl.dataset.rendered = '1';
  }

  // 실시간 섹션 누적
  liveEvts.forEach(ev => {
    liveEvents.unshift({ time: timeStr, cls: ev.cls, msg: ev.msg });
  });
  if (liveEvents.length > 15) liveEvents = liveEvents.slice(0, 15);

  liveEl.innerHTML = liveEvents.map(e => `
    <div class="live-event ${e.cls}">
      <span class="le-time">${e.time}</span>
      <span class="le-msg">${e.msg}</span>
    </div>
  `).join('') || `<div class="live-event le-info"><span class="le-time">—</span><span class="le-msg">감지 중...</span></div>`;
}

function updateSpotMetric(newSpot, marketState, preMarketPct, prevClose) {
  const m = document.getElementById('metric-spot'); if (!m) return;
  if (!currentD) return;
  const base = (marketState === 'PRE' && prevClose) ? prevClose : currentD.spotPrice;
  const pct = ((newSpot - base) / base * 100);

  const SLABELS = { PRE:'프리마켓', REGULAR:'정규장', AFTER:'애프터마켓', CLOSED:'마감' };
  const SSHORT  = { PRE:'프리', REGULAR:'정규', AFTER:'애프터', CLOSED:'마감' };
  const SCLS    = { PRE:'pre-market', REGULAR:'', AFTER:'after-market', CLOSED:'' };
  const label = `[${SSHORT[marketState]||marketState}] $${newSpot.toFixed(1)}`;

  m.querySelector('.val').textContent = label;
  m.querySelector('.lbl').textContent = `${SLABELS[marketState]||marketState} ${pct>=0?'+':''}${pct.toFixed(2)}%`;
  m.className = 'metric blue' + (SCLS[marketState] ? ' ' + SCLS[marketState] : '');
}
