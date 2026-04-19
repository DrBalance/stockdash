# GEX Dashboard — 코드 구조 문서

> 최종 업데이트: 2026-04-20
> 원본: `index.js` (857줄) + `index.html` (3,311줄)
> 현재: 서버 9개 파일 + 프론트엔드 9개 파일 + CSS 1개 = 총 19개 파일

---

## 전체 파일 목록

### 서버 사이드 (Node.js / Express)

| 파일 | 역할 | 라인 |
|------|------|------|
| `server.js` | **진입점.** Express + HTTP + WebSocketServer 생성, `initBroadcast` 주입, 서버 `listen`, 초기화 시퀀스 | 79 |
| `state.js` | 인메모리 상태 저장소 + 공유 상수 (`WATCH_SYMBOLS`, `state` 객체) | 22 |
| `utils.js` | 시간 유틸(`nowEST`, `todayEST`, `estHour`), 장 상태(`getMarketState`), 휴장일 Set, `normPDF`, `getETOffsetMs` | 63 |
| `broadcast.js` | WebSocket `broadcast()`. `initBroadcast(wss)`로 주입받아 순환 참조 차단. `getWss()` getter 제공 | 28 |
| `market.js` | Finnhub WS 현재가(`connectFinnhub`), Yahoo fetch(`fetchYahooQuote`), `fetchClosedMarketData`, `updatePrevClose`, `cronMarket`, `fetchHolidays`, `fetchSymbols` | 289 |
| `greeks.js` | `fetchCBOEChain`, `computeGreeks`(Black-Scholes GEX/Vanna/Charm), `cronGreeks`(OI 증감 누적 포함) | 196 |
| `chart-api.js` | `calcBollinger`, `fetchChartData`(Twelve Data + LRU 캐시), `VALID_RESOLUTIONS` 상수 | 134 |
| `routes.js` | 모든 `app.get('/api/...')` 라우트 등록 함수 `registerRoutes(app)` | 120 |
| `cron.js` | 모든 `node-cron` 스케줄 등록 (사이드이펙트 모듈, `import './cron.js'`로 로드) | 37 |

### 프론트엔드 (브라우저)

| 파일 | 역할 | 라인 |
|------|------|------|
| `index.html` | HTML 구조만. `<head>` + 탭/컨트롤바/콘텐츠 영역 HTML + 전역 변수 `<script>` 블록 + 모듈 로드 순서 | 315 |
| `styles.css` | 전체 CSS. `:root` 변수, 레이아웃, 컴포넌트 스타일, 애니메이션 | 274 |
| `tab-ui.js` | `switchTab()` — 탭 전환 UI 로직. `setStatus()` — 헤더 상태 도트 업데이트 | 71 |
| `ws-live.js` | 시간 유틸(`toKST`, `isEDT`), 장 상태 클라이언트(`getMarketStateClient`, `updateMarketStateBadge`, `startClock`), CLOSED 전용 로드(`loadClosed`), DOMContentLoaded 초기화, WebSocket 연결/핸들러(`connectWS`, `onWSInit`, `onWSPrices`, `onWSMarket`, `onWSGreeks`), RSI/피벗 계산, VIX 다이버전스 감지 | 532 |
| `gex-0dte.js` | 0DTE 탭 전체. `load0DTE`, `toggle0DTEAuto`, `render0DTE`(HTML 생성), `renderOITop5`, `jlScroll0`, 통합판단 패널(`buildFixedJudgment`, `buildLiveJudgment`, `renderJudgmentPanel`), `updateSpotMetric` | 658 |
| `vc-chart.js` | Vanna/Charm/GEX 실시간 흐름 차트. `calculateVannaCharm`, `calcForceBalance`, `getBarColor`, `renderGreekMetrics`, `renderForceSidebar`, `estToKST`, VC 차트 렌더(`setVCRange`, `onVCSlider`, `updateVCZoom`, `syncVCPanes`, `destroyVCPanes`, `renderVCChart`, `updateVCSignalBar`) | 686 |
| `date-view.js` | 날짜 조회 탭. `loadExpirations`, `loadData`(CBOE 옵션 파싱 + Black-Scholes GEX 계산), `jlScroll`, `render`(HTML 생성), `buildChart`(Chart.js GEX 바차트, 0DTE·날짜탭 공유), `_saveChartInst`, `updateZoom` | 477 |
| `screener.js` | 볼린저밴드 신호 패널(`loadBollinger`, `filterBollBySecotor`), 옵션 스크리너 테이블(`loadScreener`), `renderSkewBar`, `fmt` | 285 |
| `lw-chart.js` | LightweightCharts 기반 캔들/볼린저 차트. `renderLWChart`, 탭 관리(`chartAddTab`, `chartActiveTab` 등), 팔레트/프리셋(`DEFAULT_PRESETS`, `applyPreset` 등), 심볼 자동완성(`onChartSymInput` 등), 확대/축소(`chartZoom`, `chartFit`, `chartFitPrice`) | 653 |

---

## 의존 관계

### 서버 사이드

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

> 순환 참조 없음. `broadcast.js`가 `wss`를 Dependency Injection 방식으로 관리.

### 프론트엔드 로드 순서 (index.html)

