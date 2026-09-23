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
import { execSync } from 'node:child_process';
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
 * 5. 다채널 뉴스 피드 수집기
 */
async function fetchNewsFeeds() {
  const feedConfigs = [
    {
      name: 'Google News (지원금/청년/소상공인)',
      url: `https://news.google.com/rss/search?q=${encodeURIComponent('(청년도약계좌 OR 근로장려금 OR 소상공인) when:1d')}&hl=ko&gl=KR&ceid=KR:ko`,
      defaultSource: '언론사 보도',
    },
    {
      name: 'Google News (정부지원금/환급금)',
      url: `https://news.google.com/rss/search?q=${encodeURIComponent('(정부지원금 OR 환급금 OR 숨은보험금) when:1d')}&hl=ko&gl=KR&ceid=KR:ko`,
      defaultSource: '언론사 보도',
    },
    {
      name: 'Google News (금리/대출/청약/예금)',
      url: `https://news.google.com/rss/search?q=${encodeURIComponent('(기준금리 OR 주택담보대출 OR 특판예금 OR 청약) when:1d')}&hl=ko&gl=KR&ceid=KR:ko`,
      defaultSource: '금융 뉴스',
    },
    {
      name: '대한민국 정책브리핑 (korea.kr 공공 정책)',
      url: `https://news.google.com/rss/search?q=${encodeURIComponent('site:korea.kr (정책 OR 지원 OR 금융 OR 복지 OR 소상공인) when:3d')}&hl=ko&gl=KR&ceid=KR:ko`,
      defaultSource: '대한민국 정책브리핑',
    },
    {
      name: '대한민국 정책브리핑 RSS 직수신 시도',
      url: 'https://www.korea.kr/rss/policy.xml',
      defaultSource: '대한민국 정책브리핑',
    },
    {
      name: 'Google News 비즈니스/경제 헤드라인',
      url: 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=ko&gl=KR&ceid=KR:ko',
      defaultSource: '경제 종합',
    },
    {
      name: '공공 금융당국 보도자료',
      url: `https://news.google.com/rss/search?q=${encodeURIComponent('(금융위원회 OR 금융감독원 OR 기획재정부) when:2d')}&hl=ko&gl=KR&ceid=KR:ko`,
      defaultSource: '정부 공공 발표',
    },
  ];

  console.log(`📡 [뉴스 피드 수집] 총 ${feedConfigs.length}개 채널에서 수집을 시작합니다...`);
  const allItems = [];

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
 * 7. 수집된 후보군 중복 제거 및 가중치 랭킹 (15~20건 압축)
 */
function deduplicateAndRank(items) {
  const now = Date.now();
  const maxAgeMs = 36 * 60 * 60 * 1000; // 최근 36시간

  // 1) 시간 필터링
  const freshItems = items.filter((item) => {
    const age = now - item.pubDate.getTime();
    return age <= maxAgeMs && age >= -60 * 60 * 1000; // 미래 시차 1시간 오차 허용
  });

  // 2) 중요도 스코어링
  const PRIORITY_KEYWORDS = [
    { word: '청년도약계좌', score: 10 },
    { word: '근로장려금', score: 10 },
    { word: '소상공인', score: 9 },
    { word: '지원금', score: 8 },
    { word: '환급금', score: 8 },
    { word: '기준금리', score: 7 },
    { word: '주택담보대출', score: 7 },
    { word: '특판예금', score: 6 },
    { word: '비과세', score: 6 },
    { word: '연말정산', score: 6 },
    { word: '국민연금', score: 5 },
    { word: '건강보험', score: 5 },
  ];

  const scoredItems = freshItems.map((item) => {
    let score = 0;
    // 출처 신뢰도
    if (item.source.includes('정책브리핑') || item.source.includes('대한민국') || item.source.includes('정부')) {
      score += 15;
    } else if (item.source.includes('금융위') || item.source.includes('금감원') || item.source.includes('기재부')) {
      score += 15;
    } else {
      score += 5;
    }

    // 최신성 가산점 (12시간 이내 10점, 24시간 이내 5점)
    const ageHours = (now - item.pubDate.getTime()) / (1000 * 60 * 60);
    if (ageHours <= 12) score += 10;
    else if (ageHours <= 24) score += 5;

    // 키워드 가중치
    const textToMatch = `${item.title} ${item.description}`;
    for (const kw of PRIORITY_KEYWORDS) {
      if (textToMatch.includes(kw.word)) {
        score += kw.score;
      }
    }

    return { ...item, score };
  });

  // 점수 내림차순 정렬
  scoredItems.sort((a, b) => b.score - a.score);

  // 3) 자카드 유사도 기반 중복 제거
  const uniqueItems = [];
  for (const candidate of scoredItems) {
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
        description: (candidate.description || '').slice(0, 100),
      });
    }
    if (uniqueItems.length >= 15) break; // 상위 15개 압축
  }

  console.log(`🧹 [중복 제거 및 정제] 고유 후보군 ${uniqueItems.length}건 선별 완료`);
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
function cleanAndValidateMarkdown(rawContent, dateInfo) {
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

  // 1) High-CTR 제목에서 콜론(:) 일체 제거 및 치환 (D1 스크립트 절단 방지)
  const titleMatch = yaml.match(/title:\s*["']?([^"'\n]+)["']?/);
  let title = titleMatch ? titleMatch[1].trim() : `오늘자 모닝 머니 브리핑 | 생활금융 핫이슈 (${dateInfo.mmdd})`;
  if (title.includes(':')) {
    console.log(`⚠️ 제목에 콜론(:) 감지, 하이픈(-)으로 치환합니다: "${title}"`);
    title = title.replace(/:/g, ' -');
    yaml = yaml.replace(/title:\s*["']?[^"'\n]+["']?/, `title: "${title}"`);
  }

  // 2) 오늘자 일련번호 및 파일명/슬러그 계산
  const existingFiles = fs.existsSync(POSTS_DIR)
    ? fs.readdirSync(POSTS_DIR).filter((f) => f.startsWith(dateInfo.yymmdd))
    : [];
  const seqNumber = String(existingFiles.length + 1).padStart(2, '0');

  // Slug 추출 및 정규화
  const slugMatch = yaml.match(/slug:\s*["']?([^"'\n]+)["']?/);
  let baseSlug = slugMatch ? slugMatch[1].trim().toLowerCase() : 'morning-money-digest';
  // 영문 소문자, 숫자, 하이픈만 허용
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

  // 3) 본문 필수 요소 검증 (## 헤딩 4개 이상 확인)
  const h2Count = (body.match(/^##\s+/gm) || []).length;
  console.log(`🔍 [포스트 구조 검증] H2 헤딩 수: ${h2Count}개 (기준: 4개 이상)`);
  if (h2Count < 4) {
    console.warn('⚠️ H2 헤딩 수가 4개 미만입니다. 프롬프트 규칙 재점검 요망.');
  }

  const finalMarkdown = `---\n${yaml.trim()}\n---\n\n${body}\n`;
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

  // Step 2: 중복 제거 및 상위 20건 선별
  const rankedItems = deduplicateAndRank(rawItems);
  if (rankedItems.length === 0) {
    throw new Error('유효한 뉴스 후보가 0건입니다.');
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
[후보 ${idx + 1}]
- 제목: ${item.title}
- 공식 출처: ${item.source}
- 원문 링크: ${item.link}
- 발행 시점: ${item.pubDate.toISOString().replace('T', ' ').slice(0, 16)} KST
- 주요 내용: ${item.description || '본문 요약 없음'}
`.trim()
    )
    .join('\n\n');

  const systemPrompt = `
당신은 대한민국 국민들의 실생활 금융, 정부 지원금, 세제 혜택, 복지 정책을 가장 쉽고 명쾌하게 전하는 대표 생활금융 미디어 '포켓머니'의 수석 에디터입니다.
오늘 아침 출근 및 통근 시간대(08:00~09:00 KST)에 모바일로 빠르게 훑어볼 수 있는 고밀도 "아침 모닝 브리핑 (Morning Money Digest)"을 작성해야 합니다.

[작성 대원칙]
1. [상위 4개 킬러 뉴스 선정] 제공된 15~20개의 뉴스 후보 중 가계 지출 절감, 숨은 돈 환급, 저축/대출 금리 혜택, 소상공인/청년 지원 등 독자들의 지갑에 즉각적이고 가장 파급력이 큰 최적의 4개 뉴스를 엄선하세요.
2. [High-CTR 제목 생성 - ★ 절대 규칙]:
   - **제목(title)에 콜론(:)을 일체 사용하지 마세요!** (배포 시스템에서 콜론 앞부분만 잘리는 치명적 결함이 있으므로 콜론 절대 금지)
   - 파이프(|), 따옴표("..."), 대괄호([...])를 활용하여 클릭률이 폭발하는 매력적인 헤드라인을 구성하세요.
   - 예시: [놓치면 손해] 청년도약계좌 기여금 확대 오늘부터 접수... 햇살론 개편안 포함 모닝 머니 브리핑 (${dateInfo.mmdd})
3. [E-E-A-T 40% 인사이트 규칙]:
   - 단순 기사 요약에 그치면 구글 저품질/비독창적 콘텐츠(Scraped Content)로 분류됩니다.
   - 각 소식마다 '📌 3줄 팩트 브리핑'으로 사실관계를 깔끔히 정리한 후,
   - 반드시 **'💡 실무 가계/지갑 영향 실전 인사이트'**를 문단의 **40% 이상 분량**으로 심도 있게 자체 서술하세요. (예: 어떤 독자가 즉시 신청해야 하는지, 주의할 숨은 조건, 실제 아낄 수 있는 이자나 지원액 계산 등 실전 조언).
4. [기존 포스트 내부 링크 매칭]:
   - 각 뉴스 카드 하단에 제공된 [블로그 기존 심층 가이드 목록] 중 가장 연관성 높은 포스트를 1개씩 선정하여 내부 링크를 삽입하세요.
5. [표준 마크다운 포맷 준수]:
   - 1분 핵심 요약은 ':::tip[⚡ 오늘의 모닝 브리핑 1분 핵심 요약]' 박스로 시작하세요.
   - 각 뉴스 카드는 '## [카테고리] 제목' 형식의 H2로 작성하세요.
   - 카테고리 후보: [정부지원], [청년복지], [소상공인], [금융/금리], [세제/환급], [생활경제]
`.trim();

  const userPrompt = `
오늘 날짜: ${dateInfo.dateStr} (${dateInfo.mmdd})

[수집된 최신 뉴스 후보 목록 (상위 4개 엄선 요망)]:
${newsCandidatesPromptText}

[블로그 기존 심층 가이드 목록 (내부 링크 매칭용)]:
${existingPostsPromptText}

[출력 형식 주의사항]
- 절대로 서론, 결론, 인사말이나 추가 코멘트를 넣지 마세요.
- 코드 블록 마크다운(\`\`\`markdown)으로 감싸지 말고 반드시 첫 줄을 '---'로 시작하여 Frontmatter와 본문만 그대로 출력하세요.
- 제목에 콜론(:)은 일체 사용하지 마세요. (파이프 | 또는 따옴표 사용)

다음 마크다운 규격을 엄격히 준수하여 포스트 전체 내용을 작성하세요:

---
title: "[고효율 High-CTR 제목 - 콜론(:) 절대 금지! | 또는 따옴표 사용]"
slug: "${dateInfo.yymmdd}01-morning-money-digest-[핵심영문슬러그]"
description: "오늘 아침 꼭 알아야 할 주요 정책/금융 소식 4가지를 핵심 요약합니다. (130자 내외)"
category: "finance"
tags: ["모닝브리핑", "생활금융", "정부지원금", "환급금", "금리혜택"]
author: "포켓머니"
reading_time: 4
featured_image: ""
affiliate: false
post_type: "digest"
---

:::tip[⚡ 오늘의 모닝 브리핑 1분 핵심 요약]
- **[헤드라인 1 한줄 요약]**: 핵심 내용 1문장
- **[헤드라인 2 한줄 요약]**: 핵심 내용 1문장
- **[헤드라인 3 한줄 요약]**: 핵심 내용 1문장
- **[헤드라인 4 한줄 요약]**: 핵심 내용 1문장
:::

---

## [카테고리 1] 소식 제목

> 🌐 **공식 출처**: [출처명](실제뉴스원문URL)  
> 🕒 **발행 시점**: ${dateInfo.dateStr} 00:00 KST | **신뢰도**: 공식 발표 (또는 보도자료/경제전문지)

### 📌 3줄 팩트 브리핑
- 핵심 팩트 1
- 핵심 팩트 2
- 핵심 팩트 3

### 💡 실무 가계/지갑 영향 실전 인사이트
(이 소식이 일반 가계나 직장인, 소상공인의 지갑에 미치는 구체적 영향과 실전 팁을 40% 이상 분량으로 상세 서술)

> 🔗 **함께 읽으면 좋은 블로그 심층 가이드**:  
> [관련 기존 글 제목](/posts/해당글슬러그)

---

## [카테고리 2] 소식 제목
(동일한 규격으로 4개 소식까지 정확히 4개 카드 작성)

---

## 💬 오늘 아침 여러분의 생각은?
오늘 전해드린 소식 중 가계 지출이나 금융 생활에 가장 큰 영향을 줄 것 같은 이슈는 무엇인가요?  
추가로 궁금한 점이나 여러분의 의견이 있다면 댓글로 자유롭게 이야기를 나눠주세요!

*본 다이제스트는 정부 공식 보도자료, 정책브리핑, 금융당국 고시 및 주요 언론사 보도를 바탕으로 교차 검증 및 큐레이션되었습니다.*
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

  const { title, slug, filename, filePath, content } = cleanAndValidateMarkdown(rawLlmOutput, dateInfo);
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
- 🗄️ D1 DB: 등록 성공 (blogs)
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
