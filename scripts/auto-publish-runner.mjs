#!/usr/bin/env node
/**
 * blogs 자동 포스팅 오케스트레이터 및 스케줄러 (Auto Publish Runner & Daemon)
 * - 대상 블로그: 포켓머니 (blogs, /workspace/blogs)
 * - Two-Track 스케줄:
 *   1) 오전 세션: 08:20 ~ 08:50 KST (모닝 머니 다이제스트, ★ 주 7일 매일 무휴식 구동)
 *   2) 오후 세션: 18:15 ~ 18:45 KST (생활금융/복지 심층 가이드, 🎲 주 1회 랜덤 휴식)
 * 
 * [LLM 호출 경로 (2026-09-27 정리)]
 * - Gemini 네이티브 단일 경로 (thinkingBudget: 0, maxOutputTokens 16384, finishReason 검사)
 * - 제거된 경로: Tier 1 agy CLI (바이너리 부재로 전 기간 실패), Groq (키 401)
 *   근거: docs/SPEC_PIPELINE_STABILITY_AND_IMAGE_PIPELINE.md §4.2
 * 
 * 사용법:
 *   1) 수동 세션 즉시 실행:
 *      node scripts/auto-publish-runner.mjs morning                 # 아침 뉴스 다이제스트
 *      node scripts/auto-publish-runner.mjs lunch                   # 아침 뉴스 다이제스트 (호환성)
 *      node scripts/auto-publish-runner.mjs evening                 # 저녁 심층 가이드
 *      node scripts/auto-publish-runner.mjs evening --force         # 오늘 이미 완료되었어도 강제 실행
 *      node scripts/auto-publish-runner.mjs evening --dry-run       # D1/Git 건너뛰고 파일만 생성
 * 
 *   2) 백그라운드 스케줄러 데몬 모드:
 *      node scripts/auto-publish-runner.mjs daemon
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { sendTelegramReport } from './telegram-notify.mjs';
import { runNewsDigestGeneration } from './generate-news-digest.mjs';
import { gitPublish, publishPreflight, runGit } from './lib/git-publish.mjs';
import { callGemini } from './lib/llm.mjs';
import { acquireDaemonLock, isLockOwner, acquireBuildDeployLock, cleanDistDir } from './lib/runtime-lock.mjs';

// 프로세스 무중단 방어 핸들러 (예기치 못한 예외 발생 시 크래시 방지)
process.on('uncaughtException', (err) => {
  const time = new Date().toISOString();
  console.error(`[${time}] 🚨 [uncaughtException 방어] ${err?.stack || err}`);
});

process.on('unhandledRejection', (reason) => {
  const time = new Date().toISOString();
  console.error(`[${time}] 🚨 [unhandledRejection 방어] ${reason?.stack || reason}`);
});

const BLOG_ROOT = path.resolve(import.meta.dirname, '..');
const POSTS_DIR = path.join(BLOG_ROOT, 'content', 'posts');
const STATE_FILE = path.join(BLOG_ROOT, 'data', 'auto-publish-state.json');
const LOG_FILE = path.join(BLOG_ROOT, 'data', 'auto-publish.log');

// Node 22 및 로컬 bin 경로 PATH 최우선 등록 (Wrangler 및 Astro 5 구동 필수 환경 보장)
const NODE22_BIN = '/workspace/.node22/bin';
const LOCAL_BIN = path.join(BLOG_ROOT, 'node_modules', '.bin');
if (fs.existsSync(NODE22_BIN) && !process.env.PATH?.includes(NODE22_BIN)) {
  process.env.PATH = `${NODE22_BIN}:${process.env.PATH || ''}`;
}
if (fs.existsSync(LOCAL_BIN) && !process.env.PATH?.includes(LOCAL_BIN)) {
  process.env.PATH = `${LOCAL_BIN}:${process.env.PATH || ''}`;
}

// [P1] 데몬 단일 인스턴스 락 파일 (data/ 아래이므로 .gitignore 로 제외된다)
const DAEMON_LOCK_FILE = path.join(BLOG_ROOT, 'data', 'auto-publish-runner.lock');
const BUILD_LOCK_FILE = path.join(BLOG_ROOT, 'data', 'build-deploy.lock');

export function log(...args) {
  const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (_) {}
}

/**
 * 0. 환경 변수 자동 로드 (.env 다중 경로)
 */
export function loadEnvConfig() {
  const env = {};
  const envCandidates = [
    path.resolve('/workspace/.env'),
    path.resolve('/workspace/scripts/.env'),
    path.join(BLOG_ROOT, '.env'),
    path.resolve(process.cwd(), '.env'),
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
          if (!env[key]) {
            env[key] = val;
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      } catch (_) {}
    }
  }

  // 프로세스 환경변수는 .env에 없는 키만 보충
  for (const [k, v] of Object.entries(process.env)) {
    if (!env[k] && v) env[k] = v;
  }

  return env;
}

// 모듈 로드 시 환경변수 최우선 동기화
loadEnvConfig();

/**
 * [P0] 세션 단위 원자적 락 (다중 데몬 및 동시 실행 레이스 컨디션 원천 차단)
 */
function acquireSessionLock(sessionName, dateStr) {
  const lockDir = path.join(BLOG_ROOT, 'data');
  if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, `session-${sessionName}-${dateStr}.lock`);
  try {
    const fd = fs.openSync(lockFile, 'wx');
    const info = { pid: process.pid, session: sessionName, date: dateStr, startedAt: new Date().toISOString() };
    fs.writeSync(fd, JSON.stringify(info, null, 2), 'utf8');
    fs.closeSync(fd);
    log(`🔒 [세션 락 획득] ${sessionName} 세션 락 생성 (pid: ${process.pid}, ${lockFile})`);
    return {
      acquired: true,
      releaseOnFailure: () => {
        try { fs.unlinkSync(lockFile); } catch (_) {}
      }
    };
  } catch (err) {
    if (err.code === 'EEXIST') {
      log(`⛔ [세션 락 거부] 오늘(${dateStr}) ${sessionName} 세션이 이미 진행 중이거나 완료되었습니다 (${lockFile}).`);
      return { acquired: false };
    }
    throw err;
  }
}

export const FACT_SHEET_2026 = `[2026년 대한민국 핵심 생활금융·세무·복지 팩트시트 (기준 연도 2026년 철저 준수)]
- 연도 기준: 올해는 2026년입니다. 과거 연도(2024년, 2025년)를 '최신', '올해'로 언급하지 마십시오.
- 최저임금: 2026년 최저시급 10,030원 (주 40시간 기준 월 환산액 2,096,270원). 사상 첫 1만원대 진입.
- 기준 중위소득 (2026년 기준 4인가구): 약 609만원 (1인가구 약 239만원, 2인가구 약 390만원).
- 청년도약계좌: 5년 만기 시 최대 5,000만원 안팎 목돈 마련, 정부기여금 매칭 및 비과세 혜택.
- 청년내일저축계좌: 소득 기준 중위소득 100% 이하(차상위 이하는 1:3 매칭, 일반은 1:1 매칭).
- 근로장려금: 단독가구 최대 165만원, 홑벌이 최대 285만원, 맞벌이 최대 330만원.
- 국민취업지원제도: 1유형 구직촉진수당 월 50만원 x 6개월(부양가족 1인당 10만원 추가 지원).
- 출산·육아: 부모급여(0세 월 100만원, 1세 월 50만원), 육아휴직 급여 상한액 인상 적용.
- 세무/연말정산: 2026년 귀속 소득공제/세액공제 개정 사항 적용.`;

/**
 * 0-3. 마크다운 본문 공백 및 금융 금액 띄어쓰기 규범화
 */
/**
 * [P0-2] 발행 전 콘텐츠 품질 게이트 기준값
 * 프롬프트가 요구하는 하한과 동일하게 맞춘다.
 *   - "본문 내 최소 5개 이상의 깊이 있는 대주제(H2)"
 *   - "공백 포함 2,500자 ~ 3,500자 이상(공백 제외 1,800자 이상)"
 */
export const QUALITY_GATE = {
  MIN_H2: 5,
  MIN_NON_SPACE_CHARS: 1800,
  MIN_SPACE_INCLUDED_CHARS: 2800,
  MIN_REFERENCE_LINKS: 3,
  MAX_LLM_RETRY: 1, // 게이트 실패 시 LLM 재생성 시도 횟수
};

export function sanitizeProseSpaces(rawText) {
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
    // 마크다운 표 구분선(|---|) 하이픈 무한 반복 글리치 방어
    if (/^\s*\|.*\|\s*$/.test(line)) {
      return line
        .replace(/:-{4,}/g, ':---')
        .replace(/-{4,}:/g, '---:')
        .replace(/-{4,}/g, '---');
    }
    let cleaned = line.replace(/([^\s])\s{2,}([^\s])/g, '$1 $2').replace(/\s+$/, '');
    cleaned = cleaned.replace(/(\d+(?:,\d+)*(?:\.\d+)?)\s*만\s+원/g, '$1만원');
    cleaned = cleaned.replace(/(\d+(?:,\d+)*(?:\.\d+)?)\s*억\s+원/g, '$1억원');
    return cleaned;
  });
  return processed.join('\n');
}

const INTERNAL_REF_HOSTS = new Set([
  'pockemoney.com',
  'blogs.pockemoney.workers.dev',
  'www.pockemoney.com',
]);

/**
 * 본문에서 참고 출처 후보(외부 https 링크)를 추출한다.
 * 코드 블록과 이미지 태그, 사내 도메인, R2 미러 링크는 제외한다.
 * @param {string} body
 * @returns {string[]}
 */
function extractReferenceLinks(body) {
  if (!body) return [];
  const noCode = body.replace(/```[\s\S]*?```/g, ' ');
  const matches = [];
  const linkRe = /(?:^|[^!])\[[^\]]*\]\(\s*(https?:\/\/[^\s)>]+)\s*\)|<https?:\/\/[^\s>]+>/g;
  let m;
  while ((m = linkRe.exec(noCode)) !== null) {
    if (m[1]) matches.push(m[1].replace(/[),.]$/, '').trim());
    if (m[0] && m[0].startsWith('<')) matches.push(m[0].slice(1, -1).trim());
  }
  const seen = new Set();
  const unique = [];
  for (const url of matches) {
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (INTERNAL_REF_HOSTS.has(host)) continue;
    if (host.endsWith('r2.dev') || host.endsWith('workers.dev')) continue;
    const norm = `${new URL(url).origin}${new URL(url).pathname}`.replace(/\/+$/, '');
    if (seen.has(norm)) continue;
    seen.add(norm);
    unique.push(url);
  }
  return unique.slice(0, 12);
}

/**
 * 참고 출처 링크의 유효성을 HEAD/GET 요청으로 점검한다.
 * 404/410 등 명백히 죽은 링크는 배제하고, 봇 차단(403/429)과
 * 네트워크 오류(타임아웃/DNS)는 유효 가능성으로 허용한다.
 * @param {string[]} urls
 * @returns {Promise<{ ok: boolean, active: number, gone: number, errors: number }>}
 */
async function verifyReferenceLinks(urls) {
  if (!urls.length) return { ok: false, active: 0, gone: 0, errors: 0 };
  const results = await Promise.allSettled(
    urls.map(async (url) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const res = await fetch(url, {
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlogQualityChecker/1.0)' },
            redirect: 'follow',
            signal: controller.signal,
          });
          const status = res.status;
          if (status >= 200 && status < 300) return { kind: 'ok' };
          if (status === 404 || status === 410) return { kind: 'gone' };
          if (status >= 400 && status < 600) return { kind: 'blocked' };
          return { kind: 'ok' };
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return { kind: 'error' };
        return { kind: 'error' };
      }
    })
  );
  const counted = { active: 0, gone: 0, blocked: 0, errors: 0 };
  for (const r of results) {
    const kind = r.status === 'fulfilled' && r.value ? r.value.kind : 'error';
    counted[kind === 'ok' ? 'active' : kind === 'blocked' ? 'active' : kind] += 1;
  }
  return {
    ok: counted.active >= QUALITY_GATE.MIN_REFERENCE_LINKS,
    active: counted.active,
    gone: counted.gone,
    errors: counted.errors,
  };
}

