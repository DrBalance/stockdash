// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// date-view.js — 날짜 조회 탭: 만기 로드, 데이터 로드, 렌더, 차트
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function loadExpirations() {
  try {
    const sym = document.getElementById('sym-select').value;
    const r = await fetch(`${PROXY}/api/options?symbol=${sym}`);
    const json = await r.json();
    dateSpotPrice = json.data.current_price;
    dateAllOptions = json.data.options;
    const todayEST = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const exps = [...new Set(dateAllOptions.map(o=>{
      const m=o.option.trim().match(/(\d{6})[CP]/); if(!m) return null;
      return `20${m[1].slice(0,2)}-${m[1].slice(2,4)}-${m[1].slice(4,6)}`;
    }).filter(Boolean))].filter(e=>e>=todayEST).sort();
    const sel = document.getElementById('exp-select');
    sel.innerHTML = exps.map((e,i)=>`<option value="${e}"${i===0?' selected':''}>${i===0?e+' (0DTE)':e}</option>`).join('');
    document.getElementById('data-time').textContent = `로드: ${json.timestamp}`;
  } catch(e){ console.error(e); }
}

async function loadData() {
  const sym = document.getElementById('sym-select').value;
  const exp = document.getElementById('exp-select').value;
  if (!exp) return;
  const btn = document.getElementById('load-btn');
  btn.disabled=true; btn.textContent='⏳ 로딩 중...';
  setStatus('loading');
  document.getElementById('main-area').innerHTML=`<div class="card"><div class="empty-state"><div class="spinner"></div><div class="empty-sub">CBOE 데이터 수신 중...</div></div></div>`;

  try {
    if (!dateAllOptions.length) {
      const json = await fetch(`${PROXY}/api/options?symbol=${sym}`).then(r=>r.json());
      dateSpotPrice=json.data.current_price; dateAllOptions=json.data.options;
    }

    const expKey = exp.replace(/-/g,'').slice(2);

    const parsed = dateAllOptions.filter(o=>{
      const m=o.option.trim().match(/(\d{6})[CP]/); return m&&m[1]===expKey;
    }).map(o=>{
      const m=o.option.trim().match(/(\d{6})([CP])(\d+)/);
      return {strike:parseInt(m[3])/1000,type:m[2],iv:o.iv,gamma:o.gamma,delta:o.delta,oi:o.open_interest,volume:o.volume};
    });

    const map={};
    parsed.forEach(o=>{
      if(!map[o.strike])map[o.strike]={strike:o.strike,callOI:0,putOI:0,callGamma:0,putGamma:0,callVol:0,putVol:0,ivSum:0,ivN:0};
      const s=map[o.strike];
      if(o.type==='C'){s.callOI+=o.oi;s.callGamma=o.gamma;s.callVol+=o.volume;}
      else{s.putOI+=o.oi;s.putGamma=o.gamma;s.putVol+=o.volume;}
      if(o.iv>0){s.ivSum+=o.iv;s.ivN++;}
    });

    const strikes=Object.values(map).sort((a,b)=>a.strike-b.strike);

    // 만기일 16:00 ET 기준 T 계산 (index.js와 동일)
    function getExpiryCloseUTC(iso) {
      const [y, m, d] = iso.split('-').map(Number);
      const utcHour = (m >= 4 && m <= 10) ? 20 : 21;
      return new Date(Date.UTC(y, m - 1, d, utcHour, 0, 0));
    }
    const msToExp2 = getExpiryCloseUTC(exp) - new Date();
    const T2 = msToExp2 > 0
      ? msToExp2 / (1000*60*60*24*365)
      : 1 / 8760;
    const sqrtT2 = Math.sqrt(T2);
    const r2 = 0.045;

    strikes.forEach(s=>{
      s.iv=s.ivN>0?s.ivSum/s.ivN:0;
      const K2 = s.strike;
      const sigma2 = s.iv > 0 ? s.iv : 0.20;
      const d1_2 = (Math.log(dateSpotPrice/K2) + (r2 + sigma2*sigma2/2)*T2) / (sigma2*sqrtT2);
      const nd1_2 = Math.exp(-d1_2*d1_2/2) / Math.sqrt(2*Math.PI);
      const bsGamma = isFinite(nd1_2) ? nd1_2 / (dateSpotPrice * sigma2 * sqrtT2) : 0;
      s.gex = (s.callOI - s.putOI) * bsGamma * 100 * dateSpotPrice;
      s.callHedge = bsGamma * s.callOI * 100 * dateSpotPrice;
      s.putHedge  = bsGamma * s.putOI  * 100 * dateSpotPrice;
    });

    let cum=0,flipZone=null;
    strikes.forEach(s=>{const p=cum;cum+=s.gex;s.cumGex=cum;if(!flipZone&&((p<0&&cum>=0)||(p>0&&cum<=0)))flipZone=s.strike;});

    const near=strikes.filter(s=>Math.abs(s.strike-dateSpotPrice)/dateSpotPrice<0.10);
    const putWall=near.reduce((b,s)=>s.putOI>b.putOI?s:b,near[0])?.strike;
    const callWall=near.reduce((b,s)=>s.callOI>b.callOI?s:b,near[0])?.strike;
    const localGEX=strikes.filter(s=>Math.abs(s.strike-dateSpotPrice)/dateSpotPrice<0.02).reduce((a,s)=>a+s.gex,0);
    const totalCallOI=strikes.reduce((a,s)=>a+s.callOI,0);
    const totalPutOI=strikes.reduce((a,s)=>a+s.putOI,0);
    const pcr=totalPutOI/Math.max(totalCallOI,1);
    const totalGEX=cum;
    const upStrikes=strikes.filter(s=>s.strike>dateSpotPrice&&s.strike<=dateSpotPrice*1.05).sort((a,b)=>b.callHedge-a.callHedge).slice(0,4);
    const dnStrikes=strikes.filter(s=>s.strike<dateSpotPrice&&s.strike>=dateSpotPrice*0.95).sort((a,b)=>b.putHedge-a.putHedge).slice(0,4);

    // 날짜탭 전용 변수에만 저장 — 0DTE 변수(currentStrikes/currentD/priceHistory/liveEvents) 일절 건드리지 않음
    dateCurrentStrikes = strikes;
    dateCurrentD = { strikes, spotPrice: dateSpotPrice, flipZone, putWall, callWall, localGEX, totalGEX, pcr, exp, sym, upStrikes, dnStrikes };

    render(dateCurrentD);
    setStatus('live');
  } catch(e){
    console.error(e); setStatus('error');
    document.getElementById('main-area').innerHTML=`<div class="card"><div class="empty-state"><div class="empty-title">로드 실패</div><div class="empty-sub">${e.message}</div></div></div>`;
  } finally{btn.disabled=false;btn.textContent='⬇ 데이터 로드';}
}

