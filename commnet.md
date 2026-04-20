1. 프로젝트 목적 및 핵심 전략
이 프로젝트의 핵심은 **옵션 시장의 미세구조(Market Microstructure)**를 분석하여, 단순한 가격 변동이 아닌 딜러의 헤징(Hedging) 매커니즘에 의한 지수 움직임을 포착하는 것입니다.
타겟 현상: "질서 있는 하락(Orderly Decline)"
판단 근거: VIX 지수가 급등하지 않고 완만하게 상승($0.01 < dVIX/dt < 0.5$)하는 상황에서, 딜러의 Vanna 노출도가 음수(-)로 깊어지며 발생하는 기계적 매도 압력을 포착함.

2. 신규 파일별 역할 및 구현 기능
A. vanna_analyzer.js (분석 엔진)
목적: greeks.js에서 계산된 정적 데이터를 바탕으로 시장의 동적 변화(기울기, 가속도)를 판독.
핵심 함수:getVixMomentum(): 
state.vcHistory를 분석하여 VIX의 최근 기울기와 가속도 산출.analyze(): Vanna 수치와 VIX 기울기를 결합하여 '질서 있는 하락', '반등 가능성' 등의 시그널 생성.
B. heatmap.js (시각화 컴포넌트)
목적: 행사가(Strike)별로 산재된 딜러의 리스크 노출도를 직관적인 히트맵으로 전환.
구현 기능:
Color Mapping: 음수 Vanna(매도 압력)는 빨간색, 양수 Vanna(매수 지지)는 파란색으로 표시하며 강도에 따라 농도 조절.
Real-time Update: 웹소켓으로 수신되는 최신 Greeks 데이터를 즉시 반영.
3. 기존 코드 적용 가이드 (Integration Task)
1) greeks.js 수정 사항
데이터 연동: cronGreeks 함수 실행 시 계산된 result와 state.vcHistory를 VannaAnalyzer.analyze()에 전달할 것.
상태 저장: 분석 결과(Analysis object)를 state.greeks[sym].analysis에 저장하여 프론트엔드로 브로드캐스트할 것.
2) index.html 및 CSS 수정 사항
컴포넌트 삽입: 0DTE 메인 영역(area-0dte)에 히트맵이 들어갈 컨테이너를 생성할 것.
디자인 가이드 (CSS):badge-orderly: 질서 있는 하락 감지 시 오렌지색으로 깜빡이는 애니메이션 효과.heatmap-table: 다크 모드에 최적화된 폰트(var(--mono))와 가독성 있는 행 간격 유지.
3) 프론트엔드 JS 연동서버로부터 수신된 greeks 데이터에 analysis 정보가 포함되어 있다면, 이를 바탕으로 히트맵 테이블을 갱신하고 상단 상태바에 경고 메시지를 출력할 것.