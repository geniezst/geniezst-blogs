#!/usr/bin/env node
/**
 * AI 콘텐츠 자동 발행 CLI 도구 (NAS -> Cloudflare D1 & R2)
 * 사용법: node scripts/publish-post.mjs <markdown-file>
 * 
 * [절대 규칙]
 * - 오직 D1 "geniezst-blog" 및 R2 "geniezst-blog"만 사용
 * - cocipe, nudiet 등 타 리소스 절대 접근 금지
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';

// 환경 변수 자동 로드 (.env)
for (const envPath of [
  path.resolve('/workspace/.env'),
  path.resolve('/workspace/scripts/.env'),
  path.join(path.resolve(import.meta.dirname, '..'), '.env'),
]) {
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const k = trimmed.slice(0, eq).trim();
      let v = trimmed.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

const TARGET_D1 = 'blogs';
const TARGET_R2 = 'blogs';

function parseFrontmatter(fileContent) {
  const match = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error('Frontmatter (---) 형식을 찾을 수 없습니다.');
  }

  const yamlBlock = match[1];
  const content = match[2].trim();
  const metadata = {};

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      metadata[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    } else {
      metadata[key] = value;
    }
  }

  return { metadata, content };
}

/**
 * AI 특유의 다중 공백(2칸 이상 연속 띄어쓰기) 및 불필요한 여백 자동 정제
 * 코드 블록(```) 내부는 서식을 보존하고, 일반 문단의 2칸 이상 연속 띄어쓰기를 1칸으로 정리
 */
