#!/usr/bin/env node
/**
 * blogs 아침 뉴스 다이제스트 자동 생성 및 배포 파이프라인
 * - 대상: 포켓머니 (blogs, 생활금융/정부지원금/소상공인/환급금)
 * - 수집 채널: Google News RSS, 대한민국 정책브리핑, 공공/비즈니스 금융 RSS
 * - LLM: Groq (llama-3.3-70b-versatile) -> Gemini (gemini-2.5-flash) Fallback
 * - 배포: Cloudflare D1 (publish-post.mjs) & Telegram 알림
 * 
 * 사용법:
 *   node scripts/generate-news-digest.mjs             # 정상 생성 및 D1 발행/알림
 *   node scripts/generate-news-digest.mjs --dry-run   # 마크다운 파일만 생성하고 D1/Git 건너뜀
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { sendTelegramReport } from './telegram-notify.mjs';

const BLOG_ROOT = path.resolve(import.meta.dirname, '..');
const POSTS_DIR = path.join(BLOG_ROOT, 'content', 'posts');

/**
 * 1. 환경 변수 로드 (/workspace/.env, /workspace/scripts/.env, /workspace/blogs/.env)
 */
function loadEnv() {
  const env = { ...process.env };
  const envCandidates = [
    path.resolve('/workspace/.env'),
    path.resolve('/workspace/scripts/.env'),
    path.join(BLOG_ROOT, '.env'),
  ];

  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
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
        if (!env[key]) {
          env[key] = val;
        }
      }
    }
  }
  return env;
}

/**
 * 2. KST 날짜/시간 유틸리티
 */
function getKSTDate() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const timeStr = `${parts.hour}:${parts.minute}`;
  const yymmdd = `${parts.year.slice(2)}${parts.month}${parts.day}`;
  const mmdd = `${parts.month}/${parts.day}`;
  return { now, dateStr, timeStr, yymmdd, mmdd };
}

/**
 * 3. XML 엔티티 디코딩 및 텍스트 정제
 */
function decodeEntities(str) {
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
 * Google News CBMi... 암호화 URL을 실제 언론사 원문 URL로 디코딩
 */
export function decodeGoogleNewsUrl(googleUrl) {
  if (!googleUrl) return '';
  if (!googleUrl.includes('news.google.com')) return googleUrl;

  try {
    const pyCode = `
import sys, googlenewsdecoder
try:
    res = googlenewsdecoder.gnewsdecoder(sys.argv[1])
    print(res.get("decoded_url", ""))
except Exception:
    pass
`.trim();
    const res = spawnSync('python3', ['-c', pyCode, googleUrl], {
      encoding: 'utf8',
      timeout: 8000,
    });
    const decoded = res.stdout?.trim();
    if (decoded && decoded.startsWith('http')) {
      return decoded;
    }
  } catch (_) {}

  return googleUrl;
}

/**
 * 이미지 URL 유효성 검증 및 HTTPS 승격
 * - http:// 이미지를 https:// 로 변환 테스트하여 성공 시 승격
 * - Range 요청(GET bytes=0-500)으로 HTTP 200/206 상태 및 이미지 content-type 확인
 * - 깨진 이미지, 404, 403, SSL 만료 필터링
 */
export async function validateAndNormalizeImageUrl(imgUrl) {
  if (!imgUrl || !imgUrl.startsWith('http')) return null;

  // 파비콘, 1x1 투명 픽셀, svg/ico 제외
  if (/\.(ico|svg)(\?.*)?$/i.test(imgUrl)) return null;
  if (/1x1|pixel|spacer|blank|tracking|badge/i.test(imgUrl)) return null;

  // 1) http:// -> https:// 승격 시도 (Mixed Content 원천 방지)
  if (imgUrl.startsWith('http://')) {
    const httpsCandidate = imgUrl.replace('http://', 'https://');
    try {
      const res = await fetch(httpsCandidate, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          Range: 'bytes=0-500',
        },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const ct = res.headers.get('content-type') || '';
        if (ct.startsWith('image/') || ct === 'application/octet-stream' || !ct) {
          return httpsCandidate;
        }
      }
    } catch (_) {}
  }

  // 2) 원본 URL 검증
  try {
    const res = await fetch(imgUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        Range: 'bytes=0-500',
      },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const ct = res.headers.get('content-type') || '';
      if (ct.startsWith('image/') || ct === 'application/octet-stream' || !ct) {
        return imgUrl;
      }
    }
  } catch (_) {}

  return null;
}

/**
 * 외부 기사 이미지를 다운로드하여 Cloudflare R2 버킷에 미러링
 * - SSL 인증서 만료, Mixed Content 차단, 외부 언론사 핫링크 방지 영구 해결
 */
