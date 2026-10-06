#!/usr/bin/env node
/**
 * [SHARED] 원본 이미지 수집 → 정규화 → R2 미러링 파이프라인
 *
 * [왜 필요한가 — 실제 확인된 결함]
 * 1) 확장자/MIME 불일치
 *    기존 코드는 URL 에서 확장자를 뽑고(없으면 무조건 'jpg') 그것을 R2 키에 썼다.
 *    https://social.news.hada.io/topic/... 는 실제로 `content-type: image/png` 인데
 *    `.jpg` 키로 저장되어 /api/images 가 PNG 바이트를 `image/jpeg` 로 서빙했다.
 *    → 확장자·MIME 을 URL 이 아니라 **바이트**에서 판정한다.
 *
 * 2) 매직 바이트 검증 부재 → HTML/에러 페이지 통과 위험
 *    기존 최소 크기 검사는 `if (dims && dims.width < 250)` 형태라
 *    `getImageDimensions()` 가 null 을 반환하면 **검증 자체가 통째로 건너뛰어진다.**
 *    동시에 Content-Type 검사도 `|| !ct` 로 헤더가 비면 통과시켰다.
 *    → 스니핑으로 실제 이미지 포맷을 먼저 확정한 뒤에야 나머지 검사를 수행한다.
 *
 * 3) HD 업그레이드 미흡
 *    기존 정규식은 `_v\d+`, `_s\d+`, `_thumb`, `150x150` 만 처리했다.
 *    `_l`, `_m`, `_x\d+`, `?w=`, `/resize/`, `c_limit` 는 미커버 →
 *    로그에서 `_l.jpg` (썸네일) 가 대표 이미지로 채택된 사례가 있다.
 *    → 후보를 넓게 생성하고 **실제 픽셀 면적으로 승부**를 한다.
 *
 * 4) Referer 미송신
 *    핫링크 보호 포털(korea.kr, newsis 등)에서 403 이 나면 이미지가 조용히 사라진다.
 *    → `Referer: <출처 기사 URL>` 을 반드시 송신한다.
 *
 * 5) 해상도 부족 → HiDPI 흐림
 *    R2 실측 결과 720x480, 960x640, 720x395, 800x1067 등이 저장돼 있었다.
 *    본문 컬럼 폭이 약 730 CSS px 이므로 2x DPR 에서 2배 업스케일된다.
 *    → sharp 로 1200px 기준 정규화 + WebP 변환. 가로 640px 미만은 기각.
 *
 * [호환] sharp 0.35.4 는 두 프로젝트 node_modules 에 이미 설치되어 있다 (Astro 전이 의존성).
 *
 * 공용 모듈: /workspace/projects/{blog,blogs}/scripts/lib/image-pipeline.mjs (동일 사본)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const NODE22_BIN = '/workspace/.node22/bin';
if (fs.existsSync(NODE22_BIN) && !process.env.PATH?.includes(NODE22_BIN)) {
  process.env.PATH = `${NODE22_BIN}:${process.env.PATH || ''}`;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** 정규화 정책 (FR-2.4) */
export const IMAGE_POLICY = {
  MIN_WIDTH: 350, // 본문 하한. 350px 이상 프레스/언론사 보도사진 허용 (아이콘/프로필 기각)
  TARGET_WIDTH: 1200, // 정규화 기준 폭
  MAX_WIDTH: 1600, // 이 값을 넘으면 축소
  WEBP_QUALITY: 82,
  MAX_BYTES: 8 * 1024 * 1024, // 원본 다운로드 상한
  OG_WIDTH: 1200, // OG 표준 폭
  OG_HEIGHT: 630, // OG 표준 높이 (1.905:1)
  OG_QUALITY: 88,
};

// ---------------------------------------------------------------------------
// 1) 매직 바이트 스니핑 — "이 바이트가 정말 이미지인가"의 유일한 판정 기준
// ---------------------------------------------------------------------------

