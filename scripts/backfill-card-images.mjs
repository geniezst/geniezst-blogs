#!/usr/bin/env node
/**
 * 기존 다이제스트 게시글의 **카드별 출처 이미지** 소급 삽입 (백필)
 *
 * [왜 필요한가]
 *   2026-09-30 파이프라인 결함 2건이 겹쳐 카드 3/4 개가 이미지가 없이 발행됐다.
 *     1) fetchArticleOgImage 가 "우선순위에서 처음 발견한 1장"만 반환했다.
 *        기사의 og:image 가 사이트 로고(korea_logo_2024.jpg) 나 저해상도 썸네일이면
 *        같은 기사에 실린 720px 급 실사 사진은 시도조차 되지 않았다.
 *     2) 그 1장이 해상도 기준 미달이면 attempts 가 비어 카드 전체가 실패했다.
 *
 *   이 스크립트는 이미 발행된 글에 대해 같은 출처 기사에서 검증 통과 이미지를
 *   찾아 R2 에 미러링하고 카드에 삽입한다. 파이프라인 수정은 앞으로의 글에만 적용되므로
 *   이미 발행된 글은 이 스크립트로 되돌린다.
 *
 * [엄격 규칙]
 *   - 오직 해당 카드의 출처 기사에 실린 이미지만 사용한다 (타 기사 이미지 대체 금지).
 *   - 이미지가 이미 있는 카드는 건너뛴다 (--force 로 재시도 가능).
 *   - featured_image 가 비어 있을 때만 첫 카드로 승격한다. 비어 있지 않으면 건드리지 않는다.
 *
 * [사용법]
 *   node scripts/backfill-card-images.mjs --slug 26093001-...            # 미리보기 (기본)
 *   node scripts/backfill-card-images.mjs --slug 26093001-... --apply    # 실제 반영
 *   node scripts/backfill-card-images.mjs --latest --apply               # 최신 글
 *   node scripts/backfill-card-images.mjs --latest --apply --no-d1       # 로컬 파일만
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mirrorArticleImage } from './lib/image-pipeline.mjs';
import { collectArticleImageCandidates } from './generate-news-digest.mjs';

const BLOG_ROOT = path.resolve(import.meta.dirname, '..');
const POSTS_DIR = path.join(BLOG_ROOT, 'content/posts');

// 환경 변수 명시적 로드
const envCandidates = [
  path.resolve('/workspace/.env'),
  path.resolve('/workspace/scripts/.env'),
  path.join(BLOG_ROOT, '.env'),
];
for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    } catch (_) {}
  }
}

const D1_NAME = process.env.TARGET_D1 || process.env.CLOUDFLARE_D1_DATABASE_BLOGS || 'blogs';
const R2_BUCKET = process.env.TARGET_R2 || process.env.CLOUDFLARE_R2_BUCKET_BLOGS || 'blogs';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const FORCE = argv.includes('--force');
const NO_D1 = argv.includes('--no-d1');
const LATEST = argv.includes('--latest');
const slugIdx = argv.indexOf('--slug');
const SLUG = slugIdx !== -1 ? argv[slugIdx + 1] : null;

if (!SLUG && !LATEST) {
  console.error('사용법: --slug <slug> 또는 --latest');
  process.exit(1);
}

const esc = (s) => String(s ?? '').replace(/'/g, "''");

function d1Query(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', D1_NAME, '--remote', '--command', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: BLOG_ROOT, env: process.env }
  );
  const m = out.match(/\[[\s\S]*\]/g);
  if (!m) return [];
  return JSON.parse(m[m.length - 1])[0]?.results || [];
}

const targetSlug =
  SLUG ||
  fs
    .readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .pop()
    .replace(/\.md$/, '');

const file = path.join(POSTS_DIR, `${targetSlug}.md`);
if (!fs.existsSync(file)) {
  console.error(`❌ 글 파일 없음: ${file}`);
  process.exit(1);
}

const raw = fs.readFileSync(file, 'utf8');
const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
if (!fmMatch) {
  console.error('❌ frontmatter 파싱 실패');
  process.exit(1);
}
const frontmatter = fmMatch[0];
const body = raw.slice(frontmatter.length);

const SOURCE_RE = />\s*\*\*출처\*\*:\s*\[([^\]]*)\]\((https?:\/\/[^)]+)\)/i;

console.log(`\n════ 카드 이미지 백필 ════`);
console.log(`  대상: ${targetSlug}`);
console.log(`  모드: ${APPLY ? '적용(APPLY)' : '미리보기(DRY-RUN)'}${NO_D1 ? ' / D1 제외' : ''}\n`);

const cards = body.split(/(?=^##\s+)/gm);
const usedImageUrls = new Set();
const results = [];

for (let i = 0; i < cards.length; i++) {
  const card = cards[i];
  if (!card.startsWith('## ')) continue;

  const hasImage = /!\[/.test(card);
  const h2EndIdx = card.indexOf('\n');
  const h2Line = h2EndIdx !== -1 ? card.slice(0, h2EndIdx) : card;
  const title = h2Line.replace(/^##\s+(\[[^\]]+\]\s*)?/, '').trim();

  if (hasImage && !FORCE) {
    const m = card.match(/\/api\/images\/[^\s)"']+/);
    if (m) usedImageUrls.add(m[0]);
    results.push({ idx: i, title, status: 'skip', reason: '이미지 존재' });
    continue;
  }

  const src = card.match(SOURCE_RE);
  if (!src) {
    results.push({ idx: i, title, status: 'skip', reason: '출처 링크 없음' });
    continue;
  }
  const [, sourceName, sourceUrl] = src;

  let mirrored = null;
  let tried = 0;
  const candidates = await collectArticleImageCandidates(sourceUrl, 4);
  const usable = candidates.filter((u) => !usedImageUrls.has(u));

  for (const cand of usable) {
    tried++;
    const m = await mirrorArticleImage(cand, {
      blogRoot: BLOG_ROOT,
      bucket: R2_BUCKET,
      slug: `${targetSlug.slice(0, 60)}-${i}`,
      referer: sourceUrl,
      log: () => {},
    });
    if (m.url) {
      mirrored = m;
      usedImageUrls.add(cand);
      break;
    }
  }

  if (!mirrored) {
    results.push({ idx: i, title, status: 'fail', reason: `후보 ${tried}건 시도 전부 실패` });
    console.log(`  ❌ [카드 ${i}] ${title.slice(0, 34)} — 후보 ${tried}건 실패`);
    continue;
  }

  // 카드 재구성: H2 직후 이미지 + 사진 출처 캡션
  let rest = h2EndIdx !== -1 ? card.slice(h2EndIdx).trim() : '';
  rest = rest.replace(/!\[[^\]]*\]\([^)]+\)\s*/g, '');
  rest = rest.replace(/<p class="text-xs text-center[^>]*>.*?<\/p>\s*/gi, '');
  const caption = `<p class="text-xs text-center text-neutral-500 dark:text-neutral-400 my-1">사진 출처: <a href="${sourceUrl}" target="_blank" rel="noopener noreferrer">${sourceName}</a></p>`;
  cards[i] = `${h2Line}\n\n![${title}](${mirrored.url})\n${caption}\n\n${rest}\n\n`;

  results.push({
    idx: i,
    title,
    status: 'ok',
    url: mirrored.url,
    size: `${mirrored.width}x${mirrored.height}`,
  });
  console.log(
    `  ✅ [카드 ${i}] ${title.slice(0, 30)} → ${mirrored.width}x${mirrored.height} (후보 ${tried}번째)`
  );
}

