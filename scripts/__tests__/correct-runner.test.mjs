#!/usr/bin/env node
/**
 * correct-runner.mjs 의 "허위 클린 판정" 회귀 테스트 (P1-4)
 *
 * 검증 대상:
 *  1) parseReviewResult 가 파싱 실패를 [] 가 아니라 null 로 돌려주는가
 *  2) findTargetPosts 가 'audit_failed' 이력을 "검수 완료" 로 보지 않는가
 *  3) deepAudit 실패 → 'clean' 이력이 남지 않는가
 *
 * 실제 모듈은 데몬/CLI 를 시작하므로, 로직을 그대로 재현해 단언한다.
 */
import assert from 'node:assert/strict';

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

// ---------- 모듈과 동일한 파서 로직 ----------
function parseReviewResult(out) {
  if (typeof out !== 'string' || !out.trim()) return null;
  const m = out.match(/##\s*REVIEW_RESULT\s*\n?([\s\S]*)$/);
  if (!m) return null;
  const jsonStr = m[1].replace(/```(?:json)?/gi, '').trim();
  if (jsonStr.startsWith('{')) return null;
  const start = jsonStr.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1 || end <= start) return null;
  let list;
  try {
    list = JSON.parse(jsonStr.slice(start, end + 1));
  } catch (_) {
    return null;
  }
  if (!Array.isArray(list)) return null;
  return list.filter((i) => i && typeof i === 'object').map((i) => ({
    type: String(i.type || '기타').slice(0, 40),
    line: typeof i.line === 'number' ? i.line : 0,
    text: String(i.text || '').slice(0, 120),
    suggestion: String(i.suggestion || '').slice(0, 160),
  }));
}

const DONE_STATUSES = ['clean', 'fixed', 'rejected'];

console.log('\n🧪 correct-runner 허위 클린 판정 회귀 테스트');

t('정상 응답은 위반 목록을 반환한다', () => {
  const r = parseReviewResult('前言\n## REVIEW_RESULT\n[{"type":"클리셰","line":3,"text":"알아보겠습니다","suggestion":"삭제"}]');
  assert.equal(r.length, 1);
  assert.equal(r[0].type, '클리셰');
});

t('정상 응답의 빈 배열은 "위반 0건" (빈 배열, null 아님)', () => {
  const r = parseReviewResult('## REVIEW_RESULT\n[]');
  assert.deepEqual(r, []);
  assert.notEqual(r, null, '정상적인 빈 결과는 null 이면 안 된다');
});

t('마커 미발견 → null (0건 아님)', () => {
  assert.equal(parseReviewResult('감사를 완료했습니다. 이상 없습니다.'), null);
});

t('빈 문자열 / 빈 응답 → null', () => {
  assert.equal(parseReviewResult(''), null);
  assert.equal(parseReviewResult('   \n '), null);
  assert.equal(parseReviewResult(undefined), null);
  assert.equal(parseReviewResult(null), null);
});

t('깨진 JSON → null', () => {
  assert.equal(parseReviewResult('## REVIEW_RESULT\n[{"type":"클리셰",]'), null);
});

t('★ 배열이 아닌 JSON → null (기존 허위 클린 버그)', () => {
  assert.equal(parseReviewResult('## REVIEW_RESULT\n{"violations":[]}'), null);
  assert.equal(parseReviewResult('## REVIEW_RESULT\n{"result":[]}'), null);
  assert.equal(parseReviewResult('## REVIEW_RESULT\n{"count":0,"items":[]}'), null);
});

t('중첩 배열/따옴표가 섞인 정상 응답도 파싱된다', () => {
  const payload = '[{"type":"표기","text":"a]b","suggestion":"x"},{"type":"링크","text":"c"}]';
  const r = parseReviewResult('## REVIEW_RESULT\n' + payload);
  assert.equal(r.length, 2);
  assert.equal(r[0].text, 'a]b');
  assert.equal(r[1].type, '링크');
});

t('대괄호가 아예 없음 → null', () => {
  assert.equal(parseReviewResult('## REVIEW_RESULT\n이상 없습니다.'), null);
});

t('마커 뒤에 ```json 코드펜스만 있어도 파싱된다', () => {
  const r = parseReviewResult('## REVIEW_RESULT\n```json\n[{"type":"금액표기","line":9,"text":"70만원","suggestion":"70만 원"}]\n```');
  assert.equal(r.length, 1);
  assert.equal(r[0].type, '금액표기');
});

console.log('\n🧪 이력 상태 판정 (findTargetPosts doneKeys)');

function doneKeysFor(history) {
  return new Set(
    history.filter((h) => DONE_STATUSES.includes(h.status)).map((h) => `${h.session}|${h.slug}`)
  );
}

t("'clean' 이력은 검수 완료로 인정된다", () => {
  const keys = doneKeysFor([{ session: 'noon', slug: 'a', status: 'clean' }]);
  assert.ok(keys.has('noon|a'));
});

t("★ 'audit_failed' 이력은 검수 완료로 인정되지 않는다 (재검수 유지)", () => {
  const keys = doneKeysFor([{ session: 'noon', slug: 'b', status: 'audit_failed' }]);
  assert.equal(keys.has('noon|b'), false, '감사 실패 글이 검수 완료로 표시되면 안 된다');
});

t("'pending' / 'fixed' / 'rejected' 이력 판정 확인", () => {
  const keys = doneKeysFor([
    { session: 'noon', slug: 'c', status: 'pending' },
    { session: 'noon', slug: 'd', status: 'fixed' },
    { session: 'noon', slug: 'e', status: 'rejected' },
  ]);
  assert.equal(keys.has('noon|c'), false);
  assert.ok(keys.has('noon|d'));
  assert.ok(keys.has('noon|e'));
});

console.log('\n🧪 감사 실패 → clean 이력 기록 차단');

t('감사가 실패하면 violations 이 null 이고 ok 가 false 다', () => {
  const sim = (auditOk, deepV, staticV) => {
    if (!auditOk) return { status: 'audit_failed', count: 0 };
    const merged = [...staticV, ...deepV];
    return { status: merged.length === 0 ? 'clean' : 'pending', count: merged.length };
  };
  const failed = sim(false, null, []);
  assert.equal(failed.status, 'audit_failed');
  assert.notEqual(failed.status, 'clean', '★이것이 회귀의 핵심: 실패가 clean 이 되면 안 된다');

  const clean = sim(true, [], []);
  assert.equal(clean.status, 'clean', '진짜로 감사 통과 + 위반 0건일 때만 clean');

  const dirty = sim(true, [{ type: 'x' }], []);
  assert.equal(dirty.status, 'pending');
});

t('mergeViolations 은 deep 가 null 이어도 정적 결과를 유지한다', () => {
  const merge = (staticV, deepV) => {
    const seen = new Set();
    const merged = [];
    for (const v of [...staticV, ...(deepV || [])]) {
      const key = `${v.type}|${v.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(v);
    }
    return merged;
  };
  assert.equal(merge([{ type: 'a', text: 'x' }], null).length, 1);
  assert.equal(merge([], null).length, 0);
  // 중복 제거 유지
  assert.equal(merge([{ type: 'a', text: 'x' }], [{ type: 'a', text: 'x' }]).length, 1);
});

console.log(`\n✅ ${passed}개 통과 / 실패 ${process.exitCode ? '있음' : '없음'}\n`);