const MAGIC_TABLE = [
  { type: 'jpeg', ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'png', ext: 'png', mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'gif', ext: 'gif', mime: 'image/gif', test: (b) => b.toString('ascii', 0, 3) === 'GIF' },
  {
    type: 'webp',
    ext: 'webp',
    mime: 'image/webp',
    test: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
  {
    type: 'avif',
    ext: 'avif',
    mime: 'image/avif',
    test: (b) => b.toString('ascii', 4, 8) === 'ftyp' && /avif|avis|mif1/.test(b.toString('ascii', 8, 16)),
  },
  { type: 'bmp', ext: 'bmp', mime: 'image/bmp', test: (b) => b[0] === 0x42 && b[1] === 0x4d },
];

/**
 * 바이트에서 실제 포맷을 판정한다. 확장자·Content-Type 을 믿지 않는다.
 * @returns {{ type, ext, mime } | null}
 */
export function sniffImageFormat(buffer) {
  if (!buffer || buffer.length < 12) return null;
  for (const f of MAGIC_TABLE) {
    try {
      if (f.test(buffer)) return { type: f.type, ext: f.ext, mime: f.mime };
    } catch (_) {}
  }
  return null;
}

/** sharp 메타데이터로 실제 픽셀 크기. 실패 시 null (기존 이진 파서 대체) */
export async function readDimensions(buffer) {
  try {
    const md = await sharp(buffer, { limitInputPixels: false }).metadata();
    if (md && md.width > 0 && md.height > 0) return { width: md.width, height: md.height };
  } catch (_) {}
  return null;
}

// ---------------------------------------------------------------------------
// 2) 다운로드 — Referer / Accept-Language / Content-Type / 매직바이트 4중 검증
// ---------------------------------------------------------------------------

/**
 * Google News 래퍼 페이지(news.google.com/rss/articles/...)가 og:image 로 내보내는
 * 기본 이미지 자산 ID. 어떤 언론사 기사를 크롤링하든 항상 같은 구글 로고가 나온다.
 */
const GOOGLE_NEWS_DEFAULT_ASSET =
  /J6_coFbogxhRI9iM864NL_liGXvsQp2AupsKei7z0cNNfDvGUmWUy20n/i;

/**
 * 기사 본문과 무관한 사이트 공통 로고, 플레이스홀더, 기자 증명사진, 배너 여부 판별
 */
export function isPlaceholderOrLogo(url) {
  if (!url) return true;
  const lower = url.toLowerCase();

  // 1. 명백한 로고 / 심볼 / 브랜드 패턴
  const logoPatterns = [
    'logo', 'ci_', '_ci', 'bi_', '_bi', 'symbol', 'emblem', 'brand',
    'korea_logo', 'header_logo', 'footer_logo', 'top_logo', 'site_logo',
    'common_logo', 'press_logo', 'media_logo', 'company_logo', 'logo_'
  ];
  if (logoPatterns.some((p) => lower.includes(p))) return true;

  // 2. 기본/대체/플레이스홀더 이미지
  const placeholderPatterns = [
    'default', 'no_image', 'noimage', 'placeholder', 'empty', 'dummy',
    'blank', 'spacer', 'transparent', 'not_found', 'error_img',
    'opengraph_default', 'common_og', 'main_og', 'share_default',
    'korea_default', 'og_default', 'sns_default'
  ];
  if (placeholderPatterns.some((p) => lower.includes(p))) return true;

  // 3. UI 컴포넌트, 아이콘, 배너
  const uiPatterns = [
    'favicon', 'icon_', '_icon', 'btn_', '_btn', 'button',
    'banner_', '_banner', 'event_banner', 'ad_banner', 'popup_',
    'gnb_', 'snb_', 'footer_', 'header_'
  ];
  if (uiPatterns.some((p) => lower.includes(p))) return true;

  // 4. 기자 프로필 / 증명사진 (기사 내용과 무관한 기자 얼굴)
  const reporterPatterns = [
    'reporter', 'journalist', 'author_img', 'writer_img', 'profile_photo',
    'profile_img', 'member_photo', 'staff_photo'
  ];
  if (reporterPatterns.some((p) => lower.includes(p))) return true;

  // 5. 뉴스 애그리게이터 래퍼 페이지 자산 (출처 기사 이미지가 절대로 아님)
  //    [P0] 2026-09-29 실제 오발생. Google News RSS 링크(news.google.com/rss/articles/CBMi...)
  //    를 그대로 크롤링하면 래퍼 페이지의 og:image 인 구글 자체 기본 이미지
  //    (J6_coFbogxhRI9iM864NL_liGXvsQp2AupsKei7z0cNNfDvGUmWUy20n)가 잡히고,
  //    모든 카드가 동일한 구글 로고로 채워졌다. URL 만 바꿔선 막을 수 없으므로
  //    여기서 원천 차단하고, 원문 URL 로 되돌린 뒤(generate-news-digest) 이미지를 얻는다.
  if (/^https?:\/\/(?:[a-z0-9-]+\.)*news\.google\.[a-z.]{2,6}\//i.test(url.trim())) return true;
  if (GOOGLE_NEWS_DEFAULT_ASSET.test(url)) return true;

  return false;
}

/**
 * 이미지를 내려받아 검증된 버퍼를 반환한다.
 * 실패 시 사유가 포함된 { error } 를 돌려주며 절대 조용히 null 을 반환하지 않는다.
 *
 * @param {string} url
 * @param {{ referer?: string, timeoutMs?: number, maxBytes?: number }} opts
 */
export async function fetchVerifiedImage(url, opts = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return { error: '잘못된 URL' };
  if (isPlaceholderOrLogo(url)) return { error: `로고/플레이스홀더/비기사 이미지 제외 (${url.slice(0, 60)})` };

  const referer = opts.referer || url;
  const timeoutMs = opts.timeoutMs || 10000;
  const maxBytes = opts.maxBytes || IMAGE_POLICY.MAX_BYTES;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'image/avif,image/webp,image/apng,image/*;q=0.8,*/*;q=0.5',
        // 핫링크 보호 포털 대응 (FR-1.3)
        Referer: referer,
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
  } catch (err) {
    return { error: `다운로드 예외: ${err.name === 'TimeoutError' ? '타임아웃' : err.message}` };
  }

  if (!res.ok) return { error: `HTTP ${res.status}` };

  // Content-Type 이 명시적으로 이미지가 아니면 거부 (FR-1.2: `|| !ct` 제거)
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (ct && !ct.startsWith('image/')) return { error: `Content-Type 이 이미지 아님 (${ct})` };
  if (ct === 'image/svg+xml') return { error: 'SVG 는 래스터 이미지로 취급하지 않음' };

  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) return { error: `용량 초과 (${Math.round(declared / 1048576)}MB)` };

  let buffer;
  try {
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { error: `본문 수신 실패: ${err.message}` };
  }

  if (buffer.length < 1024) return { error: `용량 너무 작음 (${buffer.length}B)` };

  // 결정적 판정: 매직 바이트
  const format = sniffImageFormat(buffer);
  if (!format) {
    const head = buffer.toString('utf8', 0, 80).replace(/\s+/g, ' ').slice(0, 60);
    return { error: `매직바이트 불일치 (이미지가 아님). 앞부분: "${head}"` };
  }

  // 헤더와 바이트가 어긋나도 매직 바이트가 유효한 이미지이면 포맷 우선 적용 (한국 언론사/CMS 오설정 대응)
  if (ct && ct !== format.mime && !(format.type === 'jpeg' && ct === 'image/jpg')) {
    // Content-Type 불일치는 거부 사유가 아님 (매직 바이트가 실제 포맷임을 입증함)
  }

  const dims = await readDimensions(buffer);
  if (!dims) return { error: `픽셀 크기 판독 실패 (${format.type})` };

  return { buffer, format, dims, bytes: buffer.length, sourceUrl: url };
}

