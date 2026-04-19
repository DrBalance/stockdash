// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 인메모리 상태 저장소 & 공유 상수
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const WATCH_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'GLD', 'SLV'];

export const state = {
  prices:         {},
  market: {
    vix: null, vvix: null, vv: null,
    vold: null, uvol: null, dvol: null,
    updatedAt: null,
  },
  vixHistory: [], vixHistoryDate: '',
  greeks: {}, strikes: {},
  prevStrikes: {},   // 직전 Cron strikes (15분 전)
  baseStrikes: {},   // 당일 첫 번째 Cron strikes (누적 기준)
  baseDate:    '',   // 날짜 바뀌면 baseStrikes 리셋
  vcHistory: {}, vcHistoryDate: '',
  symbols: [],       // 미국 주식 심볼 목록 (매일 자정 갱신)
  symbolsUpdatedAt: null,
};
