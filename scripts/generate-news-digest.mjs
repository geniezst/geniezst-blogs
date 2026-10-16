#!/usr/bin/env node
/**
 * blogs 뉴스 다이제스트 공용 유틸리티 모듈 (Image/URL/Text helpers)
 *
 * NOTE (2026-10-16): 뉴스 다이제스트 자동 생성·발행 파이프라인과 아침 세션은
 *   애드센스 저품질 콘텐츠 대응 및 운영 정책 변경으로 완전히 제거되었다.
 *   본 파일은 오후 심층글 파이프라인(yamlEscapedScalar)과 이미지 백필 스크립트
 *   (collectArticleImageCandidates) 등에서 재사용하는 유틸리티만 남긴다.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { isPlaceholderOrLogo } from './lib/image-pipeline.mjs';

const BLOG_ROOT = path.resolve(import.meta.dirname, '..');

export function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 다이제스트 제목 정제 함수 (콜론 치환, 날짜/시점 표기 전면 배제)
 */
export function cleanDigestTitle(rawTitle) {
  if (!rawTitle) return '';
  let title = rawTitle.trim();

  // 1) 콜론(:) 치환
  title = title.replace(/:/g, ' |');

  // 2) 괄호로 감싸진 날짜 패턴 제거: (09/24), [9/24], (09.24), (2026-09-24) 등
  title = title.replace(/\s*[\(\[]\s*\d{1,4}[-.\/]\d{1,2}(?:[-.\/]\d{1,2})?\s*[\)\]]/g, '');

  // 3) 한국어 날짜 패턴 제거: 9월 24일, 09월 24일자 등
  title = title.replace(/\s*\d{1,2}월\s*\d{1,2}일(?:자)?/g, '');

  // 4) ISO 날짜 패턴 제거: 2026-09-24, 260924 등
  title = title.replace(/\s*\b\d{4}[-.]\d{2}[-.]\d{2}\b/g, '');

  // 5) '오늘자', '금일' 단어 제거
  title = title.replace(/(?:오늘자|금일)\s*/g, '');

  // 6) 날짜가 제거되어 빈 괄호가 남은 경우 정리: (), []
  title = title.replace(/\s*\(\s*\)/g, '');
  title = title.replace(/\s*\[\s*\]/g, '');

  // 6.5) 상투적인 다이제스트 브랜딩/꼬리표 문구 제거 (예: | 당신의 지갑을 지키는 모닝 브리핑, | 모닝 머니 브리핑, | 핵심 IT 뉴스 TOP 4, TOP 4 등)
  title = title.replace(/\s*\|\s*(?:당신의\s*지갑을\s*지키는.*|모닝\s*(?:테크\s*)?(?:머니\s*)?(?:다이제스트|브리핑).*|핵심\s*IT\s*뉴스.*|핵심\s*뉴스.*|오늘의\s*모닝.*|TOP\s*\d+.*)$/i, '');
  title = title.replace(/\s*\[\s*TOP\s*\d+\s*\]/gi, '');
  title = title.replace(/\s+(?:핵심\s*뉴스|TOP\s*\d+).*$/i, '');
  title = title.replace(/\s*\|\s*TOP\s*\d+.*$/i, '');

  // 7) 연속된 구분 기호 및 공백 정리
  title = title.replace(/\s*\|\s*\|+/g, ' |');
  title = title.replace(/\s{2,}/g, ' ');
  title = title.replace(/^\|\s*/, '').replace(/\s*\|$/, '').trim();

  return title;
}

/**
 * YAML 큰따옴표 스칼라 안전 직렬화
 * - 제목에 LLM이 넣은 `"` 나 `\` 가 그대로 심기면 Frontmatter가 깨져 Astro 파싱 실패로 이어진다.
 * @param {unknown} value
 * @returns {string}
 */