export async function mirrorImageToR2(remoteImgUrl, bucketName = 'blogs', slug = 'digest') {
  if (!remoteImgUrl || !remoteImgUrl.startsWith('http')) return remoteImgUrl;
  if (remoteImgUrl.startsWith('/api/images/')) return remoteImgUrl;

  try {
    const res = await fetch(remoteImgUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return remoteImgUrl;
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length < 200) return remoteImgUrl;

    const extMatch = remoteImgUrl.match(/\.(png|jpg|jpeg|webp|gif)/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    const datePrefix = new Date().toISOString().slice(0, 7).replace('-', '/');
    const hash = Buffer.from(remoteImgUrl).toString('base64url').slice(0, 10);
    const cleanSlug = slug.replace(/^2\d{7}-/, '').slice(0, 30);
    const r2Key = `images/${datePrefix}/${cleanSlug}-${hash}.${ext}`;
    const tmpPath = `/tmp/r2_mirror_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;

    fs.writeFileSync(tmpPath, buffer);
    try {
      execSync(`wrangler r2 object put "${bucketName}/${r2Key}" --file="${tmpPath}" --remote`, {
        stdio: 'ignore',
        timeout: 15000,
      });
      console.log(`  📸 [R2 미러링 완료] ${bucketName}/${r2Key}`);
      return `/api/images/${datePrefix}/${cleanSlug}-${hash}.${ext}`;
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  } catch (err) {
    console.warn(`  ⚠️ R2 미러링 예외 (${err.message}) -> 원본 URL 유지`);
    return remoteImgUrl;
  }
}

/**
 * 기사 웹페이지의 og:image 메타 태그 및 본문 고화질 대표 이미지 추출
 * - AMP canonical 태그 추적, amp-img, 본문 사진, JSON-LD 지원
 */
export async function fetchArticleOgImage(articleUrl, depth = 0) {
  if (!articleUrl || !articleUrl.startsWith('http')) return null;

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

      // 유효성 검사 및 정규화
      const validated = await validateAndNormalizeImageUrl(imgUrl);
      if (validated) return validated;
      // 만약 http:// 여서 validate에서 실패했더라도 최소한 원래 url 반환 (이후 R2 미러링 대상)
      if (imgUrl.startsWith('http')) return imgUrl;
    }
  } catch (_) {}

  return null;
}

/**
 * 4. RSS 피드 파싱
 */
function parseRssXml(xmlText, defaultSource = '') {
  const items = [];
  const itemMatches = xmlText.match(/<item>([\s\S]*?)<\/item>/g) || [];

  for (const itemXml of itemMatches) {
    const titleMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/i);
    const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/i);
    const pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    const descMatch = itemXml.match(/<description>([\s\S]*?)<\/description>/i);
    const sourceMatch = itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/i);

    let rawTitle = titleMatch ? decodeEntities(titleMatch[1]) : '';
    let link = linkMatch ? linkMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
    let pubDateStr = pubDateMatch ? decodeEntities(pubDateMatch[1]) : '';
    let description = descMatch ? decodeEntities(descMatch[1]) : '';
    let source = sourceMatch ? decodeEntities(sourceMatch[1]) : defaultSource;

    // Google News 형식 제목 분리: "기사 제목 - 언론사명"
    if (rawTitle.includes(' - ')) {
      const parts = rawTitle.split(' - ');
      const candidateSource = parts.pop().trim();
      rawTitle = parts.join(' - ').trim();
      if (!source || source === defaultSource) {
        source = candidateSource;
      }
    }

    if (!rawTitle || !link) continue;

    let pubDate = null;
    if (pubDateStr) {
      const parsed = Date.parse(pubDateStr);
      if (!isNaN(parsed)) {
        pubDate = new Date(parsed);
      }
    }
    if (!pubDate) {
      pubDate = new Date(); // fallback
    }

    items.push({
      title: rawTitle,
      link,
      pubDate,
      source: source || '공식 보도',
      description,
    });
  }

  return items;
}

/**
 * 대한민국 정책브리핑 직접 수집기 (고화질 이미지 100% 확보)
 */
async function fetchKoreaPolicyNews() {
  const items = [];
  try {
    const res = await fetch('https://www.korea.kr/news/policyNewsList.do', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return items;
    const html = await res.text();
    const listMatches =
      html.match(/<a\s+[^>]*href=["\x27](\/news\/policyNewsView\.do\?newsId=\d+)["\x27][^>]*>([\s\S]*?)<\/a>/g) ||
      [];

    const seenIds = new Set();
    for (const m of listMatches) {
      const hrefMatch = m.match(/href=["\x27]([^"\x27]+)["\x27]/);
      if (!hrefMatch) continue;
      const href = hrefMatch[1];
      const idMatch = href.match(/newsId=(\d+)/);
      if (!idMatch || seenIds.has(idMatch[1])) continue;
      seenIds.add(idMatch[1]);

      const titleMatch =
        m.match(/<strong[^>]*>([\s\S]*?)<\/strong>/) ||
        m.match(/<span[^>]*class=["\x27]title["\x27][^>]*>([\s\S]*?)<\/span>/);
      const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      if (!title) continue;

      const imgMatch = m.match(/<img\s+[^>]*src=["\x27]([^"\x27]+)["\x27]/i);
      const imageUrl = imgMatch ? (imgMatch[1].startsWith('http') ? imgMatch[1] : 'https://www.korea.kr' + imgMatch[1]) : '';

      const fullLink = 'https://www.korea.kr' + href;
      items.push({
        title: decodeEntities(title),
        link: fullLink,
        originalLink: fullLink,
        imageUrl: imageUrl,
        pubDate: new Date(),
        source: '대한민국 정책브리핑',
        description: `${title} - 대한민국 정책브리핑 공식 발표`,
      });
      if (items.length >= 10) break;
    }
  } catch (err) {
    console.warn(`  ⚠️ [대한민국 정책브리핑 직접 수집] 오류 (${err.message})`);
  }
  return items;
}

/**
 * 대한민국 정책브리핑 카드뉴스/시각뉴스 직접 수집기 (썸네일 이미지 포함)
 */
async function fetchKoreaVisualNews() {
  const items = [];
  try {
    const res = await fetch('https://www.korea.kr/multi/visualNewsList.do', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return items;
    const html = await res.text();
    const listMatches =
      html.match(
        /<a\s+[^>]*href=["\x27](\/multi\/visualNewsView\.do\?newsId=\d+[^"\x27]*)["\x27][^>]*>([\s\S]*?)<\/a>/g
      ) || [];

    const seenIds = new Set();
    for (const m of listMatches) {
      const hrefMatch = m.match(/href=["\x27]([^"\x27]+)["\x27]/);
      if (!hrefMatch) continue;
      const href = hrefMatch[1];
      const idMatch = href.match(/newsId=(\d+)/);
      if (!idMatch || seenIds.has(idMatch[1])) continue;
      seenIds.add(idMatch[1]);

      const imgMatch = m.match(/<img\s+[^>]*src=["\x27]([^"\x27]+)["\x27]/);
      const titleMatch =
        m.match(/<strong[^>]*>([\s\S]*?)<\/strong>/) ||
        m.match(/<span[^>]*class=["\x27]title["\x27][^>]*>([\s\S]*?)<\/span>/);
      const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      if (!title) continue;

      const fullLink = 'https://www.korea.kr' + href;
      const imageUrl = imgMatch ? (imgMatch[1].startsWith('http') ? imgMatch[1] : 'https://www.korea.kr' + imgMatch[1]) : '';

      items.push({
        title: decodeEntities(title),
        link: fullLink,
        originalLink: fullLink,
        imageUrl: imageUrl,
        pubDate: new Date(),
        source: '대한민국 정책브리핑',
        description: `${title} - 대한민국 정책브리핑 카드뉴스`,
      });
      if (items.length >= 10) break;
    }
  } catch (err) {
    console.warn(`  ⚠️ [대한민국 정책브리핑 카드뉴스 직접 수집] 오류 (${err.message})`);
  }
  return items;
}

/**
 * 대한민국 정책브리핑 보도자료 직접 수집기 (공식 공공 발표)
 */
async function fetchKoreaPressReleases() {
  const items = [];
  try {
    const res = await fetch('https://www.korea.kr/news/pressReleaseList.do', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return items;
    const html = await res.text();
    const listMatches =
      html.match(
        /<a\s+[^>]*href=["\x27](\/(?:briefing|news)\/pressReleaseView\.do\?newsId=\d+[^"\x27]*)["\x27][^>]*>([\s\S]*?)<\/a>/g
      ) || [];

    const seenIds = new Set();
    for (const m of listMatches) {
      const hrefMatch = m.match(/href=["\x27]([^"\x27]+)["\x27]/);
      if (!hrefMatch) continue;
      const href = hrefMatch[1];
      const idMatch = href.match(/newsId=(\d+)/);
      if (!idMatch || seenIds.has(idMatch[1])) continue;
      seenIds.add(idMatch[1]);

      const titleMatch = m.match(/<strong[^>]*>([\s\S]*?)<\/strong>/);
      let title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      if (!title) continue;
      title = title.replace(/^\[(?:보도자료|장관동정|카드뉴스|설명자료)\]\s*/, '').trim();

      const leadMatch = m.match(/<span\s+class=["\x27]lead["\x27][^>]*>([\s\S]*?)<\/span>/i);
      const lead = leadMatch ? leadMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      const deptMatch = m.match(/<span\s+class=["\x27]source["\x27][^>]*>[\s\S]*?<span>([^<]+)<\/span>\s*<\/span>/i);
      const dept = deptMatch ? deptMatch[1].trim() : '';

      const fullLink = 'https://www.korea.kr' + href;
      const sourceName = dept ? `대한민국 정책브리핑 (${dept})` : '대한민국 정책브리핑';

      items.push({
        title: decodeEntities(title),
        link: fullLink,
        originalLink: fullLink,
        pubDate: new Date(),
        source: sourceName,
        description: lead ? decodeEntities(lead).slice(0, 150) : `${title} - 대한민국 정책브리핑 공식 보도자료`,
      });
      if (items.length >= 10) break;
    }
  } catch (err) {
    console.warn(`  ⚠️ [대한민국 정책브리핑 보도자료 직접 수집] 오류 (${err.message})`);
  }
  return items;
}

/**
 * 5. 다채널 뉴스 피드 수집기
 */
async function fetchNewsFeeds() {
  const feedConfigs = [
    {
      name: 'Google News 경제 부문 톱 헤드라인',
      url: 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=ko&gl=KR&ceid=KR:ko',
      defaultSource: '경제 종합',
    },
    {
      name: 'Google News (지원금/청년/소상공인)',
      url: `https://news.google.com/rss/search?q=${encodeURIComponent('(청년도약계좌 OR 근로장려금 OR 소상공인 OR 자영업자) when:1d')}&hl=ko&gl=KR&ceid=KR:ko`,
      defaultSource: '언론사 보도',
    },
    {
      name: 'Google News (정부지원금/환급금/복지)',
      url: `https://news.google.com/rss/search?q=${encodeURIComponent('(정부지원금 OR 환급금 OR 숨은보험금 OR 민생지원금 OR 긴급지원) when:1d')}&hl=ko&gl=KR&ceid=KR:ko`,
      defaultSource: '언론사 보도',
    },
    {
      name: 'Google News (금리/대출/청약/예금)',
      url: `https://news.google.com/rss/search?q=${encodeURIComponent('(기준금리 OR 주택담보대출 OR 주담대 OR 특판예금 OR 청약 OR 적금) when:1d')}&hl=ko&gl=KR&ceid=KR:ko`,
      defaultSource: '금융 뉴스',
    },
    {
      name: 'Google News (세금/연금/보험/물가)',
      url: `https://news.google.com/rss/search?q=${encodeURIComponent('(연말정산 OR 세액공제 OR 국민연금 OR 건강보험 OR 물가 OR 전기요금) when:1d')}&hl=ko&gl=KR&ceid=KR:ko`,
      defaultSource: '생활금융 뉴스',
    },
    {
      name: '대한민국 정책브리핑 (korea.kr 공공 정책)',
      url: `https://news.google.com/rss/search?q=${encodeURIComponent('site:korea.kr (정책 OR 지원 OR 금융 OR 복지 OR 소상공인) when:3d')}&hl=ko&gl=KR&ceid=KR:ko`,
      defaultSource: '대한민국 정책브리핑',
    },
    {
      name: '공공 금융당국 보도자료',
      url: `https://news.google.com/rss/search?q=${encodeURIComponent('(금융위원회 OR 금융감독원 OR 기획재정부 OR 고용노동부) when:2d')}&hl=ko&gl=KR&ceid=KR:ko`,
      defaultSource: '정부 공공 발표',
    },
  ];

  console.log(`📡 [뉴스 피드 수집] 총 ${feedConfigs.length + 3}개 채널에서 수집을 시작합니다...`);
  const allItems = [];

  // 정책브리핑 직접 수집 (정책뉴스, 카드뉴스, 보도자료)
  const directPolicy = await fetchKoreaPolicyNews();
  console.log(`  ✅ [대한민국 정책브리핑 정책뉴스] ${directPolicy.length}건 수집 완료`);
  allItems.push(...directPolicy);

  const directVisual = await fetchKoreaVisualNews();
  console.log(`  ✅ [대한민국 정책브리핑 카드뉴스] ${directVisual.length}건 수집 완료 (이미지 포함)`);
  allItems.push(...directVisual);

  const directPress = await fetchKoreaPressReleases();
  console.log(`  ✅ [대한민국 정책브리핑 보도자료] ${directPress.length}건 수집 완료`);
  allItems.push(...directPress);

  for (const feed of feedConfigs) {
    try {
      const res = await fetch(feed.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        },
        signal: AbortSignal.timeout(10000), // 10초 타임아웃
      });

      if (!res.ok) {
        console.warn(`  ⚠️ [${feed.name}] HTTP ${res.status} 응답 (건너뜀)`);
        continue;
      }

      const xml = await res.text();
      const parsed = parseRssXml(xml, feed.defaultSource);
      console.log(`  ✅ [${feed.name}] ${parsed.length}건 수집 완료`);
      allItems.push(...parsed);
    } catch (err) {
      console.warn(`  ⚠️ [${feed.name}] 수집 실패 (${err.message}) - 건너뜀`);
    }
  }

  console.log(`📊 [수집 완료] 원본 수집 총계: ${allItems.length}건`);
  return allItems;
}

