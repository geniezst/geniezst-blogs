/**
 * markdown-guard 회귀 테스트
 *
 * 2026-11-17 실제 사고 덤프(data/truncated-2026-11-17-evening-{0,1}.md)를 그대로 재현한다.
 *   - 1차: 표 구분선에서 '-' 166,848자 연속 (줄이 | 로 끝나지 않아 기존 sanitize 가 통과시킴)
 *   - 2차: 표 머리글에서 공백 438,712자 연속
 */
import {
  clampRunawayRuns,
  normalizeTableSeparator,
  sanitizeMarkdownBody,
  findRunawayRun,
} from '../lib/markdown-guard.mjs';

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

console.log('\n[markdown-guard] 반복 문자 폭주 방어');

// 1) 1차 사고 재현: | :--- 로 시작하고 | 로 끝나지 않는 하이픈 폭주
const dump0 = '| 항목 | 기준 | 내용 |\n| :------------------------------- | :' + '-'.repeat(166848);
const fixed0 = sanitizeMarkdownBody(dump0);
ok('줄이 | 로 끝나지 않아도 하이픈 폭주 축약', fixed0.length < 200, `(${fixed0.length}자)`);
ok('축약 후 20자 이상 반복 문자 없음', !/(.)\1{19,}/.test(fixed0));

// 2) 2차 사고 재현: 표 머리글 공백 폭주
const dump1 = '| 항목' + ' '.repeat(438712) + '| 기준 |';
const fixed1 = sanitizeMarkdownBody(dump1);
ok('공백 폭주는 한 칸으로 축약', fixed1.length < 40, JSON.stringify(fixed1));
ok('축약 후 표 머리글 형태 유지', fixed1.startsWith('| 항목 | 기준 |'));

// 3) 표 구분선 정렬 콜론 제거
ok('| :--- | ---: | → |---|---|', normalizeTableSeparator('| :--- | ---: |') === '|---|---|');
ok('| :---: | --- | → |---|---|', normalizeTableSeparator('| :---: | --- |') === '|---|---|');
ok('내용 행은 건드리지 않음', normalizeTableSeparator('| 2026년 | 12만원 |') === '| 2026년 | 12만원 |');

// 4) 코드 블록 보존
const codeBlock = '```\n' + '-'.repeat(500) + '\n```';
ok('코드 블록 안의 반복 문자는 보존', sanitizeMarkdownBody(codeBlock) === codeBlock);

// 5) 정상 마크다운은 변형하지 않음
const normal = '## 제목\n\n| 항목 | 기준 |\n|---|---|\n| 나이 | 만 18세 |\n\n본문입니다.';
ok('정상 마크다운 무변형', sanitizeMarkdownBody(normal) === normal);

// 6) 게이트 탐지기
ok('findRunawayRun 이 별표 폭주를 잡는다', findRunawayRun('*'.repeat(50))?.length === 50);
ok('정상 텍스트는 null', findRunawayRun('정상적인 문장입니다. --- 구분선도 정상.') === null);
ok('clampRunawayRuns 는 3자 미만 구분선을 유지', clampRunawayRuns('| --- | --- |') === '| --- | --- |');

console.log(`\n===== markdown-guard 결과: ${pass} 통과 / ${fail} 실패 =====`);
process.exit(fail ? 1 : 0);
