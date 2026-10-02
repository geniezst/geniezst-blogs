#!/usr/bin/env node
/**
 * 기존 news 게시글 featured_image 소급 적용 (백필)
 *
 * [P2] 문제
 *   - 다이제스트 본문 카드의 이미지는 R2 에 정상적으로 올라가 있었지만
 *     `blog_posts.featured_image` 는 계속 빈 문자열이었다. 그래서
 *     목록 카드 · 상세 대표 이미지 · og:image · RSS enclosure 가 전부 공백이었다.
 *   - 파이프라인 수정은 앞으로 발행될 글만 고친다. 이미 발행된 글을 되돌리려면
 *     D1 에 이미 저장된 content 의 첫 카드 이미지 URL 을 다시 읽어
 *     featured_image(및 1200x630 OG 크롭본) 로 승격해야 한다.
 *
 * [동작]
 *   1. 원격 D1 에서 대상 게시글(content 포함)을 내려받는다.
 *   2. content 에서 첫 카드 이미지 URL 을 추출한다.
 *      - 우선 /api/images/ R2 경로를 재사용한다(재다운로드·재업로드 없음).
 *      - R2 경로가 아니면 원격 URL 로 보고 공용 모듈로 미러링한다.
 *   3. R2 에 아직 없는 1200x630 OG 크롭본을 만들어 올린다(과거 발행분은 크롭본이 없다).
 *   4. D1 의 featured_image / image_width / image_height / og_image 를 갱신한다.
 *
 * [안전장치]
 *   - 기본은 --dry-run. --apply 를 명시해야 실제 반영한다.
 *   - 이미 featured_image 가 채워진 글은 건너뛴다(--force 로 재실행 가능).
 *   - 이미지가 하나도 없는 글은 SKIP 으로 보고, 지우지 않는다.
 *
 * [사용법]
 *   node scripts/backfill-featured-image.mjs --category news            # 미리보기
 *   node scripts/backfill-featured-image.mjs --category news --apply     # 실제 반영
 *   node scripts/backfill-featured-image.mjs --all --apply                # 전체 카테고리
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { mirrorArticleImage, cropOgImage, uploadToR2 } from './lib/image-pipeline.mjs';

const BLOG_ROOT = path.resolve(import.meta.dirname, '..');

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
const ALL = argv.includes('--all');
const slugIdx = argv.indexOf('--slug');
const SLUG = slugIdx !== -1 ? argv[slugIdx + 1] : null;
const catIdx = argv.indexOf('--category');
const CATEGORY = catIdx !== -1 ? argv[catIdx + 1] : 'news';

function d1Query(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', D1_NAME, '--remote', '--json', '--command', sql],
    { cwd: BLOG_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000, env: process.env }
  );
  const parsed = JSON.parse(out);
  return parsed?.[0]?.results ?? [];
}

/**
 * content 에서 첫 카드 이미지 URL 을 뽑는다.
 *
 * 우선순위:
 *  1. R2 미러 경로(/api/images/...) — 이미 검증·정규화·업로드된 이미지. 재처리 불필요.
 *  2. 외부 http(s) URL — 원본 미러링이 필요할 수 있다.
 *  3. 없으면 null
 */
