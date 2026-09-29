#!/usr/bin/env node
/**
 * 중복 글 생성 방지 회귀 테스트 (3중 가드 검증)
 *
 * [왜 이 테스트가 필요한가]
 * 2026-09-29 저녁, blogs 가 이미 존재하던 youth-leap-account-2026-guide 라는
 * slug 로 새 글을 발행하려 했다. publish-post.mjs 의
 * `ON CONFLICT(slug) DO UPDATE` 가 조용히 기존 글을 덮어썼고,
 * 덮어쓰는 동안 created_at 이 9/18 값으로 유지되어
 * 새 글이 D1 최근순 목록에서 사라졌다(사용자는 "게시글이 안 올라왔다"고 인지).
 * 파일명(YYMMDDNN-)은 유일해도 frontmatter slug 은 유일하지 않았던 것이 근본 원인.
 *
 * 가드 3종
 *   1) buildExcludedTopicList  - 프롬프트에 "이미 발행된 주제" 목록 주입 (생성 단계)
 *   2) findDuplicatePost       - 생성 결과가 기존 글과 같으면 폐기·재생성 (검증 단계)
 *   3) resolveSlugCollision    - 그래도 충돌하면 slug 를 분리 (최후 방어선)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const RUNNER = path.join(PROJECT_ROOT, 'scripts', 'auto-publish-runner.mjs');

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) {
    console.log(`#   ✅ ${label}${detail ? ` ${detail}` : ''}`);
    pass++;
  } else {
    console.log(`#   ❌ ${label}${detail ? ` ${detail}` : ''}`);
    fail++;
  }
};

console.log('\n[1] resolveSlugCollision 함수 존재 및 호출 확인');
const src = fs.readFileSync(RUNNER, 'utf8');
ok('resolveSlugCollision 정의됨', /function resolveSlugCollision\s*\(/.test(src));
ok('게시 파이프라인에서 실제 호출됨', /resolveSlugCollision\(postsDir,/.test(src));
ok('충돌 시 로그를 남김', /\[슬러그 충돌\]/.test(src));

// 필요한 심볼만 떼어내 하나의 스코프로 묶어 독립 실행한다 (데몬/외부 의존성 없음)
function extract(name) {
  const s = src.indexOf(`function ${name}`);
  if (s === -1) throw new Error(`${name} 없음`);
  let d = 0;
  let started = false;
  let i = s;
  for (; i < src.length; i++) {
    if (src[i] === '{') { d++; started = true; }
    else if (src[i] === '}') { d--; if (started && d === 0) { i++; break; } }
  }
  return src.slice(s, i);
}
const constSrc = (() => {
  const s = src.indexOf('const FRONTMATTER_MAX_BYTES');
  return src.slice(s, src.indexOf('\n', s));
})();
const harness = [
  constSrc,
  extract('readFrontmatterHead'),
  extract('readPostIdentity'),
  extract('buildExcludedTopicList'),
  extract('findDuplicatePost'),
  extract('resolveSlugCollision'),
  'return { buildExcludedTopicList, findDuplicatePost, resolveSlugCollision, readFrontmatterHead, readPostIdentity };',
].join('\n');
const { resolveSlugCollision, findDuplicatePost, buildExcludedTopicList, readPostIdentity, readFrontmatterHead } = new Function(
  'fs',
  'path',
  'log',
  harness
)(fs, path, () => {});

console.log('\n[1.5] 프롬프트에 기 발행 주제 목록이 주입되는가');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-excl-'));
  fs.writeFileSync(path.join(dir, 'a.md'), '---\ntitle: "청년도약계좌 가이드"\nslug: "youth-leap-account-2026-guide"\n---\n');
  const list = buildExcludedTopicList(dir);
  ok('발행된 글의 제목이 포함됨', list.includes('청년도약계좌 가이드'), `-> ${list.slice(0, 60)}`);
  ok('발행된 글의 slug 이 포함됨', list.includes('youth-leap-account-2026-guide'));
  ok('금지 지시문이 포함됨', /생성 금지/.test(list));
  ok('개수가 명시됨', /\d+건은 이미 발행된 글/.test(list));

  const empty = buildExcludedTopicList(path.join(dir, 'nonexistent'));
  ok('글 이 없으면 제한 없음 으로 처리', /제한 없음/.test(empty));

  console.log('\n[1.6] 중복 판정이 slug / 제목 두 축에서 동작하는가');
  const dupSlug = findDuplicatePost(dir, 'youth-leap-account-2026-guide', '아무 제목');
  ok('slug 중복 검출', !!dupSlug && /slug 중복/.test(dupSlug.reason), `-> ${dupSlug?.reason || '미검출'}`);
  ok('중복 시 소유 파일을 특정', dupSlug?.file === 'a.md');
  const dupTitle = findDuplicatePost(dir, 'brand-new-slug', '청년도약계좌 가이드');
  ok('정규화 제목 중복 검출', !!dupTitle && /제목 중복/.test(dupTitle.reason), `-> ${dupTitle?.reason || '미검출'}`);
  const noDup = findDuplicatePost(dir, 'brand-new-slug', '완전히 다른 주제입니다');
  ok('새 주제는 통과', noDup === null);

  console.log('\n[1.7] 방금 생성한 파일을 자기 자신과 비교하지 않는다 (오탐 방지)');
  // 실제 결함: 생성된 파일이 이미 postsDir 에 있는 상태에서 중복 검사를 돌리면
  // 자기 자신의 slug 와 항상 일치해 "중복" 으로 오판되고 발행이 실패했다.
  fs.writeFileSync(path.join(dir, 'b.md'), '---\ntitle: "근로장려금 반기 신청 가이드"\nslug: "eitc-half-year-2026"\n---\n');
  const selfPath = path.join(dir, 'b.md');
  const id = readPostIdentity(selfPath);
  ok('생성 파일에서 slug/title 을 읽음', id.slug === 'eitc-half-year-2026' && id.title.includes('근로장려금'));
  // 제외 집합은 '방금 만든 파일' 1개여야 한다
  const withExclude = findDuplicatePost(dir, id.slug, id.title, new Set(['b.md']));
  ok('생성 파일만 exclude 하면 자기 자신은 중복 아님', withExclude === null, `-> ${withExclude ? withExclude.reason : 'null'}`);
  // 회귀 방지: 실제 호출부는 "방금 만든 파일 1개"만 exclude 해야 한다.
  // beforeFiles(기존 발행글 목록)를 exclude 로 넘기면 대조 대상이 사라져 방어선이 무의미해진다.
  ok(
    '호출부가 생성 파일만 exclude 한다 (beforeFiles 전달 금지)',
    /new Set\(\[path\.basename\(result\.postFile\)\]\)/.test(src) &&
      !/findDuplicatePost\(postsDir,[^)]*beforeFiles\)/.test(src)
  );
  const realDup = findDuplicatePost(dir, 'youth-leap-account-2026-guide', '완전히 다른 제목', new Set(['b.md']));
  ok('exclude 집합과 무관하게 기존 글과의 중복은 검출', !!realDup && realDup.file === 'a.md', `-> ${realDup?.file || '미검출'}`);
  const withoutExclude = findDuplicatePost(dir, id.slug, id.title, null);
  ok('exclude 없으면 자기 자신을 중복으로 잡음(기대 동작)', !!withoutExclude && withoutExclude.file === 'b.md');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n[2] 충돌 없음');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-slug-'));
  fs.writeFileSync(path.join(dir, '26091801-a.md'), '---\nslug: "alpha-guide"\n---\n');
  fs.writeFileSync(path.join(dir, '26091801-b.md'), '---\nslug: "beta-guide"\n---\n');

  const fresh = resolveSlugCollision(dir, 'brand-new-guide-xyz');
  ok('새로운 slug 는 그대로 통과', fresh.slug === 'brand-new-guide-xyz' && !fresh.changed);
  ok('변경 시 소유자 정보 없음', fresh.owner === undefined);

  console.log('\n[3] 충돌 발생 → 다른 글이 쓰는 slug 를 덮어쓰지 않는다');
  const hit = resolveSlugCollision(dir, 'alpha-guide');
  ok('충돌을 감지해 변경됨', hit.changed === true, `-> "${hit.slug}"`);
  ok('기존 글과 다른 slug 로 분리됨', hit.slug !== 'alpha-guide');
  ok('충돌한 기존 파일을 특정해 알려줌', hit.owner === '26091801-a.md', `-> ${hit.owner}`);
  ok('요청 원본 slug 을 보존', hit.requested === 'alpha-guide');

  console.log('\n[4] 이미 분리된 slug(-2)는 재충돌하지 않는다');
  const second = resolveSlugCollision(dir, 'alpha-guide-2');
  ok('-2 는 사용 가능 상태로 통과', second.slug === 'alpha-guide-2' && !second.changed);

  // 실제로 -2 를 선점시킨 뒤에는 다시 밀려나야 한다
  fs.writeFileSync(path.join(dir, '26091901-c.md'), '---\nslug: "alpha-guide-2"\n---\n');
  const third = resolveSlugCollision(dir, 'alpha-guide');
  ok('연속 충돌 시 -3 으로 escalate', third.slug === 'alpha-guide-3', `-> "${third.slug}"`);

  console.log('\n[5] 큰 frontmatter 를 앞에서 잘라 읽어도 slug 을 놓치지 않는다');
  const big = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-slugbig-'));
  const filler = 'x'.repeat(5000); // slug 이 4096 바이트를 넘어가는 배치
  fs.writeFileSync(
    path.join(big, '26092001-big.md'),
    `---\ntitle: "${filler}"\ndescription: "${filler}"\nslug: "deep-slug-guide"\n---\n`
  );
  const deep = resolveSlugCollision(big, 'deep-slug-guide');
  ok('frontmatter 앞부분이 길어도 충돌을 감지', deep.changed === true, `-> "${deep.slug}"`);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(big, { recursive: true, force: true });
}

console.log(`\n===== 결과: ${pass} 통과 / ${fail} 실패 =====`);
process.exit(fail ? 1 : 0);