/**
 * 본문 글자 수 기반 읽기 시간(분) 계산. 한국어 1,200자/분 평균 기준.
 * @param {number} charCount
 * @returns {number}
 */
function estimateReadingMinutes(charCount) {
  return Math.min(15, Math.max(4, Math.round(charCount / 1200)));
}

// 6대 카테고리 목록
const ALL_CATEGORIES = [
  'welfare', 'tax', 'finance', 'saving', 'subsidy', 'life-tips'
];

/**
 * 상태 파일 로드
 */
function loadState() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
      log('상태 파일 읽기 실패, 초기화합니다:', e.message);
    }
  }

  const initialState = {
    last_updated: new Date().toISOString(),
    category_counts: Object.fromEntries(ALL_CATEGORIES.map((c) => [c, 0])),
    last_session: null,
    history: [],
  };
  saveState(initialState);
  return initialState;
}

/**
 * 상태 파일 저장
 */
function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  state.last_updated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * 오늘 특정 세션이 이미 성공했는지 확인 (중복 실행 방지)
 */
function isSessionAlreadyDone(state, sessionName, todayDateStr) {
  return state.history.some(
    (h) => h.date === todayDateStr && h.session === sessionName && h.status === 'success'
  );
}

const FRONTMATTER_MAX_BYTES = 65536;

/**
 * 포스트 파일의 Frontmatter 헤더 블록만 고속으로 읽는다.
 */
function readFrontmatterHead(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (_) {
    return '';
  }
  try {
    const CHUNK = 8192;
    const buf = Buffer.alloc(FRONTMATTER_MAX_BYTES);
    let total = 0;
    while (total < FRONTMATTER_MAX_BYTES) {
      const n = fs.readSync(fd, buf, total, CHUNK, total);
      if (n <= 0) break;
      total += n;
      const so_far = buf.slice(0, total).toString('utf8');
      if (/^---\r?\n[\s\S]*?^---/m.test(so_far)) break;
    }
    return buf.slice(0, total).toString('utf8');
  } catch (_) {
    return '';
  } finally {
    try {
      fs.closeSync(fd);
    } catch (_) {}
  }
}

/**
 * 포스트가 모닝 다이제스트(뉴스) 포스트인지 정밀 판별한다.
 * (파일명이 아닌 Frontmatter의 post_type: "digest" 또는 category: "news" 기준)
 */
