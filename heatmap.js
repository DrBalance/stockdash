// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// heatmap.js — Dealer Vanna/GEX 히트맵 렌더러 (가로 스크롤)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Vanna 값을 배경색으로 변환 (음수=빨강, 양수=파랑)
 */
function _hmColor(value) {
  if (!value) return 'transparent';
  const opacity = Math.min(Math.abs(value) / 5, 1);
  return value < 0
    ? `rgba(239,68,68,${opacity.toFixed(2)})`
    : `rgba(59,130,246,${opacity.toFixed(2)})`;
}

/**
 * 히트맵을 지정 컨테이너에 렌더링합니다.
 * @param {Object} data - computeGreeks() 반환값 (analysis 포함 가능)
 * @param {string} containerId - 삽입할 DOM 요소 id
 */
function renderHeatmap(data, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!data || !data.strikes || data.strikes.length === 0) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px">히트맵 데이터 없음</div>';
    return;
  }

  const { strikes, spotPrice, vanna, analysis, symbol } = data;

  // ±8% 범위 필터링 (프리마켓 대응), 낮은 → 높은 순 (왼쪽 → 오른쪽)
  const filtered = strikes
    .filter(s => Math.abs(s.strike - spotPrice) / spotPrice < 0.08)
    .sort((a, b) => a.strike - b.strike);

  if (filtered.length === 0) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px">표시할 행사가 없음 (±8% 범위)</div>';
    return;
  }

  // 질서 있는 하락 경고 배너
  const alertBanner = (analysis && analysis.type === 'ORDERLY_DECLINE')
    ? `<div class="badge-orderly">
         ⚠ <strong>질서 있는 하락 감지</strong> — ${analysis.message}
         <span style="margin-left:8px;opacity:.7">위험도: ${analysis.dangerLevel}</span>
       </div>`
    : '';

  const vannaSign = vanna < 0 ? 'var(--red)' : 'var(--blue, #3b82f6)';

  // 현재가에 가장 가까운 열 인덱스
  const spotIdx = filtered.reduce((best, s, i) => {
    return Math.abs(s.strike - spotPrice) < Math.abs(filtered[best].strike - spotPrice) ? i : best;
  }, 0);

  // 각 행 셀 생성
  const COL_W = 72;   // 데이터 열 너비 px
  const LBL_W = 48;   // sticky 라벨 열 너비 px
  const ROW_H_SM = 28; // Strike / GEX 행 높이
  const ROW_H_LG = 56; // Vanna 행 높이

  const strikeRow = filtered.map((s, i) => {
    const isSpot = i === spotIdx;
    const spotStyle = isSpot
      ? `background:rgba(255,255,255,.1);border-left:1px solid var(--text2);border-right:1px solid var(--text2);`
      : '';
    return `<td class="hm-col${isSpot ? ' hm-col-spot' : ''}" style="min-width:${COL_W}px;max-width:${COL_W}px;height:${ROW_H_SM}px;text-align:center;font-size:11px;font-family:var(--mono);color:var(--text1);border-right:1px solid var(--border);${spotStyle}">${s.strike.toFixed(0)}</td>`;
  }).join('');

  const vannaRow = filtered.map((s, i) => {
    const isSpot = i === spotIdx;
    const vannaNum = s.vanna != null ? s.vanna : ((s.callOI - s.putOI) * 0.1);
    const vannaVal = s.vanna != null ? s.vanna.toFixed(2) : '—';
    const spotStyle = isSpot
      ? `border-left:1px solid var(--text2);border-right:1px solid var(--text2);`
      : '';
    return `<td class="hm-col${isSpot ? ' hm-col-spot' : ''}" style="min-width:${COL_W}px;max-width:${COL_W}px;height:${ROW_H_LG}px;text-align:center;font-size:12px;font-weight:700;font-family:var(--mono);color:#fff;background:${_hmColor(vannaNum)};border-right:1px solid rgba(255,255,255,.08);${spotStyle}">${vannaVal}</td>`;
  }).join('');

  const gexRow = filtered.map((s, i) => {
    const isSpot = i === spotIdx;
    const gexVal = s.gex != null ? (s.gex / 1e6).toFixed(2) + 'M' : '—';
    const gexColor = s.gex > 0 ? 'var(--green, #3fb950)' : s.gex < 0 ? 'var(--red)' : 'var(--text3)';
    const spotStyle = isSpot
      ? `background:rgba(255,255,255,.1);border-left:1px solid var(--text2);border-right:1px solid var(--text2);`
      : '';
    return `<td class="hm-col${isSpot ? ' hm-col-spot' : ''}" style="min-width:${COL_W}px;max-width:${COL_W}px;height:${ROW_H_SM}px;text-align:center;font-size:11px;font-family:var(--mono);color:${gexColor};border-right:1px solid var(--border);${spotStyle}">${gexVal}</td>`;
  }).join('');

  // 공통 sticky 라벨 셀 스타일
  const stickyCell = (text, height) =>
    `<td style="position:sticky;left:0;z-index:2;min-width:${LBL_W}px;max-width:${LBL_W}px;height:${height}px;padding:0 4px;font-size:10px;font-weight:600;color:var(--text3);background:var(--bg, #0d1117);border-right:2px solid var(--border);white-space:nowrap;vertical-align:middle;text-align:right">${text}</td>`;

  el.innerHTML = `
    <div class="hm-wrap" style="padding:12px 0 8px">
      <div class="hm-header" style="padding:0 12px 8px;display:flex;align-items:center;justify-content:space-between">
        <span class="hm-title" style="font-size:12px;font-weight:600;color:var(--text2)">Dealer Exposure Heatmap${symbol ? ' · ' + symbol : ''}</span>
        <span style="font-size:12px;color:var(--text3)">Total Vanna:&nbsp;<span style="color:${vannaSign};font-family:var(--mono);font-weight:700">${vanna != null ? vanna + 'M' : '—'}</span></span>
      </div>
      ${alertBanner}
      <div id="hm-scroll-${containerId}" style="overflow-x:auto;overflow-y:hidden;border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
        <table style="border-collapse:collapse;table-layout:fixed;width:${filtered.length * COL_W + LBL_W}px">
          <tbody>
            <tr>${stickyCell('Strike', ROW_H_SM)}${strikeRow}</tr>
            <tr>${stickyCell('Vanna<br>Exp.', ROW_H_LG)}${vannaRow}</tr>
            <tr>${stickyCell('Net<br>GEX', ROW_H_SM)}${gexRow}</tr>
          </tbody>
        </table>
      </div>
      <div class="hm-footer" style="padding:5px 12px 0;display:flex;justify-content:space-between;font-size:10px;color:var(--text3)">
        <span>색상 농도 = 헤징 압력 강도</span>
        <span>■ 파랑: Vanna 양수 &nbsp;■ 빨강: Vanna 음수</span>
      </div>
    </div>`;

  // 현재가 열이 스크롤 컨테이너 중앙에 오도록 scrollLeft 조정
  requestAnimationFrame(() => {
    const scrollEl = document.getElementById(`hm-scroll-${containerId}`);
    if (!scrollEl) return;
    const spotCol = scrollEl.querySelector('.hm-col-spot');
    if (!spotCol) return;
    const containerW = scrollEl.clientWidth;
    const colOffset  = spotCol.offsetLeft;
    const colW       = spotCol.clientWidth;
    scrollEl.scrollLeft = colOffset - containerW / 2 + colW / 2;
  });
}