function extractFirstImage(content) {
  if (!content) return null;

  // 1) R2 미러 경로
  const r2m = content.match(/\/api\/images\/[A-Za-z0-9._/-]+/);
  if (r2m) return { url: r2m[0], kind: 'r2' };

  // 2) 외부 이미지 URL (파일 확장자가 있는 것만)
  const extM = content.match(/https?:\/\/[^\s)"'<>]+\.(?:jpe?g|png|webp|gif|avif)(?:\?[^\s)"'<>]*)?/i);
  if (extM) return { url: extM[0], kind: 'remote' };

  return null;
}

const esc = (s) => String(s ?? '').replace(/'/g, "''");

/** R2 객체가 실제로 존재하는지 확인 (없으면 false) */
function r2Exists(key) {
  const tmp = path.join(os.tmpdir(), `r2check_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  try {
    execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `${R2_BUCKET}/images/${key}`, '--remote', '--file', tmp], {
      cwd: BLOG_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });
    return fs.existsSync(tmp) && fs.statSync(tmp).size > 0;
  } catch (_) {
    return false;
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_) {}
  }
}

/** R2 에서 이미지를 내려받아 버퍼로 반환. 없으면 null */
function r2Download(key) {
  const tmp = path.join(os.tmpdir(), `r2get_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  try {
    execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `${R2_BUCKET}/images/${key}`, '--remote', '--file', tmp], {
      cwd: BLOG_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) return null;
    return fs.readFileSync(tmp);
  } catch (_) {
    return null;
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_) {}
  }
}

async function verifyAndBuildOg(imageUrl, slug) {
  // ── 1. 이미 R2 에 있는 경로 ───────────────────────────────────────────
  if (imageUrl.startsWith('/api/images/')) {
    const key = imageUrl.replace(/^\/api\/images\//, '');

    if (!r2Exists(key)) {
      return { ok: false, error: `R2 객체 없음: images/${key}` };
    }

    // OG 크롭본이 이미 있으면 재사용
    const ogKey = key.replace(/\.(jpe?g|png|webp|avif)$/i, '-og.jpg');
    if (r2Exists(ogKey)) {
      return { ok: true, ogUrl: `/api/images/${ogKey}`, width: null, height: null, reused: true };
    }

    // [P2] OG 크롭본이 없다 → 지금 만든다.
    //   발행 시점 파이프라인이 og_image 를 넣기 전의 글이므로 크롭본도 없다.
    //   Workers 런타임에 sharp 가 없어 요청 시점 크롭이 불가능하므로,
    //   여기서 1200x630 JPEG 를 만들어 올린다.
    const buf = r2Download(key);
    if (!buf) return { ok: false, error: `R2 다운로드 실패: images/${key}` };

    const og = await cropOgImage(buf);
    if (!og.ok) return { ok: false, error: `OG 크롭 실패: ${og.error}` };

    if (!uploadToR2({ blogRoot: BLOG_ROOT, bucket: R2_BUCKET, key: ogKey, buffer: og.buffer })) {
      return { ok: false, error: `OG 업로드 실패: ${ogKey}` };
    }
    console.log(`   🆕 OG 크롭본 생성: images/${ogKey}`);

    // 원본 픽셀 크기도 DB 에 넣어 CLS 를 없앤다
    const meta = await sharpMeta(buf);

    return {
      ok: true,
      ogUrl: `/api/images/${ogKey}`,
      width: meta?.width ?? null,
      height: meta?.height ?? null,
    };
  }

  // ── 2. 외부 URL → 검증 + 정규화 + OG 크롭까지 한 번에 ────────────────
  // 슬러그를 그대로 쓰지 않는다: 슬러그는 YYMMDD 접두사를 제거하며
  // 장문이라 키가 불필요하게 길어진다. 의미 있는 축약형을 만든다.
  const shortSlug = String(slug || 'backfill')
    .replace(/^\d{6,8}-?/, '')
    .replace(/[^a-z0-9-]/gi, '-')
    .slice(0, 40) || 'backfill';
  const mirrored = await mirrorArticleImage(imageUrl, {
    blogRoot: BLOG_ROOT,
    bucket: R2_BUCKET,
    slug: shortSlug,
    log: (m) => console.log(m),
  });
  if (!mirrored.url) return { ok: false, error: mirrored.error || '미러링 실패' };
  return {
    ok: true,
    url: mirrored.url,
    width: mirrored.width,
    height: mirrored.height,
    ogUrl: mirrored.ogUrl || null,
  };
}

/** sharp 로 버퍼의 픽셀 크기를 읽는다 (실패 시 null) */
async function sharpMeta(buf) {
  try {
    const { default: sharp } = await import('sharp');
    const m = await sharp(buf).metadata();
    return { width: m.width ?? null, height: m.height ?? null };
  } catch (_) {
    return null;
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log(`📸 기존 글 featured_image 백필 — ${APPLY ? '실행 모드(APPLY)' : 'DRY-RUN'}`);
  console.log(`   대상 D1: ${D1_NAME} / R2: ${R2_BUCKET} / 카테고리: ${ALL ? '전체' : CATEGORY}`);
  console.log('='.repeat(70));

  // 주의: 일반 문자열 안의 ${...} 는 템플릿 리터럴이 아니므로 그대로 문자열이 된다.
  // 카테고리 슬러그를 치환하려면 여기서 실제로 값을 넣어야 한다.
  const catFilter = `status='published' AND category_id=(SELECT id FROM blog_categories WHERE slug='${esc(CATEGORY)}')`;
  const where = SLUG ? `slug='${esc(SLUG)}'` : (ALL ? `status='published'` : catFilter);
  const rows = d1Query(
    `SELECT slug, title, featured_image, content FROM blog_posts WHERE ${where} ORDER BY published_at DESC`
  );

  console.log(`\n대상 게시글 ${rows.length}건\n`);

  const stats = { total: rows.length, skipped: 0, noImage: 0, filled: 0, failed: 0, alreadySet: 0 };
  const updates = [];

  for (const row of rows) {
    const { slug, title, featured_image: current, content } = row;

    if (current && !FORCE) {
      stats.alreadySet++;
      console.log(`⏭  ${slug}\n     이미 featured_image 있음: ${current}`);
      continue;
    }

    const found = extractFirstImage(content);
    if (!found) {
      stats.noImage++;
      console.log(`🚫 ${slug}\n     content 에 이미지 URL 이 없어 SKIP (삭제/변경 없음)`);
      continue;
    }

    console.log(`🔍 ${slug}\n     첫 카드 이미지: ${found.url} (${found.kind})`);

    const built = await verifyAndBuildOg(found.url, slug);
    if (!built.ok) {
      stats.failed++;
      console.log(`   ❌ ${built.error}`);
      continue;
    }

    const newFeatured = built.url || found.url; // R2 재사용이면 기존 경로 그대로
    stats.filled++;
    console.log(`   ✅ featured_image → ${newFeatured}`);
    if (built.ogUrl) console.log(`      og_image       → ${built.ogUrl}`);
    else if (built.reused) console.log(`      og_image       → (기존 OG 크롭본 재사용)`);

    updates.push({
      slug,
      featured: newFeatured,
      width: built.width,
      height: built.height,
      og: built.ogUrl || null,
    });
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`결과: 전체 ${stats.total} | 채움 ${stats.filled} | 이미있음 ${stats.alreadySet} | 이미지없음 ${stats.noImage} | 실패 ${stats.failed}`);
  console.log('='.repeat(70));

  if (!APPLY) {
    console.log('\n💡 DRY-RUN 모드입니다. 실제 반영하려면 --apply 를 붙이세요.');
    console.log(`   예) node scripts/backfill-featured-image.mjs --category ${CATEGORY} --apply\n`);
    return;
  }

  if (updates.length === 0) {
    console.log('\n반영할 변경이 없습니다.\n');
    return;
  }

  // D1(SQLite) 의 UPDATE ... FROM (VALUES) 호환성을 고려해 UPDATE 문을 개별 생성한다.
  // 크기를 모르는(R2 재사용) 행은 기존 값을 보존하도록 COALESCE 를 쓴다.
  const statements = updates
    .map(
      (u) => `UPDATE blog_posts SET
  featured_image = '${esc(u.featured)}',
  image_width    = COALESCE(${u.width || 'NULL'}, image_width),
  image_height   = COALESCE(${u.height || 'NULL'}, image_height),
  og_image       = ${u.og ? `'${esc(u.og)}'` : 'og_image'}
WHERE slug = '${esc(u.slug)}';`
    )
    .join('\n');

  // Cloudflare D1 은 SQL 레벨 BEGIN TRANSACTION 을 거부한다(Durable Object storage 규칙).
  // UPDATE 는 원자적이므로 트랜잭션 없이 그대로 실행한다.
  const sql = `${statements}\n`;
  const tmp = path.join(os.tmpdir(), `backfill_${Date.now()}.sql`);
  fs.writeFileSync(tmp, sql, 'utf8');
  try {
    execFileSync('npx', ['wrangler', 'd1', 'execute', D1_NAME, '--remote', '--file', tmp, '--yes'], {
      cwd: BLOG_ROOT,
      stdio: 'inherit',
      timeout: 120000,
    });
    console.log(`\n🎉 ${updates.length}건 반영 완료\n`);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

main().catch((e) => {
  console.error('\n❌ 백필 실패:', e.message);
  process.exit(1);
});