// ---------------------------------------------------------------------------
// 3) HD 후보 생성 — 기존 정규식의 미커버 패턴을 넓힌다 (FR-1.4)
// ---------------------------------------------------------------------------

// 확장자 앞 접미사형 축소본 표기 (jtoday _v150, joongang _s150, ...)
const THUMBNAIL_SUFFIX =
  /[-_](v\d+|s\d+|m|l|x\d+|xl|xs|thumb|tmb|small|mini|tc)(?=\.(jpg|jpeg|png|webp|gif))/i;
// 경로형 축소본 표기 (네이버뉴스 /w500/, /h120/, /c250/ 등)
const THUMBNAIL_PATH = /\/(w|h|c|mw|mh)\d{2,4}(\/|$)/i;
const THUMBNAIL_DIR = /\/(thumb|thumbnails?|small|mini)\//i;
// newsis 의 l_<num>_<ts>.jpg 는 크기 버킷 코드이며 통상 제공 최고 해상도다.
const NEWSIS_OPAQUE_BUCKET = /\/l_\d+_\d+\./i;

const HD_QUERY_KEYS = ['w', 'width', 'cw', 'sw', 'maxwidth', 'size'];

/** 썸네일로 보이는지 판별 (정규식만, 네트워크 호출 없음) */
export function looksLikeThumbnail(url) {
  if (!url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return false;
  }
  // newsis 불투명 버킷 코드는 오탐이 크므로 먼저 제외한다
  if (NEWSIS_OPAQUE_BUCKET.test(url)) return false;

  if (THUMBNAIL_PATH.test(parsed.pathname) || THUMBNAIL_DIR.test(parsed.pathname)) return true;
  for (const key of HD_QUERY_KEYS) {
    const v = parsed.searchParams.get(key);
    if (v && Number(v) > 0 && Number(v) <= 400) return true;
  }
  if (/googleusercontent\.com/i.test(parsed.hostname) && /=w(?:[1-4]\d{2})\b/i.test(url)) return true;
  return THUMBNAIL_SUFFIX.test(url);
}

