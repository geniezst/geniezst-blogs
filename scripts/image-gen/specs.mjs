// 글 본문 이미지 데이터. 키 = public/assets/posts/ 아래 상대 경로(확장자 제외).
const D = '2026.10.19';
export const SPECS = {
  'credit-card-point-cash-conversion-2026-guide/steps': {
    type: 'steps', title: '카드포인트 계좌 이체 순서', subtitle: '여신금융협회 카드포인트 통합조회 · 금융결제원 어카운트인포',
    source: '금융위원회·정책브리핑', date: D,
    items: [
      { title: '앱 접속 후 본인 인증', desc: '휴대폰 인증 또는 공동·금융인증서', tag: '무료' },
      { title: '카드사별 포인트 확인', desc: '소멸 예정 포인트부터 확인', tag: '11개 카드사' },
      { title: '이체할 카드사·금액 선택', desc: '본인 명의 계좌만 지정 가능', tag: '1포인트부터' },
      { title: '계좌 입금 확인', desc: '제휴 포인트는 이체 대상 아님', tag: '완료' },
    ],
  },
  'credit-debit-card-income-deduction-strategy-2026/threshold': {
    type: 'steps', title: '카드 소득공제 계산 순서', subtitle: '총급여 5,000만원 예시, 2025년 귀속 기준',
    source: '국세청·정책브리핑', date: D,
    items: [
      { title: '총급여 25%까지는 공제 없음', desc: '5,000만원 × 25% = 1,250만원, 신용카드분부터 채운 것으로 계산', tag: '문턱', hl: true },
      { title: '신용카드 사용분 15%', desc: '문턱 이후 신용카드 사용액', tag: '15%' },
      { title: '체크카드·현금영수증 30%', desc: '도서·공연·체육시설(2025.7~)도 30%, 총급여 7,000만원 이하', tag: '30%' },
      { title: '전통시장·대중교통 40%', desc: '추가 한도 300만원(7,000만원 이하)', tag: '40%' },
      { title: '기본 한도 300만원 안에서 공제', desc: '2026년 사용분부터 자녀 1명당 50만원 추가(최대 100만원)', tag: '한도' },
    ],
  },
  'eitc-2026-missed-deadline-remaining-application-windows/timeline': {
    type: 'timeline', title: '근로장려금 2026년 신청 창구', subtitle: '2025년 소득분 정기·기한후, 2026년 소득분 반기신청',
    source: '국세청 근로·자녀장려금 안내', date: D,
    items: [
      { when: '5.1~6.1', name: '정기신청', sub: '2025년 소득', tag: '9월 지급' },
      { when: '6.2~12.1', name: '기한후 신청', sub: '정기신청 놓친 경우', tag: '95% 지급', hl: true },
      { when: '9.1~9.15', name: '반기(상반기분)', sub: '근로소득만', tag: '12월 35% 지급' },
      { when: '2027.3.1~15', name: '반기(하반기분)', sub: '연간 정산', tag: '2027년 6월' },
    ],
  },
  'health-insurance-dependent-eligibility-guide-2026/flow': {
    type: 'steps', title: '피부양자 자격 판정 순서', subtitle: '셋 중 하나라도 넘으면 지역가입자로 전환',
    source: '국민건강보험공단', date: D,
    items: [
      { title: '관계 요건', desc: '배우자, 직계존·비속과 그 배우자, 형제·자매', tag: '부양' },
      { title: '합산소득 연 2,000만원 이하', desc: '사업·금융·연금·근로·기타소득 합계, 기혼이면 부부 모두', tag: '소득' },
      { title: '사업소득 기준', desc: '등록 사업자는 소득 없어야, 미등록은 500만원 이하', tag: '사업', hl: true },
      { title: '재산세 과표 5.4억원 이하', desc: '5.4억~9억원은 연소득 1,000만원 이하일 때만', tag: '재산' },
    ],
  },
  'hope-savings-account-eligibility-benefits-2026/compare': {
    type: 'barsH', title: '희망저축계좌 유형별 3년 적립액', subtitle: '본인 월 10만원 저축, 이자 제외',
    source: '보건복지부 · 합계 1유형 1,440만원, 2유형 1,080만원', date: D,
    items: [
      { label: '1유형 본인 저축', value: '360만원', num: 360 },
      { label: '1유형 정부지원금', value: '1,080만원', num: 1080, hl: true },
      { label: '2유형 본인 저축', value: '360만원', num: 360 },
      { label: '2유형 정부지원금', value: '720만원', num: 720 },
    ],
  },
  'housing-benefit-2026-guide-maximizing-support/calc': {
    type: 'steps', title: '임차급여 지급액 계산 순서', subtitle: '서울 1인, 보증금 500만원·월세 35만원·소득인정액 100만원 예시',
    source: '국토교통부 마이홈포털', date: D,
    items: [
      { title: '실제 임차료 산정', desc: '월세 35만원 + 보증금 500만원 × 4% ÷ 12 ≈ 36만 6,667원', tag: '1단계' },
      { title: '기준임대료와 비교', desc: '서울 1인 36만 9천원보다 적으므로 36만 6,667원', tag: '2단계' },
      { title: '자기부담분 차감', desc: '(100만원 − 82만 556원) × 30% ≈ 5만 3,833원', tag: '3단계', hl: true },
      { title: '월 지급액', desc: '약 31만 2,800원 (소득·재산 조사로 확정)', tag: '결과' },
    ],
  },
  'housing-loan-interest-deduction-2026-strategy/limit-flow': {
    type: 'table', title: '이자상환액 공제 한도 결정', subtitle: '2024년 1월 1일 이후 기준',
    source: '국세청 장기주택저당차입금 이자상환액 공제', date: D,
    cols: ['상환기간', '고정금리·비거치식 분할상환', '연간 한도'], widths: [2, 4, 2.4], hlCol: 2,
    rows: [['15년 이상', '둘 다 충족', '2,000만원'], ['15년 이상', '둘 중 하나 충족', '1,800만원'], ['15년 이상', '둘 다 미충족', '800만원'], ['10년 이상', '둘 중 하나 이상 충족', '600만원']],
  },
  'housing-pension-2026-guide-maximizing-income/monthly': {
    type: 'barsV', title: '주택연금 나이별 월지급금 (주택가격 3억원)', subtitle: '종신지급방식 정액형, 일반주택, 2026년 3월 1일 이후 신규 신청',
    source: '한국주택금융공사 · 부부 중 연소자 기준', date: D,
    items: [
      { label: '55세', value: '46.8만원', num: 46.8 }, { label: '60세', value: '63.2만원', num: 63.2 }, { label: '65세', value: '75.8만원', num: 75.8 },
      { label: '70세', value: '92.3만원', num: 92.3, hl: true }, { label: '75세', value: '114.3만원', num: 114.3 }, { label: '80세', value: '144.9만원', num: 144.9 },
    ],
  },
  'housing-rent-loan-deduction-2026-strategy/limit': {
    type: 'table', title: '청약저축 공제와 합친 400만원 한도 예시', subtitle: '무주택 세대주, 총급여 7,000만원 이하 가정',
    source: '국세청 특별소득공제 안내', date: D,
    cols: ['구분', '사례 1', '사례 2'], widths: [3.4, 2.2, 2.8], hlCol: 2,
    rows: [['청약저축 납입', '300만원', '300만원'], ['청약저축 공제(40%)', '120만원', '120만원'], ['전세대출 원리금 상환', '600만원', '900만원'], ['원리금 공제(40%)', '240만원', '360만원'], ['합계 → 인정액', '360만원', '480만원 → 400만원']],
  },
  'housing-stability-monthly-rent-loan-2026-guide/balance': {
    type: 'barsV', title: '월 60만원씩 빌릴 때 쌓이는 원금', subtitle: '만기에 한꺼번에 갚아야 하는 금액',
    source: '2년 이자 합계 약 19만 5천원(연 1.3%) · 약 27만원(연 1.8%), 단순 계산', date: D,
    items: [{ label: '6개월', value: '360만원', num: 360 }, { label: '12개월', value: '720만원', num: 720 }, { label: '18개월', value: '1,080만원', num: 1080 }, { label: '24개월', value: '1,440만원', num: 1440, hl: true }],
  },
  'housing-subscription-monthly-limit-250k-strategy-2026/recognized': {
    type: 'barsH', title: '10년 납입 시 공공분양 저축총액 인정액', subtitle: '2024년 11월 이후 납입분, 월 인정 한도 25만원',
    source: '국토교통부 · 월 50만원을 넣어도 25만원까지만 인정', date: D,
    items: [{ label: '월 10만원', value: '1,200만원', num: 1200 }, { label: '월 25만원', value: '3,000만원', num: 3000, hl: true }, { label: '월 50만원', value: '3,000만원', num: 3000 }],
  },
  'isa-maturity-pension-transfer-strategy-2026/savings': {
    type: 'barsH', title: 'ISA 전환액별 추가 세액공제', subtitle: '연금계좌 세액공제율 16.5%(총급여 5,500만원 이하) · 13.2%(초과)',
    source: '국세청 · 추가 공제 = 전환액 × 10%(최대 300만원) × 공제율', date: D,
    items: [
      { label: '1,000만원 · 16.5%', value: '16만 5천원', num: 16.5 }, { label: '1,000만원 · 13.2%', value: '13만 2천원', num: 13.2 },
      { label: '2,000만원 · 16.5%', value: '33만원', num: 33 }, { label: '2,000만원 · 13.2%', value: '26만 4천원', num: 26.4 },
      { label: '3,000만원 이상 · 16.5%', value: '49만 5천원', num: 49.5, hl: true }, { label: '3,000만원 이상 · 13.2%', value: '39만 6천원', num: 39.6 },
    ],
  },
  'national-employment-support-allowance-2026/types': {
    type: 'table', title: '국민취업지원제도 Ⅰ유형 구분', subtitle: '구직촉진수당 지급 유형',
    source: '고용노동부·고용24', date: D,
    cols: ['구분', '나이', '가구 소득', '재산', '최근 2년 취업경험'], widths: [2.3, 1.6, 2.1, 1.3, 3],
    rows: [['요건심사형', '15~69세', '중위 60% 이하', '4억원', '100일·800시간 이상'], ['선발형', '15~69세', '중위 60% 이하', '4억원', '100일·800시간 미만'], ['선발형(청년)', '18~34세', '중위 120% 이하', '5억원', '관계없음']],
  },
  'national-tomorrow-learning-card-2026-guide/structure': {
    type: 'table', title: '국민내일배움카드 지원 구조', subtitle: '5년 유효, 한도 안에서 자부담을 뺀 금액을 지원',
    source: '고용24·고용노동부·정책브리핑', date: '2026.10.21',
    cols: ['구분', '금액', '해당하는 사람'], widths: [2, 2.4, 5], hlCol: 1,
    rows: [['기본 한도', '300만원', '발급 제외 대상이 아닌 국민'], ['추가 지원', '+200만원', '기간제·파견·단시간·일용근로자, 수급자 등'], ['최대 한도', '500만원', '추가 지원 대상자만 (계좌 한도 기준)'], ['자부담', '훈련비의 0~55%', '통상 15~55%, 특정 계층은 0%·낮은 비율'], ['훈련장려금', '월 11.6만원(일반)', '140시간 이상 과정, 출석률 80% 이상']],
  },
  'newborn-special-loan-2026-guide/process': {
    type: 'steps', title: '신생아 특례대출 신청 절차', subtitle: '기금e든든 심사 후 수탁은행에서 실행',
    source: '마이홈포털·주택도시기금', date: D,
    items: [
      { title: '기금e든든 대출 신청', desc: '소득·자산 심사 진행', tag: '온라인' },
      { title: '수탁은행 서류 제출', desc: '등본, 가족관계증명서, 소득 증빙, 계약서', tag: '은행' },
      { title: '담보·보증 심사 후 승인', desc: 'LTV 70%(생애최초 80%), DTI 60%', tag: '심사' },
      { title: '대출 실행', desc: '구입은 잔금일, 전세는 입주일에 맞춰', tag: '실행', hl: true },
    ],
  },
  'newlywed-home-loan-2026-guide/limits': {
    type: 'barsH', title: '디딤돌대출 대상별 최대 한도', subtitle: 'LTV 70%(생애최초 80%)·DTI 60% 함께 적용',
    source: '국토교통부 마이홈포털', date: D,
    items: [{ label: '일반', value: '2억원', num: 2 }, { label: '생애최초 구입', value: '2.4억원', num: 2.4 }, { label: '신혼가구', value: '3.2억원', num: 3.2, hl: true }, { label: '2자녀 이상', value: '3.2억원', num: 3.2, hl: true }],
  },
  'newlywed-jeonse-loan-2026-guide/compare': {
    type: 'table', title: '버팀목 전세대출 신혼부부와 일반 가구', subtitle: '주택도시기금, 마이홈포털 기준',
    source: '국토교통부 마이홈포털', date: D,
    cols: ['항목', '신혼부부', '일반 가구'], widths: [2.3, 3.5, 3.5], hlCol: 1,
    rows: [['부부합산 연소득', '7,500만원 이하', '5,000만원 이하'], ['대출 한도', '수도권 2.5억 · 지방 1.6억', '수도권 1.2억 · 지방 8천만'], ['보증금 대비', '80% 이내', '70% 이내'], ['임차보증금', '수도권 4억 · 지방 3억 이하', '수도권 3억 · 지방 2억 이하'], ['순자산', '3.45억원 이하', '3.45억원 이하']],
  },
  'parental-leave-allowance-2026-guide/caps': {
    type: 'barsV', title: '육아휴직 급여 기간별 월 상한액', subtitle: '2025년 1월 1일 시행, 사후지급금 폐지로 휴직 중 전액 지급',
    source: '고용노동부 · 하한액 월 70만원', date: D,
    items: [{ label: '1~3개월', sub: '통상임금 100%', value: '250만원', num: 250, hl: true }, { label: '4~6개월', sub: '통상임금 100%', value: '200만원', num: 200 }, { label: '7개월 이후', sub: '통상임금 80%', value: '160만원', num: 160 }],
  },
  'small-business-policy-funds-guide-2026/process': {
    type: 'steps', title: '소상공인 정책자금 신청 흐름', subtitle: '대리대출은 은행, 직접대출은 공단이 실행',
    source: '소상공인시장진흥공단', date: D,
    items: [
      { title: '정책자금 누리집 온라인 신청', desc: 'ols.semas.or.kr, 자금 선택', tag: '신청' },
      { title: '공단 심사', desc: '대리대출은 지원 대상 확인서 발급', tag: '소진공' },
      { title: '대리대출: 보증·은행 심사', desc: '은행 심사에서 한도 조정·거절 가능', tag: '은행', hl: true },
      { title: '대출 실행', desc: '직접대출은 공단이 바로 실행', tag: '실행' },
    ],
  },
  'sme-worker-preferential-savings-guide-2026/match': {
    type: 'table', title: '납입액별 원금 (근로자 + 회사 20%)', subtitle: '이자 제외 단순 합계',
    source: '중소벤처기업부', date: D,
    cols: ['월 납입', '회사 지원금(월)', '3년 합계', '5년 합계'], widths: [2, 2.6, 2.4, 2.4], hlCol: 3,
    rows: [['10만원', '2만원', '432만원', '720만원'], ['30만원', '6만원', '1,296만원', '2,160만원'], ['50만원', '10만원', '2,160만원', '3,600만원']],
  },
  'youth-jeonse-deposit-guarantee-support-2026/support': {
    type: 'table', title: '반환보증 보증료 지원 대상별 기준', subtitle: 'HUG·HF·SGI서울보증 반환보증 가입자',
    source: '정부24 국토교통부 보증료 지원', date: D,
    cols: ['구분', '소득 기준', '지원'], widths: [3, 3, 3.6], hlCol: 2,
    rows: [['청년 (19~39세)', '연 5,000만원 이하', '보증료 전액, 최대 40만원'], ['신혼부부 (7년 이내)', '부부 7,500만원 이하', '보증료 전액, 최대 40만원'], ['그 외 임차인', '연 6,000만원 이하', '보증료의 90%, 최대 40만원']],
  },
  'youth-leap-account-2026-guide/compare': {
    type: 'table', title: '청년도약계좌와 청년미래적금 비교', subtitle: '도약계좌는 기존 가입자 기준, 미래적금은 2026년 모집 기준',
    source: '금융위원회·서민금융진흥원', date: D,
    cols: ['구분', '청년도약계좌', '청년미래적금'], widths: [2.2, 4, 3.6], hlCol: 2,
    rows: [['만기', '5년', '3년'], ['월 납입 한도', '70만원', '50만원'], ['정부 지원', '소득 구간별 매칭 (월 최대 3.3만원)', '납입액의 6% 또는 12%'], ['비과세', '이자소득 비과세', '이자소득 비과세'], ['신규 가입', '2025.12.31 종료', '회차별 모집']],
  },
  'youth-monthly-rent-support-2026-guide/eligibility': {
    type: 'steps', title: '청년월세 지원 자격 확인 순서', subtitle: '2026년 모집 기준, 모든 단계를 충족해야 대상',
    source: '국토교통부·복지로', date: D,
    items: [
      { title: '만 19~34세', desc: '2027년부터 연령 기준 확대 예정(공고 확인)', tag: '나이' },
      { title: '부모와 따로 사는 무주택 청년', desc: '청약통장 요건은 2026년부터 폐지', tag: '거주' },
      { title: '청년가구 중위 60% 이하, 재산 1.22억원 이하', desc: '소득인정액 기준', tag: '청년가구' },
      { title: '원가구 중위 100% 이하, 재산 4.7억원 이하', desc: '30세 이상·혼인 등은 원가구 미반영 예외', tag: '원가구', hl: true },
    ],
  },
  'youth-tomorrow-savings-account-2026-guide/composition': {
    type: 'barsH', title: '청년내일저축계좌 본인 저축액별 3년 적립', subtitle: '정부지원금은 월 30만원으로 동일, 이자 제외',
    source: '보건복지부 · 정부지원금 1,080만원 포함 합계', date: D,
    items: [{ label: '본인 월 10만원', value: '1,440만원', num: 1440 }, { label: '본인 월 30만원', value: '2,160만원', num: 2160 }, { label: '본인 월 50만원', value: '2,880만원', num: 2880, hl: true }],
  },
};
