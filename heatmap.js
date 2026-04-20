// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// heatmap.js — Dealer Vanna/GEX 히트맵 렌더러 (Vanilla JS)
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

  // 현재가 기준 ±5% 범위 필터링, 높은 가격이 위
  const filtered = strikes
    .filter(s => Math.abs(s.strike - spotPrice) / spotPrice < 0.05)
    .sort((a, b) => b.strike - a.strike);

  if (filtered.length === 0) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px">표시할 행사가 없음 (±5% 범위)</div>';
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

  const rows = filtered.map(s => {
    const isSpot = Math.abs(s.strike - spotPrice) < 1;
    const vannaVal = s.vanna != null ? s.vanna.toFixed(2) : '—';
    const gexVal   = s.gex   != null ? (s.gex / 1e6).toFixed(2) + 'M' : '—';
    const vannaNum = s.vanna != null ? s.vanna : ((s.callOI - s.putOI) * 0.1);
    return `<tr style="${isSpot ? 'background:rgba(255,255,255,.06)' : ''}">
      <td class="hm-td">${s.strike}${isSpot ? ' 📍' : ''}</td>
      <td class="hm-td hm-center" style="background:${_hmColor(vannaNum)}">${vannaVal}</td>
      <td class="hm-td hm-right">${gexVal}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="hm-wrap">
      <div class="hm-header">
        <span class="hm-title">Dealer Exposure Heatmap${symbol ? ' · ' + symbol : ''}</span>
        <span style="font-size:12px;color:var(--text3)">Total Vanna:
          <span style="color:${vannaSign};font-family:var(--mono);font-weight:700">${vanna != null ? vanna + 'M' : '—'}</span>
        </span>
      </div>
      ${alertBanner}
      <div style="overflow-y:auto;max-height:320px;border:1px solid var(--border);border-radius:6px">
        <table class="heatmap-table">
          <thead>
            <tr>
              <th class="hm-th">Strike</th>
              <th class="hm-th hm-center">Vanna Exposure</th>
              <th class="hm-th hm-right">Net GEX</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="hm-footer">
        <span>📍 현재가 인접</span>
        <span>색상 농도 = 헤징 압력 강도</span>
      </div>
    </div>`;
}