/**
 * 원본 후보 URL 목록을 생성한다. 순서대로 시도하며 실제로 픽셀이 큰 것을 고른다.
 * @returns {string[]}
 */
export function buildHdCandidates(url) {
  if (!url) return [];
  const out = new Set();
  const add = (u) => {
    if (u && u !== url && /^https?:\/\//i.test(u)) {
      try {
        new URL(u);
        out.add(u);
      } catch (_) {}
    }
  };

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return [];
  }

  // A) 경로 세그먼트 치환
  const dirVariants = [
    // 네이버뉴스: /w500/ /h120/ /c250/ -> /original/
    parsed.pathname.replace(/\/(?:mw|mh|w|h|c)\d{2,4}\//i, '/original/'),
    parsed.pathname.replace(/\/thumb\//i, '/'),
    parsed.pathname.replace(/\/small\//i, '/'),
    parsed.pathname.replace(/\/c_limit[/_-]/i, '/'),
  ];
  // A-2) 그누보드(Gnuboard) 및 CMS 썸네일 접두사/접미사 역추적
  const gnuboardVariants = [
    // /thumb-filename_600x337.jpg -> /filename.jpg
    parsed.pathname.replace(/\/thumb-([^/]+?)_\d+x\d+(\.[a-z0-9]+)$/i, '/$1$2'),
    // /thumb-filename.jpg -> /filename.jpg
    parsed.pathname.replace(/\/thumb-([^/]+)$/i, '/$1'),
    // filename_600x337.jpg -> filename.jpg
    parsed.pathname.replace(/_\d+x\d+(?=\.[a-z0-9]+$)/i, ''),
  ];
  // A-3) 확장자 앞 접미사 제거
  const suffixVariants = [
    parsed.pathname.replace(/[-_]v\d+(?=\.)/i, ''),
    parsed.pathname.replace(/[-_]s\d+(?=\.)/i, ''),
    parsed.pathname.replace(/[-_]x\d+(?=\.)/i, ''),
    parsed.pathname.replace(/[-_]xl(?=\.)/i, ''),
    parsed.pathname.replace(/[-_]xs(?=\.)/i, ''),
    parsed.pathname.replace(/[-_]l(?=\.)/i, ''),
    parsed.pathname.replace(/[-_]m(?=\.)/i, ''),
    parsed.pathname.replace(/[-_]thumb(?=\.)/i, ''),
    parsed.pathname.replace(/[-_]tmb(?=\.)/i, ''),
    parsed.pathname.replace(/[-_]small(?=\.)/i, ''),
    parsed.pathname.replace(/[-_]\d+x\d+(?=\.)/i, ''),
  ];
  for (const p of [...dirVariants, ...gnuboardVariants, ...suffixVariants]) {
    if (p !== parsed.pathname && p.includes('.')) {
      add(parsed.origin + p + parsed.search);
    }
  }

  // A-3) 원본 지정 파라미터 (Cloudinary / imgix 계열)
  for (const [key, value] of [
    ['w', 1600],
    ['width', 1600],
    ['cw', 1600],
    ['size', 'large'],
    ['format', 'original'],
  ]) {
    const p2 = new URL(url);
    p2.searchParams.set(key, String(value));
    add(p2.toString());
  }
  for (const pattern of [
    /\/resize\/\d+x\d+/i,
    /\/imageView\/.*$/i,
    /\/fit-in\/\d+x\d+/i,
    /\/c_limit[,_]/i,
  ]) {
    if (pattern.test(parsed.pathname)) {
      add(`${parsed.origin}${parsed.pathname.replace(pattern, '')}${parsed.search}`);
      add(`${parsed.origin}${parsed.pathname.replace(pattern, '/resize/1600x0')}${parsed.search}`);
    }
  }

  // A-4) Google CDN (googleusercontent.com 등): =s0-w300-rw, =w300 -> =w1200, =s0, =w1600
  if (/googleusercontent\.com/i.test(parsed.hostname) || /=s\d+|=w\d+/i.test(url)) {
    add(url.replace(/=(?:s\d+|w\d+|s0-w\d+)(?:-rw)?$/i, '=w1200'));
    add(url.replace(/=(?:s\d+|w\d+|s0-w\d+)(?:-rw)?$/i, '=s0'));
    add(url.replace(/=(?:s\d+|w\d+|s0-w\d+)(?:-rw)?$/i, '=w1600'));
  }

  // 원본은 항상 마지막 후보로 유지
  add(url);
  return [...out];
}

// ---------------------------------------------------------------------------
// 4) sharp 정규화 — 1200px 기준 + WebP (FR-2.4)
// ---------------------------------------------------------------------------

/**
 * 가로 640px 미만이면 기각, 그 외에는 1200px 기준으로 정규화한다.
 * 확대(upscale)는 하지 않는다.
 * @returns {Promise<{ buffer, width, height, ext, mime } | { error: string, width?: number, height?: number }>}
 */
export async function normalizeImage(buffer, opts = {}) {
  const minWidth = opts.minWidth || IMAGE_POLICY.MIN_WIDTH;
  const target = opts.targetWidth || IMAGE_POLICY.TARGET_WIDTH;
  const maxWidth = opts.maxWidth || IMAGE_POLICY.MAX_WIDTH;

  const dims = await readDimensions(buffer);
  if (!dims) return { error: '픽셀 크기 판독 실패' };

  // 세로로 긴 이미지는 가로 기준을 적용하기 어려우므로 축 비례 축소만 수행한다
  const landscape = dims.width >= dims.height;
  if (landscape && dims.width < minWidth) {
    return { error: `해상도 부족 (${dims.width}x${dims.height} < ${minWidth}px)`, width: dims.width, height: dims.height };
  }

  let targetWidth = dims.width;
  if (landscape) {
    if (dims.width > maxWidth) targetWidth = maxWidth;
    else if (dims.width > target) targetWidth = target; // 640~1600 구간은 1200 으로 정리
  }

  const out = await sharp(buffer, { limitInputPixels: false })
    .rotate() // EXIF 회전 반영
    .resize({ width: targetWidth, withoutEnlargement: true, fit: 'inside' })
    .webp({ quality: IMAGE_POLICY.WEBP_QUALITY, effort: 4 })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: out.data,
    width: out.info.width,
    height: out.info.height,
    ext: 'webp',
    mime: 'image/webp',
  };
}

// ---------------------------------------------------------------------------
// 5) R2 업로드 — 결과 기록 + 실패 전파 (FR-2.3)
// ---------------------------------------------------------------------------

/**
 * R2 에 오브젝트를 올리고 공개 URL 을 반환한다.
 * 키는 콘텐츠 해시를 포함해 교체 시 URL 이 달라진다 (FR-2.1).
 *
 * @param {object} p
 * @param {string} p.blogRoot  wrangler 실행 cwd (wrangler.toml 위치)
 * @param {string} p.bucket
 * @param {string} p.key
 * @param {Buffer} p.buffer
 * @param {(msg: string) => void} [p.log]
 */
/**
 * wrangler 실행 파일 경로
 *
 * [P1] 수정: 데몬은 PATH 에 node_modules/.bin 이 없는 상태(예: cron, systemd, opencode)에서
 *   도는데, 'wrangler' 를 그대로 쓰면 ENOENT 로 R2 업로드가 전부 조용히 실패했다.
 *   프로젝트 로컬 바이너리를 우선 사용하고, 없을 때만 npx 로 폴백한다.
 */
let _wranglerPath = null;
export function wranglerBin(blogRoot) {
  if (_wranglerPath) return _wranglerPath;
  const local = path.join(blogRoot, 'node_modules', '.bin', 'wrangler');
  _wranglerPath = fs.existsSync(local) ? local : 'npx';
  return _wranglerPath;
}

function getCloudflareEnv(blogRoot) {
  const env = { ...process.env };
  const envPaths = [
    '/workspace/.env',
    path.join(blogRoot, '.env'),
    path.resolve(process.cwd(), '.env'),
  ];
  for (const p of envPaths) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            const k = trimmed.slice(0, eq).trim();
            let v = trimmed.slice(eq + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
              v = v.slice(1, -1);
            }
            if (k.startsWith('CLOUDFLARE_') || !env[k]) env[k] = v;
            if (k.startsWith('CLOUDFLARE_') || !process.env[k]) process.env[k] = v;
          }
        }
      } catch (_) {}
    }
  }
  const NODE22_BIN = '/workspace/.node22/bin';
  const LOCAL_BIN = path.join(blogRoot, 'node_modules', '.bin');
  env.PATH = `${NODE22_BIN}:${LOCAL_BIN}:${env.PATH || ''}`;
  return env;
}