function jlScroll(dir) {
  const el = document.getElementById('judgment-live-scroll');
  if (el) el.scrollBy({ top: dir * 72, behavior: 'smooth' });
}

function render(d){
  const{strikes,flipZone,putWall,callWall,localGEX,totalGEX,pcr,exp,sym,upStrikes,dnStrikes}=d;
  const sp = d.spotPrice; // 날짜탭 전용 spotPrice (전역 spotPrice 참조 안 함)
  const regime=totalGEX>=0?'positive':'negative';
  const vc = calculateVannaCharm(strikes, spotPrice, exp);

  const alarms=[];
  const flipDist=flipZone?Math.abs(sp-flipZone)/sp*100:null;
  const putDist=putWall?(sp-putWall)/sp*100:null;
  if(!flipZone) alarms.push({l:'red',m:`GEX 전 구간 ${regime==='negative'?'음수':'양수'} — Flip Zone 없음`});
  else if(flipDist<0.5) alarms.push({l:'red',m:`Flip Zone ($${flipZone}) 극근접 ${flipDist.toFixed(2)}% — 방향 전환 임박`});
  else if(flipDist<1.5) alarms.push({l:'yellow',m:`Flip Zone ($${flipZone}) 근접 ${flipDist.toFixed(2)}%`});
  if(putDist!==null&&putDist<1) alarms.push({l:'red',m:`Put Wall ($${putWall}) 직하방 — 이탈 시 낙폭 가속`});
  alarms.push(localGEX<0?{l:'red',m:`로컬 GEX ${(localGEX/1e6).toFixed(1)}M — 딜러 추세 증폭`}:{l:'green',m:`로컬 GEX +${(localGEX/1e6).toFixed(1)}M — 딜러 변동성 억제`});
  if(pcr>1.5) alarms.push({l:'red',m:`PCR ${pcr.toFixed(2)} — 풋 편중 심화`});
  else if(pcr<0.7) alarms.push({l:'yellow',m:`PCR ${pcr.toFixed(2)} — 콜 편중`});

  const maxUp=Math.max(...upStrikes.map(s=>s.callHedge),1);
  const maxDn=Math.max(...dnStrikes.map(s=>s.putHedge),1);
  const rankCls=i=>['r1','r2','r3','r4'][i]||'r4';
  const upRows=upStrikes.map((s,i)=>{
    const dist=((s.strike-sp)/sp*100).toFixed(2);
    const pct=Math.round(s.callHedge/maxUp*100);
    return `<div class="hedge-row"><span class="hedge-rank ${rankCls(i)}">${i+1}</span><span class="hedge-strike">$${s.strike}</span><span class="hedge-dist">+${dist}%</span><div class="hedge-bar-wrap"><div class="hedge-bar up" style="width:${pct}%"></div></div><span class="hedge-pressure">${(s.callHedge/1e6).toFixed(1)}M</span></div>`;
  }).join('');
  const dnRows=dnStrikes.map((s,i)=>{
    const dist=((sp-s.strike)/sp*100).toFixed(2);
    const pct=Math.round(s.putHedge/maxDn*100);
    return `<div class="hedge-row"><span class="hedge-rank ${rankCls(i)}">${i+1}</span><span class="hedge-strike">$${s.strike}</span><span class="hedge-dist">-${dist}%</span><div class="hedge-bar-wrap"><div class="hedge-bar dn" style="width:${pct}%"></div></div><span class="hedge-pressure">${(s.putHedge/1e6).toFixed(1)}M</span></div>`;
  }).join('');

  const chartData=strikes.filter(s=>Math.abs(s.strike-sp)/sp<0.08);
  const tableData=strikes.filter(s=>Math.abs(s.strike-sp)/sp<0.10);
  const vixDisplay = vixVal ? vixVal.toFixed(2) : '—';
  const vvixDisplay = vvixVal ? vvixVal.toFixed(2) : '—';
  const vixCls = vixVal ? (vixVal>30?'danger':vixVal>20?'warn':'') : '';
  const vvixCls = vvixVal ? (vvixVal>130?'danger':vvixVal>110?'warn':'') : '';

  const fixedItems = buildFixedJudgment(d, vc);

  document.getElementById('main-area').innerHTML=`
  <div class="card">
    <div class="card-title">${sym} · 만기 ${exp} · 종가 기준 $${sp.toFixed(2)}</div>
    <div class="regime-bar ${regime}">${regime==='positive'?'✚ Positive GEX — 딜러 변동성 억제 (피닝)':'▼ Negative GEX — 딜러 추세 증폭'}</div>
    <div id="alarm-list"></div>
    <div class="metrics">
      <div class="metric blue" id="metric-spot"><div class="val">$${sp.toFixed(1)}</div><div class="lbl">현재가</div></div>
      <div class="metric ${flipZone?'orange':''}"><div class="val">${flipZone?'$'+flipZone:'없음'}</div><div class="lbl">Flip Zone</div></div>
      <div class="metric ${pcr>1.5?'red':pcr<0.7?'yellow':''}"><div class="val">${pcr.toFixed(2)}</div><div class="lbl">Put/Call</div></div>
      <div class="metric red"><div class="val">${putWall?'$'+putWall:'—'}</div><div class="lbl">Put Wall</div></div>
      <div class="metric green"><div class="val">${callWall?'$'+callWall:'—'}</div><div class="lbl">Call Wall</div></div>
      <div class="metric ${localGEX<0?'red':'green'}"><div class="val">${(localGEX/1e6).toFixed(1)}M</div><div class="lbl">Local GEX</div></div>
      <div class="metric ${vixVal&&vixVal>30?'danger':vixVal&&vixVal>20?'warn':'yellow'}" id="metric-vix"><div class="val">${vixDisplay}</div><div class="lbl">VIX</div></div>
      <div class="metric ${vvixVal&&vvixVal>130?'danger':vvixVal&&vvixVal>110?'warn':'yellow'}" id="metric-vvix"><div class="val">${vvixDisplay}</div><div class="lbl">VVIX</div></div>
      <div class="metric" id="metric-vanna" style="border-color:rgba(188,140,255,.33)"><div class="val" style="color:var(--purple)">${vc.totalVanna.toFixed(1)}M</div><div class="lbl" style="color:var(--purple)">● Vanna Exp</div></div>
      <div class="metric" id="metric-charm" style="border-color:rgba(88,166,255,.33)"><div class="val" style="color:var(--blue)">${vc.totalCharm.toFixed(1)}M</div><div class="lbl" style="color:var(--blue)">● Charm · VC ${Math.abs(vc.totalVanna)>0?(Math.abs(vc.totalCharm)/Math.abs(vc.totalVanna)).toFixed(2):'—'}</div></div>
    </div>

    <div class="hedge-section">
      <div class="hedge-title">딜러 헷지 부담 집중 스트라이크 (γ × OI 기준)</div>
      <div class="hedge-grid">
        <div><div class="hedge-col-label" style="color:var(--green)">▲ 상승 — 콜 헷지 Top4</div>${upRows||'<div style="color:var(--text3);font-size:13px;padding:8px">데이터 없음</div>'}</div>
        <div><div class="hedge-col-label" style="color:var(--red)">▼ 하락 — 풋 헷지 Top4</div>${dnRows||'<div style="color:var(--text3);font-size:13px;padding:8px">데이터 없음</div>'}</div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">OI 분포 + GEX</div>
    <div class="chart-controls">
      <span class="zoom-label">확대</span>
      <input type="range" class="zoom-slider" id="zoom-slider" min="1" max="6" step="0.5" value="1" oninput="updateZoom(this.value)">
      <span class="zoom-val" id="zoom-val">1×</span>
      <span class="scroll-hint">← 가로 스크롤 →</span>
    </div>
    <div class="chart-scroll-wrap" id="chart-scroll-wrap-date">
      <div class="chart-inner" id="chart-inner-date"><canvas id="mainchart-date"></canvas></div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">스트라이크별 상세 — 현재가 ±10%</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Strike</th><th>Call OI</th><th>Put OI</th><th>GEX(M)</th><th>Call Vol</th><th>Put Vol</th><th>IV</th></tr></thead>
      <tbody id="tbl-body-date"></tbody>
    </table></div>
  </div>`;

  // 알람
  const al=document.getElementById('alarm-list');
  (alarms.length?alarms:[{l:'green',m:'특이 리스크 없음'}]).forEach(a=>{
    const div=document.createElement('div'); div.className=`alarm ${a.l}`; div.textContent=a.m; al.appendChild(div);
  });

  // 차트
  requestAnimationFrame(() => {
    buildChart(chartData, sp, flipZone, putWall, callWall, '-date');
  });

  // 테이블
  const tbody=document.getElementById('tbl-body-date');
  tableData.forEach(s=>{
    const isCur=Math.abs(s.strike-sp)<0.5;
    const isFlip=s.strike===flipZone,isPW=s.strike===putWall,isCW=s.strike===callWall;
    const tr=document.createElement('tr');
    if(isCur)tr.className='cur'; else if(isFlip)tr.className='flip';
    let tags='';
    if(isCur)tags+=`<span class="tag tag-cur">현재가</span>`;
    if(isFlip)tags+=`<span class="tag tag-flip">Flip</span>`;
    if(isPW)tags+=`<span class="tag tag-pw">Put Wall</span>`;
    if(isCW)tags+=`<span class="tag tag-cw">Call Wall</span>`;
    const gc=s.gex>=0?'#3fb950':'#f85149';
    tr.innerHTML=`<td>$${s.strike}${tags}</td><td>${s.callOI.toLocaleString()}</td><td>${s.putOI.toLocaleString()}</td><td style="color:${gc};font-weight:600">${s.gex>=0?'+':''}${(s.gex/1e6).toFixed(2)}</td><td>${s.callVol.toLocaleString()}</td><td>${s.putVol.toLocaleString()}</td><td>${s.iv>0?(s.iv*100).toFixed(1)+'%':'—'}</td>`;
    tbody.appendChild(tr);
  });
}