/**
 * 6. 단어 자카드 유사도 계산 (중복 기사 필터링)
 */
function calculateJaccardSimilarity(str1, str2) {
  const tokenize = (s) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^가-힣a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter((w) => w.length >= 2)
    );

  const setA = tokenize(str1);
  const setB = tokenize(str2);

  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 출처(언론사명) 정규화 유틸리티
 */
function normalizeSourceName(source) {
  if (!source) return '기타 출처';
  let s = source.trim();
  // 부처명 등 괄호 제거 (예: "대한민국 정책브리핑 (국토교통부)" -> "대한민국 정책브리핑")
  s = s.replace(/\s*\([^)]*\)/g, '').trim();
  return s || '기타 출처';
}

/**
 * 다중 언론사 교차 보도 빈도 계산 (Burst Detection)
 * 제목 간 자카드 유사도 0.45 이상인 기사들을 동일 이슈 클러스터로 묶고,
 * 클러스터 내 고유 언론사(출처) 수를 계산하여 가산점 부여:
 * 2개사(+15점), 3~4개사(+25점), 5개사 이상(+35점)
 */
function calculateBurstDetection(items) {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const matchedSources = new Set();
    const mySource = normalizeSourceName(item.source);
    if (mySource) matchedSources.add(mySource);

    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      const other = items[j];
      const sim = calculateJaccardSimilarity(item.title, other.title);
      if (sim >= 0.45) {
        const otherSource = normalizeSourceName(other.source);
        if (otherSource) matchedSources.add(otherSource);
      }
    }

    const pressCount = Math.max(1, matchedSources.size);
    item.crossReportCount = pressCount;

    let burstScore = 0;
    if (pressCount >= 5) {
      burstScore = 35;
    } else if (pressCount >= 3) {
      burstScore = 25;
    } else if (pressCount === 2) {
      burstScore = 15;
    }
    item.burstScore = burstScore;
  }
}

/**
 * 핫이슈 트리거 키워드 가중치 정의
 */
const TRIGGER_KEYWORDS_TIER_1 = ['확정', '시행', '신청 시작', '마감', '단독', '전격', '발표', '긴급']; // +10점
const TRIGGER_KEYWORDS_TIER_2 = ['지원금', '환급', '면제', '최대', '인상', '인하', '개편', '혜택'];     // +8점
const TRIGGER_KEYWORDS_TIER_3 = ['조건 완화', '청년도약계좌', '소상공인', '주담대', '특판'];          // +5점

/**
 * 7. 핫이슈 스코어링 엔진 (Hotness Scoring Engine) 및 중복 제거 (15~20건 압축)
 */