export function uploadToR2({ blogRoot, bucket, key, buffer, log = () => {} }) {
  // [P1] 임시 파일 확장자를 실제 키 확장자와 맞춘다.
  //   OG 크롭본(jpg) 을 올릴 때도 .webp 로 저장하면 wrangler 가
  //   Content-Type 을 image/webp 로 기록해, JPEG 바이트를 WebP 로 서빙하게 된다.
  const keyExt = (key.split('.').pop() || 'webp').toLowerCase();
  const tmp = path.join(os.tmpdir(), `r2img_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${keyExt}`);
  fs.writeFileSync(tmp, buffer);
  try {
    const node22 = path.join(NODE22_BIN, 'node');
    const nodeBin = fs.existsSync(node22) ? node22 : process.execPath;
    const wranglerJs = path.join(blogRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    const wranglerBinPath = path.join(blogRoot, 'node_modules', '.bin', 'wrangler');
    const execEnv = getCloudflareEnv(blogRoot);

    let bin = nodeBin;
    let args = [wranglerJs, 'r2', 'object', 'put', `${bucket}/${key}`, '--file', tmp, '--remote'];

    if (!fs.existsSync(wranglerJs)) {
      if (fs.existsSync(wranglerBinPath)) {
        bin = wranglerBinPath;
        args = ['r2', 'object', 'put', `${bucket}/${key}`, '--file', tmp, '--remote'];
      } else {
        bin = 'npx';
        args = ['wrangler', 'r2', 'object', 'put', `${bucket}/${key}`, '--file', tmp, '--remote'];
      }
    }

    execFileSync(bin, args, {
      cwd: blogRoot,
      env: execEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    });
    log(`  📸 [R2 업로드 완료] ${bucket}/${key} (${(buffer.length / 1024).toFixed(0)}KB)`);
    return true;
  } catch (err) {
    const stderr = (err.stderr || err.stdout || '').toString().trim().slice(0, 300);
    log(`  ❌ [R2 업로드 실패] ${bucket}/${key}: ${stderr || err.message}`);
    return false;
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_) {}
  }
}

