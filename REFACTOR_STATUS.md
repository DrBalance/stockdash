# GEX Dashboard — 파일 분리 리팩토링 현황

> 마지막 작업일: 2026-04-19  
> 원본 파일: `index.js` (857줄) + `index.html` (3,926줄)  
> 목표: 역할별 단일 책임 파일로 분리, 순환 참조 없는 단방향 의존 구조 확립

---

## ✅ 완성된 파일 목록

### 서버 사이드 (Node.js / Express)

| 파일 | 역할 | 라인 | 원본 위치 |
|---|---|---|---|
| `state.js` | 인메모리 상태 저장소 + 공유 상수 (`WATCH_SYMBOLS`, `state` 객체) | 22 | index.js 28~43 |
| `utils.js` | 시간 유틸(`nowEST`, `todayEST`, `estHour`), 장 상태(`getMarketState`), 휴장일 Set, `normPDF`, `getETOffsetMs` | 63 | index.js 132~196 |
| `broadcast.js` | WebSocket `broadcast()` 함수. `initBroadcast(wss)`로 주입받아 순환 참조 차단. `getWss()` getter 제공 | 28 | index.js 57~64 |
| `market.js` | Finnhub WS 현재가(`connectFinnhub`), Yahoo fetch(`fetchYahooQuote`), `fetchClosedMarketData`, `updatePrevClose`, `cronMarket`, `fetchHolidays`, `fetchSymbols` | 289 | index.js 200~372, 651~673 |
| `greeks.js` | `fetchCBOEChain`, `computeGreeks`(Black-Scholes GEX/Vanna/Charm), `cronGreeks`(OI 증감 누적 포함) | 196 | index.js 373~553 |
| `cron.js` | 모든 `node-cron` 스케줄 등록 (사이드이펙트 모듈, `import './cron.js'`로 로드) | 37 | index.js 558~581 |
| `chart-api.js` | `calcBollinger`, `fetchChartData`(Twelve Data + LRU 캐시), `VALID_RESOLUTIONS` 상수 | 134 | index.js 675~809 |
| `routes.js` | 모든 `app.get('/api/...')` 라우트 등록 함수 `registerRoutes(app)` | 120 | index.js 586~650, 814~840 |
| `server.js` | **진입점.** Express + HTTP + WebSocketServer 생성, `initBroadcast` 주입, 서버 `listen`, 초기화 시퀀스 | 79 | index.js 48~131, 845~856 |

### 프론트엔드 (브라우저 `<script>`)

| 파일 | 역할 | 라인 | 원본 위치 |
|---|---|---|---|
| `screener.js` | `loadBollinger`(섹터 히트맵+신호카드), `filterBollBySecotor`, `loadScreener`(옵션 스크리너 테이블), `renderSkewBar`, `fmt` | 285 | index.html 658~950 |
| `lw-chart.js` | LW차트 렌더(`renderLWChart`), 탭 관리(`chartAddTab` 등), 팔레트/프리셋(`DEFAULT_PRESETS`, `applyPreset` 등), 심볼 자동완성(`onChartSymInput` 등), 확대/축소 버튼 | 615 | index.html 3,308~3,924 |

### 이전 세션에서 완성된 프론트엔드 파일

| 파일 | 역할 | 라인 |
|---|---|---|
| `index.html` | HTML 구조 + CSS (인라인 스타일 포함) | 295 |
| `styles.css` | 전체 CSS 분리본 | 275 |
| `tab-ui.js` | 탭 전환 UI (`switchTab`, 탭 상태 관리) | 257 |
| `ws-live.js` | WebSocket 클라이언트, 실시간 가격/시장 수신 | 368 |
| `gex-0dte.js` | 0DTE GEX 탭 — `load0DTE`, `updateSpotMetric`, 판단 패널 | 472 |
| `vc-chart.js` | Vanna/Charm/VIX Velocity 차트 렌더링 | 885 |
| `date-view.js` | 날짜별 만기 탭 — `loadExpirations`, `loadData`, `render`, `buildChart` | 498 |

