// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// routes.js — 모든 REST API 라우트
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { WebSocket } from 'ws';
import { state } from './state.js';
import { todayEST, getMarketState } from './utils.js';
import { fetchClosedMarketData, getFinnhubWsState } from './market.js';
import { fetchCBOEChain } from './greeks.js';
import { fetchChartData, VALID_RESOLUTIONS } from './chart-api.js';
import { getWss } from './broadcast.js';

export function registerRoutes(app) {

  // ── 현재가
  app.get('/api/quote', (req, res) => {
    const sym  = (req.query.symbol || 'SPY').toUpperCase();
    const data = state.prices[sym];
    if (!data) return res.json({ symbol: sym, price: null, note: 'no_data_yet' });
    res.json({ symbol: sym, ...data });
  });

  app.get('/api/quotes', async (req, res) => {
    if (getMarketState() === 'CLOSED') await fetchClosedMarketData();
    res.json(state.prices);
  });

  // ── 시장 지표 (VIX/VVIX/VOLD)
  app.get('/api/market', async (req, res) => {
    if (getMarketState() === 'CLOSED') await fetchClosedMarketData();
    res.json(state.market);
  });

  // ── Greeks (요약)
  app.get('/api/greeks', (req, res) => {
    const sym  = (req.query.symbol || 'SPY').toUpperCase();
    const data = state.greeks[sym];
    if (!data) return res.json({ symbol: sym, note: 'no_data_yet' });
    const { strikes, ...summary } = data;
    res.json({ symbol: sym, ...summary });
  });

  // ── Strikes (전체)
  app.get('/api/strikes', (req, res) => {
    const sym  = (req.query.symbol || 'SPY').toUpperCase();
    const data = state.strikes[sym];
    if (!data) return res.json({ symbol: sym, strikes: [], note: 'no_data_yet' });
    res.json({ symbol: sym, strikes: data });
  });

  // ── GEX 0DTE (Greeks + Strikes 통합)
  app.get('/api/gex0dte', (req, res) => {
    const sym     = (req.query.symbol || 'SPY').toUpperCase();
    const greeks  = state.greeks[sym];
    const strikes = state.strikes[sym];
    if (!greeks || !strikes) return res.json({ error: 'no_data_yet', symbol: sym });
    res.json({ ...greeks, strikes, source: 'cron_computed' });
  });

  // ── VC 히스토리 (Vanna/Charm 시계열)
  app.get('/api/vc_history', (req, res) => {
    const sym = (req.query.symbol || 'SPY').toUpperCase();
    res.json({ symbol: sym, date: todayEST(), history: state.vcHistory[sym] || [] });
  });

  // ── CBOE 원본 옵션체인 (on-demand)
  app.get('/api/options', async (req, res) => {
    const sym = (req.query.symbol || 'SPY').toUpperCase();
    try {
      const data = await fetchCBOEChain(sym);
      res.json({ ...data, source: 'cboe', timestamp: new Date().toISOString() });
    } catch (e) { res.status(500).json({ error: e.message, symbol: sym }); }
  });

  // ── 서버 상태
  app.get('/api/status', (req, res) => {
    res.json({
      ok: true, version: '2.0.0',
      finnhubWs:        getFinnhubWsState() === WebSocket.OPEN ? 'connected' : 'disconnected',
      wsClients:        getWss()?.clients.size ?? 0,
      pricesUpdated:    Object.fromEntries(Object.entries(state.prices).map(([k, v]) => [k, v.updatedAt])),
      marketUpdatedAt:  state.market.updatedAt,
      greeksSymbols:    Object.keys(state.greeks),
      vixHistoryLen:    state.vixHistory.length,
      symbolsCount:     state.symbols.length,
      symbolsUpdatedAt: state.symbolsUpdatedAt,
      uptime:           process.uptime(),
      now:              new Date().toISOString(),
    });
  });

  // ── 심볼 자동완성
  app.get('/api/symbols', (req, res) => {
    const q = (req.query.q || '').toUpperCase().trim();
    if (!q) return res.json({ count: state.symbols.length, symbols: state.symbols.slice(0, 50) });
    const matched = state.symbols.filter(s =>
      s.symbol.startsWith(q) || s.name?.toUpperCase().includes(q)
    ).slice(0, 30);
    res.json({ count: matched.length, symbols: matched });
  });

  // ── 차트 데이터 (Twelve Data)
  app.get('/api/chart', async (req, res) => {
    const symbol     = (req.query.symbol || 'SPY').toUpperCase();
    const resolution = req.query.resolution || 'D';
    if (!VALID_RESOLUTIONS.includes(resolution))
      return res.status(400).json({ error: 'invalid resolution', valid: VALID_RESOLUTIONS });
    if (!process.env.TWELVEDATA_KEY)
      return res.status(503).json({ error: 'TWELVEDATA_KEY 환경변수가 설정되지 않았습니다', symbol });
    try {
      console.log(`[Chart] ${symbol} res=${resolution} 요청`);
      const data = await fetchChartData(symbol, resolution);
      console.log(`[Chart] ${symbol} res=${resolution} 완료 — candles=${data.candles.length}`);
      res.json(data);
    } catch (e) {
      console.error(`[Chart] ${symbol} res=${resolution} 실패:`, e.message);
      res.status(500).json({ error: e.message, symbol, resolution });
    }
  });
}