const okCount = results.filter((r) => r.status === 'ok').length;
const failCount = results.filter((r) => r.status === 'fail').length;
const skipCount = results.filter((r) => r.status === 'skip').length;
console.log(`\n  합계: 성공 ${okCount} / 실패 ${failCount} / 건너뜀 ${skipCount}`);

if (!okCount) {
  console.log('\n  반영할 변경 없음 — 종료');
  process.exit(0);
}

const newBody = cards.join('');
let newFrontmatter = frontmatter;
const firstOk = results.find((r) => r.status === 'ok');

if (firstOk && /featured_image:\s*["']?["']?/.test(frontmatter)) {
  newFrontmatter = frontmatter.replace(/featured_image:\s*["']?["']?/, `featured_image: "${firstOk.url}"`);
  if (firstOk.size) {
    const [w, h] = firstOk.size.split('x');
    if (!/image_width:/.test(newFrontmatter)) {
      newFrontmatter = newFrontmatter.replace(/---\r?\n$/, `image_width: ${w || 1600}\nimage_height: ${h || 900}\n---\n`);
    }
  }
}
const newRaw = newFrontmatter + newBody;

if (!APPLY) {
  console.log('\n  ⏸ DRY-RUN — 실제 반영은 --apply 를 붙이세요');
  process.exit(0);
}

fs.writeFileSync(file, newRaw, 'utf8');
console.log(`\n  💾 로컬 파일 반영: ${path.relative(BLOG_ROOT, file)}`);

if (!NO_D1) {
  let updateSql = `UPDATE blog_posts SET content='${esc(newBody)}', updated_at=datetime('now')`;
  if (firstOk) {
    updateSql += `, featured_image=CASE WHEN featured_image IS NULL OR featured_image='' THEN '${esc(firstOk.url)}' ELSE featured_image END`;
    if (firstOk.size) {
      const [w, h] = firstOk.size.split('x');
      updateSql += `, image_width=COALESCE(image_width, ${w || 1600}), image_height=COALESCE(image_height, ${h || 900})`;
    }
  }
  updateSql += ` WHERE slug='${esc(targetSlug)}'; SELECT changes() AS updated;`;
  const rows = d1Query(updateSql);
  console.log(`  🗄️ D1 content & featured_image 갱신: ${rows?.[0]?.updated ?? 0}행`);
}

console.log('\n  다음 단계: npm run build 후 git 커밋·푸시');