async function deduplicateAndRank(items) {
  const now = Date.now();
  const maxAgeMs = 36 * 60 * 60 * 1000; // 최근 36시간

  // 1) 시간 필터링
  const freshItems = items.filter((item) => {
    const age = now - item.pubDate.getTime();
    return age <= maxAgeMs && age >= -60 * 60 * 1000; // 미래 시차 1시간 오차 허용
  });

  // 2) 다중 언론사 교차 보도 빈도(Burst Detection) 계산
  calculateBurstDetection(freshItems);

  // 3) 1차 기본 점수 산출
  const baseScoredItems = freshItems.map((item) => {
    let score = 0;

    // 3-1. 대한민국 정책브리핑 및 정부 공식 발표 신뢰도 (20점 부여)
    const sLower = (item.source || '').toLowerCase();
    const isGovernment =
      sLower.includes('정책브리핑') ||
      sLower.includes('대한민국') ||
      sLower.includes('정부') ||
      sLower.includes('금융위') ||
      sLower.includes('금융위원회') ||
      sLower.includes('금감원') ||
      sLower.includes('금융감독원') ||
      sLower.includes('기재부') ||
      sLower.includes('기획재정부') ||
      sLower.includes('고용노동부') ||
      sLower.includes('국세청') ||
      sLower.includes('보건복지부') ||
      sLower.includes('중소벤처기업부');

    const trustScore = isGovernment ? 20 : 5;
    score += trustScore;

    // 3-2. 다중 언론사 교차 보도 가중치 (Burst Detection)
    score += item.burstScore || 0;

    // 3-3. 최신성 가중치: 6시간 이내(+20점), 12시간 이내(+15점), 24시간 이내(+8점)
    const ageHours = (now - item.pubDate.getTime()) / (1000 * 60 * 60);
    let recencyScore = 0;
    if (ageHours <= 6) {
      recencyScore = 20;
    } else if (ageHours <= 12) {
      recencyScore = 15;
    } else if (ageHours <= 24) {
      recencyScore = 8;
    }
    score += recencyScore;

    // 3-4. 핫이슈 트리거 키워드 가중치
    const textToMatch = `${item.title} ${item.description || ''}`;
    let keywordScore = 0;
    for (const kw of TRIGGER_KEYWORDS_TIER_1) {
      if (textToMatch.includes(kw)) keywordScore += 10;
    }
    for (const kw of TRIGGER_KEYWORDS_TIER_2) {
      if (textToMatch.includes(kw)) keywordScore += 8;
    }
    for (const kw of TRIGGER_KEYWORDS_TIER_3) {
      if (textToMatch.includes(kw)) keywordScore += 5;
    }
    score += keywordScore;

    // 3-5. 대표 이미지 보유 가산점: +10점 (기존 수집 이미지)
    let imageScore = 0;
    if (item.imageUrl) {
      imageScore = 10;
      score += imageScore;
    }

    return {
      ...item,
      trustScore,
      recencyScore,
      keywordScore,
      imageScore,
      hotnessScore: score,
      score, // 호환성
    };
  });

  // 1차 점수 기준 내림차순 정렬
  baseScoredItems.sort((a, b) => b.hotnessScore - a.hotnessScore);

  // 4) 상위 후보군(상위 30건) 대상 대표 이미지 크롤링 및 URL 디코딩
  const topCandidates = baseScoredItems.slice(0, 30);
  console.log(`🖼️ [대표 이미지 크롤링] 상위 30건 후보 대상 URL 디코딩 및 대표 이미지 추출 시작...`);
  await Promise.allSettled(
    topCandidates.map(async (item) => {
      try {
        if (!item.originalLink || item.originalLink === item.link) {
          const decoded = decodeGoogleNewsUrl(item.link);
          item.originalLink = decoded;
        }
        if (!item.imageUrl) {
          const img = await fetchArticleOgImage(item.originalLink || item.link);
          if (img) {
            item.imageUrl = img;
            item.imageScore = 10;
            item.hotnessScore += 10;
            item.score = item.hotnessScore;
            console.log(`  📸 [이미지 획득 +10점] ${item.source}: ${item.title.slice(0, 35)}...`);
          }
        }
      } catch (_) {}
    })
  );

  // 5) 최종 핫이슈 점수(hotnessScore) 순으로 내림차순 재정렬
  topCandidates.sort((a, b) => b.hotnessScore - a.hotnessScore);

  // 6) 자카드 유사도 0.45 이상 중복 제거 및 상위 18개(15~20건) 압축
  const uniqueItems = [];
  for (const candidate of topCandidates) {
    let isDuplicate = false;
    for (const accepted of uniqueItems) {
      const similarity = calculateJaccardSimilarity(candidate.title, accepted.title);
      if (similarity >= 0.45) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) {
      uniqueItems.push({
        ...candidate,
        description: (candidate.description || '').slice(0, 150),
      });
    }
    if (uniqueItems.length >= 18) break; // 상위 18개 압축 (15~20건 범위)
  }

  console.log(`🧹 [핫이슈 스코어링] 고유 핫이슈 후보군 ${uniqueItems.length}건 선별 완료:`);
  uniqueItems.forEach((item, idx) => {
    console.log(
      `  [후보 ${idx + 1}] (핫이슈 점수: ${item.hotnessScore}점, 교차: ${item.crossReportCount}개사, 이미지: ${item.imageUrl ? 'O' : 'X'}) [${item.source}] ${item.title.slice(0, 40)}`
    );
  });

  return uniqueItems;
}

/**
 * 8. 블로그 기존 포스트 목록 스캔 (내부 링크 매칭용)
 */
function getExistingPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];

  const files = fs
    .readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'template.md');

  const posts = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
      const titleMatch = content.match(/title:\s*["']?([^"'\n]+)["']?/);
      const slugMatch = content.match(/slug:\s*["']?([^"'\n]+)["']?/);
      const catMatch = content.match(/category:\s*["']?([^"'\n]+)["']?/);
      const descMatch = content.match(/description:\s*["']?([^"'\n]+)["']?/);

      if (titleMatch && slugMatch) {
        posts.push({
          title: titleMatch[1].trim(),
          slug: slugMatch[1].trim(),
          category: catMatch ? catMatch[1].trim() : 'finance',
          description: descMatch ? descMatch[1].trim().slice(0, 60) : '',
        });
      }
    } catch (_) {}
  }

  // 최신 포스트 10개 반환
  return posts.slice(-10);
}

/**
 * 9. LLM 호출 파이프라인 (Groq -> Gemini Fallback)
 */
async function callLLM(messages, env) {
  // 1순위: Groq API
  const groqUrl = (env.GROQ_API_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '') + '/chat/completions';
  const groqKey = env.GROQ_API_KEY;
  const groqModel = env.GROQ_MODEL || 'llama-3.3-70b-versatile';

  if (groqKey) {
    console.log(`🧠 [LLM 1순위 시도] Groq (${groqModel})...`);
    try {
      const res = await fetch(groqUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: groqModel,
          messages,
          temperature: 0.6,
          max_tokens: 3800,
        }),
        signal: AbortSignal.timeout(45000), // 45초 타임아웃
      });

      if (res.ok) {
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (content && content.trim()) {
          console.log(`✅ [Groq 생성 성공]`);
          return content;
        }
      }
      const errText = await res.text();
      console.warn(`⚠️ [Groq 호출 실패 HTTP ${res.status}] ${errText.slice(0, 150)} -> Gemini Fallback 전환`);
    } catch (err) {
      console.warn(`⚠️ [Groq 예외 발생] ${err.message} -> Gemini Fallback 전환`);
    }
  }

  // 2순위: Google Gemini API Fallback (429 쿼터 초과 시 가용 모델 순환 폴백)
  const geminiUrl = (env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/').replace(/\/+$/, '') + '/chat/completions';
  const geminiKey = env.GEMINI_API_KEY;

  if (!geminiKey) {
    throw new Error('Groq와 Gemini API 키가 모두 설정되지 않았습니다.');
  }

  const geminiModelCandidates = [
    env.GEMINI_MODEL || 'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-flash-latest',
    'gemini-3.5-flash-lite',
  ];

  let lastError = null;
  for (const model of geminiModelCandidates) {
    console.log(`🧠 [LLM Fallback 시도] Gemini (${model})...`);
    try {
      const res = await fetch(geminiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${geminiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.6,
          max_tokens: 8192,
        }),
        signal: AbortSignal.timeout(90000), // 90초 타임아웃
      });

      if (!res.ok) {
        const errText = await res.text();
        console.warn(`⚠️ [Gemini ${model} HTTP ${res.status}] ${errText.slice(0, 120)} -> 다음 모델 시도`);
        lastError = new Error(`Gemini ${model} 실패 (${res.status}): ${errText}`);
        continue;
      }

      const data = await res.json();
      const choice = data?.choices?.[0];
      console.log(`📊 [Gemini ${model} 응답 완료] finish_reason: ${choice?.finish_reason}, usage:`, data?.usage);

      const content = choice?.message?.content;
      if (content && content.trim()) {
        console.log(`✅ [Gemini (${model}) Fallback 생성 성공]`);
        return content;
      }
    } catch (err) {
      console.warn(`⚠️ [Gemini ${model} 예외 발생] ${err.message} -> 다음 모델 시도`);
      lastError = err;
    }
  }

  throw lastError || new Error('모든 Gemini 모델 Fallback 호출이 실패했습니다.');
}

