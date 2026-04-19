// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// broadcast.js — WebSocket 브로드캐스트 헬퍼
// wss 인스턴스를 늦게 주입받아 순환 참조를 방지합니다.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { WebSocket } from 'ws';

let _wss = null;

/** server.js에서 wss 인스턴스를 주입 */
export function initBroadcast(wss) {
  _wss = wss;
}

/** routes.js 등 외부 모듈에서 wss에 접근할 때 사용 (순환 참조 방지) */
export function getWss() {
  return _wss;
}

export function broadcast(type, data) {
  if (!_wss) return;
  const msg = JSON.stringify({ type, data, ts: new Date().toISOString() });
  for (const client of _wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch (_) {}
    }
  }
}