function buildChart(chartData, sp, flipZone, putWall, callWall, sfx) {
  const _isDate = (sfx === '-date');
  // 탭별 인스턴스 독립 관리 — 한 탭의 destroy가 다른 탭에 영향 없음
  if (_isDate) { if (chartInstDate){chartInstDate.destroy();chartInstDate=null;} }
  else          { if (chartInst){chartInst.destroy();chartInst=null;} }

  const wrap=document.getElementById('chart-scroll-wrap'+(sfx||''));
  const inner=document.getElementById('chart-inner'+(sfx||''));
  if (!wrap || !inner) { console.warn('[buildChart] wrap/inner 없음', sfx); return; }
  const baseW=wrap.clientWidth||window.innerWidth-56;
  inner.style.width=Math.max(baseW, baseW*zoomLevel)+'px';

  const canvas = document.getElementById('mainchart'+(sfx||''));
  if (!canvas) { console.warn('[buildChart] canvas 없음: mainchart'+(sfx||'')); return; }
  const _chartInst=new Chart(canvas,{
    data:{
      labels:chartData.map(s=>s.strike%5===0?'$'+s.strike:''),
      datasets:[
        {type:'bar',label:'Call OI',data:chartData.map(s=>s.callOI),backgroundColor:'rgba(88,166,255,.4)',yAxisID:'y'},
        {type:'bar',label:'Put OI',data:chartData.map(s=>-s.putOI),backgroundColor:'rgba(248,81,73,.4)',yAxisID:'y'},
        {type:'line',label:'GEX(M)',data:chartData.map(s=>+(s.gex/1e6).toFixed(3)),
         borderColor:'#f0883e',backgroundColor:'transparent',
         pointRadius:3,pointBackgroundColor:'#f0883e',
         pointHoverBackgroundColor:'#f85149',pointHoverRadius:7,pointHoverBorderColor:'#fff',pointHoverBorderWidth:1.5,
         borderWidth:2.5,tension:.3,yAxisID:'y2'},
      ]
    },
    options:{
      responsive:true,maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      onHover:(e,els)=>{ const _ci=_isDate?chartInstDate:chartInst; if(_ci) _ci._hoveredIdx = els.length ? els[0].index : null; },
      plugins:{
        legend:{display:true,position:'top',align:'start',labels:{color:'#8b949e',font:{size:12},boxWidth:12,padding:16}},
        tooltip:{
          backgroundColor:'#161b22',borderColor:'#30363d',borderWidth:1,
          titleColor:'#e6edf3',bodyColor:'#8b949e',padding:12,
          callbacks:{
            title:items=>'$'+chartData[items[0].dataIndex]?.strike,
            afterBody:items=>{
              const s=chartData[items[0].dataIndex]; if(!s) return [];
              const lines=[];
              if(s.iv>0) lines.push(`IV: ${(s.iv*100).toFixed(1)}%`);
              if(s.strike===flipZone) lines.push('⚡ Flip Zone');
              if(s.strike===putWall) lines.push('🔴 Put Wall');
              if(s.strike===callWall) lines.push('🟢 Call Wall');
              return lines;
            }
          }
        },
      },
      scales:{
        x:{ticks:{color:'#6e7681',font:{size:11},autoSkip:false,maxRotation:45},grid:{color:'rgba(48,54,61,.7)'}},
        y:{
          position:'left',
          ticks:{
            color:'#6e7681',font:{size:11},
            callback: v => {
              const abs = Math.abs(v);
              const sign = v < 0 ? '-' : '';
              if (abs >= 1000000) return sign + Math.round(abs/1000000) + 'M';
              if (abs >= 1000) return sign + Math.round(abs/1000) + 'K';
              return v;
            }
          },
          grid:{color:'rgba(48,54,61,.7)'},
          afterDataLimits(scale) {
            const range = scale.max - scale.min;
            const pad = range === 0 ? (Math.abs(scale.max)*0.2||100) : range * 0.12;
            scale.min -= pad;
            scale.max += pad;
          }
        },
        y2:{
          position:'right',
          ticks:{
            color:'#f0883e',font:{size:11},
            callback: v => {
              const abs = Math.abs(v);
              const sign = v < 0 ? '-' : '';
              if (abs >= 1000) return sign + Math.round(abs/1000) + 'K';
              return v + 'M';
            }
          },
          grid:{
            drawOnChartArea:true,
            color: ctx => ctx.tick.value === 0 ? 'rgba(255,255,255,0.25)' : 'transparent',
            lineWidth: ctx => ctx.tick.value === 0 ? 1 : 0,
          },
          afterDataLimits(scale) {
            const range = scale.max - scale.min;
            const pad = range === 0 ? 1 : range * 0.12;
            scale.min -= pad;
            scale.max += pad;
          }
        },
      }
    },
    plugins:[{
      // ── 현재가 세로 점선 (onWSPrices에서 chart._spotPrice 업데이트 시 실시간 반영)
      id: 'spotLine',
      afterDraw(chart) {
        const sp2 = chart._spotPrice ?? sp;
        const spotIdx = chartData.findIndex(s => Math.abs(s.strike - sp2) < 0.5);
        if (spotIdx < 0) return;
        const { ctx, chartArea } = chart;
        const x = chart.scales.x.getPixelForValue(spotIdx);
        ctx.save();
        ctx.strokeStyle = '#58a6ff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        // 상단 라벨
        ctx.setLineDash([]);
        ctx.fillStyle = '#58a6ff';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('$' + sp2.toFixed(0), x, chartArea.top - 2);
        ctx.restore();
      }
    },{
      // ── 호버 시 GEX 라인 붉은 점 ──
      id: 'hoverDot',
      afterDraw(chart) {
        const idx = chart._hoveredIdx;
        if (idx == null) return;
        const ds = chart.data.datasets[2]; // GEX 라인
        const meta = chart.getDatasetMeta(2);
        if (!meta?.data[idx]) return;
        const pt = meta.data[idx];
        const ctx = chart.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 6, 0, Math.PI*2);
        ctx.fillStyle = '#f85149';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    },{
      // ── OI GEX 차트 y축 스크롤 고정 플러그인 ──
      id: 'mainStickyY',
      afterDraw(chart) {
        const wrap = document.getElementById('chart-scroll-wrap');
        if (!wrap) return;
        const yScale = chart.scales['y'];
        const y2Scale = chart.scales['y2'];
        if (!yScale) return;
        const scrollX = wrap.scrollLeft;
        const wrapW = wrap.clientWidth;
        const { ctx, chartArea, height, width } = chart;

        ctx.save();

        // ── 왼쪽 y축 고정 (스크롤 시만) ──
        if (scrollX > 0) {
          const axisW = yScale.right;
          ctx.fillStyle = '#161b22';
          ctx.fillRect(scrollX, 0, axisW, height);
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#6e7681';
          ctx.font = '11px monospace';
          yScale.ticks.forEach((tick, i) => {
            const y = yScale.getPixelForTick(i);
            const abs = Math.abs(tick.value);
            const sign = tick.value < 0 ? '-' : '';
            let label = abs >= 1000000 ? sign+Math.round(abs/1e6)+'M'
                      : abs >= 1000    ? sign+Math.round(abs/1000)+'K'
                      : String(tick.value);
            ctx.fillText(label, scrollX + axisW - 4, y);
          });
          ctx.strokeStyle = '#30363d';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(scrollX + axisW, chartArea.top);
          ctx.lineTo(scrollX + axisW, chartArea.bottom);
          ctx.stroke();
        }

        // ── 오른쪽 y2축 고정 (확대/스크롤 모두 항상 표시) ──
        if (y2Scale && (scrollX > 0 || wrapW < width)) {
          const rAxisStart = y2Scale.left;
          const rAxisW = width - rAxisStart;
          const fixedRX = scrollX + wrapW - rAxisW;
          ctx.fillStyle = '#161b22';
          ctx.fillRect(fixedRX, 0, rAxisW, height);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#f0883e';
          ctx.font = '11px monospace';
          y2Scale.ticks.forEach((tick, i) => {
            const y = y2Scale.getPixelForTick(i);
            const abs = Math.abs(tick.value);
            const sign = tick.value < 0 ? '-' : '';
            const label = abs >= 1000 ? sign+Math.round(abs/1000)+'K' : tick.value+'M';
            ctx.fillText(label, fixedRX + 4, y);
          });
          ctx.strokeStyle = '#30363d';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(fixedRX, chartArea.top);
          ctx.lineTo(fixedRX, chartArea.bottom);
          ctx.stroke();
        }

        ctx.restore();
      }
    }]
  });

  // 스크롤 시 y축 재드로우
  const mainWrap = document.getElementById('chart-scroll-wrap'+(sfx||''));
  if (mainWrap) {
    mainWrap._scrollHandler && mainWrap.removeEventListener('scroll', mainWrap._scrollHandler);
    mainWrap._scrollHandler = () => {
      if (_isDate) { if(chartInstDate) chartInstDate.draw(); }
      else          { if(chartInst) chartInst.draw(); }
    };
    mainWrap.addEventListener('scroll', mainWrap._scrollHandler, { passive: true });
  }
  // 인스턴스 저장
  if (_isDate) chartInstDate = _chartInst;
  else chartInst = _chartInst;
}

// chart instance 저장 헬퍼
function _saveChartInst(inst, isDate) {
  if (isDate) chartInstDate = inst;
  else chartInst = inst;
}

function updateZoom(val){
  zoomLevel=parseFloat(val);
  const isDateTab = document.getElementById('area-date')?.style.display !== 'none';
  const zsfx = isDateTab ? '-date' : '';
  const zv = document.getElementById('zoom-val' + zsfx);
  if(zv) zv.textContent = val+'×';
  if(!currentD) return;
  const chartData=currentStrikes.filter(s=>Math.abs(s.strike-currentD.spotPrice)/currentD.spotPrice<0.08);
  buildChart(chartData,currentD.spotPrice,currentD.flipZone,currentD.putWall,currentD.callWall, zsfx);
}