```
<script> 글로벌 변수 블록 (PROXY, API_BASE, WS_URL, 공유 let 변수들)
  ↓
tab-ui.js       (switchTab, setStatus — 가장 먼저, 다른 모듈에서 호출)
  ↓
ws-live.js      (장 상태, WebSocket, VIX — 초기화 담당, DOMContentLoaded 포함)
  ↓
gex-0dte.js     (0DTE 탭 — ws-live의 onWSPrices/onWSGreeks에서 호출)
  ↓
vc-chart.js     (Greek 차트 — gex-0dte와 ws-live에서 renderVCChart 호출)
  ↓
date-view.js    (날짜탭 + buildChart 공유함수 — switchTab에서 호출)
  ↓
screener.js     (스크리너 탭 — switchTab에서 호출)
  ↓
lw-chart.js     (LW 차트 탭 — switchTab에서 호출, chartTabVisible 등 자체 상태)
```

### 주요 전역 변수 (index.html 글로벌 블록)

| 변수 | 타입 | 용도 |
|------|------|------|
| `PROXY`, `API_BASE` | const string | 서버 API 베이스 URL |
| `WS_URL` | const string | WebSocket 서버 URL |
| `spotPrice` | number | 현재 현물가 (ws-live → gex-0dte, vc-chart 공유) |
| `vixVal`, `vvixVal` | number | VIX/VVIX 현재값 (ws-live → gex-0dte 공유) |
| `currentStrikes`, `currentD` | array/object | 0DTE 탭 현재 옵션 데이터 |
| `dateCurrentStrikes`, `dateCurrentD` | array/object | 날짜 탭 현재 옵션 데이터 |
| `liveEvents` | array | 판단 패널 실시간 이벤트 목록 |
| `priceHistory` | array | VIX·현물가 시계열 (VIX 다이버전스 계산용) |
| `vcHistory` | array | Vanna/Charm/GEX 시계열 (vc-chart 렌더용) |
| `vcActiveTab` | string | VC 차트 현재 활성 탭 |
| `auto0DTEInterval` | timer | 0DTE 자동갱신 타이머 |
| `current0DTESym` | string | 현재 선택 심볼 |
| `screenerLoaded` | boolean | 스크리너 최초 로드 완료 플래그 |

---

## 크로스 파일 함수 호출 관계

| 호출처 | 호출 대상 | 위치 |
|--------|-----------|------|
| `ws-live.js` (`onWSPrices`) | `updateSpotMetric` | gex-0dte.js |
| `ws-live.js` (`onWSPrices`) | `render0DTE` | gex-0dte.js |
| `ws-live.js` (`onWSPrices`) | `renderVCChart` | vc-chart.js |
| `ws-live.js` (`onWSGreeks`) | `renderVCChart` | vc-chart.js |
| `ws-live.js` (`startClock`) | `load0DTE` | gex-0dte.js |
| `ws-live.js` (`startClock`) | `connectWS` | ws-live.js (자기 참조) |
| `tab-ui.js` (`switchTab`) | `loadExpirations` | date-view.js |
| `tab-ui.js` (`switchTab`) | `buildChart` | date-view.js |
| `tab-ui.js` (`switchTab`) | `renderVCChart` | vc-chart.js |
| `tab-ui.js` (`switchTab`) | `loadBollinger`, `loadScreener` | screener.js |
| `tab-ui.js` (`switchTab`) | `initChartSymbols`, `renderLWChart` | lw-chart.js |
| `gex-0dte.js` (`render0DTE`) | `buildChart` | date-view.js |
| `gex-0dte.js` (`render0DTE`) | `calculateVannaCharm` | vc-chart.js |
| `date-view.js` (`render`) | `calculateVannaCharm` | vc-chart.js |
| `date-view.js` (`loadData`) | `setStatus` | tab-ui.js |
| `gex-0dte.js` (`load0DTE`) | `setStatus` | tab-ui.js |

---

## API 엔드포인트 목록

| 엔드포인트 | 담당 파일 | 설명 |
|-----------|-----------|------|
| `GET /api/status` | routes.js | 서버 상태, GEX 계산 시각 |
| `GET /api/gex0dte` | routes.js | 0DTE GEX/Vanna/Charm 계산 결과 |
| `GET /api/greeks` | routes.js | 전체 심볼 Greek 데이터 |
| `GET /api/market` | routes.js | VIX/VVIX/VOLD/VIX Velocity |
| `GET /api/quotes` | routes.js | 현재가(Finnhub 캐시) |
| `GET /api/options` | routes.js | CBOE 옵션 체인 (raw) |
| `GET /api/bollinger` | routes.js | 볼린저밴드 신호 (섹터별) |
| `GET /api/screener` | routes.js | 옵션 스크리너 (기관 플로우) |
| `GET /api/chart` | routes.js | 캔들 차트 데이터 (Twelve Data) |
| `WS wss://` | server.js | 실시간 가격·시장·Greeks 푸시 |

---

## 진입점 및 실행

### 서버 시작

```bash
node server.js
```

`package.json`:
```json
{ "scripts": { "start": "node server.js" } }
```

Railway `railway.toml`:
```toml
[deploy]
startCommand = "node server.js"
```

### 프론트엔드

`index.html`을 브라우저에서 열면 자동 초기화:
1. 전역 변수 블록 로드
2. 모듈 스크립트 순서대로 로드
3. `ws-live.js`의 `DOMContentLoaded` 핸들러 실행
   - 장 중: `load0DTE()` + 자동갱신 타이머 + `connectWS()`
   - 장 마감: `loadClosed()` (1회성 조회)

---

## 리팩토링 이력

| 단계 | 내용 | 결과 |
|------|------|------|
| 1차 | `index.js` (857줄) → 서버 사이드 9개 파일로 분리 | 순환 참조 해소 |
| 2차 | `index.html` 인라인 JS 일부 분리 (`screener.js`, `lw-chart.js`) | 미완성 상태 |
| 3차 | `index.html` (3,311줄) → `styles.css` + 7개 JS 파일로 완전 분리 | **index.html 315줄으로 축소** |
