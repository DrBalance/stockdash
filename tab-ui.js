// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// tab-ui.js — 탭 전환 UI + 상태 표시
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── 탭 전환 ──
function switchTab(tab) {
  // 탭 버튼 상태 업데이트
  ['0dte','date','screener','chart'].forEach(t => {
    const el = document.getElementById('tab-' + t);
    if (el) el.className = 'tab-btn' + (t === tab ? ' active' : '');
  });
  // 컨트롤 바
  const ctrl0 = document.getElementById('ctrl-0dte');
  const ctrlD = document.getElementById('ctrl-date');
  if (ctrl0) ctrl0.style.display = tab === '0dte' ? '' : 'none';
  if (ctrlD) ctrlD.style.display = tab === 'date' ? '' : 'none';
  // 콘텐츠 영역
  const area0 = document.getElementById('area-0dte');
  const areaD = document.getElementById('area-date');
  const areaS = document.getElementById('area-screener');
  const areaC = document.getElementById('area-chart');
  if (area0) area0.style.display = tab === '0dte'     ? '' : 'none';
  if (areaD) areaD.style.display = tab === 'date'     ? '' : 'none';
  if (areaS) areaS.style.display = tab === 'screener' ? '' : 'none';
  if (areaC) areaC.style.display = tab === 'chart'    ? '' : 'none';
  // 날짜 탭 최초 진입 시 만기 목록 로드
  if (tab === 'date' && !dateAllOptions.length) loadExpirations();
  // 스크리너 탭 최초 진입 시 데이터 로드
  if (tab === 'screener') { loadBollinger(); loadScreener(); }
  // 차트 탭 진입
  if (tab === 'chart') {
    chartTabVisible = true;
    initChartSymbols();
    if (chartPendingUpdate) {
      chartPendingUpdate = false;
      renderLWChart(window._chartPendingData);
      window._chartPendingData = null;
    } else {
      const _t = chartActiveTab();
      if (_t?.data) renderLWChart(_t.data);
    }
  } else {
    chartTabVisible = false;
  }
  // 탭 복귀 시 GEX 차트 복원
  if (tab === '0dte' && currentD) {
    requestAnimationFrame(() => {
      const chartData = currentStrikes.filter(
        s => Math.abs(s.strike - currentD.spotPrice) / currentD.spotPrice < 0.08
      );
      buildChart(chartData, currentD.spotPrice, currentD.flipZone, currentD.putWall, currentD.callWall, '');
      if (vcHistory.length > 0) renderVCChart();
    });
  }
  if (tab === 'date' && dateCurrentD) {
    requestAnimationFrame(() => {
      const chartData = dateCurrentStrikes.filter(
        s => Math.abs(s.strike - dateCurrentD.spotPrice) / dateCurrentD.spotPrice < 0.08
      );
      buildChart(chartData, dateCurrentD.spotPrice, dateCurrentD.flipZone, dateCurrentD.putWall, dateCurrentD.callWall, '-date');
    });
  }
}

function setStatus(s){
  const dot=document.getElementById('status-dot'),txt=document.getElementById('status-text');
  if(s==='loading'){dot.className='status-dot';txt.textContent='로딩 중...';}
  else if(s==='live'){dot.className='status-dot live';txt.textContent='로드 완료';}
  else if(s==='updating'){dot.className='status-dot updating';txt.textContent='갱신 중...';}
  else{dot.className='status-dot';txt.textContent='오류';}
}