---

## 의존 관계 (서버 사이드)

```
server.js
 ├── state.js          (leaf)
 ├── utils.js          (leaf)
 ├── broadcast.js      (leaf — ws만 의존)
 ├── market.js         → state, utils, broadcast
 ├── greeks.js         → state, utils, broadcast
 ├── cron.js           → market, greeks
 ├── chart-api.js      → utils
 └── routes.js         → state, utils, market, greeks, chart-api, broadcast
```

> **순환 참조 없음.** `broadcast.js`가 `wss`를 주입(Dependency Injection) 방식으로 관리하여  
> `server ↔ market`, `server ↔ greeks`, `server ↔ routes` 순환을 모두 차단.

---

## 기존 index.js 처리 방법

`index.js`는 `server.js`로 완전 교체되었으므로 **삭제**.

```bash
rm index.js
```

`package.json` 진입점 변경:

```json
{
  "scripts": {
    "start": "node server.js"
  }
}
```

Railway 배포 시 Start Command도 변경:

```toml
# railway.toml
[deploy]
startCommand = "node server.js"
```

---

## index.html에서 script 태그 로드 순서

분리된 JS 파일들은 아래 순서로 `<script src="...">` 로드해야 합니다.  
(전역 변수 의존 순서 준수)

```html
<!-- 외부 라이브러리 -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>

<!-- 대시보드 모듈 (순서 중요) -->
<script src="tab-ui.js"></script>
<script src="ws-live.js"></script>
<script src="gex-0dte.js"></script>
<script src="vc-chart.js"></script>
<script src="date-view.js"></script>
<script src="screener.js"></script>
<script src="lw-chart.js"></script>
```

---

## 남은 작업 / 주의 사항

### ✅ 완료
- 서버 사이드 전체 분리 (`index.js` → 9개 파일)
- 프론트엔드 전체 분리 (`index.html` 인라인 스크립트 → 7개 파일)
- 순환 참조 완전 해소

### ⚠️ 다음 세션에서 확인할 것

1. **`API_BASE` / `PROXY` 전역 변수** — `ws-live.js` 또는 `tab-ui.js` 상단에 선언되어 있는지 확인.  
   `screener.js`와 `lw-chart.js`가 `API_BASE`를 직접 참조하므로, 선언이 이들보다 먼저 로드되어야 함.

2. **`screenerLoaded` 전역 변수** — `screener.js`의 `loadScreener()` 내부에서 `screenerLoaded = true`를 씀.  
   이 변수가 `tab-ui.js`에서 선언/관리되는지 확인 필요.

3. **`getMarketStateClient()` 함수** — `lw-chart.js`에서 호출됨.  
   `ws-live.js` 또는 `tab-ui.js`에 정의되어 있는지 확인 필요.

4. **`window._marketState`** — `ws-live.js`에서 WS 수신 시 세팅하는지 확인.

5. **통합 테스트** — 서버 시작 후 `/api/status`, `/api/gex0dte?symbol=SPY`, `/api/chart?symbol=SPY&resolution=D` 엔드포인트 순서대로 확인.

---

## 파일별 export/import 핵심 요약

```js
// state.js
export const state, WATCH_SYMBOLS

// utils.js
export { holidaySet, setHolidaySet, nowEST, todayEST, estHour,
         isExtendedHours, getNextTradingDay, getMarketState,
         normPDF, getETOffsetMs }

// broadcast.js
export { initBroadcast, broadcast, getWss }

// market.js
export { connectFinnhub, getFinnhubWsState, fetchYahooQuote,
         fetchClosedMarketData, updatePrevClose, cronMarket,
         fetchHolidays, fetchSymbols }

// greeks.js
export { fetchCBOEChain, computeGreeks, cronGreeks }

// chart-api.js
export { calcBollinger, fetchChartData, VALID_RESOLUTIONS }

// routes.js
export { registerRoutes }

// cron.js  → (사이드이펙트만, export 없음)
// server.js → (진입점, export 없음)
```
