// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// screener.js — 볼린저밴드 신호 패널 + 옵션 스크리너 테이블
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── 포맷 헬퍼 ──────────────────────────────────────────────
function fmt(n) {
  if (!n) return '-';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

// ── IV 스큐 바 렌더 ────────────────────────────────────────
// skew 범위: 보통 -0.5 ~ +0.5 (IV 단위)
// 바 최대 너비 기준: ±0.30을 100%로 정규화
function renderSkewBar(skew) {
  const MAX   = 0.30;
  const pct   = Math.min(Math.abs(skew) / MAX * 100, 100);
  const label = (skew > 0 ? '+' : '') + (skew * 100).toFixed(1) + '%';

  if (skew > 0.01) {
    // Call Skew — 중앙에서 오른쪽으로 초록 바
    return `
      <div style="display:flex;align-items:center;gap:4px;font-size:11px">
        <div style="width:50%;display:flex;justify-content:flex-end">
          <div style="width:2px;height:12px;background:var(--border)"></div>
        </div>
        <div style="width:50%;display:flex;align-items:center;gap:3px">
          <div style="width:${pct/2}%;min-width:2px;height:8px;
               background:var(--green);border-radius:0 2px 2px 0;opacity:.85"></div>
          <span style="color:var(--green);white-space:nowrap;font-size:10px">${label}</span>
        </div>
      </div>`;
  } else if (skew < -0.01) {
    // Put Skew — 중앙에서 왼쪽으로 빨간 바
    return `
      <div style="display:flex;align-items:center;gap:4px;font-size:11px">
        <div style="width:50%;display:flex;justify-content:flex-end;align-items:center;gap:3px">
          <span style="color:var(--red);white-space:nowrap;font-size:10px">${label}</span>
          <div style="width:${pct/2}%;min-width:2px;height:8px;
               background:var(--red);border-radius:2px 0 0 2px;opacity:.85"></div>
        </div>
        <div style="width:50%">
          <div style="width:2px;height:12px;background:var(--border)"></div>
        </div>
      </div>`;
  } else {
    // 중립
    return `
      <div style="display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--text3)">
        <div style="width:2px;height:12px;background:var(--border);margin-right:4px"></div>
        <span>0</span>
      </div>`;
  }
}

// ── 볼린저밴드 신호 패널 ───────────────────────────────────
async function loadBollinger() {
  const el = document.getElementById('boll-panel');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px">로딩 중...</div>';

  try {
    const res  = await fetch(API_BASE + '/api/bollinger');
    const data = await res.json();

    if (data.error || data.total === 0) {
      el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px">데이터 수집 후 표시됩니다</div>';
      return;
    }

    const bollToday = new Date().toISOString().split('T')[0];
    const bollLabel = data.date === bollToday ? '' : ` · 📅 ${data.date} 기준`;
    const { signals, sector_summary } = data;

    // ── 섹터 한국어 매핑
    const sectorKr = {
      broad_market:'시장',   technology:'기술',      energy:'에너지',
      financial:'금융',      healthcare:'헬스',       industrial:'산업재',
      utilities:'유틸',      staples:'필수소비재',    discretionary:'임의소비재',
      commodity_metal:'귀금속', commodity_agri:'농산물',
      crypto:'암호화폐',     country:'국가ETF',       ai_data:'AI',
      fintech:'핀테크',
    };

    // ── 섹터 요약 히트맵
    let sectorHtml = '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px">';
    for (const [sector, stat] of Object.entries(sector_summary)) {
      const total = stat.total;
      if (!total) continue;
      const buyRatio  = stat.buy  / total;
      const sellRatio = stat.sell / total;
      let bg = 'var(--bg3)', tc = 'var(--text3)';
      if (buyRatio  >= 0.3) { bg = 'rgba(63,185,80,.12)';  tc = 'var(--green)'; }
      if (sellRatio >= 0.3) { bg = 'rgba(248,81,73,.12)';  tc = 'var(--red)';   }

      sectorHtml += `
        <div style="background:${bg};border:1px solid var(--border);border-radius:6px;
                    padding:6px 10px;cursor:pointer;min-width:70px;text-align:center"
             onclick="filterBollBySecotor('${sector}')">
          <div style="font-size:11px;color:${tc};font-weight:700">${sectorKr[sector] || sector}</div>
          <div style="font-size:10px;color:var(--text3);margin-top:2px">
            🟢${stat.buy} 🔴${stat.sell} 👀${stat.watch}
          </div>
        </div>`;
    }
    sectorHtml += '</div>';

    // ── 신호 카드
    const signalConfig = {
      buy:   { label:'🟢 매수 신호',   bg:'rgba(63,185,80,.08)',  border:'rgba(63,185,80,.25)'  },
      sell:  { label:'🔴 인버스 신호', bg:'rgba(248,81,73,.08)', border:'rgba(248,81,73,.25)'  },
      watch: { label:'👀 관찰 신호',   bg:'rgba(210,153,34,.08)', border:'rgba(210,153,34,.25)' },
    };

    let cardsHtml = '';
    for (const [type, cfg] of Object.entries(signalConfig)) {
      const rows = signals[type] || [];
      if (!rows.length) continue;

      cardsHtml += `
        <div style="background:${cfg.bg};border:1px solid ${cfg.border};
                    border-radius:8px;padding:14px 16px;margin-bottom:10px">
          <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:10px">
            ${cfg.label}
            <span style="font-size:11px;font-weight:400;color:var(--text3)">${rows.length}개</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px">`;

      for (const r of rows) {
        const pctB     = (r.pct_b * 100).toFixed(0);
        const strength = '★'.repeat(r.signal_strength || 1);
        const gradeColor = r.grade === 'A' ? 'var(--blue)' :
                           r.grade === 'B' ? 'var(--yellow)' : 'var(--text3)';
        let optSign = '';
        if (r.pcr_oi != null) {
          if (type === 'buy'  && r.pcr_oi < 0.7) optSign = ' ✅옵션확인';
          if (type === 'sell' && r.pcr_oi > 1.5) optSign = ' ✅옵션확인';
        }

        cardsHtml += `
          <div style="background:var(--bg2);border:1px solid var(--border);
                      border-radius:6px;padding:8px 12px;min-width:130px">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span style="font-weight:700;color:var(--text);font-family:var(--mono)">${r.symbol}</span>
              <span style="font-size:10px;color:${gradeColor};font-weight:700">${r.grade}등급</span>
            </div>
            <div style="font-size:11px;color:var(--text3);margin-top:4px">
              %B: <span style="color:var(--text2)">${pctB}%</span> · $${r.close}
            </div>
            <div style="font-size:11px;margin-top:2px">
              <span style="color:var(--yellow)">${strength}</span>
              <span style="color:var(--green);font-size:10px">${optSign}</span>
            </div>
          </div>`;
      }
      cardsHtml += '</div></div>';
    }

    el.innerHTML = sectorHtml + cardsHtml;

  } catch (err) {
    el.innerHTML = `<div style="color:var(--red);font-size:12px;padding:8px">⚠️ ${err.message}</div>`;
  }
}

// ── 섹터 클릭 → 하단 스크리너 필터 연동 (향후 확장)
function filterBollBySecotor(sector) {
  console.log('섹터 필터:', sector);
}

// ── 옵션 스크리너 테이블 ───────────────────────────────────
async function loadScreener() {
  const type     = document.getElementById('screener-type')?.value || 'all';
  const resultEl = document.getElementById('screener-result');
  const timeEl   = document.getElementById('screener-time');

  if (resultEl) resultEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)">로딩 중...</div>';

  try {
    const res  = await fetch(`${API_BASE}/api/screener?type=${type}`);
    const data = await res.json();

    if (data.error) throw new Error(data.error);

    const today    = new Date().toISOString().split('T')[0];
    const isLatest = data.date === today;
    const dateLabel = isLatest ? data.date + ' (오늘)' : data.date + ' (최근 거래일 기준)';
    if (timeEl) timeEl.textContent = '기준일: ' + dateLabel;

    // 데이터 없을 때
    if (data.total === 0) {
      if (resultEl) resultEl.innerHTML = `
        <div style="text-align:center;padding:40px;color:var(--text3)">
          <div style="font-size:24px;margin-bottom:8px">📭</div>
          <div>수집된 데이터가 없습니다</div>
          <div style="font-size:12px;margin-top:4px">장 마감 후 자동 수집됩니다 (21:00 UTC)</div>
        </div>`;
      return;
    }

    // ── 섹터 이름 매핑
    const sectorNames = {
      broad_market:'🌐 시장 전체', technology:'💻 기술',
      energy:'⛽ 에너지',         financial:'🏦 금융',
      healthcare:'💊 헬스케어',   industrial:'🏗 산업재',
      utilities:'⚡ 유틸리티',    staples:'🛒 필수소비재',
      discretionary:'🛍 임의소비재',
    };

    let html = '';
    for (const [sector, items] of Object.entries(data.sectors)) {
      const sectorLabel = sectorNames[sector] || sector;
      const allRows     = [...(items.etf || []), ...(items.stocks || [])];
      if (!allRows.length) continue;

      html += `
        <div style="margin-bottom:24px">
          <div style="font-size:13px;font-weight:700;color:var(--text2);
               margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border)">
            ${sectorLabel}
          </div>
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              <thead>
                <tr style="color:var(--text3);border-bottom:1px solid var(--border)">
                  <th style="text-align:left;padding:4px 8px;width:70px">종목</th>
                  <th style="text-align:left;padding:4px 8px;width:50px">구분</th>
                  <th style="text-align:right;padding:4px 8px">만기</th>
                  <th style="text-align:right;padding:4px 8px">DTE</th>
                  <th style="text-align:right;padding:4px 8px">Call OI</th>
                  <th style="text-align:right;padding:4px 8px">Put OI</th>
                  <th style="text-align:right;padding:4px 8px">PCR</th>
                  <th style="text-align:right;padding:4px 8px">Z-Score</th>
                  <th style="text-align:center;padding:4px 8px;min-width:120px">IV Skew</th>
                  <th style="text-align:right;padding:4px 8px">신호</th>
                </tr>
              </thead>
              <tbody>`;

      for (const r of allRows) {
        const zscore = r.oi_zscore || 0;
        const skew   = r.iv_skew   || 0;
        const isEtf  = r.type === 'etf';

        let signal = '🟡', rowBg = 'transparent';
        if      (zscore > 2  && skew > 0) { signal = '🟢 Call 급증'; rowBg = 'rgba(63,185,80,0.05)';  }
        else if (zscore > 2)              { signal = '🟢 OI 급증';   rowBg = 'rgba(63,185,80,0.05)';  }
        else if (zscore < -2)             { signal = '🔴 Put 급증';  rowBg = 'rgba(248,81,73,0.05)';  }
        else if (skew > 0.05)             { signal = '📈 Call Skew'; }
        else if (skew < -0.05)            { signal = '📉 Put Skew';  }

        const zColor    = zscore > 2 ? 'var(--green)' : zscore < -2 ? 'var(--red)' : 'var(--text2)';
        const skewColor = skew > 0.02 ? 'var(--green)' : skew < -0.02 ? 'var(--red)' : 'var(--text2)';

        html += `
          <tr style="border-bottom:1px solid var(--border);background:${rowBg}">
            <td style="padding:5px 8px;font-weight:${isEtf ? '700' : '400'};color:var(--text1)">${r.symbol}</td>
            <td style="padding:5px 8px;color:var(--text3)">${isEtf ? 'ETF' : '주식'}</td>
            <td style="padding:5px 8px;text-align:right;color:var(--text2)">${r.expiry_date || '-'}</td>
            <td style="padding:5px 8px;text-align:right;color:var(--text3)">${r.dte || '-'}일</td>
            <td style="padding:5px 8px;text-align:right;color:var(--text2)">${fmt(r.call_oi)}</td>
            <td style="padding:5px 8px;text-align:right;color:var(--text2)">${fmt(r.put_oi)}</td>
            <td style="padding:5px 8px;text-align:right;color:var(--text2)">${r.pcr_oi?.toFixed(2) || '-'}</td>
            <td style="padding:5px 8px;text-align:right;color:${zColor};font-weight:600">
              ${zscore > 0 ? '+' : ''}${zscore.toFixed(1)}
            </td>
            <td style="padding:4px 8px;vertical-align:middle">${renderSkewBar(skew)}</td>
            <td style="padding:5px 8px;text-align:right">${signal}</td>
          </tr>`;
      }
      html += `</tbody></table></div></div>`;
    }

    if (resultEl) resultEl.innerHTML = html;
    screenerLoaded = true;

  } catch (err) {
    if (resultEl) resultEl.innerHTML = `
      <div style="text-align:center;padding:40px;color:var(--red)">
        <div style="font-size:20px;margin-bottom:8px">⚠️</div>
        <div>${err.message}</div>
      </div>`;
  }
}