function isDigestPost(filePath) {
  try {
    const head = readFrontmatterHead(filePath);
    if (/post_type:\s*["']?digest["']?/i.test(head)) return true;
    if (/category:\s*["']?news["']?/i.test(head)) return true;
    return false;
  } catch (_) {
    return false;
  }
}


/**
 * 카테고리 균등 배분 알고리즘
 * - 누적 발행 수가 가장 적은 카테고리 우선 선택
 * - 직전 세션 카테고리 중복 방지
 */
function selectOptimalCategory(state, sessionName) {
  const counts = state.category_counts || {};
  const lastHistory = state.history[state.history.length - 1];
  const lastCategory = lastHistory ? lastHistory.category : null;

  // 정렬: 카테고리별 발행 횟수 오름차순
  const sorted = [...ALL_CATEGORIES].sort((a, b) => (counts[a] || 0) - (counts[b] || 0));

  // 직전 카테고리와 다른 것 중 최소 발행 카테고리 선발
  for (const cat of sorted) {
    if (sorted.length > 1 && cat === lastCategory) continue;
    return cat;
  }
  return sorted[0];
}

/**
 * KST (한국 표준시, UTC+9) 현재 날짜 및 시간 반환
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
  const hours = parseInt(parts.hour, 10);
  const minutes = parseInt(parts.minute, 10);
  const timeStr = `${parts.hour}:${parts.minute}`;
  const dayOfWeek = new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0: 일, 1: 월, ..., 6: 토
  return { now, dateStr, hours, minutes, timeStr, dayOfWeek };
}

const DAY_NAMES = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

/**
 * 주차 식별자 계산 (ISO 8601 기준 연-주차, 예: 2026-W39)
 */
function getYearWeek(dateStr) {
  const date = new Date(`${dateStr}T12:00:00Z`);
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * 주 1회 오후 심층글 스킵 요일 선정 및 유지 (자연스러운 휴식일 시뮬레이션)
 * - 오전 뉴스 다이제스트는 매일(주 7일) 무휴식 구동
 * - 오후 심층글은 주 1회 랜덤 휴식
 */
function checkOrUpdateWeeklySkip(state, dateStr) {
  const currentWeek = getYearWeek(dateStr);
  if (
    !state.weekly_skip_config ||
    state.weekly_skip_config.current_week !== currentWeek ||
    state.weekly_skip_config.skip_afternoon_day === undefined ||
    state.weekly_skip_config.skip_afternoon_day === null
  ) {
    const randomDay = Math.floor(Math.random() * 7); // 0~6 중 랜덤 요일
    state.weekly_skip_config = {
      current_week: currentWeek,
      skip_afternoon_day: randomDay,
      skip_day_name: DAY_NAMES[randomDay],
    };
    saveState(state);
    log(`🎲 [주간 변칙 스케줄 갱신] ${currentWeek} 주간 1회 오후 심층글 휴식 요일 배정: ${DAY_NAMES[randomDay]}`);
  }
  return state.weekly_skip_config;
}

/**
 * 일일 랜덤 시간 생성 (점심: 11:15~11:45, 저녁: 18:15~18:45)
 */
function getRandomTargetMinutes(minHour, minMinute, maxHour, maxMinute) {
  const minTotal = minHour * 60 + minMinute;
  const maxTotal = maxHour * 60 + maxMinute;
  const randomTotal = Math.floor(Math.random() * (maxTotal - minTotal + 1)) + minTotal;
  return {
    hour: Math.floor(randomTotal / 60),
    minute: randomTotal % 60,
  };
}

/**
 * 다변화된 데이터 시각화 차트 6종 프리셋
 * - 매 포스팅마다 랜덤으로 선정되며, 직전 발행 포스트와 중복되지 않도록 자동 순환
 */
export const CHART_PRESETS = [
  {
    type: 'stacked-bar',
    name: '누적 분할 스택 바 차트 (Stacked Segment Breakdown Bar)',
    instruction: `[선정된 차트 유형: 누적 분할 스택 바 차트]
전체 수혜액/총액 대비 세부 항목 비중(예: 원금 vs 이자 vs 기여금, 기본급 vs 수당)을 '누적 분할 스택 바 차트'로 작성하세요.
HTML 구조 규격:
<div class="financial-chart-box">
<div class="chart-header">
<div class="chart-title"><span>📊</span><span>[차트 제목: 전체 수혜액 항목별 비중 구성]</span></div>
<div class="chart-subtitle">[기준 설명 및 산정 조건]</div>
</div>
<div class="stacked-bar-wrapper">
<div class="stacked-bar-track">
<div class="stacked-bar-segment bg-blue-600" style="width: 50%;">50%</div>
<div class="stacked-bar-segment bg-teal-600" style="width: 30%;">30%</div>
<div class="stacked-bar-segment bg-amber-500" style="width: 20%;">20%</div>
</div>
<div class="stacked-bar-cards">
<div class="stacked-card-item">
<div class="stacked-card-header"><span class="font-medium text-neutral-700 dark:text-neutral-300">항목 1</span><span class="text-xs font-bold text-blue-600 dark:text-blue-400 font-mono">50%</span></div>
<div class="stacked-card-amount text-blue-600 dark:text-blue-400 font-mono">300만원</div>
<div class="stacked-card-desc">설명 요약</div>
</div>
<!-- 필요 항목 반복 -->
</div>
<div class="p-3 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200/60 dark:border-blue-800/40 text-xs text-blue-800 dark:text-blue-300 flex items-center justify-between">
<span>💡 <strong>총 혜택 합계: OOO만원</strong> (비과세 혜택 적용)</span>
<span class="font-mono font-bold text-blue-700 dark:text-blue-300 text-sm">합계 100%</span>
</div>
</div>
</div>`,
  },
  {
    type: 'column-chart',
    name: '세로 컬럼 막대 차트 (Vertical Column Bar Chart)',
    instruction: `[선정된 차트 유형: 세로 컬럼 막대 차트]
소득 구간별, 가입 기간별, 또는 기관/은행별 비교 수치를 '세로 컬럼 막대 차트'로 작성하세요.
HTML 구조 규격:
<div class="financial-chart-box">
<div class="chart-header">
<div class="chart-title"><span>📊</span><span>[차트 제목: 구간별/기관별 수치 비교]</span></div>
<div class="chart-subtitle">[기준 데이터 및 대상 요건]</div>
</div>
<div class="column-chart-wrapper">
<div class="column-chart-item">
<span class="column-value">300만원</span>
<div class="column-track"><div class="column-fill bg-neutral-400" style="height: 45%;">45%</div></div>
<span class="column-label">구간 A</span>
</div>
<div class="column-chart-item">
<span class="column-value">450만원</span>
<div class="column-track"><div class="column-fill bg-teal-600" style="height: 70%;">70%</div></div>
<span class="column-label">구간 B</span>
</div>
<div class="column-chart-item">
<span class="column-value text-emerald-600 font-bold">600만원</span>
<div class="column-track"><div class="column-fill bg-gradient-to-t from-emerald-600 to-teal-500" style="height: 100%;">최대</div></div>
<span class="column-label font-bold text-emerald-700 dark:text-emerald-300">최고 혜택</span>
</div>
</div>
</div>`,
  },
  {
    type: 'step-pipeline',
    name: '단계별 파이프라인 퍼널 차트 & 비교 막대 그래프 (Step Progression & Bar Chart)',
    instruction: `[선정된 차트 유형: 단계별 파이프라인 로드맵 + 비교 막대 그래프]
제도 참여 단계별 누적 수령액 로드맵과 함께, 일반 상품 대비 수혜액 격차를 시각적으로 비교하는 수평 막대 그래프를 함께 작성하세요.
HTML 구조 규격:
<div class="financial-chart-box">
<div class="chart-header">
<div class="chart-title"><span>📈</span><span>[차트 제목 1: 구간별/상품별 실수령액 비교]</span></div>
<div class="chart-subtitle">[상세 비교 기준 및 분석]</div>
</div>
<div class="bar-chart-row">
<div class="bar-chart-label"><span>비교 대상 1</span><span class="font-bold">수치 1</span></div>
<div class="bar-chart-track"><div class="bar-chart-fill bg-neutral-400" style="width: 60%;">60%</div></div>
</div>
<div class="bar-chart-row">
<div class="bar-chart-label"><span class="text-emerald-700 dark:text-emerald-300 font-bold">최대 혜택 대상</span><span class="font-bold text-emerald-600">최대 수치</span></div>
<div class="bar-chart-track"><div class="bar-chart-fill bg-gradient-to-r from-emerald-600 to-teal-500" style="width: 100%;">100% (최고)</div></div>
</div>
</div>

<div class="financial-chart-box">
<div class="chart-header">
<div class="chart-title"><span>🚀</span><span>[차트 제목 2: 단계별 누적 혜택 로드맵]</span></div>
<div class="chart-subtitle">[단계별 혜택 지급 조건 및 누적 합산액]</div>
</div>
<div class="pipeline-flow-wrapper">
<div class="pipeline-step">
<span class="pipeline-step-badge bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">1단계</span>
<div class="pipeline-step-title">초기 지원금</div>
<div class="pipeline-step-amount text-blue-600 dark:text-blue-400 font-mono">100만원</div>
<div class="pipeline-step-desc">신청 초기 즉시 지급</div>
</div>
<div class="pipeline-step">
<span class="pipeline-step-badge bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300">2단계</span>
<div class="pipeline-step-title">중간 인센티브</div>
<div class="pipeline-step-amount text-teal-600 dark:text-teal-400 font-mono">+150만원</div>
<div class="pipeline-step-desc">6개월 성실 이행 시</div>
</div>
<div class="pipeline-step border-emerald-300 dark:border-emerald-700">
<span class="pipeline-step-badge bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">최종 단계</span>
<div class="pipeline-step-title">만기/성공금</div>
<div class="pipeline-step-amount text-emerald-600 dark:text-emerald-400 font-mono">+250만원</div>
<div class="pipeline-step-desc font-bold text-emerald-700 dark:text-emerald-300">최종 누적 총 500만원</div>
</div>
</div>
</div>`,
  },
  {
    type: 'stat-grid',
    name: '통계 지표 비교 카드 그리드 & 비교 막대 그래프 (Stat Metric Grid & Bar Chart)',
    instruction: `[선정된 차트 유형: 핵심 통계 지표 카드 + 수치 비교 막대 그래프]
핵심 3대 혜택 지표 카드와 함께, 지원 구간별 차등 혜택을 시각적으로 보여주는 수평 가로 막대 차트를 함께 작성하세요.
HTML 구조 규격:
<div class="financial-chart-box">
<div class="chart-header">
<div class="chart-title"><span>⚡</span><span>[차트 제목 1: 핵심 3대 수혜 지표 요약]</span></div>
<div class="chart-subtitle">[공식 고시 기준 핵심 데이터 분석]</div>
</div>
<div class="stat-grid-wrapper">
<div class="stat-card-item">
<div class="stat-card-top"><span class="text-xs font-semibold text-neutral-500">기본 지표</span><span class="text-xs font-bold text-blue-600 font-mono">연 최고</span></div>
<div class="stat-card-metric text-blue-700 dark:text-blue-300">연 6.0%</div>
<div class="text-xs text-neutral-600 dark:text-neutral-400">시중 최고 수준 금리</div>
</div>
<div class="stat-card-item">
<div class="stat-card-top"><span class="text-xs font-semibold text-neutral-500">정부 지원</span><span class="text-xs font-bold text-teal-600 font-mono">매칭 지원</span></div>
<div class="stat-card-metric text-teal-700 dark:text-teal-300">최대 144만원</div>
<div class="text-xs text-neutral-600 dark:text-neutral-400">월 최대 매칭 지원금</div>
</div>
<div class="stat-card-item">
<div class="stat-card-top"><span class="text-xs font-semibold text-neutral-500">절세 혜택</span><span class="text-xs font-bold text-amber-600 font-mono">전액 면제</span></div>
<div class="stat-card-metric text-amber-700 dark:text-amber-300">15.4% 비과세</div>
<div class="text-xs text-neutral-600 dark:text-neutral-400">이자 소득세 전액 면제</div>
</div>
</div>
</div>

<div class="financial-chart-box">
<div class="chart-header">
<div class="chart-title"><span>📈</span><span>[차트 제목 2: 구간별 수치 비교 막대 그래프]</span></div>
<div class="chart-subtitle">[상세 비교 기준 및 분석]</div>
</div>
<div class="bar-chart-row">
<div class="bar-chart-label"><span>비교 대상 1</span><span class="font-bold">수치 1</span></div>
<div class="bar-chart-track"><div class="bar-chart-fill bg-neutral-400" style="width: 50%;">50%</div></div>
</div>
<div class="bar-chart-row">
<div class="bar-chart-label"><span class="text-emerald-700 dark:text-emerald-300 font-bold">최대 혜택 대상</span><span class="font-bold text-emerald-600">최대 수치</span></div>
<div class="bar-chart-track"><div class="bar-chart-fill bg-gradient-to-r from-emerald-600 to-teal-500" style="width: 100%;">100% (최고)</div></div>
</div>
</div>`,
  },
  {
    type: 'horizontal-bar',
    name: '수평 가로 막대 차트 (Horizontal Bar Chart)',
    instruction: `[선정된 차트 유형: 수평 가로 막대 차트]
소득 분위별 또는 일반 금융 상품 대비 실수령액 격차를 '수평 가로 막대 차트'로 작성하세요.
HTML 구조 규격:
<div class="financial-chart-box">
<div class="chart-header">
<div class="chart-title"><span>📈</span><span>[차트 제목: 구간별/상품별 수치 비교]</span></div>
<div class="chart-subtitle">[상세 비교 기준 및 분석]</div>
</div>
<div class="bar-chart-row">
<div class="bar-chart-label"><span>비교 대상 1</span><span class="font-bold">수치 1</span></div>
<div class="bar-chart-track"><div class="bar-chart-fill bg-neutral-400" style="width: 50%;">50%</div></div>
</div>
<div class="bar-chart-row">
<div class="bar-chart-label"><span>비교 대상 2</span><span class="font-bold">수치 2</span></div>
<div class="bar-chart-track"><div class="bar-chart-fill bg-teal-600" style="width: 75%;">75%</div></div>
</div>
<div class="bar-chart-row">
<div class="bar-chart-label"><span class="text-emerald-700 dark:text-emerald-300 font-bold">최대 혜택 대상</span><span class="font-bold text-emerald-600">최대 수치</span></div>
<div class="bar-chart-track"><div class="bar-chart-fill bg-gradient-to-r from-emerald-600 to-teal-500" style="width: 100%;">100% (최고)</div></div>
</div>
</div>`,
  },
  {
    type: 'donut-chart',
    name: '원형 도넛 SVG 차트 (SVG Donut Breakdown Chart)',
    instruction: `[선정된 차트 유형: 원형 도넛 SVG 차트]
만기 총액의 세부 항목별 구성비(원금 vs 정부기여금 vs 은행이자)를 '원형 도넛 SVG 차트'로 작성하세요.
HTML 구조 규격:
<div class="financial-chart-box">
<div class="chart-header">
<div class="chart-title"><span>🥧</span><span>[차트 제목: 세부 비중 분석]</span></div>
<div class="chart-subtitle">[만기 총액 기준 항목별 비중]</div>
</div>
<div class="donut-chart-wrapper">
<div class="donut-graphic">
<svg viewBox="0 0 42 42">
<circle cx="21" cy="21" r="15.915" fill="transparent" stroke="currentColor" stroke-width="5" class="text-neutral-200 dark:text-neutral-800" />
<circle cx="21" cy="21" r="15.915" fill="transparent" stroke="#059669" stroke-width="5" stroke-dasharray="70 30" stroke-dashoffset="0" />
<circle cx="21" cy="21" r="15.915" fill="transparent" stroke="#0d9488" stroke-width="5" stroke-dasharray="30 70" stroke-dashoffset="-70" />
</svg>
<div class="donut-center-text"><span class="text-xs text-neutral-400">총합</span><span class="text-base font-black font-mono">수치</span></div>
</div>
<div class="donut-legend">
<div class="donut-legend-item"><div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-emerald-600 shrink-0"></span><span>항목 1</span></div><span class="font-bold font-mono">금액 1</span></div>
<div class="donut-legend-item"><div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full bg-teal-600 shrink-0"></span><span>항목 2</span></div><span class="font-bold font-mono">금액 2</span></div>
</div>
</div>
</div>`,
  }
];

/**
 * 🌅 아침 뉴스 다이제스트 전용 파이프라인 (Morning News Digest)
 * - 매일(주 7일) 무휴식 구동
 * - 다채널 뉴스 피드 수집 + LLM(Groq/Gemini) 큐레이션 + D1 발행 + 텔레그램 연동
 */
/**
 * [자가 복구] 원격에 반영되지 못한 로컬 커밋이 남아 있으면 밀어낸다.
 *
 * 왜 필요한가
 *   2026-09-29 저녁 발행 2건이 D1 등록까지 성공한 뒤 push 에서 죽었다.
 *   그런데 상태 파일에는 이미 `success` 로 기록돼 있었기 때문에
 *   중복 실행 방지 로직이 이후 재시도를 전부 건너뛰었다.
 *   결과적으로 사람이 알기 전까지 사이트가 이전 빌드를 서빙했다.
 *
 * 무엇을 하는가
 *   글 생성 없이, 남은 커밋만 원격으로 밀어낸다.
 *   (재발행은 slug 충돌·중복 콘텐츠 위험이 있어 하지 않는다)
 */
function drainPendingDeploys() {
  let pending = 0;
  try {
    const out = runGit(BLOG_ROOT, ['rev-list', '--count', 'origin/main..HEAD'], { timeout: 30000 });
    pending = parseInt(String(out).trim(), 10) || 0;
  } catch (err) {
    // 원격에 아직 접근 못 하면 조용히 넘어간다 (사전 점검이 별도로 알린다)
    log(`ℹ️ [자가 복구] 미반영 커밋 확인 불가: ${err.gitStderr || err.message}`);
    return;
  }

  if (pending === 0) {
    log(`✅ [자가 복구] 미반영 커밋 없음 (로컬과 원격 동기화 완료)`);
    return;
  }

  log(`⚠️ [자가 복구] 원격에 반영되지 못한 커밋 ${pending}건 발견 — 푸시합니다.`);
  try {
    gitPublish({
      repoRoot: BLOG_ROOT,
      paths: [], // 이미 커밋되어 있으므로 스테이징 대상 없음
      message: 'chore: drain pending deploy',
      log: (m) => log(`   ${m}`),
    });
    log(`✅ [자가 복구] ${pending}건 커밋을 원격에 반영했습니다.`);
  } catch (err) {
    // 자가 복구 실패는 조용히 넘기지 않는다 — 운영자가 알아야 한다
    log(`❌ [자가 복구 실패] ${pending}건 커밋을 원격에 반영하지 못했습니다: ${err.message}`);
    log(`   ⚠️ 사이트가 이전 빌드를 서빙 중입니다. 수동 확인이 필요합니다.`);
  }
}

export async function runMorningNewsDigestPipeline(options = {}) {
  const { dateStr, timeStr } = getKSTDate();
  console.log(`\n========================================`);
  console.log(`🌅 [포켓머니 아침 모닝 브리핑 시작] ${dateStr} (morning) 실행 시각: ${timeStr} KST`);
  console.log(`========================================`);

  // [P0 · 2026-09-29] 발행 착수 전 GitHub 인증 사전 점검.
  // push 권한이 없으면 D1 등록까지 끝난 뒤 사이트가 이전 빌드를 서빙하는
  // 최악의 상태가 되므로, 아무것도 쓰기 전에 먼저 차단한다.
  if (!options.dryRun) {
    const pre = publishPreflight(BLOG_ROOT, (m) => console.log(m));
    if (!pre.ok) {
      console.error(`❌ [사전 점검 실패] ${pre.error}`);
      console.error(`   ${pre.hint}`);
      console.error(`   발행 착수를 중단합니다. (D1/R2 미등록, 로컬 변경 없음)`);
      throw new Error(`GitHub 사전 점검 실패로 발행 중단: ${pre.error}`);
    }
  }

  const state = loadState();

  // 1. 중복 실행 검사
  let sessionLock = null;
  if (!options.force && !options.dryRun) {
    const isDone = state.history.some(
      (h) => h.date === dateStr && (h.session === 'morning' || h.session === 'lunch') && h.status === 'success'
    );
    if (isDone) {
      console.log(`ℹ️ [중복 방지] 오늘(${dateStr}) 아침 다이제스트 세션은 이미 성공적으로 완료되었습니다. 건너뜁니다.`);
      return true;
    }

    // 파일시스템 기반 실제 포스트 존재 여부 2차 검증 (YYMMDD 형태 중복 방지)
    const yy = dateStr.slice(2, 4);
    const mm = dateStr.slice(5, 7);
    const dd = dateStr.slice(8, 10);
    const prefix = `${yy}${mm}${dd}`;
    const existingPosts = fs.existsSync(POSTS_DIR)
      ? fs.readdirSync(POSTS_DIR).filter(f =>
          f.startsWith(prefix) &&
          (f.endsWith('.md') || f.endsWith('.mdx')) &&
          f !== 'template.md' &&
          isDigestPost(path.join(POSTS_DIR, f))
        )
      : [];
    if (existingPosts.length > 0) {
      console.log(`ℹ️ [중복 방지] 오늘(${dateStr}) 생성된 모닝 다이제스트 포스트(${existingPosts.join(', ')})가 이미 파일시스템에 존재합니다. 건너뜁니다.`);
      return true;
    }

    // 원자적 세션 락 획득 시도 (동시 구동 레이스 컨디션 차단)
    sessionLock = acquireSessionLock('morning', dateStr);
    if (!sessionLock.acquired) {
      return true;
    }
  }

  try {
    const res = await runNewsDigestGeneration(options);
    if (!res || !res.success) {
      throw new Error('뉴스 다이제스트 생성에 실패했습니다.');
    }

    if (options.dryRun) {
      console.log(`ℹ️ [DRY-RUN] 아침 다이제스트 시뮬레이션 완료.`);
      return true;
    }

    // 상태 파일 갱신 (오전 다이제스트 전용 카테고리 'news' 고정)
    state.last_session = 'morning';
    state.category_counts['news'] = (state.category_counts['news'] || 0) + 1;
    state.history.push({
      date: dateStr,
      session: 'morning',
      time: timeStr,
      category: 'news',
      title: res.title,
      slug: res.slug,
      post_type: 'digest',
      status: 'success',
    });
    saveState(state);

    console.log(`✅ [아침 모닝 브리핑 완료] "${res.title}" (${res.slug})`);
    return true;
  } catch (err) {
    console.error(`❌ [아침 다이제스트 파이프라인 실패]`, err.message);
    if (sessionLock?.releaseOnFailure) {
      sessionLock.releaseOnFailure();
    }

    state.history.push({
      date: dateStr,
      session: 'morning',
      time: timeStr,
      category: 'news',
      status: 'failed',
      error: err.message,
    });
    saveState(state);

    const failMsg = `⚠️ *[blogs 아침 뉴스 다이제스트 실패]*\n\n⏰ *시간:* ${timeStr} KST\n❌ *오류:* ${err.message}`;
    await sendTelegramReport(failMsg);
    return false;
  }
}

/**
 * 저녁 심층글 LLM 호출 — Gemini 네이티브 단일 경로
 *
 * [P0-3 변경 사유]
 * 1) Groq 제거: API 키가 401 Invalid Api Key를 전 기간 반환했으나 매 세션 1순위로 호출되어
 *    의미 없는 요청과 지연만 발생시켰다.
 * 2) Gemini 네이티브 + thinkingBudget:0: 기존 OpenAI 호환 엔드포인트는 `max_tokens` 하드캡에
 *    걸려 글이 잘렸고, `finish_reason` 을 전혀 검사하지 않아 잘린 글이 "성공"으로 발행됐다.
 *    (실제 사례: 2,020자 / H2 3개 글이 심층 가이드로 D1 등록)
 * 3) MAX_TOKENS 감지 시 `truncated=true` 예외를 던져 호출자가 중단/재시도를 결정하게 한다.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} env
 * @returns {Promise<string>}
 */
export async function callLLMWithFallback(messages, env) {
  const systemPrompt = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const userPrompt = messages
    .filter((m) => m.role !== 'system')
    .map((m) => m.content)
    .join('\n\n');

  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY가 설정되지 않았습니다.');
  }

  const result = await callGemini({
    systemPrompt,
    userPrompt,
    env,
    maxOutputTokens: 16384,
    temperature: 0.6,
    log: (m) => log(m),
  });

  if (result.truncated) {
    throw new Error(result.message);
  }
  log(`✅ [LLM 생성 성공] ${result.model} (글자 수: ${result.text.length}자)`);
  return result.text;
}

/**
 * 마크다운 응답 파싱, Frontmatter 정합성 보정 및 YYMMDDNN-[slug].md 파일 저장
 */
export async function parseAndSaveArticleMarkdown({ rawMarkdown, category, targetDateStr, selectedChart, rejectedSlugSink = [] }) {
  const postsDir = path.join(BLOG_ROOT, 'content', 'posts');
  if (!fs.existsSync(postsDir)) {
    fs.mkdirSync(postsDir, { recursive: true });
  }

  let cleaned = rawMarkdown.trim();
  // 마크다운 코드블록 펜스 제거
  cleaned = cleaned.replace(/^```(?:markdown)?\s*\r?\n/i, '');
  cleaned = cleaned.replace(/\r?\n```\s*$/i, '');
  cleaned = cleaned.trim();

  // Frontmatter 분리
  const firstFm = cleaned.indexOf('---');
  if (firstFm === -1) {
    throw new Error('생성된 결과에서 Frontmatter 시작(---)을 찾을 수 없습니다.');
  }
  const secondFm = cleaned.indexOf('---', firstFm + 3);
  if (secondFm === -1) {
    throw new Error('생성된 결과에서 Frontmatter 종료(---)를 찾을 수 없습니다.');
  }

  let yamlBlock = cleaned.slice(firstFm + 3, secondFm).trim();
  let bodyContent = cleaned.slice(secondFm + 3).trim();

  // 본문 시작 잔여물 정리
  bodyContent = bodyContent.replace(/^```[a-z]*\s*\r?\n/i, '');
  bodyContent = bodyContent.replace(/^\s*```\s*\r?\n/i, '');
  bodyContent = bodyContent.replace(/\r?\n```\s*$/i, '');
  bodyContent = bodyContent.trim();
  bodyContent = sanitizeProseSpaces(bodyContent);

  // 0) 차트 컴포넌트 누락 시 자동 보강 (100% 무결성 보장)
  if (!bodyContent.includes('financial-chart-box') && selectedChart?.instruction) {
    const chartHtmlMatch = selectedChart.instruction.match(/<div class="financial-chart-box">[\s\S]*?<\/div>\s*<\/div>/);
    if (chartHtmlMatch) {
      const chartHtml = chartHtmlMatch[0];
      const firstH2Match = bodyContent.match(/^(##\s+[^\n]+\n+)/m);
      if (firstH2Match) {
        const insertIdx = bodyContent.indexOf(firstH2Match[0]) + firstH2Match[0].length;
        bodyContent = bodyContent.slice(0, insertIdx) + `\n${chartHtml}\n\n` + bodyContent.slice(insertIdx);
        log(`ℹ️ [차트 자동 보강] 본문에 차트가 누락되어 선정된 차트 컴포넌트(${selectedChart.name})를 첫 번째 H2 뒤에 자동 삽입했습니다.`);
      } else {
        bodyContent = `${chartHtml}\n\n` + bodyContent;
      }
    }
  }

  // 1) Title 정제 (콜론 치환, 따옴표 보호)
  const titleMatch = yamlBlock.match(/title:\s*["']?([^"'\n]+)["']?/);
  let title = titleMatch ? titleMatch[1].trim() : '생활금융 및 복지 혜택 가이드';
  title = title.replace(/:/g, ' -').replace(/\s{2,}/g, ' ').trim();
  yamlBlock = yamlBlock.replace(/title:\s*["']?[^"'\n]+["']?/, `title: "${title.replace(/"/g, '\\"')}"`);

  // 2) Slug 정제 (영문 소문자 하이픈 형식 보장)
  const slugMatch = yamlBlock.match(/slug:\s*["']?([^"'\n]+)["']?/);
  let rawSlug = slugMatch ? slugMatch[1].trim() : '';
  let cleanSlug = rawSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!cleanSlug || cleanSlug.length < 3) {
    cleanSlug = `${category}-guide-${Date.now().toString().slice(-4)}`;
  }

  // [P0 · 슬러그 충돌 차단]
  // 파일명은 YYMMDDNN 접두사 덕분에 항상 고유하지만, frontmatter 의 `slug` 은
  // LLM 이 만든 문자열이라 이미 다른 글이 쓰고 있을 수 있다.
  // publish-post.mjs 는 ON CONFLICT(slug) DO UPDATE 라 충돌 시
  // 기존 글을 조용히 덮어쓴다. 그 결과:
  //   - 새 글이 목록(D1 최근순)에서 사라진다 (created_at 이 옛 글로 유지)
  //   - 기존 글 내용�� 사라진다
  // 2026-09-29 저녁에 youth-leap-account-2026-guide 가 정확히 이 상황이었다.
  // 여기서 미리 충돌을 해소해 D1 에 닿기 전에 막는다.
  const collision = resolveSlugCollision(postsDir, cleanSlug);
  if (collision.changed) {
    log(`⚠️ [슬러그 충돌] "${collision.requested}" 이 이미 다른 글에서 사용 중입니다.`);
    log(`   → "${collision.slug}" 로 변경해 기존 글을 보호합니다.`);
    cleanSlug = collision.slug;
  }
  yamlBlock = yamlBlock.replace(/slug:\s*["']?[^"'\n]+["']?/, `slug: "${cleanSlug}"`);

  // 3) Description 정제
  const descMatch = yamlBlock.match(/description:\s*["']?([^"'\n]+)["']?/);
  let description = descMatch ? descMatch[1].trim() : `${title} 상세 분석 및 신청 가이드입니다.`;
  description = description.replace(/:/g, ' -').replace(/\s{2,}/g, ' ').trim();
  yamlBlock = yamlBlock.replace(/description:\s*["']?[^"'\n]+["']?/, `description: "${description.replace(/"/g, '\\"')}"`);

  // 4) Category 보정
  if (/category:\s*["']?[^"'\n]+["']?/.test(yamlBlock)) {
    yamlBlock = yamlBlock.replace(/category:\s*["']?[^"'\n]+["']?/, `category: "${category}"`);
  } else {
    yamlBlock += `\ncategory: "${category}"`;
  }

  // 6) Author 보정
  if (!/author:\s*["']?[^"'\n]+["']?/.test(yamlBlock)) {
    yamlBlock += `\nauthor: "스마트 머니"`;
  }

  // 7) Affiliate 보정
  if (!/affiliate:\s*(?:true|false)/.test(yamlBlock)) {
    yamlBlock += `\naffiliate: false`;
  }

  // 8) Tags 기본값 점검
  if (!yamlBlock.includes('tags:')) {
    yamlBlock += `\ntags: [${category}, 생활금융, 정부지원, 절세전략]`;
  }

  // 9) Reading Time 본문 글자 수 기준 계산 (하드코딩 제거)
  const readingTime = estimateReadingMinutes(bodyContent.length);
  if (/reading_time:\s*\d+/.test(yamlBlock)) {
    yamlBlock = yamlBlock.replace(/reading_time:\s*\d+/, `reading_time: ${readingTime}`);
  } else {
    yamlBlock += `\nreading_time: ${readingTime}`;
  }

  const finalMarkdown = `---\n${yamlBlock}\n---\n\n${bodyContent}\n`;

  // 9) 일련번호 파일명 계산 (YYMMDDNN-[slug].md)
  const yymmdd = targetDateStr.slice(2).replace(/-/g, '');
  const existingFiles = fs.readdirSync(postsDir);
  const dayFiles = existingFiles.filter((f) => f.startsWith(yymmdd) && f.endsWith('.md') && f !== 'template.md');

  let maxSeq = 0;
  for (const f of dayFiles) {
    const m = f.match(new RegExp(`^${yymmdd}(\\d{2})`));
    if (m) {
      const seq = parseInt(m[1], 10);
      if (seq > maxSeq) maxSeq = seq;
    }
  }
  const nextSeqStr = String(maxSeq + 1).padStart(2, '0');
  const fileName = `${yymmdd}${nextSeqStr}-${cleanSlug}.md`;
  const postFile = path.join(postsDir, fileName);

  fs.writeFileSync(postFile, finalMarkdown, 'utf8');

  // 무결성 및 통계 로깅 (본문 기준)
  const totalChars = bodyContent.length;
  const nonSpaceChars = bodyContent.replace(/\s/g, '').length;
  const h2Count = (bodyContent.match(/^##\s+/gm) || []).length;
  const hasChart = bodyContent.includes('financial-chart-box');

  log(`📊 [콘텐츠 무결성 검증]`);
  log(`- 파일명: ${fileName}`);
  log(`- 제목: "${title}" (slug: ${cleanSlug})`);
  log(`- 본문 총 글자 수: ${totalChars}자 (공백 제외: ${nonSpaceChars}자)`);
  log(`- H2 대주제 개수: ${h2Count}개`);
  log(`- 필수 차트 컴포넌트 포함 여부: ${hasChart ? '✅ PASS' : '⚠️ WARN (차트 태그 누락)'}`);

  // [P0-2] 발행 전 하드 게이트
  // 기존에는 위 통계가 로그로만 출력되고 언제나 return 되어, 규칙 미달 글도 그대로 발행되었다.
  // (실제 사례: 총 글자 수 310자 / 2,020자, H2 0~3개 글이 "심층 가이드"로 D1 등록됨)
  // 오전 다이제스트 경로(generate-news-digest.mjs)에는 이미 동일한 하드 게이트가 있으므로
  // 저녁 경로도 동일한 기준을 적용해 비대칭을 제거한다.
  const violations = [];
  if (h2Count < QUALITY_GATE.MIN_H2) violations.push(`H2 대주제 ${h2Count}개 (최소 ${QUALITY_GATE.MIN_H2}개 필요)`);
  if (nonSpaceChars < QUALITY_GATE.MIN_NON_SPACE_CHARS)
    violations.push(`공백 제외 ${nonSpaceChars}자 (최소 ${QUALITY_GATE.MIN_NON_SPACE_CHARS}자 필요)`);
  if (totalChars < QUALITY_GATE.MIN_SPACE_INCLUDED_CHARS)
    violations.push(`공백 포함 ${totalChars}자 (최소 ${QUALITY_GATE.MIN_SPACE_INCLUDED_CHARS}자 필요)`);

  // [P0-2.1] 추가 품질 게이트: 표(Table) 필수 검증
  const hasTable = /\|[\s-:]+\|/.test(bodyContent);
  if (!hasTable) {
    violations.push(`마크다운 분석 표(Table) 누락 (최소 1개 이상의 비교/정리 표 필요)`);
  }

  // [P0-2.2] 추가 품질 게이트: 시각적 컴포넌트(Callout 박스 또는 차트) 검증
  const hasCallout = /:::(?:warning|note|checklist|step)\[/.test(bodyContent);
  if (!hasCallout && !hasChart) {
    violations.push(`시각적 강조 컴포넌트(Callout 박스 또는 차트) 누락`);
  }

  // [P0-2.3] 추가 품질 게이트: 연도 환각 검사 (2024년 최신, 2025년 최신 등)
  const yearHallucination = /(?:2024년|2025년)\s*(?:최신|기준|개정|현재)/g.exec(bodyContent + ' ' + title);
  if (yearHallucination) {
    violations.push(`기준 연도 왜곡 감지: "${yearHallucination[0]}" (현재 연도는 2026년이어야 함)`);
  }

  // 참고 출처 링크 게이트 — 정부/공식 제도 안내 URL 이 실제로 존재해야 발행 가능
  const refLinks = extractReferenceLinks(bodyContent);
  const linkCheck = await verifyReferenceLinks(refLinks);
  if (refLinks.length === 0) {
    violations.push(`참고 출처 링크 0개 (최소 ${QUALITY_GATE.MIN_REFERENCE_LINKS}개 필요)`);
  } else if (!linkCheck.ok) {
    const infraFailure =
      linkCheck.errors > 0 &&
      linkCheck.gone === 0 &&
      linkCheck.active + linkCheck.errors >= QUALITY_GATE.MIN_REFERENCE_LINKS;
    if (infraFailure) {
      log(`⚠️ [참고 출처 검증 미완료] 네트워크 오류 ${linkCheck.errors}개로 검증 불가 (활성 ${linkCheck.active}개). 경고만 남기고 진행합니다.`);
    } else {
      const detail = `활성 ${linkCheck.active}/${refLinks.length}개 (404/사망: ${linkCheck.gone}개, 네트워크 오류: ${linkCheck.errors}개)`;
      violations.push(`유효한 참고 출처 링크 부족 (최소 ${QUALITY_GATE.MIN_REFERENCE_LINKS}개 필요) — ${detail}`);
    }
  } else if (refLinks.length > 0) {
    log(`✅ [참고 출처 검증 통과] 활성 링크 ${linkCheck.active}/${refLinks.length}개`);
  }

  if (violations.length > 0) {
    // 불합격 산출물을 디스크에 남기지 않는다 (다음 세션의 중복 방지 상태 오염 방지)
    // 단, 재시도가 또 같은 주제를 뽑지 않도록 시도 주제는 상위 호출부에 남긴다.
    const attempted = readPostIdentity(postFile);
    if (attempted.slug) rejectedSlugSink.push(attempted.slug);
    try {
      fs.unlinkSync(postFile);
      log(`🗑️ [게이트] 미달 파일을 삭제했습니다: ${fileName}`);
    } catch (_) {}
    const err = new Error(
      `[콘텐츠 품질 게이트 실패] ${violations.join(', ')}. 프롬프트가 요구하는 분량/구조를 충족하지 않아 발행을 중단합니다.`
    );
    err.qualityGate = true;
    err.violations = violations;
    throw err;
  }

  log(`✅ [콘텐츠 품질 게이트 통과] H2 ${h2Count}개, 공백 제외 ${nonSpaceChars}자`);

  return {
    postFile,
    title,
    slug: cleanSlug,
    fileName,
    totalChars,
    nonSpaceChars,
  };
}

/**
 * Tier 2 내장 심층글 생성 엔진 (Built-in Deep Article Generator)
 */
export async function runBuiltinDeepArticleGenerator({ category, sessionName, targetDateStr, selectedChart, options = {} }) {
  const env = loadEnvConfig();
  const avoidTopics = Array.isArray(options.avoidTopics) ? options.avoidTopics : [];
  log(`🚀 [Tier 2 엔진 가동] 내장 심층글 생성기를 호출합니다. (카테고리: ${category}, 세션: ${sessionName}, 차트: ${selectedChart.name})`);

  const systemPrompt = `당신은 대한민국 생활 경제 및 정부 정책 복지 혜택 전문 금융/행정 시니어 에디터입니다.
블로그 저장소 위치는 /workspace/projects/blogs 이며 블로그 이름은 '포켓머니(pockemoney)'입니다.
구글 애드센스 고수익 승인 표준 및 개발자/실무자 수준의 정확하고 깊이 있는 금융 분석 기준을 엄격히 준수하세요.

${FACT_SHEET_2026}

[필수 작성 지침]
0. [절대 금지 - 이미 발행된 주제]
${buildExcludedTopicList(path.join(BLOG_ROOT, 'content', 'posts'))}
${avoidTopics.length ? `   - 이번 실행에서 이미 시도했으나 채택되지 않은 주제입니다. 이 주제 및 동일 주제는 절대 다시 선택하지 마세요: ${avoidTopics.join(', ')}` : ''}
   - 위 목록에 있는 주제와 사실상 같은 글은 어떤 경우에도 생성하지 마세요. 제목이나 슬러그만 살짝 바꾼 변형도 금지입니다.
   - 목록에 없는 완전히 새로운 주제를 고르세요. 목록이 비어 있지 않다면 반드시 그 밖의 주제를 선택해야 합니다.
${buildInternalLinkInstruction(path.join(BLOG_ROOT, 'content', 'posts'), category)}
1. [골디락스 난이도 및 주제 선정]
   - 직장인, 사회초년생, 자영업자, 신혼부부, 은퇴자 등 다양한 독자층이 일상에서 검색창에 자주 찾는 실전 생활금융, 세무(연말정산/소득공제/비과세), 주거/부동산(청약통장/전세보증보험), 복지/건강보험(피부양자 자격/실업급여), 생활 지원금(근로장려금/소상공인 지원) 등 다채롭고 구체적인 실무 주제를 선정하세요.
2. [필수 분량 규격]
   - 반드시 전체 공백 포함 최소 2,800자 이상 (공백 제외 최소 1,800자 이상)의 깊이 있는 전문 정보를 작성하세요. 얇은 글(Thin content)은 절대 금지됩니다.
3. [금액 띄어쓰기 규범]
   - '70만 원', '5,000만 원'처럼 띄어 쓰지 말고 반드시 '70만원', '5,000만원', '2.4만원', '1억원'처럼 붙여 쓰세요.
4. [필수 데이터 시각화 차트 삽입 - 이번 세션 지정 유형: ${selectedChart.name}]
${selectedChart.instruction}
   - 반드시 본문 첫 번째 H2 또는 두 번째 H2 직후에 위 지정된 유형의 반응형 차트 컴포넌트를 마크다운 코드블록(\`\`\`) 없이 순수 HTML 구조(<div class="financial-chart-box">...</div>)로 완벽하게 삽입하세요.
5. [풍부한 시각적 UI 컴포넌트 마크다운 디렉티브 활용]
   - 독자의 정보 습득력과 가독성을 높이기 위해 다음 4가지 커스텀 디렉티브 문법을 본문 적재적소에 각각 1회 이상 적극 활용하세요:
   :::warning[신청 시 주의사항 및 결격 사유]
   기한 경과 시 구제 불가 안내, 중복 수혜 불가 사업 주의점 등...
   :::
   :::note[핵심 체크포인트]
   해당 정책의 최대 수혜 금액 및 핵심 요건 한눈에 보기...
   :::
   :::checklist[신청 전 자가진단 체크리스트]
   - 가구원 소득/재산 기준 충족 여부 확인
   - 공인인증서 및 신분증 사전 준비
   - 필수 증빙 서류 발급 완료
   :::
   :::step[단계별 신청 절차]
   1. 온라인 사전 자격 모의계산
   2. 정부24 / 고용24 온라인 서류 제출
   3. 적격 심사 및 대상자 통보 수령
   :::
6. [필수 구조 (H2 최소 5개 이상 필수 구성)]
   - 구체적인 제도 개요 및 최신 법령/지침 개정 배경
   - 핵심 대상 자격 요건 정밀 분석표 (Table: 대상자, 소득/재산 기준 등)
   - 실제 수혜/납입 금액 또는 혜택 비교표 (Table: 시중 상품 대비 차등 혜택 분석)
   - 실무 비대면 신청/진행 절차 및 필수 구비 서류
   - 신청 전 반드시 점검해야 할 불이익 방지 및 예외 규정
   - 독자들이 검색창에서 가장 자주 묻는 실전 Q&A (FAQ 4~5문항)
   - 위 6대 요소를 각각 독립된 '## [직관적인 소제목]' 헤딩으로 반드시 5개 이상 구성하세요.
   - 반드시 마크다운 표(Table: `| 항목 | 기준 | 내용 |`)를 최소 1개 이상 작성하여 핵심 자격 요건이나 시중 상품 대비 혜택 차이를 체계적으로 비교하세요.
   - 작성한 금액·자격 요건·일정 수치는 반드시 정부/공식 발표 기준으로만 서술하고, 근거가 되는 공식 안내 페이지 링크(정책브리핑, 법제처 국가법령정보센터, 정부24, 고용24, 건강보험공단, 국세청 등)를 실제 존재하는 URL로 최소 3개 이상 인라인 링크 또는 '## 참고 자료' 섹션으로 명시하세요. 존재하지 않는 URL을 지어내는 것은 절대 금지입니다.
7. [절대 금지 사항]
   - 반드시 현재 연도인 2026년 기준(2026년 최신 개정 및 2026년 정책)으로 작성하세요. 과거 연도(2024년, 2025년 등)를 '최신'으로 서술하거나 제목/슬러그에 넣는 것을 엄격히 금지합니다.
   - 기계적인 '들어가며', '마치며', '서론', '결론' 헤딩을 절대 쓰지 마세요.
   - 상투적인 멘트('~에 대해 알아보겠습니다', '이 글에서는 ~를 정리합니다', '도움이 되셨기를 바랍니다') 전면 금지.
   - 제목 및 소제목에 콜론(:) 사용 금지 (하이픈 - 또는 | 로 대체).
   - 문장마다 볼드체(**단어**)를 남발하지 마세요. 메뉴 경로, 법조문, 액수는 인라인 코드(백틱 또는 작은따옴표)로 표기하고, 볼드는 본문 전체에서 가장 중요한 핵심 결론 1~2개에만 극도로 절제하세요.
   - 소제목 번호 매기기('1.', '1.1') 금지, 직관적이고 매력적인 텍스트 소제목을 쓰세요.
   - 금융 및 행정 공문서 수준의 정확한 수치와 전문적 어조를 견지하세요.
8. [출력 형식]
   - 마크다운 Frontmatter로 시작하여 본문으로 이어지는 순수 마크다운 텍스트만 출력하세요.
   - Frontmatter 필수 필드:
---
title: "제목 (콜론 없이 매력적인 고수익 CTR 제목)"
slug: "korean-policy-topic-english-slug"
description: "핵심 요약 120~150자 내외"
category: "${category}"
tags: [태그1, 태그2, 태그3, 태그4]
author: "스마트 머니"
reading_time: 8
affiliate: false
---`;

  const userPrompt = `카테고리: ${category}
날짜: ${targetDateStr}
세션: ${sessionName}
지정 차트: ${selectedChart.name}

위 지침을 철저히 준수하여 ${category} 카테고리에 최적화된 최고 품질의 3,000자 내외 심층 가이드 마크다운을 작성해주세요.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const rawMarkdown = await callLLMWithFallback(messages, env);

  const parsed = await parseAndSaveArticleMarkdown({
    rawMarkdown,
    category,
    targetDateStr,
    selectedChart,
    rejectedSlugSink: Array.isArray(options.rejectedSlugs) ? options.rejectedSlugs : [],
  });

  return parsed;
}

/**
 * 아티클 생성 진입점 — Gemini 네이티브 단일 경로
 *
 * [P0-3 변경 사유]
 * Tier 1(agy CLI)은 시스템에 바이너리가 존재하지 않아(전 기간 `agy: not found`) 매 세션마다
 * 실패하고, 실패 원인을 throw 해서 Tier 2 구동을 막았다. 게다가 예전 구현은 프롬프트를
 * `/bin/sh -c` 인라인으로 넘겨 백틱이 명령으로 실행되고(`/bin/sh: 1: code: not found`),
 * 셸 경유 때문에 `spawnSync /bin/sh ETIMEDOUT` 로 죽기도 했다.
 * → 결정: Tier 1(agy) 과 Groq 단계를 모두 제거하고 Gemini 네이티브 한 경로로 통일한다.
 *
 * @returns {Promise<{ postFile: string, title: string, slug: string, tier: string }>}
 */
export async function generateArticleWithFallback({
  category,
  sessionName,
  targetDateStr,
  selectedChart,
  options = {},
}) {
  const postsDir = path.join(BLOG_ROOT, 'content', 'posts');
  if (!fs.existsSync(postsDir)) fs.mkdirSync(postsDir, { recursive: true });
  const beforeFiles = new Set(fs.readdirSync(postsDir));

  log(`🧠 [LLM] Gemini 네이티브 단일 경로로 심층글을 생성합니다.`);

  // [P0-2] 생성 실패 유형별로 재시도 전략을 다르게 한다.
  //  - truncated (MAX_TOKENS): 잘린 응답
  //  - qualityGate (분량/구조 미달): 다른 표본을 뽑기 위한 재생성
  // 두 경우 모두 MAX_LLM_RETRY 회까지만 시도하고, 최종 실패 시 throw 하여
  // 호출부(D1 발행 단계)에 절대 도달하지 못하게 한다.
  let lastError = null;
  // [P0] 재시도 때 같은 주제를 다시 뽑는 것을 막기 위한 목록.
  // 2026-09-29 저녁 재실행 시 1·2차 시도 모두 '근로장려금 반기 신청' 을 골랐던
  // 것처럼, 재시도는 같은 확률적 분포에서 다시 뽑히므로 방치하면 무한 반복된다.
  const avoidTopics = [];
  for (let attempt = 0; attempt <= QUALITY_GATE.MAX_LLM_RETRY; attempt++) {
    if (attempt > 0) {
      log(`🔄 [LLM 재시도 ${attempt}/${QUALITY_GATE.MAX_LLM_RETRY}] 사유: ${lastError?.message?.slice(0, 140) || '알 수 없음'}`);
    }
    try {
      const result = await runBuiltinDeepArticleGenerator({
        category,
        sessionName,
        targetDateStr,
        selectedChart,
        options: { compactRetry: attempt > 0, attempt, avoidTopics: [...avoidTopics], rejectedSlugs: avoidTopics },
      });

      // 방어: LLM 이 파일을 만들지 못한 채 성공으로 보고하는 경우 차단
      if (!result?.postFile || !fs.existsSync(result.postFile)) {
        throw new Error('LLM 이 포스트 파일을 생성하지 않았습니다.');
      }
      if (beforeFiles.has(path.basename(result.postFile))) {
        log(`⚠️ 신규 파일이 감지되지 않아 기존 파일로 판단합니다: ${result.postFile}`);
      }

      // [P0 · 중복 주제 차단] 이미 발행된 글과 같은 글이 나오면 폐기하고 재생성한다.
      // 프롬프트로 막지 못한 경우를 여기서 하드하게 차단한다.
      // 방치하면 publish-post.mjs 의 ON CONFLICT(slug) DO UPDATE 가
      // 기존 글을 덮어써 새 글이 목록에서 사라지고 기존 글이 잃어진다.
      const dupInfo = readPostIdentity(result.postFile);
      // 제외할 것은 "방금 막 생성된 이 파일" 뿐이다.
      // 나머지 디스크의 파일은 모두 기존 발행글이므로 비교 대상이 되어야 한다.
      // (beforeFiles 를 제외 대상으로 넘기면 발행글과 대조하지 못해 방어선이 무의미해진다)
      const dup = findDuplicatePost(
        postsDir,
        dupInfo.slug,
        dupInfo.title,
        new Set([path.basename(result.postFile)])
      );
      if (dup) {
        try {
          fs.unlinkSync(result.postFile);
          log(`🗑️ 중복 산출물 폐기: ${path.basename(result.postFile)} (${dup.reason}) → 기존 글 ${dup.file}`);
        } catch (_) {}
        const err = new Error(`이미 발행된 글과 중복입니다: ${dup.reason} (${dup.file})`);
        err.duplicate = true;
        if (dupInfo.slug) avoidTopics.push(dupInfo.slug);
        throw err;
      }

      result.tier = 'Gemini Native';
      result.attempts = attempt + 1;
      return result;
    } catch (err) {
      lastError = err;
      const reason = err.duplicate
        ? '중복 주제'
        : err.qualityGate
          ? '품질 게이트 미달'
          : err.truncated
            ? '응답 잘림'
            : '생성 오류';
      log(`⛔ [LLM ${reason}] ${err.message.slice(0, 200)}`);
      // 중복 주제는 프롬프트에 금지 목록을 주입했으므로 재시도로 해결될 가능성이 높다
      if (err.duplicate) {
        log(`🔁 [중복 회피 재시도 ${attempt + 1}/${QUALITY_GATE.MAX_LLM_RETRY}] 다른 주제를 선택하도록 다시 생성합니다.`);
      }
    }
  }

  const finalErr = lastError || new Error('심층글 생성에 실패했습니다.');
  finalErr.exhausted = true;
  throw finalErr;
}

/**
 * 실제 포스트 생성 및 배포 파이프라인
 */
/**
 * 파일의 frontmatter 블록만 안전하게 읽는다.
 *
 * 왜 단순 read �� 수가 아닌가
 *   앞부분 N 바이트만 읽으면 title/description 이 길어 slug 이 그 뒤에 놓일 때
 *   조용히 놓친다. 중복 방어 로직에서 "놓쳤다" 는 것은 "중복이 없다" 와 구분되지
 *   않으므로 위험하다. frontmatter 종료(---)까지 필요한 만큼만 읽되,
 *   비정상적으로 큰 파일은 상한으로 자른다.
 */

/** 생성된 포스트 파일의 frontmatter 에서 slug / title 을 읽는다 */
function readPostIdentity(filePath) {
  const head = readFrontmatterHead(filePath);
  const s = head.match(/^slug:\s*["']?([^"'\n]+)["']?\s*$/m);
  const t = head.match(/^title:\s*["']?([^"'\n]+)["']?\s*$/m);
  return { slug: s ? s[1].trim() : '', title: t ? t[1].trim() : '' };
}

/**
 * 이미 발행된 글의 주제 목록을 프롬프트에 주입하기 위한 문자열을 만든다.
 *
 * 왜 필요한가
 *   2026-09-29 저녁에 LLM 이 이미 발행된 youth-leap-account-2026-guide 와
 *   사실상 같은 주제를 다시 생성했다. 프롬프트에 "중복 금지" 는 있었지만
 *   **무엇이 이미 발행되었는지 알려주는 목록이 아예 없었다.**
 *   즉 prohibition 없이 prohibition 만 있었다.
 */
function buildExcludedTopicList(postsDir) {
  const items = [];
  let files = [];
  try {
    files = fs
      .readdirSync(postsDir)
      .filter((f) => f.endsWith('.md') && f !== 'template.md')
      .sort();
  } catch (_) {
    return '   - (발행된 글이 없어 제한 없음)';
  }

  for (const f of files) {
    const head = readFrontmatterHead(path.join(postsDir, f));
    if (!head) continue;
    const t = head.match(/^title:\s*["']?([^"'\n]+)["']?\s*$/m);
    const s = head.match(/^slug:\s*["']?([^"'\n]+)["']?\s*$/m);
    const title = t ? t[1].trim() : '';
    const slug = s ? s[1].trim() : '';
    if (title || slug) items.push(`   - ${title || slug}${slug ? ` (slug: ${slug})` : ''}`);
  }

  if (!items.length) return '   - (발행된 글이 없어 제한 없음)';
  return `   아래 ${items.length}건은 이미 발행된 글입니다. 이 주제들과 겹치는 글은 생성 금지:` + `\n${items.join('\n')}`;
}

/**
 * 내부 링크 후보군 추출 및 프롬프트 주입용 헬퍼 (/blog/[slug] 경로 표준 준수)
 */
export function getInternalLinkCandidates(postsDir, targetCategory, limit = 5) {
  const candidates = [];
  try {
    const files = fs.readdirSync(postsDir).filter((f) => f.endsWith('.md') && f !== 'template.md');
    for (const f of files) {
      const head = readFrontmatterHead(path.join(postsDir, f));
      if (!head) continue;
      const s = head.match(/^slug:\s*["']?([^"'\n]+)["']?\s*$/m);
      const t = head.match(/^title:\s*["']?([^"'\n]+)["']?\s*$/m);
      const c = head.match(/^category:\s*["']?([^"'\n]+)["']?\s*$/m);
      const slug = s ? s[1].trim() : '';
      const title = t ? t[1].trim() : '';
      const cat = c ? c[1].trim() : '';
      if (slug && title) {
        candidates.push({ slug, title, category: cat, isSameCat: cat === targetCategory });
      }
    }
  } catch (_) {
    return [];
  }
  candidates.sort((a, b) => (b.isSameCat ? 1 : 0) - (a.isSameCat ? 1 : 0));
  return candidates.slice(0, limit);
}

function buildInternalLinkInstruction(postsDir, category) {
  const candidates = getInternalLinkCandidates(postsDir, category, 6);
  if (!candidates.length) return '';
  const lines = candidates.map((c) => `   - [${c.title}](/blog/${c.slug})`);
  return `\n[내부 추천 링크 (SEO 상호 연결 - 본문 맥락에 맞게 1~2개 자연스럽게 링크 삽입)]
아래 기존 포스트 중 현재 글의 주제와 연관된 글이 있다면 본문 내 문맥에 어울리게 마크다운 링크(/blog/[slug])로 1~2개 자연스럽게 인라인 인용 또는 '함께 읽으면 좋은 글'로 연결하세요:
${lines.join('\n')}\n`;
}

/**
 * [P0] 생성된 글이 이미 발행된 글과 사실상 같은지 검사한다.
 *
 * 판정 기준
 *   - frontmatter slug 이 정확히 같으면 중복 (D1 upsert 로 기존 글을 덮어씀)
 *   - 제목을 한글/영문/숫자만 남긴 정규화 키로 비교했을 때 같으면 중복
 *     (예: "청년도약계좌 2026년 최신 가이드" vs "청년도약계좌 2026 가이드")
 *
 * @param {Set<string>|null} exclude 비교에서 제외할 파일명 (이번 실행에서 만든 파일 등)
 * @returns {null | { file: string, reason: string }}
 */
function findDuplicatePost(postsDir, slug, title, exclude = null) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^0-9a-z가-힣]+/g, '')
      .trim();

  const wantSlug = String(slug || '').trim();
  const wantTitle = norm(title);

  let files = [];
  try {
    files = fs.readdirSync(postsDir).filter((f) => f.endsWith('.md') && f !== 'template.md');
  } catch (_) {
    return null;
  }

  for (const f of files) {
    // 방금 생긴 파일을 자기 자신과 비교하면 항상 "중복" 으로 판정된다
    if (exclude && exclude.has(f)) continue;
    const head = readFrontmatterHead(path.join(postsDir, f));
    if (!head) continue;
    const t = head.match(/^title:\s*["']?([^"'\n]+)["']?\s*$/m);
    const s = head.match(/^slug:\s*["']?([^"'\n]+)["']?\s*$/m);
    const hasSlug = s ? s[1].trim() : '';
    const hasTitle = t ? t[1].trim() : '';

    if (wantSlug && hasSlug === wantSlug) {
      return { file: f, reason: `slug 중복 ("${wantSlug}")` };
    }
    if (wantTitle && hasTitle && norm(hasTitle) === wantTitle) {
      return { file: f, reason: `제목 중복 ("${hasTitle}")` };
    }
  }
  return null;
}

/**
 * [P0] 이미 다른 글이 사용 중인 slug 인지 확인하고, 충돌하면 유일한 slug 로 바꿔준다.
 *
 * 왜 필요한가
 *   publish-post.mjs 가 ON CONFLICT(slug) DO UPDATE 라, 같은 slug 가 들어오면
 *   새 글이 삽입되는 대신 기존 글이 조용히 덮어써진다. 덮어쓰는 동안
 *   created_at 은 옛 값으로 유지되므로 새 글은 D1 최근순 목록에서 사라지고,
 *   기존 글의 내용도 잃게 된다.
 *
 * 파일명(YYMMDDNN-...)은 유일해도 frontmatter slug 은 유일하지 않다.
 * 2026-09-29 저녁 youth-leap-account-2026-guide 충돌이 이 경로였다.
 *
 * @returns {{ slug: string, changed: boolean, requested: string, owner?: string }}
 */
function resolveSlugCollision(postsDir, requestedSlug) {
  const taken = new Map(); // slug -> 소유 파일명
  let files = [];
  try {
    files = fs.readdirSync(postsDir).filter((f) => f.endsWith('.md') && f !== 'template.md');
  } catch (_) {
    return { slug: requestedSlug, changed: false, requested: requestedSlug };
  }

  for (const f of files) {
    const head = readFrontmatterHead(path.join(postsDir, f));
    if (!head) continue;
    const m = head.match(/^slug:\s*["']?([^"'\n]+)["']?\s*$/m);
    if (m) taken.set(m[1].trim(), f);
  }

  if (!taken.has(requestedSlug)) {
    return { slug: requestedSlug, changed: false, requested: requestedSlug };
  }

  for (let n = 2; n <= 50; n++) {
    const candidate = `${requestedSlug}-${n}`;
    if (!taken.has(candidate)) {
      return { slug: candidate, changed: true, requested: requestedSlug, owner: taken.get(requestedSlug) };
    }
  }
  // 극단적으로 -N 이 모두 소진되면 타임스탬프로 우회
  return {
    slug: `${requestedSlug}-${Date.now().toString().slice(-6)}`,
    changed: true,
    requested: requestedSlug,
    owner: taken.get(requestedSlug),
  };
}

export async function runPublishPipeline(sessionName, options = {}) {
  const { dateStr, timeStr } = getKSTDate();
  console.log(`\n========================================`);
  console.log(`🚀 [blogs 생활경제 자동 게시 시작] ${dateStr} (${sessionName}) 실행 시각: ${timeStr} KST`);
  console.log(`========================================`);

  // [P0 · 2026-09-29] 발행 착수 전 GitHub 인증 사전 점검.
  // push 권한이 없으면 D1 등록까지 끝난 뒤 사이트가 이전 빌드를 서빙하는
  // 최악의 상태가 되므로, 아무것도 쓰기 전에 먼저 차단한다.
  if (!options.dryRun) {
    const pre = publishPreflight(BLOG_ROOT, (m) => console.log(m));
    if (!pre.ok) {
      console.error(`❌ [사전 점검 실패] ${pre.error}`);
      console.error(`   ${pre.hint}`);
      console.error(`   발행 착수를 중단합니다. (D1/R2 미등록, 로컬 변경 없음)`);
      throw new Error(`GitHub 사전 점검 실패로 발행 중단: ${pre.error}`);
    }
  }

  const state = loadState();

  // 1. 중복 실행 검사 (--force 옵션 지원)
  let sessionLock = null;
  if (!options.force && !options.dryRun) {
    if (isSessionAlreadyDone(state, sessionName, dateStr)) {
      console.log(`ℹ️ [중복 방지] 오늘(${dateStr}) ${sessionName} 세션은 이미 성공적으로 완료되었습니다. 건너뜁니다.`);
      return true;
    }

    // 파일시스템 기반 실제 오후 심층 포스트 존재 여부 2차 검증 (YYMMDD 형태 중복 방지)
    const yy = dateStr.slice(2, 4);
    const mm = dateStr.slice(5, 7);
    const dd = dateStr.slice(8, 10);
    const prefix = `${yy}${mm}${dd}`;
    const existingPosts = fs.existsSync(POSTS_DIR)
      ? fs.readdirSync(POSTS_DIR).filter(f =>
          f.startsWith(prefix) &&
          (f.endsWith('.md') || f.endsWith('.mdx')) &&
          f !== 'template.md' &&
          !isDigestPost(path.join(POSTS_DIR, f))
        )
      : [];
    if (existingPosts.length > 0) {
      console.log(`ℹ️ [중복 방지] 오늘(${dateStr}) 생성된 오후 심층 포스트(${existingPosts.join(', ')})가 이미 파일시스템에 존재합니다. 건너뜁니다.`);
      return true;
    }

    sessionLock = acquireSessionLock(sessionName, dateStr);
    if (!sessionLock.acquired) {
      return true;
    }
  }

  // 2. 카테고리 선정
  const category = selectOptimalCategory(state, sessionName);
  console.log(`📂 선정된 카테고리: "${category}" (누적 발행: ${state.category_counts[category] || 0}건)`);

  // 3. 차트 유형 랜덤 선정 (직전 발행된 차트와 중복되지 않도록 6종 중 자동 순환)
  const lastChartType = state.last_chart_type || null;
  const availableCharts = CHART_PRESETS.filter((c) => c.type !== lastChartType);
  const selectedChart = availableCharts[Math.floor(Math.random() * availableCharts.length)] || CHART_PRESETS[0];
  console.log(`📊 이번 세션 선정 차트 스타일: "${selectedChart.name}" (유형: ${selectedChart.type})`);

  try {
    // 4. LLM 심층글 생성 (Gemini 네이티브 단일 경로)
    //    실제 작성 지침은 runBuiltinDeepArticleGenerator 내부의 systemPrompt 에 단일 관리한다.
    const generated = await generateArticleWithFallback({
      category,
      sessionName,
      targetDateStr: dateStr,
      selectedChart,
      options,
    });

    const latestPostFile = generated.postFile;
    const generatedTitle = generated.title;
    const generatedSlug = generated.slug;
    const engineTier = generated.tier || 'Auto Engine';

    console.log(`📄 신규 포스트 생성 확인: "${generatedTitle}" (slug: ${generatedSlug}, 엔진: ${engineTier})`);

    // dry-run 옵션 시 DB 발행 및 Git 커밋 건너뜀
    if (options.dryRun) {
      log(`🧪 [--dry-run] D1 DB 발행 및 Git 커밋을 건너뜁니다. (생성 파일: ${latestPostFile})`);
      return true;
    }

    // 6. Astro 프로덕션 빌드 무결성 사전 검증 (빌드가 100% 통과해야만 D1에 발행)
    let buildLock = null;
    let d1Published = false;
    let deploySynced = true;
    let deployError = null;

    try {
      buildLock = acquireBuildDeployLock(BUILD_LOCK_FILE, { label: `auto-publish-${sessionName}` });
      if (!buildLock.acquired) {
        throw new Error(`다른 빌드/배포 프로세스(PID: ${buildLock.holder?.pid}, 라벨: ${buildLock.holder?.label})가 작업 중이어서 빌드 락을 획득하지 못했습니다.`);
      }

      // [P0] dist 디렉토리 사전 정리 (계정 권한 불일치 EACCES 및 캐시 오염 방어)
      cleanDistDir(path.join(BLOG_ROOT, 'dist'), log);

      console.log(`⚙️ [빌드 사전 검증] Astro 프로덕션 빌드 무결성을 검증합니다...`);
      try {
        execSync(`npm run build`, {
          cwd: BLOG_ROOT,
          stdio: 'inherit',
          env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
        });
        console.log(`✅ [빌드 사전 검증 통과] 프로덕션 빌드가 에러 없이 완료되었습니다.`);
      } catch (buildErr) {
        // 빌드 실패 시 D1 미등록 상태에서 오류 포스트 파일을 롤백 삭제하여 디스크 오염 방지
        try {
          if (fs.existsSync(latestPostFile)) {
            fs.unlinkSync(latestPostFile);
            log(`🗑️ [빌드 실패 롤백] 오류 포스트 파일을 삭제했습니다: ${path.basename(latestPostFile)}`);
          }
        } catch (_) {}
        throw new Error(`Astro 프로덕션 빌드 검증 실패 (D1 미등록): ${buildErr.message}`);
      }

      // 7. D1 데이터베이스 발행 (빌드 통과 후에만 안전하게 실행)
      console.log(`🗄️ [D1 발행] Cloudflare D1 원격 데이터베이스에 발행합니다...`);
      execSync(`node scripts/publish-post.mjs "${latestPostFile}"`, {
        cwd: BLOG_ROOT,
        stdio: 'inherit',
      });
      d1Published = true;

      // 8. 상태 파일 갱신 및 안전 저장 (Git 커밋 전 최신 상태 파일 디스크 반영)
      state.category_counts[category] = (state.category_counts[category] || 0) + 1;
      state.last_session = sessionName;
      state.last_chart_type = selectedChart.type;
      state.history.push({
        date: dateStr,
        session: sessionName,
        time: timeStr,
        category,
        title: generatedTitle,
        slug: generatedSlug,
        chart_type: selectedChart.type,
        engine: engineTier,
        status: 'success',
      });
      saveState(state);

      // 9. GitHub commit & push (Cloudflare Workers 자동 배포)
      // [P0-1] rebase 실패를 더 이상 삼키지 않는다. 실패 시 원격 미반영 상태로 중단하고
      //        텔레그램 경보를 보낸다. (기존: `catch (_) {}` + "🚀 Push 완료" 거짓 보고)
      log(`📦 GitHub main에 커밋 및 푸시하여 Workers 배포를 트리거합니다...`);
      try {
        const filesToStage = ['content/posts/'];
        // 런타임 상태 파일은 .gitignore 로 제외되어 더 이상 stage 하지 않는다.
        // (추적 상태였던 시점에 stage 되어 `git pull --rebase` 를 "unstaged changes" 로 깨뜨렸다)
        const result = gitPublish({
          repoRoot: BLOG_ROOT,
          paths: filesToStage,
          message: `feat(post): auto publish [${sessionName}] ${generatedSlug}`,
          log: (m) => log(`   ${m}`),
        });
        if (result.committed) {
          log(`🚀 [GitHub Push 완료] Workers 자동 배포가 시작되었습니다.`);
        } else {
          log(`ℹ️ 원격에 반영할 로컬 변경이 없어 푸시를 건너뜁니다. (${result.reason || 'no-changes'})`);
        }
      } catch (gitErr) {
        deploySynced = false;
        deployError = gitErr;
        log(`❌ [GitHub 배포 실패] ${gitErr.message}`);
        log(`   ⚠️ D1/R2 발행은 완료되었으나 사이트는 아직 이전 빌드입니다.`);
      }
    } finally {
      if (buildLock && buildLock.release) {
        buildLock.release();
      }
    }

    // 10. 텔레그램 성공 보고 발송
    // [P0-1] 배포 실패를 성공 보고서에 그대로 "완료"로 적지 않는다.
    const deployLine = deploySynced
      ? '- 🚀 배포: GitHub push ➔ Workers 배포 완료'
      : '- 🚀 배포: ❌ *실패* — D1 등록은 완료됐으나 사이트는 이전 빌드입니다. 수동 조치 필요';
    const successMsg = `🎉 *[포켓머니(pockemoney) 자동 게시 완료]*

⏰ *실행 시간:* ${timeStr} KST
🏷️ *구분:* ${sessionName}
📂 *카테고리:* ${category}
🤖 *엔진:* ${engineTier}
📝 *제목:* ${generatedTitle}
🔗 *slug:* ${generatedSlug}

*검증 상태:*
- 🗄️ D1 DB: 등록 성공 (blogs)
- ⚙️ 빌드: PASS (0 errors)
${deployLine}`;

    await sendTelegramReport(successMsg);

    if (!deploySynced) {
      // 별도 알림을 보내 눈에 띄게 한다 (FR-4.1: 실패를 성공으로 위장하지 않는다)
      await sendTelegramReport(
        `🚨 *[심각] blogs GitHub 배포 실패*\n\n` +
          `⏰ ${timeStr} KST / ${sessionName}\n` +
          `📝 ${generatedTitle}\n\n` +
          `*원인:* ${deployError?.message || '알 수 없음'}\n\n` +
          `*영향:* D1/R2 등록은 완료되었으나 소스 코드가 GitHub 에 반영되지 않아 ` +
          `사이트는 이전 빌드를 계속 서빙합니다. 로컬 커밋은 보존되어 있습니다.`
      );
      log(`🚨 배포 실패 경보를 텔레그램으로 전송했습니다.`);
    }

    console.log(
      deploySynced
        ? `✅ ${sessionName} 세션 자동 게시 작업이 성공적으로 완료되었습니다!`
        : `⚠️ ${sessionName} 세션: D1 등록은 성공했으나 GitHub 배포가 실패했습니다.`
    );
    return deploySynced;
  } catch (err) {
    console.error(`❌ [자동 게시 실패]`, err.message);
    if (!d1Published && sessionLock?.releaseOnFailure) {
      sessionLock.releaseOnFailure();
    }

    // 실패 상태 기록
    state.history.push({
      date: dateStr,
      session: sessionName,
      time: timeStr,
      category,
      status: 'failed',
      error: err.message,
    });
    saveState(state);

    // 텔레그램 실패 보고 발송
    const isGateFailure = err.qualityGate || err.exhausted;
    const failMsg = isGateFailure
      ? `🚫 *[blogs 품질 게이트로 발행 차단]*

⏰ *실행 시간:* ${timeStr} KST
🏷️ *구분:* ${sessionName}
📂 *카테고리:* ${category}

❌ *차단 사유:* ${err.message}

*조치:* D1 등록 및 GitHub 커밋을 수행하지 않았습니다. 생성된 미달 파일도 삭제했습니다.
_llm 도retry ${QUALITY_GATE.MAX_LLM_RETRY}회로 분량/구조를 충족하지 못했습니다. 프롬프트 규칙 점검 필요._`
      : `⚠️ *[blogs 자동 게시 실패]*

⏰ *실행 시간:* ${timeStr} KST
🏷️ *구분:* ${sessionName}
📂 *카테고리:* ${category}
❌ *오류 원인:* ${err.message}
🔄 *조치:* 상태 기록 및 에러 로깅 완료`;

    await sendTelegramReport(failMsg);
    return false;
  }
}

/**
 * 데몬 스케줄러 메인 루프 (Two-Track 스케줄러)
 * - 1) 오전 세션: 08:20 ~ 08:50 KST (모닝 머니 다이제스트, ★ 주 7일 매일 무휴식 구동)
 * - 2) 오후 세션: 18:15 ~ 18:45 KST (생활금융 심층 가이드, 🎲 주 1회 랜덤 휴식)
 */
async function startDaemon() {
  // [P1] 데몬 단일 인스턴스 보장
  //   이전엔 락을 쓰지 않아 중복 기동 시 같은 시각에 발행이 두 번 돌 수 있었다.
  const lock = acquireDaemonLock(DAEMON_LOCK_FILE, { label: 'auto-publish-runner' });
  if (!lock.acquired) {
    log(`❌ 다른 auto-publish-runner 데몬이 이미 실행 중입니다 (pid ${lock.holder?.pid ?? '?'}). 중복 기동을 거부합니다.`);
    process.exit(1);
  }
  const release = lock.release;
  log(`🔒 데몬 단일 인스턴스 락 획득 (pid ${process.pid}, ${DAEMON_LOCK_FILE})`);

  const cleanup = () => {
    try { release(); } catch (_) {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  log(`🤖 [blogs 포켓머니 2-Track 자동화 스케줄러 데몬 가동]`);
  log(`- 오전 범위: 08:20 ~ 08:50 KST (모닝 머니 다이제스트, ★ 주 7일 매일 무휴식)`);
  log(`- 오후 범위: 18:15 ~ 18:45 KST (생활금융 심층 가이드, 🎲 주 1회 랜덤 휴식)`);

  // [자가 복구] 이전 실행에서 push 에 실패해 원격에 반영되지 못한 커밋이
  // 남아 있을 수 있다. 2026-09-29 저녁 1건이 정확히 그 상태였고,
  // 상태 파일은 이미 success 로 기록돼 있어 어떤 자동 재시도도 걸리지 않았다.
  // 글을 재생성하지 않고 남은 커밋만 밀어내는 방식으로 복구한다.
  drainPendingDeploys();

  let currentMorningTarget = getRandomTargetMinutes(8, 20, 8, 50);
  let currentEveningTarget = getRandomTargetMinutes(18, 15, 18, 45);
  let lastCheckedDay = '';
  let isAfternoonSkippedToday = false;
  let morningExecutedToday = false;
  let eveningExecutedToday = false;
  let eveningSkippedLoggedToday = false;
  let isSessionRunning = false;

  const formatTarget = (t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
  log(`📅 오늘의 랜덤 목표 시간: 오전 ${formatTarget(currentMorningTarget)}, 오후 ${formatTarget(currentEveningTarget)}`);

  while (true) {
    // [P0] 데몬 락 파일 소유권 주기적 확인 (다른 프로세스가 락을 가져갔거나 service.sh restart로 교체된 경우 자진 종료)
    if (!isLockOwner(DAEMON_LOCK_FILE)) {
      log(`🛑 [고스트 데몬 방지] 데몬 락(${DAEMON_LOCK_FILE})의 소유권이 상실되었거나 다른 프로세스에 이전되었습니다. 현재 프로세스(pid ${process.pid})를 안전하게 종료합니다.`);
      process.exit(0);
    }

    if (isSessionRunning) {
      await new Promise((r) => setTimeout(r, 15000));
      continue;
    }

    const { dateStr, hours, minutes, dayOfWeek } = getKSTDate();
    const currentTotal = hours * 60 + minutes;
    const morningTargetTotal = currentMorningTarget.hour * 60 + currentMorningTarget.minute;
    const eveningTargetTotal = currentEveningTarget.hour * 60 + currentEveningTarget.minute;

    // 날짜가 바뀌면 새로운 랜덤 시간 배정 및 주간 스킵 점검
    if (lastCheckedDay !== dateStr) {
      currentMorningTarget = getRandomTargetMinutes(8, 20, 8, 50);
      currentEveningTarget = getRandomTargetMinutes(18, 15, 18, 45);
      lastCheckedDay = dateStr;
      morningExecutedToday = false;
      eveningExecutedToday = false;
      eveningSkippedLoggedToday = false;

      const state = loadState();
      const weeklyConfig = checkOrUpdateWeeklySkip(state, dateStr);
      isAfternoonSkippedToday = (dayOfWeek === weeklyConfig.skip_afternoon_day);

      log(`\n🌅 [새 날짜 감지: ${dateStr} (${DAY_NAMES[dayOfWeek]})] 새로운 랜덤 목표 배정:`);
      log(`- 📰 오전 다이제스트: ${formatTarget(currentMorningTarget)} KST (매일 무휴식)`);
      if (isAfternoonSkippedToday) {
        log(`- 🎲 오늘은 주 1회 오후 심층글 휴식일(${weeklyConfig.skip_day_name})입니다! 오후 세션을 건너뜁니다.`);
      } else {
        log(`- 📚 오후 심층글: ${formatTarget(currentEveningTarget)} KST`);
      }
    }

    const state = loadState();

    // 1. 오전 다이제스트 시간 도달 확인 (Catch-up Window: 목표 시각 도달 후 오전 12시 이전)
    const morningDone = isSessionAlreadyDone(state, 'morning', dateStr) || isSessionAlreadyDone(state, 'lunch', dateStr);
    if (!morningDone && !morningExecutedToday && currentTotal >= morningTargetTotal && currentTotal < 12 * 60) {
      log(`🌅 [오전 세션 트리거] 목표 시각(${formatTarget(currentMorningTarget)}) 도달/보상 실행 (현재: ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} KST)`);
      morningExecutedToday = true;
      isSessionRunning = true;
      try {
        await runMorningNewsDigestPipeline();
      } catch (e) {
        log(`❌ [오전 세션 오류 방어] ${e.message}`);
      } finally {
        isSessionRunning = false;
      }
      await new Promise((r) => setTimeout(r, 65000)); // 중복 분 실행 방지
    }

    // 2. 오후 심층글 시간 도달 확인 (Catch-up Window: 목표 시각 도달 후 24시 이전)
    const eveningDone = isSessionAlreadyDone(state, 'evening', dateStr);
    if (!eveningDone && !eveningExecutedToday && currentTotal >= eveningTargetTotal && currentTotal < 24 * 60) {
      if (isAfternoonSkippedToday) {
        if (!eveningSkippedLoggedToday) {
          const weeklyConfig = state.weekly_skip_config || {};
          log(`💤 오늘은 주 1회 오후 심층글 휴식일(${weeklyConfig.skip_day_name || '지정요일'})입니다. 오후 세션을 건너뜁니다.`);
          eveningSkippedLoggedToday = true;
          try {
            await sendTelegramReport(
              `💤 *[포켓머니 오후 세션 휴식 안내]*\n\n오늘은 주 1회 오후 심층글 휴식일(${weeklyConfig.skip_day_name || '휴식일'})입니다.\n오전 뉴스 다이제스트는 매일 무휴식 발행되며, 오후 심층글은 내일부터 다시 정상 발행됩니다.`
            );
          } catch (_) {}
        }
      } else {
        log(`📚 [오후 세션 트리거] 목표 시각(${formatTarget(currentEveningTarget)}) 도달/보상 실행 (현재: ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} KST)`);
        eveningExecutedToday = true;
        isSessionRunning = true;
        try {
          await runPublishPipeline('evening');
        } catch (e) {
          log(`❌ [오후 세션 오류 방어] ${e.message}`);
        } finally {
          isSessionRunning = false;
        }
        await new Promise((r) => setTimeout(r, 65000)); // 중복 분 실행 방지
      }
    }

    // 30초마다 체크
    await new Promise((r) => setTimeout(r, 30000));
  }
}

// CLI 직접 실행 시 분기
if (process.argv[1] && process.argv[1].endsWith('auto-publish-runner.mjs')) {
  const arg = process.argv[2];
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');

  if (arg === 'morning' || arg === 'lunch') {
    runMorningNewsDigestPipeline({ force, dryRun }).then((success) => process.exit(success ? 0 : 1));
  } else if (arg === 'evening') {
    runPublishPipeline(arg, { force, dryRun }).then((success) => process.exit(success ? 0 : 1));
  } else if (arg === 'daemon') {
    startDaemon();
  } else {
    console.log('사용법:');
    console.log('  node scripts/auto-publish-runner.mjs morning                 # 오전 뉴스 다이제스트 수동 실행');
    console.log('  node scripts/auto-publish-runner.mjs lunch                   # 오전 뉴스 다이제스트 수동 실행 (호환용)');
    console.log('  node scripts/auto-publish-runner.mjs evening                 # 오후 심층 가이드 수동 실행');
    console.log('  node scripts/auto-publish-runner.mjs evening --force         # 오늘 이미 완료되었어도 강제 실행');
    console.log('  node scripts/auto-publish-runner.mjs evening --dry-run       # D1/Git 건너뛰고 파일만 생성');
    console.log('  node scripts/auto-publish-runner.mjs daemon                  # 상시 Two-Track 스케줄러 데몬 가동');
  }
}
