// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 유틸 함수 — 시간, 휴장일, 장 상태, 수학
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN;

// ── 공유 휴장일 Set (market.js에서 갱신)
export let holidaySet = new Set(); // 'YYYY-MM-DD'

export function setHolidaySet(newSet) {
  holidaySet = newSet;
}

// ── EST 기준 시간 헬퍼
export function nowEST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}
export function todayEST() { return nowEST().toLocaleDateString('en-CA'); }
export function estHour()  { const n = nowEST(); return n.getHours() + n.getMinutes() / 60; }

export function isExtendedHours() {
  const h = estHour(), dow = nowEST().getDay();
  return dow >= 1 && dow <= 5 && h >= 4 && h < 20;
}

// ET 기준 Date → 'YYYY-MM-DD' 변환 (UTC 메서드 미사용)
function etISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── 현재 유효한 거래 세션 날짜 반환 (ET 기준만 사용)
// ET 평일 04:00~20:00 → 오늘 / 그 외(주말·휴장·마감 후) → 다음 거래일
export function getTargetTradingDay() {
  const et = nowEST();
  const dow = et.getDay();
  const h   = et.getHours() + et.getMinutes() / 60;
  const iso = etISO(et);

  if (dow >= 1 && dow <= 5 && !holidaySet.has(iso) && h >= 4 && h < 20) {
    return iso; // 오늘이 유효한 거래 세션
  }

  // 다음 거래일 탐색 (ET 기준)
  const d = new Date(et);
  for (let i = 1; i <= 10; i++) {
    d.setDate(d.getDate() + 1);
    const nextISO = etISO(d);
    const nextDow = d.getDay();
    if (nextDow >= 1 && nextDow <= 5 && !holidaySet.has(nextISO)) return nextISO;
  }
  return null;
}

// ── 특정 날짜 기준 다음 거래일 계산 (ET 기준만 사용)
export function getNextTradingDay(fromDate = nowEST()) {
  const d = new Date(fromDate);
  for (let i = 1; i <= 10; i++) {
    d.setDate(d.getDate() + 1);
    const iso = etISO(d);
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5 && !holidaySet.has(iso)) return iso;
  }
  return null;
}

// ── 장 상태 판별
export function getMarketState() {
  const today = todayEST();
  if (holidaySet.has(today)) return 'CLOSED';
  const h = estHour(), dow = nowEST().getDay();
  if (dow === 0 || dow === 6)    return 'CLOSED';
  if (h >= 4   && h <  9.5)     return 'PRE';
  if (h >= 9.5 && h <  16)      return 'REGULAR';
  if (h >= 16  && h <  20)      return 'AFTER';
  return 'CLOSED';
}

// ── 수학 유틸
export function normPDF(x) {
  return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
}

// ── ET(America/New_York) offset → UTC 변환용
// 서머타임(EDT=-4h) / 표준시(EST=-5h) 자동 감지
export function getETOffsetMs(date) {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const etStr  = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const utcD   = new Date(utcStr);
  const etD    = new Date(etStr);
  return utcD.getTime() - etD.getTime();
}
