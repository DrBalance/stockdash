// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// vanna_analyzer.js — 2차 Greeks 분석 및 시그널 엔진
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * VIX의 최근 기울기를 계산합니다.
 * @param {Array} history - state.vcHistory[sym] 배열
 * @returns {number} slope
 */
export function calculateVixSlope(history) {
  if (!history || history.length < 5) return 0;
  const recent = history.slice(-5);
  const first = recent[0].vix;
  const last = recent[recent.length - 1].vix;
  return parseFloat((last - first).toFixed(3));
}

/**
 * Vanna와 VIX 기울기를 결합하여 시장의 '질서'를 판단합니다.
 */
export function analyzeMarketOrder(greeks, vixSlope) {
  const { vanna, symbol } = greeks;
  let signal = 'NEUTRAL';
  let intensity = 0;

  if (vanna < 0 && vixSlope > 0 && vixSlope < 0.5) {
    signal = 'ORDERLY_DECLINE';
    intensity = Math.abs(vanna) * vixSlope;
  } else if (vanna < 0 && vixSlope < 0) {
    signal = 'VANNA_RALLY_POTENTIAL';
    intensity = Math.abs(vanna) * Math.abs(vixSlope);
  }

  return {
    symbol,
    signal,
    intensity: parseFloat(intensity.toFixed(2)),
    vixSlope,
    timestamp: new Date().toISOString(),
  };
}

/**
 * VIX의 변화 속도와 가속도를 계산합니다.
 */
export function getVixMomentum(history) {
  if (!history || history.length < 10) return { slope: 0, isAccelerating: false };
  const recent = history.slice(-10);
  const firstHalf  = recent.slice(0, 5).reduce((a, b) => a + (b.vix || 0), 0) / 5;
  const secondHalf = recent.slice(5).reduce((a, b)  => a + (b.vix || 0), 0) / 5;
  const slope = secondHalf - firstHalf;
  return {
    slope: parseFloat(slope.toFixed(4)),
    isAccelerating: secondHalf > firstHalf,
  };
}

/**
 * Vanna 수치와 VIX의 역행/순행 여부를 판단합니다.
 */
export function checkVannaVixCorrelation(history) {
  if (!history || history.length < 2) return 'STABLE';
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  if (!last || !prev) return 'STABLE';
  const isVixUp = (last.vix || 0) > (prev.vix || 0);
  const isVannaDeepening = (last.vanna || 0) < (prev.vanna || 0);
  return isVixUp && isVannaDeepening ? 'INTENSIFYING_PRESSURE' : 'STABLE';
}

/**
 * 질서 있는 하락 시그널을 생성합니다.
 */
export function getOrderlyDeclineSignal(greeks, momentum, correlation) {
  const { vanna } = greeks;
  const isVannaHeavy = vanna < -10;
  const isVixOrderly = momentum.slope > 0 && momentum.slope < 0.3;

  if (isVannaHeavy && isVixOrderly && correlation === 'INTENSIFYING_PRESSURE') {
    return {
      type: 'ORDERLY_DECLINE',
      dangerLevel: parseFloat((Math.abs(vanna) * momentum.slope * 10).toFixed(2)),
      message: '딜러 헤징에 의한 질서 있는 하락 구간 진입',
    };
  }
  return { type: 'NORMAL', dangerLevel: 0, message: '특이사항 없음' };
}

/**
 * greeks.js의 cronGreeks에서 호출하는 통합 분석 함수.
 * @param {Object} result - computeGreeks() 반환값
 * @param {Array}  vcHistory - state.vcHistory[sym]
 * @returns {Object} { type, dangerLevel, message }
 */
export function analyzeVanna(result, vcHistory) {
  if (!vcHistory || vcHistory.length < 2) return { type: 'NORMAL', dangerLevel: 0, message: '데이터 부족' };
  const momentum    = getVixMomentum(vcHistory);
  const correlation = checkVannaVixCorrelation(vcHistory);
  return getOrderlyDeclineSignal(result, momentum, correlation);
}
