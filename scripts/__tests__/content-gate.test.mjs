/**
 * 발행 게이트 / 실패 분류 단위 테스트
 *
 * 2026-11-18: 연도 게이트가 "2025년 기준" 이라는 정상 비교 문장을 오탐해
 * 7,611자 / H2 5개 글을 발행 차단한 사례를 회귀 케이스로 고정한다.
 */
import { findYearHallucination, describeFailure } from '../auto-publish-runner.mjs';

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('  ✅', label, extra);
  } else {
    fail++;
    console.log('  ❌', label, extra);
  }
};

console.log('\n[content-gate] 연도 게이트 / 실패 분류');

ok(
  '2026년과 대비한 2025년 기준은 허용',
  findYearHallucination('제목', '2025년 기준 9%였으나 2026년부터 9.5%로 인상됩니다.') === null
);
ok(
  '과거임을 밝힌 2025년 기준은 허용',
  findYearHallucination('제목', '기존 2025년 기준으로는 수급 개시 연령이 63세였습니다.') === null
);
ok('제목의 "2025년 최신"은 차단', findYearHallucination('2025년 최신 국민연금 개편', '본문') === '2025년 최신');
ok(
  '맥락 없는 "2025년 기준"은 차단',
  findYearHallucination('제목', '국민연금 보험료율은 2025년 기준 9%입니다.') === '2025년 기준'
);

ok(
  'describeFailure: 폭주 잘림',
  describeFailure({ message: 'Gemini 응답이 maxOutputTokens(24576) 에서 잘렸습니다', runaway: true }) ===
    'LLM 응답 폭주로 중단 (표 정렬 반복)'
);
ok(
  'describeFailure: 일반 잘림',
  describeFailure({ message: 'Gemini 응답이 maxOutputTokens(16384) 에서 잘렸습니다' }) ===
    'LLM 응답이 분량 상한에서 잘림'
);
ok(
  'describeFailure: 그라운딩 미수행',
  /그라운딩/.test(describeFailure({ message: '[팩트체크 실패] 검색 그라운딩이 수행되지 않았습니다' }))
);
ok('describeFailure: 일일 한도 소진', describeFailure({ message: 'Gemini gemini-2.5-flash HTTP 429: quota', dailyQuota: true }) === 'Gemini 무료 일일 호출 한도 소진 (태평양 자정 리셋)');
ok('describeFailure: 품질 게이트', /품질/.test(describeFailure({ message: '[콘텐츠 품질 게이트 실패] H2 2개' })));

console.log(`\n===== content-gate 결과: ${pass} 통과 / ${fail} 실패 =====`);
process.exit(fail ? 1 : 0);