/**
 * OG 표준 크롭 (1200x630 중앙 크롭 JPEG)
 *
 * [P2] Workers SSR 런타임에는 sharp 가 없어 요청 시점 크롭이 불가능하다.
 *      그래서 발행 시점에 미리 만들어 R2 에 올려두고, DB(og_image) 에 URL 만 저장한다.
 *      JPEG 를 쓰는 이유: WebP 는 소셜 크롤러의 og:image 지원이 불안정하다.
 *
 * @param {Buffer} buffer  원본 이미지 바이트
 * @returns {Promise<{ok: boolean, buffer?: Buffer, error?: string, width?: number, height?: number}>}
 */
export async function cropOgImage(buffer) {
  try {
    const out = await sharp(buffer)
      .resize(IMAGE_POLICY.OG_WIDTH, IMAGE_POLICY.OG_HEIGHT, {
        fit: 'cover', // 잘라도 되는 영역을 중앙으로 채운다
        position: 'centre',
      })
      .jpeg({ quality: IMAGE_POLICY.OG_QUALITY, mozjpeg: true })
      .toBuffer();
    return { ok: true, buffer: out, width: IMAGE_POLICY.OG_WIDTH, height: IMAGE_POLICY.OG_HEIGHT };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// 6) 오케스트레이터
// ---------------------------------------------------------------------------

/**
 * 출처 이미지 URL 을 받아 최대 해상도 후보를 찾고 → 정규화하고 → R2 에 올린다.
 *
 * @param {string} remoteUrl 원본 기사 이미지 URL
 * @param {object} p
 * @param {string} p.blogRoot
 * @param {string} p.bucket
 * @param {string} p.slug       R2 키 접두 slug
 * @param {string} [p.referer]  출처 기사 URL (Referer 헤더)
 * @param {(msg: string) => void} [p.log]
 * @returns {Promise<{ url, key, width, height, bytes, sourceUrl, candidatesTried } | { error: string, attempts: string[] }>}
 */
export async function mirrorArticleImage(remoteUrl, p) {
  const log = p.log || (() => {});
  const attempts = [];

  if (!remoteUrl) return { error: '이미지 URL 이 없음', attempts };
  if (remoteUrl.startsWith('/api/images/')) return { url: remoteUrl, alreadyMirrored: true, attempts };
  if (!/^https?:\/\//i.test(remoteUrl)) return { error: '외부 URL 이 아님', attempts };

  // Mixed Content 방지: http -> https 승격
  let normalized = remoteUrl;
  if (remoteUrl.startsWith('http://')) {
    const httpsUrl = 'https://' + remoteUrl.slice(7);
    const probe = await fetchVerifiedImage(httpsUrl, { referer: p.referer, timeoutMs: 6000 });
    if (probe.buffer) normalized = httpsUrl;
    else attempts.push(`https 승격 실패: ${probe.error}`);
  }

  const candidates = buildHdCandidates(normalized);
  log(`  🔍 [이미지] 원본 후보 ${candidates.length}개 생성 (${looksLikeThumbnail(normalized) ? '썸네일로 감지됨 → 원본 탐색' : '원본으로 보임'})`);

  let best = null;
  let bestScore = -1;

  // 썸네일이면 원본 후보를 우선, 아니면 원본을 먼저
  const ordered = looksLikeThumbnail(normalized) ? [...candidates].reverse() : candidates;

  for (const candidate of ordered) {
    const res = await fetchVerifiedImage(candidate, { referer: p.referer });
    if (res.error) {
      attempts.push(`✗ ${shortUrl(candidate)} — ${res.error}`);
      continue;
    }

    const score = res.dims.width * res.dims.height;
    if (score > bestScore) {
      best = res;
      bestScore = score;
    }
    // 1600px 이상을 찾았으면 더 탐색할 필요가 없다 (FR-2.4 상한)
    if (res.dims.width >= IMAGE_POLICY.MAX_WIDTH) break;
  }

  if (!best) {
    return { error: `사용 가능한 이미지 후보 없음 (${attempts.length}건 시도)`, attempts };
  }

  const normalizedOut = await normalizeImage(best.buffer);
  if (normalizedOut.error) {
    return {
      error: `정규화 실패: ${normalizedOut.error} (최선 후보 ${best.dims.width}x${best.dims.height})`,
      attempts,
      bestDims: best.dims,
    };
  }

  // 콘텐츠 해시 기반 키 → 동일 슬러그 재발행 시 URL 이 바뀌어 캐시가 무효화된다
  const datePrefix = new Date().toISOString().slice(0, 7).replace('-', '/');
  const contentHash = crypto.createHash('sha256').update(normalizedOut.buffer).digest('hex').slice(0, 12);
  const cleanSlug = String(p.slug).replace(/^\d{8}-?/, '').replace(/[^a-z0-9-]/gi, '-').slice(0, 40) || 'digest';
  const key = `images/${datePrefix}/${cleanSlug}-${contentHash}.${normalizedOut.ext}`;

  const ok = uploadToR2({
    blogRoot: p.blogRoot,
    bucket: p.bucket,
    key,
    buffer: normalizedOut.buffer,
    log,
  });
  if (!ok) return { error: 'R2 업로드 실패', attempts };

  log(
    `  ✅ [이미지 확정] ${best.dims.width}x${best.dims.height} → ${normalizedOut.width}x${normalizedOut.height} WebP ` +
      `(${(normalizedOut.buffer.length / 1024).toFixed(0)}KB) · ${key}`
  );

  const publicUrl = `/api/images/${datePrefix}/${cleanSlug}-${contentHash}.${normalizedOut.ext}`;

  // [P2] OG 크롭본을 함께 만든다. 실패해도 본문 이미지는 이미 확정되었으므로
  //      전체 파이프라인을 실패시키지 않고 ogImage=null 로만 보고한다.
  let ogUrl = null;
  let ogKey = null;
  const og = await cropOgImage(best.buffer);
  if (og.ok) {
    ogKey = `images/${datePrefix}/${cleanSlug}-${contentHash}-og.jpg`;
    const ogUploaded = uploadToR2({ blogRoot: p.blogRoot, bucket: p.bucket, key: ogKey, buffer: og.buffer, log });
    if (ogUploaded) {
      ogUrl = `/api/images/${datePrefix}/${cleanSlug}-${contentHash}-og.jpg`;
      log(`  🖼️  [OG 크롭 완료] ${IMAGE_POLICY.OG_WIDTH}x${IMAGE_POLICY.OG_HEIGHT} · ${ogKey}`);
    }
  } else {
    log(`  ⚠️ [OG 크롭 실패] ${og.error}`);
  }

  return {
    url: publicUrl,
    key,
    ogUrl,
    ogKey,
    width: normalizedOut.width,
    height: normalizedOut.height,
    bytes: normalizedOut.buffer.length,
    sourceUrl: best.sourceUrl,
    sourceDims: best.dims,
    candidatesTried: attempts.length,
  };
}

function shortUrl(u) {
  try {
    const p2 = new URL(u);
    return (p2.hostname + p2.pathname).slice(0, 70);
  } catch (_) {
    return String(u).slice(0, 70);
  }
}

export default mirrorArticleImage;