export function yamlEscapedScalar(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Google News CBMi... URL을 실제 언론사 원문 URL로 디코딩 (순수 Node 구현)
 *
 * [왜 바꿨가 — 2026-09-29]
 * 기존 구현은 `python3 -c "import googlenewsdecoder"` 브릿지였는데,
 * 시스템/venv 어디에도 `googlenewsdecoder` 가 로컬 임포트 불가
 * (venv 의 selectolax 네이티브 모듈 손상) → 예외를 삼키고 원본 URL 을 그대로 반환했다.
 * 결과: Google News RSS 항목 100%가 미해결 상태로 남았고, 아래 이미지 파이프라인이
 * 래퍼 페이지를 직접 크롤링해 **구글 기본 로고**를 출처 이미지로 게시했다.
 * 의존성(Python 패키지) 없이 동작하도록 Google 이 쓰는 batchexecute API 로 직접 구현한다.
 *
 * [동작]
 * 1) 래퍼 페이지에서 data-n-a-sg(서명) / data-n-a-ts(타임스탬프) 추출
 * 2) DotsSplashUi/data/batchexecute 에 garturlreq 로 원문 URL 요청
 * 3) 해석 안 되면 원본 URL 을 그대로 반환 (호출측이 실패로 판단)
 *
 * @param {string} googleUrl
 * @returns {Promise<string>} 실제 원문 URL (해석 실패 시 입력값 그대로)
 */
