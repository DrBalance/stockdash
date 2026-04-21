// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cron.js — 모든 Cron 스케줄 등록
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import cron from 'node-cron';
import { cronMarket, cronMarketVold, fetchHolidays, fetchSymbols, updatePrevClose, connectFinnhub } from './market.js';
import { cronGreeks } from './greeks.js';

// VIX/VVIX: 평일 ET 04~20시 매분
cron.schedule('* 4-20 * * 1-5', async () => {
  try { await cronMarket(); } catch (e) { console.error('[Cron Market]', e.message); }
}, { timezone: 'America/New_York' });

// VOLD: 평일 ET 정규장(09~16시)만
cron.schedule('* 9-16 * * 1-5', async () => {
  try { await cronMarketVold(); } catch (e) { console.error('[Cron VOLD]', e.message); }
}, { timezone: 'America/New_York' });

// Greeks: 평일 ET 04~20시 15분마다
cron.schedule('*/15 4-20 * * 1-5', async () => {
  try { await cronGreeks(); } catch (e) { console.error('[Cron Greeks]', e.message); }
}, { timezone: 'America/New_York' });

// Greeks: CLOSED 진입 시 (ET 20:00) 다음 거래일 데이터 1회 fetch
cron.schedule('0 20 * * 1-5', async () => {
  try { await cronGreeks(); } catch (e) { console.error('[Cron Greeks CLOSED]', e.message); }
}, { timezone: 'America/New_York' });

// prevClose: 장 마감 직후 1회
cron.schedule('5 16 * * 1-5', async () => {
  try { await updatePrevClose(); } catch (e) { console.error('[prevClose]', e.message); }
}, { timezone: 'America/New_York' });

// Finnhub 재연결: 정규장 시작 직후 (ET 09:30)
// 프리마켓 동안 Yahoo 폴백으로 전환되어 있던 것을 Finnhub 실시간으로 복귀
cron.schedule('30 9 * * 1-5', async () => {
  console.log('[Cron] 정규장 시작 — Finnhub 재연결 시도');
  try { connectFinnhub(); } catch (e) { console.error('[Cron Finnhub]', e.message); }
}, { timezone: 'America/New_York' });

// 휴장일 목록: 매일 자정 ET 갱신
cron.schedule('0 0 * * *', async () => {
  try { await fetchHolidays(); } catch (e) { console.error('[Holiday]', e.message); }
}, { timezone: 'America/New_York' });

// 심볼 목록: 매일 새벽 1시 ET 갱신
cron.schedule('0 1 * * *', async () => {
  try { await fetchSymbols(); } catch (e) { console.error('[Symbols]', e.message); }
}, { timezone: 'America/New_York' });