/**
 * 10. 마크다운 생성 결과 정제 및 검증
 */
async function cleanAndValidateMarkdown(rawContent, dateInfo, candidates = []) {
  let cleaned = rawContent.trim();

  // ```markdown 코드 블록 제거 (앞뒤 유연하게)
  cleaned = cleaned.replace(/^```(?:markdown)?\s*\r?\n/i, '');
  cleaned = cleaned.replace(/\r?\n```\s*$/i, '');
  cleaned = cleaned.trim();

  // Frontmatter 분리: 첫 번째 '---'와 두 번째 '---'를 정밀하게 추출
  const firstFmIndex = cleaned.indexOf('---');
  if (firstFmIndex === -1) {
    console.error('LLM 원본 응답 샘플 (앞 500자):\n', rawContent.slice(0, 500));
    throw new Error('생성된 결과에서 Frontmatter 시작(---)을 찾을 수 없습니다.');
  }

  const secondFmIndex = cleaned.indexOf('---', firstFmIndex + 3);
  if (secondFmIndex === -1) {
    console.error('LLM 원본 응답 전체 길이:', rawContent.length);
    console.error('LLM 원본 응답 앞 1500자:\n', rawContent.slice(0, 1500));
    throw new Error('생성된 결과에서 Frontmatter 종료(---)를 찾을 수 없습니다.');
  }

  let yaml = cleaned.slice(firstFmIndex + 3, secondFmIndex).trim();
  let body = cleaned.slice(secondFmIndex + 3).trim();

  // body 시작 부분에 남아있는 코드블록 잔여물(``` 또는 ```yaml, ```markdown 등) 제거
  body = body.replace(/^```[a-z]*\s*\r?\n/i, '');
  body = body.replace(/^\s*```\s*\r?\n/i, '');
  body = body.replace(/\r?\n```\s*$/i, '');
  body = body.trim();

  // 1) High-CTR 제목 정제 (cleanDigestTitle: 콜론 치환, 날짜 및 꼬리표 완전 배제)
  const titleMatch = yaml.match(/title:\s*["']?([^"'\n]+)["']?/);
  let title = titleMatch ? cleanDigestTitle(titleMatch[1]) : '놓치면 손해 보는 생활금융 핫이슈 핵심 요약';
  title = cleanDigestTitle(title);
  yaml = yaml.replace(/title:\s*["']?[^"'\n]+["']?/, `title: "${title}"`);

  // 2) 카테고리 'news' ('새소식')로 100% 고정
  if (/category:\s*["']?[^"'\n]+["']?/.test(yaml)) {
    yaml = yaml.replace(/category:\s*["']?[^"'\n]+["']?/, 'category: "news"');
  } else {
    yaml += '\ncategory: "news"';
  }

  // 3) 태그 기본값 점검 (없거나 빈약할 때 '새소식' 포함)
  if (!yaml.includes('tags:')) {
    yaml += '\ntags: ["새소식", "모닝브리핑", "생활금융", "정부지원금", "환급금"]';
  }

  // 4) 오늘자 일련번호 및 파일명/슬러그 계산
  const existingFiles = fs.existsSync(POSTS_DIR)
    ? fs.readdirSync(POSTS_DIR).filter((f) => f.startsWith(dateInfo.yymmdd))
    : [];
  const seqNumber = String(existingFiles.length + 1).padStart(2, '0');

  // Slug 추출 및 정규화
  const slugMatch = yaml.match(/slug:\s*["']?([^"'\n]+)["']?/);
  let baseSlug = slugMatch ? slugMatch[1].trim().toLowerCase() : 'morning-money-digest';
  baseSlug = baseSlug
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // 접두어 정돈 (YYMMDDNN- 중복 방지)
  if (!baseSlug.startsWith(`${dateInfo.yymmdd}`)) {
    baseSlug = `${dateInfo.yymmdd}${seqNumber}-${baseSlug.replace(/^\d+-/, '')}`;
  }

  // Frontmatter 필드 강제 보정
  yaml = yaml
    .replace(/slug:\s*["']?[^"'\n]+["']?/, `slug: "${baseSlug}"`)
    .replace(/author:\s*["']?[^"'\n]+["']?/, `author: "포켓머니"`)
    .replace(/reading_time:\s*\d+/, `reading_time: 4`);

  if (!yaml.includes('post_type:')) {
    yaml += `\npost_type: "digest"`;
  }
  if (!yaml.includes('author:')) {
    yaml += `\nauthor: "포켓머니"`;
  }
  if (!yaml.includes('reading_time:')) {
    yaml += `\nreading_time: 4`;
  }

  // 다이제스트는 개별 카드 이미지만 사용하므로 상단 featured_image는 항상 ""로 강제
  if (/featured_image:\s*["']?[^"'\n]*["']?/.test(yaml)) {
    yaml = yaml.replace(/featured_image:\s*["']?[^"'\n]*["']?/, 'featured_image: ""');
  } else {
    yaml += '\nfeatured_image: ""';
  }

  // 5) 이모지 및 구 서식 강제 정제
  body = body.replace(/:::tip\[(?:⚡\s*)?(.*?)\]/g, ':::tip[$1]');
  body = body.replace(/>\s*(?:🌐\s*)?\*\*공식\s*출처\*\*:/gi, '> **출처**:');
  body = body.replace(/>\s*(?:🌐\s*)?\*\*출처\*\*:/gi, '> **출처**:');
  body = body.replace(/>\s*(?:🕒\s*)?\*\*발행\s*시점\*\*:/gi, '> **발행**:');
  body = body.replace(/>\s*(?:🕒\s*)?\*\*발행\*\*:/gi, '> **발행**:');
  body = body.replace(/>\s*(?:🔗\s*)?\*\*함께\s*읽으면\s*좋은\s*블로그\s*심층\s*가이드\*\*:/gi, '> **관련 가이드**:');
  body = body.replace(/>\s*(?:🔗\s*)?\*\*관련\s*가이드\*\*:/gi, '> **관련 가이드**:');
  body = body.replace(/###\s*(?:💡\s*)?(?:실무\s*가계\/지갑\s*영향\s*실전\s*인사이트|실무\s*시사점|가계\s*영향\s*및\s*실전\s*인사이트)/gi, '### 가계 영향 및 실전 팁');

  // 6) 3줄 팩트 브리핑을 둥근 모서리 박스(:::fact[핵심 팩트 요약])로 변환
  body = body.replace(
    /###\s*(?:📌\s*)?(?:3줄\s*팩트\s*브리핑|핵심\s*팩트\s*요약|팩트\s*요약)\r?\n([\s\S]*?)(?=\r?\n###|\r?\n---|\r?\n:::\w+|$)/gi,
    (_match, listContent) => {
      return `:::fact[핵심 팩트 요약]\n${listContent.trim()}\n:::\n\n`;
    }
  );
  body = body.replace(/:::fact\[(?:📌\s*)?(.*?)\]/g, ':::fact[$1]');

  // 7) 독자 소통 / 댓글 유도 섹션 완전 삭제
  body = body.replace(/##\s*(?:💬\s*)?(?:오늘\s*아침\s*여러분의\s*생각은|독자\s*소통|여러분의\s*의견|댓글로\s*이야기)[\s\S]*?(?=\n---|\n##|$)/gi, '');
  body = body.replace(/추가로\s*궁금한\s*점이나\s*여러분의\s*의견이\s*있다면\s*댓글로.*?나눠주세요!?/gi, '');

  // 8) 헤딩 및 서두의 잔여 이모지(⚡, 📌, 💡, 🌐, 🕒, 💬) 정리
  body = body.replace(/^([#>]+\s*)[⚡📌💡🌐🕒💬🔗]\s*/gm, '$1');

  // 9) 잘못되거나 깨진 이미지 태그 정리
  body = body.replace(/!\[.*?\]\((?:없음|none|null|undefined|\s*)\)\r?\n?(?:<p[^>]*>.*?<\/p>)?/gi, '');
  body = body.replace(/!\[.*?\]\((?!https?:\/\/)[^\)]+\)\r?\n?(?:<p[^>]*>.*?<\/p>)?/gi, '');

  // 10) 이미지 보강 및 깨짐 방지 파이프라인 (기사마다 반드시 검증된 대표 이미지 주입)
  const cardSections = body.split(/(?=^##\s+)/gm);
  const updatedSections = await Promise.all(
    cardSections.map(async (sec) => {
      if (!sec.startsWith('## ')) return sec;

      const h2EndIdx = sec.indexOf('\n');
      const h2Line = h2EndIdx !== -1 ? sec.slice(0, h2EndIdx) : sec;
      const cleanH2Title = h2Line.replace(/^##\s+(\[[^\]]+\]\s*)?/, '').trim();

      // 출처 정보 파싱
      const linkMatch = sec.match(/>\s*\*\*출처\*\*:\s*\[([^\]]*)\]\((https?:\/\/[^\)]+)\)/i);
      const matchedHref = linkMatch ? linkMatch[2].trim() : '';
      const sourceName = linkMatch ? linkMatch[1].trim() : '공식 출처';

      // 기존 섹션 내 이미지 태그 추출
      const existingImgMatch = sec.match(/!\[([^\]]*)\]\((https?:\/\/[^\s\)]+)\)/i);
      let activeImgUrl = existingImgMatch ? existingImgMatch[2].trim() : null;

      // 1) 이미지가 없거나 플레이스홀더인 경우 후보군에서 이미지 매칭 시도
      if (!activeImgUrl) {
        let foundCandidate = null;
        if (matchedHref && candidates && candidates.length > 0) {
          foundCandidate = candidates.find(
            (c) =>
              c.imageUrl &&
              (c.link === matchedHref ||
                c.originalLink === matchedHref ||
                matchedHref.includes(c.link) ||
                (c.originalLink && (matchedHref.includes(c.originalLink) || c.originalLink.includes(matchedHref))))
          );

          if (!foundCandidate) {
            const idMatch = matchedHref.match(/newsId=(\d+)/i) || matchedHref.match(/\/(\d+)(?:\?|$)/);
            if (idMatch) {
              const targetId = idMatch[1];
              foundCandidate = candidates.find(
                (c) =>
                  c.imageUrl &&
                  ((c.originalLink && c.originalLink.includes(targetId)) || (c.link && c.link.includes(targetId)))
              );
            }
          }

          if (!foundCandidate) {
            let bestScore = 0;
            for (const c of candidates) {
              if (!c.imageUrl) continue;
              const score = calculateJaccardSimilarity(cleanH2Title, c.title);
              if (score > bestScore && score >= 0.2) {
                bestScore = score;
                foundCandidate = c;
              }
            }
          }
        }

        if (foundCandidate && foundCandidate.imageUrl) {
          activeImgUrl = foundCandidate.imageUrl;
        }
      }

      // 2) 여전히 이미지가 없다면: 기사 출처 URL(matchedHref)로부터 실시간 크롤링 시도
      if (!activeImgUrl && matchedHref) {
        console.log(`  🌐 [실시간 대표 이미지 크롤링] ${sourceName} (${cleanH2Title.slice(0, 30)})...`);
        const fetchedImg = await fetchArticleOgImage(matchedHref);
        if (fetchedImg) {
          activeImgUrl = fetchedImg;
          console.log(`  ✅ [실시간 이미지 획득 성공] ${fetchedImg}`);
        }
      }

      // 3) 이미지가 확보된 경우: R2 미러링 수행하여 HTTPS 환경 깨짐/차단 원천 방지
      if (activeImgUrl) {
        const mirrored = await mirrorImageToR2(activeImgUrl, 'blogs', baseSlug);
        const finalImgUrl = mirrored || activeImgUrl;

        let rest = h2EndIdx !== -1 ? sec.slice(h2EndIdx).trim() : '';
        // 기존의 이미지 태그 및 사진 출처 p태그를 말끔히 제거 후 재구성
        rest = rest.replace(/!\[[^\]]*\]\([^\)]+\)\s*/g, '');
        rest = rest.replace(/<p class="text-xs text-center[^>]*>.*?<\/p>\s*/gi, '');

        const captionHtml = `<p class="text-xs text-center text-neutral-500 dark:text-neutral-400 my-1">사진 출처: <a href="${matchedHref}" target="_blank" rel="noopener noreferrer">${sourceName}</a></p>`;
        return `${h2Line}\n\n![${cleanH2Title}](${finalImgUrl})\n${captionHtml}\n\n${rest}`;
      } else {
        // 이미지를 획득하지 못한 경우 사진 출처 p태그만 홀로 남지 않도록 정리
        let cleanedSec = sec.replace(/<p class="text-xs text-center[^>]*>.*?<\/p>\s*/gi, '');
        return cleanedSec;
      }
    })
  );
  body = updatedSections.join('\n\n');

  // Google News 링크를 디코딩된 실제 언론사 URL로 치환
  if (candidates && candidates.length > 0) {
    for (const cand of candidates) {
      if (cand.originalLink && cand.originalLink !== cand.link) {
        body = body.replaceAll(cand.link, cand.originalLink);
      }
    }
  }

  // 11) 하단 에디토리얼 푸터 문구 완전 제거
  body = body.replace(/\*?\s*본\s*다이제스트는.*?(?:발행됩니다|큐레이션되었습니다)\.?\s*\*?/g, '').trim();
  body = body.replace(/(?:\r?\n---\s*)+$/g, '').trim();

  // 12) H2 헤딩 수 검증
  const h2Count = (body.match(/^##\s+/gm) || []).length;
  console.log(`🔍 [포스트 구조 검증] H2 헤딩 수: ${h2Count}개 (기준: 4개 이상)`);
  if (h2Count < 4) {
    console.warn('⚠️ H2 헤딩 수가 4개 미만입니다. 프롬프트 규칙 재점검 요망.');
  }

  const finalMarkdown = `---\n${yaml.trim()}\n---\n\n${body.trim()}\n`;
  const filename = `${baseSlug}.md`;
  const filePath = path.join(POSTS_DIR, filename);

  return {
    title,
    slug: baseSlug,
    filename,
    filePath,
    content: finalMarkdown,
  };
}

/**
 * 11. 메인 다이제스트 생성 및 배포 파이프라인
 */
export async function runNewsDigestGeneration(options = {}) {
  const isDryRun = options.dryRun || process.argv.includes('--dry-run');
  const env = loadEnv();
  const dateInfo = getKSTDate();

  console.log(`\n======================================================`);
  console.log(`🌅 [포켓머니 아침 모닝 브리핑 파이프라인 가동]`);
  console.log(`📅 실행 일자: ${dateInfo.dateStr} ${dateInfo.timeStr} KST`);
  console.log(`🛠️ 실행 모드: ${isDryRun ? 'DRY-RUN (파일 생성 검증만)' : 'PRODUCTION (D1 발행 & 텔레그램 연동)'}`);
  console.log(`======================================================`);

  // Step 1: 뉴스 수집
  const rawItems = await fetchNewsFeeds();
  if (rawItems.length === 0) {
    throw new Error('수집된 뉴스 아이템이 없습니다. 파이프라인을 중단합니다.');
  }

  // Step 2: 핫이슈 스코어링 및 상위 후보 선별 (대표 이미지 크롤링 포함)
  const rankedItems = await deduplicateAndRank(rawItems);
  if (rankedItems.length === 0) {
    throw new Error('유효한 뉴스 후보가 0건입니다.');
  }

  // Step 2-1: 후보 기사 원문 URL 잔여 확인
  for (const item of rankedItems) {
    if (!item.originalLink || item.originalLink === item.link) {
      try {
        const decoded = decodeGoogleNewsUrl(item.link);
        if (decoded) item.originalLink = decoded;
      } catch (_) {}
    }
  }

  // Step 3: 기존 포스트 스캔 (내부 링크 추천용)
  const existingPosts = getExistingPosts();
  const existingPostsPromptText = existingPosts
    .map((p) => `- [${p.title}](/posts/${p.slug}) (카테고리: ${p.category}) - ${p.description.slice(0, 80)}...`)
    .join('\n');

  // Step 4: LLM 프롬프트 조립
  const newsCandidatesPromptText = rankedItems
    .map(
      (item, idx) => `
[후보 ${idx + 1}] [핫이슈 점수: ${item.hotnessScore || item.score}점, 교차보도: ${item.crossReportCount || 1}개사]
- 제목: ${item.title}
- 공식 출처: ${item.source}
- 원문 링크: ${item.originalLink || item.link}
- 대표 이미지: ${item.imageUrl || '없음'}
- 발행 시점: ${item.pubDate.toISOString().replace('T', ' ').slice(0, 16)} KST
- 주요 내용: ${item.description || '본문 요약 없음'}
`.trim()
    )
    .join('\n\n');

  const systemPrompt = `
당신은 대한민국 국민들의 실생활 금융, 정부 지원금, 세제 혜택, 복지 정책을 가장 쉽고 명쾌하게 전하는 대표 생활금융 미디어 '포켓머니'의 수석 에디터입니다.
오늘 아침 출근 및 통근 시간대(08:00~09:00 KST)에 모바일로 빠르게 훑어볼 수 있는 고밀도 "아침 모닝 브리핑 (Morning Money Digest)"을 작성해야 합니다.

[작성 대원칙]
1. [핫이슈 점수 기반 상위 4개 킬러 뉴스 엄선]:
   제공된 뉴스 후보 중 [핫이슈 점수: XX점, 교차보도: N개사] 지표가 가장 높으면서, 가계 지출 절감, 숨은 돈 환급, 저축/대출 금리 혜택, 소상공인/청년 지원 등 독자들의 지갑과 실생활 영향도가 가장 큰 최상위 4개 뉴스를 엄선하세요.
2. [High-CTR 제목 네이밍 규칙 - ★ 절대 규칙]:
   - ⚠️ [절대 금지 1] 제목에 날짜(예: 09/23, (09/24), 2026-09-24, 9월 24일, 오늘자, 금일 등)를 일체 넣지 마세요! 포스트 본문과 메타데이터에 작성일이 표시되므로 제목에 날짜를 쓸 필요가 없습니다.
   - ⚠️ [절대 금지 2] 제목에 콜론(:)을 일체 사용하지 마세요! (DB 배포 시 콜론 앞부분이 잘려나가는 버그가 있습니다. 콜론 대신 파이프 | 또는 따옴표를 사용하세요)
   - ⚠️ [절대 금지 3] 제목 끝에 '| 당신의 지갑을 지키는 모닝 브리핑', '| 모닝 머니 브리핑', '| 모닝 브리핑', 'TOP 4', '| 핵심 IT 뉴스 TOP 4' 등과 같은 상투적인 부제나 브랜딩 꼬리표 문구를 절대 붙이지 마세요! 오직 실제 기사의 뉴스 이슈 내용으로만 제목을 작성하세요.
   - 따옴표("..."), 대괄호([...]), 쉼표와 접속사, & 기호를 활용하여 핵심 뉴스 이슈 2~3개를 명확하고 간결하게 연결하세요.
   - 예시: [놓치면 손해] 청년도약계좌 기여금 확대 오늘부터 접수 & 햇살론 제도 개편안
3. [이모지 전면 배제 및 프로페셔널 톤앤매너 - ★ 엄격 준수]:
   - ⚡, 📌, 💡, 🌐, 🕒, 💬 등 남발되던 모든 이모지를 절대 사용하지 마세요!
   - 신뢰도 높은 전문 경제 언론사 스타일의 단정한 텍스트 헤딩과 타이포그래피 구조를 유지하세요.
4. [3줄 팩트 브리핑 둥근 박스 UI]:
   - 각 뉴스마다 3줄 팩트 요약은 반드시 ':::fact[핵심 팩트 요약]' 디렉티브 블록으로 작성하세요.
5. [출처 기사 주요 사진/이미지 임베딩 및 출처 명시]:
   - 후보에 제공된 '대표 이미지'가 있는 경우, 기사 H2 헤딩 바로 아래에 다음 형식으로 이미지를 삽입하세요:
     ![헤드라인 핵심 요약 대체텍스트](대표이미지URL)
     <p class="text-xs text-center text-neutral-500 dark:text-neutral-400 my-1">사진 출처: <a href="기사원문URL" target="_blank" rel="noopener noreferrer">언론사명</a></p>
   - 대표 이미지가 없거나 '없음'인 경우, 억지로 가짜 이미지를 넣지 말고 이미지 마크다운과 사진 출처 캡션을 완전히 생략하세요.
6. [E-E-A-T 40% 인사이트 규칙]:
   - 단순 기사 요약에 그치면 구글 저품질/비독창적 콘텐츠로 분류됩니다.
   - 팩트 브리핑 박스 다음에는 반드시 '### 가계 영향 및 실전 팁' 섹션을 핵심 위주로 1~2문단(200~350자 내외)으로 명쾌하고 실용적으로 자체 서술하세요. (신청 대상, 혜택 금액, 주의사항 등).
7. [기존 포스트 내부 링크 매칭]:
   - 각 뉴스 카드 하단에 제공된 [블로그 기존 심층 가이드 목록] 중 가장 연관성 높은 포스트를 1개씩 선정하여 '> **관련 가이드**:' 형식으로 내부 링크를 삽입하세요.
8. [독자 소통 / 댓글 유도 문구 영구 삭제]:
   - 블로그 내에 댓글 시스템이 존재하지 않으므로, '오늘 아침 여러분의 생각은?', '댓글로 이야기 나눠주세요', 또는 "본 다이제스트는..." 등의 안내 푸터 문구는 일체 작성하지 마세요.
`.trim();

  const userPrompt = `
오늘 날짜: ${dateInfo.dateStr}

[수집된 최신 뉴스 후보 목록 (상위 4개 엄선 요망)]:
${newsCandidatesPromptText}

[블로그 기존 심층 가이드 목록 (내부 링크 매칭용)]:
${existingPostsPromptText}

[출력 형식 주의사항]
- 절대로 서론, 결론, 인사말이나 추가 코멘트를 넣지 마세요.
- 코드 블록 마크다운(\`\`\`markdown)으로 감싸지 말고 반드시 첫 줄을 '---'로 시작하여 Frontmatter와 본문만 그대로 출력하세요.
- 제목에 날짜(09/23, 2026-09-24, 오늘자 등), 콜론(:), 상투적 부제/꼬리표('| 당신의 지갑을 지키는 모닝 브리핑', 'TOP 4', '| 모닝 머니 브리핑' 등)은 일체 사용하지 마세요. (파이프 | 또는 따옴표 사용)
- category는 무조건 "news"로 고정하세요.
- ⚡, 📌, 💡, 🌐, 🕒, 💬 등 모든 이모지는 일체 사용하지 마세요.

다음 마크다운 규격을 엄격히 준수하여 포스트 전체 내용을 작성하세요:

---
title: "[고효율 High-CTR 제목 - 날짜 일체 배제, 콜론(:) 절대 금지! | 또는 따옴표 사용]"
slug: "${dateInfo.yymmdd}01-morning-money-digest-[핵심영문슬러그]"
description: "오늘 아침 꼭 알아야 할 주요 정책 및 생활 금융 소식 4가지를 핵심 요약합니다. (130자 내외)"
category: "news"
tags: ["새소식", "모닝브리핑", "생활금융", "정부지원금", "환급금"]
author: "포켓머니"
reading_time: 4
featured_image: ""
affiliate: false
post_type: "digest"
---

:::tip[오늘의 모닝 브리핑 1분 핵심 요약]
- **[헤드라인 1 한줄 요약]**: 핵심 내용 1문장
- **[헤드라인 2 한줄 요약]**: 핵심 내용 1문장
- **[헤드라인 3 한줄 요약]**: 핵심 내용 1문장
- **[헤드라인 4 한줄 요약]**: 핵심 내용 1문장
:::

---

## [카테고리 1] 소식 제목

![헤드라인 핵심 대체텍스트](대표이미지URL)
<p class="text-xs text-center text-neutral-500 dark:text-neutral-400 my-1">사진 출처: <a href="기사원문URL" target="_blank" rel="noopener noreferrer">언론사명</a></p>

> **출처**: [언론사명](기사원문URL)  
> **발행**: ${dateInfo.dateStr} 00:00 KST | **신뢰도**: 공식 발표 (또는 보도자료/경제전문지)

:::fact[핵심 팩트 요약]
- 핵심 팩트 1
- 핵심 팩트 2
- 핵심 팩트 3
:::

### 가계 영향 및 실전 팁
(이 소식이 일반 가계나 직장인, 소상공인의 지갑에 미치는 구체적 영향과 실전 팁을 40% 이상 분량으로 상세 서술)

> **관련 가이드**:  
> [관련 기존 글 제목](/posts/해당글슬러그)

---

## [카테고리 2] 소식 제목
(동일한 규격으로 4개 소식까지 정확히 4개 카드 작성. 이미지가 없는 후보는 이미지 마크다운과 사진 출처 캡션을 생략)
`.trim();

  // Step 5: LLM 호출
  const rawLlmOutput = await callLLM(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    env
  );

  // Step 6: 결과 정제 및 로컬 파일 저장
  if (!fs.existsSync(POSTS_DIR)) {
    fs.mkdirSync(POSTS_DIR, { recursive: true });
  }

  const { title, slug, filename, filePath, content } = await cleanAndValidateMarkdown(rawLlmOutput, dateInfo, rankedItems);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`💾 [파일 저장 완료] ${filePath}`);
  console.log(`📝 포스트 제목: "${title}"`);
  console.log(`🔗 포스트 슬러그: "${slug}"`);

  if (isDryRun) {
    console.log(`\n🎉 [DRY-RUN 모드 완료] 파일이 성공적으로 생성되었습니다. D1 등록 및 Git 커밋은 건너뜁니다.`);
    return { title, slug, filePath, success: true };
  }

  // Step 7: Cloudflare D1 등록
  console.log(`🗄️ [Cloudflare D1 등록] publish-post.mjs 실행...`);
  execSync(`node scripts/publish-post.mjs "${filePath}"`, {
    cwd: BLOG_ROOT,
    stdio: 'inherit',
  });

  // Step 8: Astro 프로덕션 빌드 검증
  console.log(`⚙️ [빌드 검증] Astro 프로덕션 빌드 실행...`);
  execSync(`npm run build`, {
    cwd: BLOG_ROOT,
    stdio: 'inherit',
  });

  // Step 9: Git Commit & Push (Workers 배포 트리거)
  console.log(`📦 [배포 트리거] Git commit & push...`);
  try {
    execSync(`git add content/posts/${filename}`, { cwd: BLOG_ROOT });
    const staged = execSync(`git status --porcelain`, { cwd: BLOG_ROOT }).toString().trim();
    if (staged) {
      execSync(`git commit -m "feat(digest): morning news digest ${slug}"`, { cwd: BLOG_ROOT });
      try {
        execSync(`git pull --rebase origin main`, { cwd: BLOG_ROOT });
      } catch (_) {}
      execSync(`git push origin main`, { cwd: BLOG_ROOT });
      console.log(`🚀 [GitHub Push 완료] Workers 자동 배포가 시작되었습니다.`);
    }
  } catch (gitErr) {
    console.warn(`⚠️ Git push 중 경고 (D1 등록은 완료됨): ${gitErr.message}`);
  }

  // Step 10: 텔레그램 알림 발송
  const telegramMsg = `🌅 *[포켓머니(pockemoney) 아침 모닝 브리핑 발행 완료]*

⏰ *발행 시각:* ${dateInfo.timeStr} KST
📰 *세션:* 아침 뉴스 다이제스트 (Morning Digest)
📝 *제목:* ${title}
🔗 *슬러그:* ${slug}

*검증 상태:*
- 🗄️ D1 DB: 등록 성공 (blogs / news)
- ⚙️ 빌드: PASS (0 errors)
- 🚀 배포: Cloudflare Workers 동기화 완료`;

  await sendTelegramReport(telegramMsg);
  console.log(`📣 [텔레그램 알림 전송 완료]`);

  console.log(`\n✅ 아침 뉴스 다이제스트 파이프라인이 성공적으로 종료되었습니다!`);
  return { title, slug, filePath, success: true };
}

// CLI 직접 실행 처리
if (process.argv[1] && process.argv[1].endsWith('generate-news-digest.mjs')) {
  runNewsDigestGeneration()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`❌ [다이제스트 생성 실패]`, err.message);
      process.exit(1);
    });
}