export async function decodeGoogleNewsUrl(googleUrl) {
  if (!googleUrl || !googleUrl.includes('news.google.com')) return googleUrl;

  const idMatch = googleUrl.match(/news\.google\.[a-z.]+\/rss\/articles\/([^?&/]+)/i);
  if (!idMatch) return googleUrl;
  const base64 = idMatch[1];

  try {
    const pageRes = await fetch(`https://news.google.com/rss/articles/${base64}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!pageRes.ok) return googleUrl;

    const html = await pageRes.text();
    const signature = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const timestamp = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
    if (!signature || !timestamp) return googleUrl;

    const payload = [
      'garturlreq',
      [
        ['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1],
        'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0,
      ],
      base64,
      Number(timestamp),
      signature,
    ];

    const apiRes = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      },
      body: new URLSearchParams({
        'f.req': JSON.stringify([[['Fbv4je', JSON.stringify(payload), null, 'generic']]]),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!apiRes.ok) return googleUrl;

    const text = await apiRes.text();
    const chunk = text.split('\n\n')[1];
    if (!chunk) return googleUrl;

    const decoded = JSON.parse(JSON.parse(chunk)[0][2])[1];
    if (typeof decoded === 'string' && /^https?:\/\//i.test(decoded)) {
      return decoded;
    }
  } catch (_) {
    /* 해석 실패는 조용히 통과시킨다 (호출측이 이미지 미확보로 처리) */
  }

  return googleUrl;
}

/**
 * Google News 래퍼 URL 을 실제 원문 URL 로 되돌린다.
 * 되돌릴 수 없으면 null 을 반환해, 호출측이 래퍼 페이지 이미지를 쓰지 않도록 한다.
 */
export async function resolveSourceArticleUrl(articleUrl) {
  if (!articleUrl || !articleUrl.includes('news.google.com')) return articleUrl;
  const resolved = await decodeGoogleNewsUrl(articleUrl);
  return resolved !== articleUrl ? resolved : null;
}

/**
 * 이미지 URL 유효성 검증 및 HTTPS 승격
 * - Range 요청(GET bytes=0-1024) 우선 시도 후 403/416 등 거부 시 일반 GET 재시도
 * - Referer 헤더 지원으로 언론사 핫링크 방지 서버 통과
 */
export async function validateAndNormalizeImageUrl(imgUrl, options = {}) {
  if (!imgUrl || !imgUrl.startsWith('http')) return null;

  // 파비콘, 1x1 투명 픽셀, svg/ico 제외 및 사이트 로고/플레이스홀더 배제
  if (/\.(ico|svg)(\?.*)?$/i.test(imgUrl)) return null;
  if (/1x1|pixel|spacer|blank|tracking|badge/i.test(imgUrl)) return null;
  if (isPlaceholderOrLogo(imgUrl)) return null;

  const opts = typeof options === 'string' ? { referer: options } : (options || {});
  const referer = opts.referer || null;
  const timeoutMs = opts.timeoutMs || 7000;

  const testImageReachability = async (testUrl) => {
    try {
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      };
      if (referer) headers['Referer'] = referer;
      const res = await fetch(testUrl, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.startsWith('image/') || ct === 'application/octet-stream' || !ct) {
          return true;
        }
      }
    } catch (_) {}
    return false;
  };

  // 1) http:// -> https:// 승격 시도 (Mixed Content 원천 방지)
  if (imgUrl.startsWith('http://')) {
    const httpsCandidate = imgUrl.replace('http://', 'https://');
    if (await testImageReachability(httpsCandidate)) {
      return httpsCandidate;
    }
  }

  // 2) 원본 URL 검증
  if (await testImageReachability(imgUrl)) {
    return imgUrl;
  }

  return null;
}

/**
 * 이미지 버퍼로부터 너비 및 높이 메타데이터 추출 (고속 바이너리 파서)
 */
export function getImageDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  // PNG: IHDR chunk (width: 16-19, height: 20-23)
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), type: 'png' };
  }
  // JPEG: SOI (0xFFD8) & SOF markers
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let offset = 2;
    while (offset < buffer.length - 8) {
      if (buffer[offset] !== 0xFF) { offset++; continue; }
      const marker = buffer[offset + 1];
      if (marker >= 0xC0 && marker <= 0xC3) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5), type: 'jpg' };
      }
      if (marker === 0xD9 || marker === 0xDA) break;
      const len = buffer.readUInt16BE(offset + 2);
      offset += 2 + len;
    }
  }
  // WebP
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunkType = buffer.toString('ascii', 12, 16);
    if (chunkType === 'VP8 ') {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff, type: 'webp' };
    } else if (chunkType === 'VP8L') {
      const b0 = buffer[21], b1 = buffer[22], b2 = buffer[23], b3 = buffer[24];
      return { width: 1 + (((b1 & 0x3F) << 8) | b0), height: 1 + (((b3 & 0xF) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6)), type: 'webp' };
    } else if (chunkType === 'VP8X') {
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3), type: 'webp' };
    }
  }
  return null;
}

/**
 * 외부 기사 이미지를 다운로드하여 Cloudflare R2 버킷에 미러링
 * - SSL 인증서 만료, Mixed Content 차단, 외부 언론사 핫링크 방지 영구 해결
 */
export async function mirrorImageToR2(remoteImgUrl, bucketName = 'blogs', slug = 'digest') {
  if (!remoteImgUrl) return null;
  if (remoteImgUrl.startsWith('/api/images/')) return remoteImgUrl;
  if (!remoteImgUrl.startsWith('http')) return null;

  try {
    const res = await fetch(remoteImgUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length < 500) return null;

    // 최소 해상도 검증: 가로 250px 미만인 아이콘/트래킹 픽셀만 기각 (500px 웹 보도사진 수용)
    const dims = getImageDimensions(buffer);
    if (dims && dims.width > 0 && dims.width < 250) {
      console.warn(`  ⚠️ 이미지 해상도가 너무 작음 (${dims.width}x${dims.height} < 250px) -> 고화질 폴백으로 대체`);
      return null;
    }

    const extMatch = remoteImgUrl.match(/\.(png|jpg|jpeg|webp|gif)/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    const datePrefix = new Date().toISOString().slice(0, 7).replace('-', '/');
    const hash = crypto.createHash('md5').update(remoteImgUrl).digest('hex').slice(0, 10);
    const cleanSlug = slug.replace(/^2\d{7}-/, '').slice(0, 30);
    const r2Key = `images/${datePrefix}/${cleanSlug}-${hash}.${ext}`;
    const tmpPath = `/tmp/r2_mirror_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;

    fs.writeFileSync(tmpPath, buffer);
    try {
      const wranglerEnv = { ...process.env };
      if (!wranglerEnv.CLOUDFLARE_API_TOKEN) {
        try {
          const envTxt = fs.readFileSync('/workspace/.env', 'utf8');
          const m = envTxt.match(/CLOUDFLARE_API_TOKEN=(.*)/);
          if (m) wranglerEnv.CLOUDFLARE_API_TOKEN = m[1].trim().replace(/^["']|["']$/g, '');
        } catch (_) {}
      }
      execSync(`wrangler r2 object put "${bucketName}/${r2Key}" --file="${tmpPath}" --remote`, {
        cwd: BLOG_ROOT,
        env: wranglerEnv,
        stdio: 'ignore',
        timeout: 15000,
      });
      console.log(`  📸 [R2 미러링 완료] ${bucketName}/${r2Key}`);
      return `/api/images/${datePrefix}/${cleanSlug}-${hash}.${ext}`;
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  } catch (err) {
    console.warn(`  ⚠️ R2 미러링 예외 (${err.message}) -> 다운로드 실패`);
    return null;
  }
}

/**
 * 기사 웹페이지의 og:image 메타 태그 및 본문 고화질 대표 이미지 추출
 * - AMP canonical 태그 추적, amp-img, 본문 사진, JSON-LD 지원
 */
export async function fetchArticleOgImage(articleUrl, depth = 0) {
  if (!articleUrl || !articleUrl.startsWith('http')) return null;

  // [P0] Google News 래퍼 URL 은 반드시 원문으로 되돌린 뒤 크롤링한다.
  // 되돌릴 수 없으면 그대로 크롤링했을 때 구글 기본 로고(og:image)가 나온다.
  if (articleUrl.includes('news.google.com')) {
    const resolved = await resolveSourceArticleUrl(articleUrl);
    if (!resolved) return null;
    articleUrl = resolved;
  }

  try {
    const res = await fetch(articleUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      signal: AbortSignal.timeout(6000), // 6초 타임아웃
      redirect: 'follow',
    });

    if (!res.ok) return null;

    const html = await res.text();

    // 1) og:image / twitter:image 정규식 검색 (임의의 속성 순서 지원)
    const ogMatch =
      html.match(/<meta\s+[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i) ||
      html.match(/<meta\s+[^>]*name=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["'](?:og:image|twitter:image)["']/i);

    // 2) link rel="image_src"
    const linkMatch =
      html.match(/<link\s+[^>]*rel=["']image_src["'][^>]*href=["']([^"']+)["']/i) ||
      html.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']image_src["']/i);

    // 3) amp-img 태그 (AMP 뉴스 페이지)
    const ampImgMatch = html.match(/<amp-img\s+[^>]*src=["']([^"']+)["']/i);

    // 4) 본문 내 고화질 기사 원본 사진 (photo, orgPhoto, attaches, upload 등)
    const articlePhotoMatch = html.match(
      /<img\s+[^>]*src=["'](https?:\/\/[^"']+\/(?:orgPhoto|photo|attaches|upload|news\/thumbnail)[^"']+\.(?:png|jpg|jpeg|webp))["']/i
    );

    // 5) JSON-LD 스키마 내 "image" 필드
    let jsonLdImg = null;
    const jsonLdMatch = html.match(/<script\s+[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch) {
      try {
        const parsed = JSON.parse(jsonLdMatch[1]);
        if (typeof parsed.image === 'string') jsonLdImg = parsed.image;
        else if (Array.isArray(parsed.image) && parsed.image[0]) jsonLdImg = parsed.image[0];
        else if (parsed.image?.url) jsonLdImg = parsed.image.url;
      } catch (_) {}
    }

    const rawMatch = ogMatch || linkMatch || ampImgMatch || articlePhotoMatch;
    let imgUrl = rawMatch ? decodeEntities(rawMatch[1].trim()) : jsonLdImg;

    // 만약 og:image를 못 찾았고 canonical 링크가 있으면 1회 재귀 조회
    if (!imgUrl && depth === 0) {
      const canonicalMatch = html.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
      if (canonicalMatch && canonicalMatch[1] && canonicalMatch[1] !== articleUrl) {
        const canonicalUrl = canonicalMatch[1].trim();
        const canonicalImg = await fetchArticleOgImage(canonicalUrl, depth + 1);
        if (canonicalImg) return canonicalImg;
      }
    }

    if (imgUrl) {
      // 상대 경로면 절대 경로로 변환
      if (imgUrl.startsWith('//')) {
        imgUrl = 'https:' + imgUrl;
      } else if (imgUrl.startsWith('/')) {
        try {
          const parsedBase = new URL(articleUrl);
          imgUrl = `${parsedBase.origin}${imgUrl}`;
        } catch (_) {}
      }

      // 1) 축소판 썸네일(_v150, _s150, _thumb, 150x150 등)인 경우 원본 고화질 우선 시도
      if (/(_v\d+|_s\d+|_thumb|\b150x150\b|-150x150)/i.test(imgUrl)) {
        const hdCandidate = imgUrl
          .replace(/_v\d+\./i, '.')
          .replace(/_s\d+\./i, '.')
          .replace(/_thumb\./i, '.')
          .replace(/-?150x150\./i, '.');
        const validatedHd = await validateAndNormalizeImageUrl(hdCandidate, { referer: articleUrl });
        if (validatedHd) return validatedHd;
      }

      // 2) 일반 유효성 검사 및 정규화
      const validated = await validateAndNormalizeImageUrl(imgUrl, { referer: articleUrl });
      if (validated) return validated;

      // 검증되지 않은(깨졌거나 404인) 이미지는 절대 반환하지 않음
      return null;
    }
  } catch (_) {}

  return null;
}

/**
 * [P2] 기사에서 대표 이미지 **후보 목록**을 수집한다.
 *
 * fetchArticleOgImage 는 og:image / link / amp / 본문 중 "첫 번째로 발견한 1장"만 반환한다.
 * 그 1장이 로고·썸네일·저해상도면 그대로 실패하고, 같은 기사에 실린 720px급 실사 사진은
 * 시도조차 되지 않는다 (2026-09-30 실제로 3/4 카드가 여기서 실패).
 *
 * 따라서 우선순위별 후보를 모두 모아 검증까지 통과한 것만 반환하고,
 * 호출부가 앞에서부터 순서대로 시도하며 성공하는 첫 장을 사용한다.
 *
 * @returns {Promise<string[]>} 검증 통과한 원본 이미지 URL (우선순위 순)
 */
export async function collectArticleImageCandidates(articleUrl, max = 4) {
  if (!articleUrl || typeof articleUrl !== 'string') return [];
  articleUrl = decodeEntities(articleUrl.trim());
  if (!articleUrl.startsWith('http')) return [];
  if (articleUrl.includes('news.google.com')) {
    const resolved = await resolveSourceArticleUrl(articleUrl);
    if (!resolved) return [];
    articleUrl = decodeEntities(resolved);
  }

  let html = '';
  try {
    const res = await fetch(articleUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });
    if (!res.ok) return [];
    html = await res.text();
  } catch (_) {
    return [];
  }

  const toAbs = (u) => {
    if (!u) return null;
    let s = decodeEntities(String(u).trim());
    if (s.startsWith('//')) s = 'https:' + s;
    else if (s.startsWith('/')) {
      try {
        s = `${new URL(articleUrl).origin}${s}`;
      } catch (_) {
        return null;
      }
    }
    if (!/^https?:\/\//i.test(s)) return null;
    return isPlaceholderOrLogo(s) ? null : s;
  };

  // 1순위: 메타 태그 (og:image / twitter:image / image_src)
  const metaRaw = [
    ...html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*content=["']([^"']+)["']/gi),
    ...html.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["']/gi),
    ...html.matchAll(/<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["']/gi),
  ].map((m) => m[1]);

  // 2순위: JSON-LD image
  const jsonLdRaw = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1]);
      const img = parsed?.image;
      if (typeof img === 'string') jsonLdRaw.push(img);
      else if (Array.isArray(img) && img[0]) jsonLdRaw.push(img[0]);
      else if (img?.url) jsonLdRaw.push(img.url);
    } catch (_) {}
  }

  // 3순위: 본문 실사 이미지 (지연 로딩 data-src, data-original, data-lazy-src 포함)
  const bodyRaw = [];
  for (const m of html.matchAll(/<img\b([^>]+)>/gi)) {
    const tagAttrs = m[1];
    for (const attrMatch of tagAttrs.matchAll(/\b(?:src|data-src|data-original|data-lazy-src)=["']([^"']+)["']/gi)) {
      const srcVal = attrMatch[1];
      if (srcVal && /attaches|orgPhoto|photo|upload|news\/thumbnail|media/i.test(srcVal)) {
        bodyRaw.push(srcVal);
      }
    }
  }

  const ordered = [...new Set([...metaRaw, ...jsonLdRaw, ...bodyRaw].map(toAbs).filter(Boolean))];
  if (!ordered.length) return [];

  // 썸네일 URL 은 원본으로 승격해 먼저 시도
  const promoted = [];
  for (const u of ordered) {
    if (
      /\/thumb-[^/]+?_\d+x\d+\.[a-z0-9]+$/i.test(u) ||
      /\/thumb-[^/]+$/i.test(u) ||
      /_\d+x\d+\.[a-z0-9]+$/i.test(u) ||
      /_v\d+|_s\d+|_thumb|\b150x150\b|-150x150|_tc\./i.test(u)
    ) {
      promoted.push(
        u
          .replace(/\/thumb-([^/]+?)_\d+x\d+(\.[a-z0-9]+)$/i, '/$1$2')
          .replace(/\/thumb-([^/]+)$/i, '/$1')
          .replace(/_\d+x\d+(?=\.[a-z0-9]+$)/i, '')
          .replace(/_v\d+\./i, '.')
          .replace(/_s\d+\./i, '.')
          .replace(/_thumb\./i, '.')
          .replace(/-?150x150\./i, '.')
          .replace(/_tc\./i, '.')
      );
    }
  }

  const finalOrder = [...new Set([...promoted, ...ordered])];
  const valid = [];
  for (const u of finalOrder) {
    if (valid.length >= max) break;
    const v = await validateAndNormalizeImageUrl(u, { referer: articleUrl });
    if (v) valid.push(v);
  }
  return valid;
}

export function articleUrlKey(u) {
  if (!u || typeof u !== 'string') return '';
  const s0 = u.trim();
  if (!s0) return '';
  const s = s0.startsWith('//') ? 'https:' + s0 : s0;
  try {
    const x = new URL(s);
    x.hash = '';
    x.search = x.search.replace(/[?&]+$/, '');
    // origin 비교는 스킴까지 같은지 보기보다 "호스트+경로" 만 통일한다.
    // http/https 혼재는 동일한 기사로 봐야 한다(링크 스킴 차이는 크롤링이 아니라 표기 차이).
    const host = x.hostname.replace(/^www\./, '').toLowerCase();
    // 경로 끝 슬래시는 newsId 가 붙은 query 형태에서 "같은 기사 다른 표기"로 자주 나온다.
    // 슬래시 제거 후 query 가 남는다면 pathname 이 아니라 query 까지 정규화 대상으로 본다.
    const path = x.pathname.replace(/\/+$/, '');
    const search = x.search;
    // 예: /view.do?newsId=1/  →  경로와 질의 경계에 걸린 슬래시만 정리
    const cleanedSearch = search ? search.replace(/\/(\?|$)/, '$1').replace(/\/(?=[^/]*$)/, '') : '';
    return `https://${host}${path}${cleanedSearch}`;
  } catch (_) {
    return s0.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/#.*$/, '').replace(/[?&]+$/, '');
  }
}

export function safeHost(u) {
  try {
    return new URL(u).hostname;
  } catch (_) {
    return '';
  }
}
