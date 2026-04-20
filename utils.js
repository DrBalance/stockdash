// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 유틸 함수 — 시간, 휴장일, 장 상태, 수학
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN;

// ── 공유 휴장일 Set (market.js에서 갱신)
export let holidaySet = new Set(); // 'YYYY-MM-DD'

export function setHolidaySet(newSet) {
  holidaySet = newSet;
}

// ── ET 현재 시각 (로컬 메서드가 ET 값을 반환)
export function nowEST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

// ET 기준 Date → 'YYYY-MM-DD' (UTC 메서드 미사용)
function etISO(d) {
  const y   = d.getFullYear();
  const m   = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 핵심: ET 기준 컨텍스트를 한 번에 계산
// 모든 날짜/장 상태 판단은 이 함수 하나에서 처리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function getETContext() {
  const et  = nowEST();
  const dow = et.getDay();                          // 0=일 ... 6=토 (ET 기준)
  const h   = et.getHours() + et.getMinutes() / 60; // ET 시각 (소수)
  const todayISO = etISO(et);                        // ET 오늘 날짜

  const isTradingDay = dow >= 1 && dow <= 5 && !holidaySet.has(todayISO);

  // ── 장 상태
  let marketState = 'CLOSED';
  if (isTradingDay) {
    if      (h >= 4   && h < 9.5) marketState = 'PRE';
    else if (h >= 9.5 && h < 16)  marketState = 'REGULAR';
    else if (h >= 16  && h < 20)  marketState = 'AFTER';
    // 00:00~04:00, 20:00+ → CLOSED
  }

  // ── 현재 세션의 대상 만기일
  // ET 평일(비휴장) + 20시 이전(자정~새벽 포함) → 오늘
  // ET 20시 이후 / 주말 / 휴장 → 다음 거래일
  let targetISO = null;
  if (isTradingDay && h < 20) {
    targetISO = todayISO;
  } else {
    const d = new Date(et);
    for (let i = 1; i <= 10; i++) {
      d.setDate(d.getDate() + 1);
      const iso = etISO(d);
      const dw  = d.getDay();
      if (dw >= 1 && dw <= 5 && !holidaySet.has(iso)) { targetISO = iso; break; }
    }
  }

  // ── vcHistory 기록 여부 (ET 평일 04:00~20:00)
  const isExtended = isTradingDay && h >= 4 && h < 20;

  return { todayISO, targetISO, marketState, isExtended };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 기존 인터페이스 — getETContext() 래핑
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export const getMarketState      = () => getETContext().marketState;
export const todayEST            = () => getETContext().todayISO;
export const isExtendedHours     = () => getETContext().isExtended;
export const getTargetTradingDay = () => getETContext().targetISO;

// market.js 전용: 특정 날짜 기준 다음 거래일 (ET 기준)
export function getNextTradingDay(fromDate = nowEST()) {
  const d = new Date(fromDate);
  for (let i = 1; i <= 10; i++) {
    d.setDate(d.getDate() + 1);
    const iso = etISO(d);
    const dw  = d.getDay();
    if (dw >= 1 && dw <= 5 && !holidaySet.has(iso)) return iso;
  }
  return null;
}

// ── 수학 유틸
export function normPDF(x) {
  return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
}

// ── ET offset → UTC 변환용 (서머타임 자동 감지)
export function getETOffsetMs(date) {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const etStr  = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
  return new Date(utcStr).getTime() - new Date(etStr).getTime();
}

// ── 하위 호환 (estHour는 내부에서만 쓰였으나 혹시 모를 참조 보호)
export const estHour = () => { const et = nowEST(); return et.getHours() + et.getMinutes() / 60; };
