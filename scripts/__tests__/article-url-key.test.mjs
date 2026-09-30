#!/usr/bin/env node
/**
 * 출처 이미지 매칭 회귀 테스트 (articleUrlKey 정규화 검증)
 *
 * [왜 이 테스트가 필요한가]
 * 2026-09-30 오전 다이제스트가 4개 카드 중 3개에서 이미지가 빠진 채 발행됐다.
 * 조사 결과 크롤링은 정상인데 **매칭 단계**가 두 번 꺾였다:
 *
 *   1) fetchArticleOgImage 가 og:image 한 장만 반환.
 *      korea.kr 이 자기 로고(korea_logo_2024.jpg)를 og:image 로 선언해서
 *      1순위로 뽑혔고, 같은 기사에 실린 720x480 실사 사진은 시도조차 안 됐다.
 *      → collectArticleImageCandidates 로 후보 다중 시도 (2026-09-30 수정)
 *
 *   2) 카드 href 와 RSS 후보 link 를 문자열 완전일치로만 비교.
 *      트레일링 `&`/`#`, http↔https, `//` 상대경로 차이만으로도 매칭이 깨졌다.
 *      → articleUrlKey 정규화 후 비교 (2026-09-30 수정)
 *
 * 이 테스트는 2번이 다시 깨지지 않는지 고정한다.
 * 특히 "다른 기사로 오인 판정"(오탐)이 생기면 허위 출처 이미지가 붙으므로
 * 달라야 하는 케이스를 반드시 함께 검증한다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { articleUrlKey } from '../generate-news-digest.mjs';

const TARGET = 'https://www.korea.kr/news/policyNewsView.do?newsId=148972766';
const KEY = articleUrlKey(TARGET);

test('동일 기사 표기 변형은 모두 같은 키로 정규화된다', () => {
  const variants = [
    'https://www.korea.kr/news/policyNewsView.do?newsId=148972766&',
    'https://www.korea.kr/news/policyNewsView.do?newsId=148972766#top',
    'http://www.korea.kr/news/policyNewsView.do?newsId=148972766',
    '//www.korea.kr/news/policyNewsView.do?newsId=148972766',
    'https://www.korea.kr/news/policyNewsView.do?newsId=148972766/',
    'https://www.korea.kr/news/policyNewsView.do/?newsId=148972766',
    '  https://www.korea.kr/news/policyNewsView.do?newsId=148972766  ',
    'https://korea.kr/news/policyNewsView.do?newsId=148972766',
  ];
  for (const v of variants) {
    assert.equal(articleUrlKey(v), KEY, `정규화 불일치: ${v}`);
  }
});

test('다른 기사는 반드시 다른 키가 된다 (오탐 방지)', () => {
  // 여기서 오탐이 나면 출처와 무관한 이미지가 붙는다. 엄격 규칙의 안전장치.
  const different = [
    'https://www.newspim.com/news/view/20260930000225',
    'https://www.korea.kr/news/policyNewsView.do?newsId=999999999',
    'https://www.korea.kr/news/policyNewsView.do?newsId=148972766&mode=view',
    'https://www.korea.kr/news/policyBrowseView.do?newsId=148972766',
  ];
  for (const d of different) {
    assert.notEqual(articleUrlKey(d), KEY, `오탐: 다른 기사가 동일 판정됨 → ${d}`);
  }
});

test('빈 값·비문자열은 예외 없이 빈 문자열을 반환한다', () => {
  for (const bad of ['', null, undefined, 0, false, {}]) {
    assert.equal(articleUrlKey(bad), '');
  }
});

test('해시·트레일링 구분자만 다른 쿼리는 보존된다', () => {
  // 질의 파라미터 순서까지 정규화하면 서로 다른 필터 조건이 합쳐지므로
  // 파라미터는 그대로 두는 편이 안전하다.
  assert.notEqual(
    articleUrlKey('https://x.kr/a.do?id=1'),
    articleUrlKey('https://x.kr/a.do?id=2')
  );
});