function sanitizeProseSpaces(rawText) {
  if (!rawText) return '';
  const lines = rawText.split('\n');
  let inCode = false;
  const processed = lines.map((line) => {
    if (line.trim().startsWith('```')) {
      inCode = !inCode;
      return line;
    }
    if (inCode) {
      return line;
    }
    // 마크다운 표 구분선(|---|)은 서식 유지
    if (/^\s*\|.*\|\s*$/.test(line)) {
      return line;
    }
    // 2칸 이상 연속 띄어쓰기를 1칸으로 정제 및 행 끝 공백 제거
    let cleaned = line.replace(/([^\s])\s{2,}([^\s])/g, '$1 $2').replace(/\s+$/, '');
    // '70만 원' -> '70만원', '5,000만 원' -> '5,000만원' 등 금융 금액 띄어쓰기 표준화
    cleaned = cleaned.replace(/(\d+(?:,\d+)*(?:\.\d+)?)\s*만\s+원/g, '$1만원');
    cleaned = cleaned.replace(/(\d+(?:,\d+)*(?:\.\d+)?)\s*억\s+원/g, '$1억원');
    return cleaned;
  });
  return processed.join('\n');
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('사용법: node scripts/publish-post.mjs <markdown-file>');
    process.exit(1);
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`파일을 찾을 수 없습니다: ${resolvedPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(resolvedPath, 'utf8');
  let { metadata, content } = parseFrontmatter(raw);

  // 다중 공백 정제
  content = sanitizeProseSpaces(content);
  let title = (metadata.title || '').replace(/\s{2,}/g, ' ').trim();
  // 콜론(:) 및 장황한 부제 자동 제거 (간결한 단일 제목 원칙)
  if (title.includes(':')) {
    title = title.split(':')[0].trim();
  }
  const slug = (metadata.slug || '').trim();
  const description = (metadata.description || '').replace(/\s{2,}/g, ' ').trim();
  const categorySlug = metadata.category || 'welfare';
  const author = metadata.author || '포켓머니';
  const readingTime = Number(metadata.reading_time || 5);
  const affiliate = metadata.affiliate === 'true' || metadata.affiliate === true ? 1 : 0;
  let featuredImage = metadata.featured_image || null;

  if (!title || !slug) {
    throw new Error('Frontmatter에 title과 slug는 필수입니다.');
  }

  console.log(`[1/3] 포스트 파싱 완료: "${title}" (${slug})`);

  // 이미지 업로드 처리 (로컬 파일인 경우 R2로 업로드)
  if (featuredImage && !featuredImage.startsWith('http') && fs.existsSync(path.resolve(path.dirname(resolvedPath), featuredImage))) {
    const localImgPath = path.resolve(path.dirname(resolvedPath), featuredImage);
    const ext = path.extname(localImgPath);
    const datePrefix = new Date().toISOString().slice(0, 7).replace('-', '/');
    const r2Key = `images/${datePrefix}/${slug}${ext}`;

    console.log(`[2/3] R2 버킷(${TARGET_R2})에 이미지 업로드 중: ${r2Key}...`);
    execSync(`wrangler r2 object put "${TARGET_R2}/${r2Key}" --file="${localImgPath}" --remote`, {
      stdio: 'inherit',
    });
    featuredImage = `/api/images/${datePrefix}/${slug}${ext}`;
  } else {
    console.log(`[2/3] R2 이미지 업로드 단계 건너뜀 (외부 URL 또는 이미지 없음)`);
  }

  // D1에 포스트 및 태그 등록
  console.log(`[3/3] Cloudflare D1(${TARGET_D1})에 등록 중...`);

  // SQL 이스케이프
  const esc = (str) => (str ? str.replace(/'/g, "''") : '');

  const sql = `
INSERT INTO blog_posts (
  slug, title, description, content, category_id, status, author, featured_image,
  reading_time_minutes, affiliate_disclosure, published_at, updated_at
)
VALUES (
  '${esc(slug)}',
  '${esc(title)}',
  '${esc(description)}',
  '${esc(content)}',
  (SELECT id FROM blog_categories WHERE slug = '${esc(categorySlug)}' LIMIT 1),
  'published',
  '${esc(author)}',
  ${featuredImage ? `'${esc(featuredImage)}'` : 'NULL'},
  ${readingTime},
  ${affiliate},
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  content = excluded.content,
  category_id = excluded.category_id,
  status = excluded.status,
  author = excluded.author,
  featured_image = excluded.featured_image,
  reading_time_minutes = excluded.reading_time_minutes,
  affiliate_disclosure = excluded.affiliate_disclosure,
  updated_at = CURRENT_TIMESTAMP;
`;

  // 임시 SQL 파일 생성 후 --file 옵션으로 안전하게 실행
  const tempSqlPath = path.join(os.tmpdir(), `d1_publish_${Date.now()}.sql`);
  fs.writeFileSync(tempSqlPath, sql, 'utf8');

  try {
    execSync(`wrangler d1 execute "${TARGET_D1}" --remote --file="${tempSqlPath}" --yes`, {
      stdio: 'inherit',
    });
  } finally {
    if (fs.existsSync(tempSqlPath)) {
      fs.unlinkSync(tempSqlPath);
    }
  }

  console.log(`\n🎉 포스트 발행 완료!`);
  console.log(`- 제목: ${title}`);
  console.log(`- 사이트 경로: /blog/${slug}`);
  console.log(`- 카테고리: ${categorySlug}`);

  // Bing IndexNow 실시간 색인 제출
  await notifyIndexNow(slug);
}

async function notifyIndexNow(slug) {
  const host = 'pockemoney.com';
  const key = '6059e7c7aa31475986bb3547ace2c153';
  const keyLocation = `https://${host}/${key}.txt`;
  const postUrl = `https://${host}/blog/${slug}`;

  try {
    console.log(`\n📡 [IndexNow] 실시간 색인 제출 요청 중...`);
    const res = await fetch('https://api.indexnow.org/IndexNow', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        host,
        key,
        keyLocation,
        urlList: [`https://${host}/`, postUrl],
      }),
    });
    if (res.status === 200 || res.status === 202) {
      console.log(`✅ [IndexNow] 제출 성공 (HTTP ${res.status}): ${postUrl}`);
    } else {
      console.warn(`⚠️ [IndexNow] 응답 코드 HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`⚠️ [IndexNow] 제출 건너뜀 (${err.message})`);
  }
}

main().catch((err) => {
  console.error('발행 실패:', err.message);
  process.exit(1);
});
