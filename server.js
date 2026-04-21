// StockDash Server — Railway (Node.js) v2.0
// 데이터 소스:
//   현재가(SPY/QQQ 등) → Finnhub WebSocket (실시간) → 클라이언트 WS 푸시
//   VIX/VVIX/VOLD     → Yahoo Finance 1분 Cron → 클라이언트 WS 푸시
//   옵션체인/Greeks    → CBOE 15분 Cron → REST API 제공
//   차트 캔들          → Twelve Data REST API + LRU 캐시

import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

import { state } from './state.js';
import { fetchClosedMarketData, connectFinnhub, fetchHolidays, fetchSymbols, cronMarket, updatePrevClose } from './market.js';
import { cronGreeks } from './greeks.js';
import { registerRoutes } from './routes.js';
import { initBroadcast } from './broadcast.js';
import './cron.js'; // Cron 스케줄 등록 (사이드이펙트)

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Express + HTTP + WebSocket 서버
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(cors());
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.json());

// broadcast.js에 wss 인스턴스 주입 (순환 참조 방지)
initBroadcast(wss);

wss.on('connection', async (ws) => {
  console.log('[WS] 클라이언트 연결 — 총 ' + wss.clients.size + '개');
  try {
    await fetchClosedMarketData();
    ws.send(JSON.stringify({
      type: 'init',
      data: { prices: state.prices, market: state.market },
      ts: new Date().toISOString(),
    }));
  } catch (_) {}
  ws.on('close', () => console.log('[WS] 해제 — 총 ' + wss.clients.size + '개'));
  ws.on('error', (e) => console.warn('[WS] 오류:', e.message));
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REST 라우트 등록
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
registerRoutes(app);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 서버 시작
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.listen(PORT, () => {
  console.log('[Server] StockDash v2.0 — port ' + PORT);
  fetchHolidays().then(() => {
    connectFinnhub();
    fetchSymbols().catch(e => console.error('[Init] symbols:', e.message));
    cronMarket().catch(e => console.error('[Init] market:', e.message));
    setTimeout(() => {
      cronGreeks().catch(e => console.error('[Init] greeks:', e.message));
      updatePrevClose().catch(e => console.error('[Init] prevClose:', e.message));
    }, 3000);
  });
});
