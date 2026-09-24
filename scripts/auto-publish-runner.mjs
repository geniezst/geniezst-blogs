#!/usr/bin/env node
/**
 * blogs 자동 포스팅 오케스트레이터 및 스케줄러 (Auto Publish Runner & Daemon)
 * - 대상 블로그: 포켓머니 (blogs, /workspace/blogs)
 * - Two-Track 스케줄:
 *   1) 오전 세션: 08:20 ~ 08:50 KST (모닝 머니 다이제스트, ★ 주 7일 매일 무휴식 구동)
 *   2) 오후 세션: 18:15 ~ 18:45 KST (생활금융/복지 심층 가이드, 🎲 주 1회 랜덤 휴식)
 * 
 * [무중단 2-Tier Fallback 아키텍처 (BE-02)]
 * - Tier 1: agy CLI (stdin 파이핑 + PATH 하드닝 + 바이너리 안전 검증)
 * - Tier 2: 내장 심층글 생성 엔진 (Built-in Deep Article Generator)
 *           Groq (llama-3.3-70b-versatile) -> Gemini (gemini-2.5-flash) Fallback
 * 
 * 사용법:
 *   1) 수동 세션 즉시 실행:
 *      node scripts/auto-publish-runner.mjs morning                 # 아침 뉴스 다이제스트
 *      node scripts/auto-publish-runner.mjs lunch                   # 아침 뉴스 다이제스트 (호환성)
 *      node scripts/auto-publish-runner.mjs evening                 # 저녁 심층 가이드
 *      node scripts/auto-publish-runner.mjs evening --force         # 오늘 이미 완료되었어도 강제 실행
 *      node scripts/auto-publish-runner.mjs evening --dry-run       # D1/Git 건너뛰고 파일만 생성
 *      node scripts/auto-publish-runner.mjs evening --tier2-only    # Tier 2 내장 엔진 즉시 테스트
 * 
 *   2) 백그라운드 스케줄러 데몬 모드:
 *      node scripts/auto-publish-runner.mjs daemon
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { sendTelegramReport } from './telegram-notify.mjs';
import { runNewsDigestGeneration } from './generate-news-digest.mjs';

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
const STATE_FILE = path.join(BLOG_ROOT, 'data', 'auto-publish-state.json');
const LOG_FILE = path.join(BLOG_ROOT, 'data', 'auto-publish.log');

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
  const env = { ...process.env };
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
        }
      } catch (_) {}
    }
  }
  return env;
}

/**
 * 0-1. agy CLI 바이너리 안전 탐색 (심볼릭 링크 및 실행 권한 안전 검증)
 */
export function findAgyBinary() {
  // 1. 환경변수 지정 경로 우선
  const envBin = process.env.AGY_BIN_PATH;
  if (envBin && fs.existsSync(envBin)) {
    try {
      const real = fs.realpathSync(envBin);
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch (_) {}
  }

  // 2. 다중 표준 후보 경로
  const homeDir = process.env.HOME || '/root';
  const candidates = [
    '/root/.local/bin/agy',
    '/usr/local/bin/agy',
    '/root/.gemini/antigravity-cli/bin/agy',
    path.join(homeDir, '.local', 'bin', 'agy'),
    path.join(homeDir, '.gemini', 'antigravity-cli', 'bin', 'agy'),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      try {
        const real = fs.realpathSync(candidate);
        fs.accessSync(real, fs.constants.X_OK);
        return real;
      } catch (_) {}
    }
  }

  // 3. which agy
  try {
    const whichRes = execSync('which agy 2>/dev/null', { encoding: 'utf8' }).trim();
    if (whichRes && fs.existsSync(whichRes)) {
      const real = fs.realpathSync(whichRes);
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    }
  } catch (_) {}

  return null;
}

/**
 * 0-2. 서브프로세스용 하드닝된 환경변수 생성
 */
export function buildHardenedEnv() {
  const extraPaths = ['/root/.local/bin', '/usr/local/bin', '/root/.gemini/antigravity-cli/bin'];
  const currentPath = process.env.PATH || '';
  const hardenedPath = [...extraPaths, currentPath].filter(Boolean).join(':');

  return {
    ...process.env,
    PATH: hardenedPath,
  };
}

/**
 * 0-3. 마크다운 본문 공백 및 금융 금액 띄어쓰기 규범화
 */
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
export async function runMorningNewsDigestPipeline(options = {}) {
  const { dateStr, timeStr } = getKSTDate();
  console.log(`\n========================================`);
  console.log(`🌅 [포켓머니 아침 모닝 브리핑 시작] ${dateStr} (morning) 실행 시각: ${timeStr} KST`);
  console.log(`========================================`);

  const state = loadState();

  // 1. 중복 실행 검사
  const isDone = state.history.some(
    (h) => h.date === dateStr && (h.session === 'morning' || h.session === 'lunch') && h.status === 'success'
  );
  if (isDone && !options.force) {
    console.log(`ℹ️ [중복 방지] 오늘(${dateStr}) 아침 다이제스트 세션은 이미 성공적으로 완료되었습니다. 건너뜁니다.`);
    return true;
  }

  try {
    const res = await runNewsDigestGeneration(options);
    if (!res || !res.success) {
      throw new Error('뉴스 다이제스트 생성에 실패했습니다.');
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
 * Tier 2: LLM API 호출 파이프라인 (Groq llama-3.3-70b-versatile -> Gemini gemini-2.5-flash Fallback)
 */
export async function callLLMWithFallback(messages, env) {
  // 1순위: Groq API
  const groqUrl = (env.GROQ_API_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '') + '/chat/completions';
  const groqKey = env.GROQ_API_KEY;
  const groqModel = env.GROQ_MODEL || 'llama-3.3-70b-versatile';

  if (groqKey) {
    log(`🧠 [Tier 2 - LLM 1순위 시도] Groq (${groqModel})...`);
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
          max_tokens: 4500,
        }),
        signal: AbortSignal.timeout(60000), // 60초 타임아웃
      });

      if (res.ok) {
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (content && content.trim()) {
          log(`✅ [Tier 2 - Groq 생성 성공] (글자 수: ${content.trim().length}자)`);
          return content.trim();
        }
      }
      const errText = await res.text();
      log(`⚠️ [Tier 2 - Groq 호출 실패 HTTP ${res.status}] ${errText.slice(0, 150)} -> Gemini Fallback 전환`);
    } catch (err) {
      log(`⚠️ [Tier 2 - Groq 예외 발생] ${err.message} -> Gemini Fallback 전환`);
    }
  } else {
    log(`⚠️ [Tier 2 - Groq 건너뜀] GROQ_API_KEY가 없습니다 -> Gemini 시도`);
  }

  // 2순위: Google Gemini API Fallback
  const geminiUrl = (env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/').replace(/\/+$/, '') + '/chat/completions';
  const geminiKey = env.GEMINI_API_KEY;

  if (!geminiKey) {
    throw new Error('Groq와 Gemini API 키가 모두 설정되지 않았습니다.');
  }

  const geminiModelCandidates = [
    env.GEMINI_MODEL || 'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-flash-latest',
  ];

  let lastError = null;
  for (const model of geminiModelCandidates) {
    log(`🧠 [Tier 2 - LLM Fallback 시도] Gemini (${model})...`);
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
        log(`⚠️ [Tier 2 - Gemini ${model} HTTP ${res.status}] ${errText.slice(0, 120)} -> 다음 모델 시도`);
        lastError = new Error(`Gemini ${model} 실패 (${res.status}): ${errText}`);
        continue;
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (content && content.trim()) {
        log(`✅ [Tier 2 - Gemini (${model}) Fallback 생성 성공] (글자 수: ${content.trim().length}자)`);
        return content.trim();
      }
    } catch (err) {
      log(`⚠️ [Tier 2 - Gemini ${model} 예외 발생] ${err.message} -> 다음 모델 시도`);
      lastError = err;
    }
  }

  throw lastError || new Error('모든 Gemini 모델 Fallback 호출이 실패했습니다.');
}

/**
 * 마크다운 응답 파싱, Frontmatter 정합성 보정 및 YYMMDDNN-[slug].md 파일 저장
 */
export function parseAndSaveArticleMarkdown({ rawMarkdown, category, targetDateStr, selectedChart }) {
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

  // 5) Author 보정
  if (!/author:\s*["']?[^"'\n]+["']?/.test(yamlBlock)) {
    yamlBlock += `\nauthor: "스마트 머니"`;
  }

  // 6) Reading Time 보정
  if (!/reading_time:\s*\d+/.test(yamlBlock)) {
    yamlBlock += `\nreading_time: 8`;
  }

  // 7) Affiliate 보정
  if (!/affiliate:\s*(?:true|false)/.test(yamlBlock)) {
    yamlBlock += `\naffiliate: false`;
  }

  // 8) Tags 기본값 점검
  if (!yamlBlock.includes('tags:')) {
    yamlBlock += `\ntags: [${category}, 생활금융, 정부지원, 절세전략]`;
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

  // 무결성 및 통계 로깅
  const totalChars = finalMarkdown.length;
  const nonSpaceChars = finalMarkdown.replace(/\s/g, '').length;
  const h2Count = (finalMarkdown.match(/^##\s+/gm) || []).length;
  const hasChart = finalMarkdown.includes('financial-chart-box');

  log(`📊 [Tier 2 콘텐츠 무결성 검증]`);
  log(`- 파일명: ${fileName}`);
  log(`- 제목: "${title}" (slug: ${cleanSlug})`);
  log(`- 총 글자 수: ${totalChars}자 (공백 제외: ${nonSpaceChars}자)`);
  log(`- H2 대주제 개수: ${h2Count}개`);
  log(`- 필수 차트 컴포넌트 포함 여부: ${hasChart ? '✅ PASS' : '⚠️ WARN (차트 태그 누락)'}`);

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
export async function runBuiltinDeepArticleGenerator({ category, sessionName, targetDateStr, selectedChart }) {
  const env = loadEnvConfig();
  log(`🚀 [Tier 2 엔진 가동] 내장 심층글 생성기를 호출합니다. (카테고리: ${category}, 세션: ${sessionName}, 차트: ${selectedChart.name})`);

  const systemPrompt = `당신은 대한민국 생활 경제 및 정부 정책 복지 혜택 전문 금융/행정 시니어 에디터입니다.
블로그 저장소 위치는 /workspace/blogs 이며 블로그 이름은 '포켓머니(pockemoney)'입니다.
구글 애드센스 고수익 승인 표준 및 개발자/실무자 수준의 정확하고 깊이 있는 금융 분석 기준을 엄격히 준수하세요.

[필수 작성 지침]
1. [골디락스 난이도 및 주제 선정]
   - 직장인, 사회초년생, 자영업자, 신혼부부, 은퇴자 등 다양한 독자층이 일상에서 검색창에 자주 찾는 실전 생활금융, 세무(연말정산/소득공제/비과세), 주거/부동산(청약통장/전세보증보험), 복지/건강보험(피부양자 자격/실업급여), 생활 지원금(근로장려금/소상공인 지원) 등 다채롭고 구체적인 실무 주제를 선정하세요.
2. [필수 분량 규격]
   - 반드시 전체 공백 포함 2,800자 ~ 3,500자 이상 (공백 제외 최소 1,800자 이상)의 깊이 있는 전문 정보를 작성하세요. 얇은 글(Thin content)은 절대 금지됩니다.
3. [금액 띄어쓰기 규범]
   - '70만 원', '5,000만 원'처럼 띄어 쓰지 말고 반드시 '70만원', '5,000만원', '2.4만원', '1억원'처럼 붙여 쓰세요.
4. [필수 데이터 시각화 차트 삽입 - 이번 세션 지정 유형: ${selectedChart.name}]
${selectedChart.instruction}
   - 반드시 본문 첫 번째 H2 또는 두 번째 H2 직후에 위 지정된 유형의 반응형 차트 컴포넌트를 마크다운 코드블록(\`\`\`) 없이 순수 HTML 구조(<div class="financial-chart-box">...</div>)로 완벽하게 삽입하세요.
5. [필수 구조 (H2 최소 5개 이상 필수 구성)]
   - 구체적인 제도 개요 및 최신 법령/지침 개정 배경
   - 핵심 대상 자격 요건 정밀 분석표 (Table: 대상자, 소득/재산 기준 등)
   - 실제 수혜/납입 금액 또는 혜택 비교표 (Table: 시중 상품 대비 차등 혜택 분석)
   - 실무 비대면 신청/진행 절차 및 필수 구비 서류
   - 신청 전 반드시 점검해야 할 불이익 방지 및 예외 규정
   - 독자들이 검색창에서 가장 자주 묻는 실전 Q&A (FAQ 4~5문항)
   위 6대 요소를 각각 독립된 '## [직관적인 소제목]' 헤딩으로 반드시 5개 이상 구성하세요.
6. [절대 금지 사항]
   - 기계적인 '들어가며', '마치며', '서론', '결론' 헤딩을 절대 쓰지 마세요.
   - 상투적인 멘트('~에 대해 알아보겠습니다', '이 글에서는 ~를 정리합니다', '도움이 되셨기를 바랍니다') 전면 금지.
   - 제목 및 소제목에 콜론(:) 사용 금지 (하이픈 - 또는 | 로 대체).
   - 문장마다 볼드체(**단어**)를 남발하지 마세요. 메뉴 경로, 법조문, 액수는 인라인 코드(백틱 또는 작은따옴표)로 표기하고, 볼드는 본문 전체에서 가장 중요한 핵심 결론 1~2개에만 극도로 절제하세요.
   - 소제목 번호 매기기('1.', '1.1') 금지, 직관적이고 매력적인 텍스트 소제목을 쓰세요.
   - 금융 및 행정 공문서 수준의 정확한 수치와 전문적 어조를 견지하세요.
7. [출력 형식]
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

  const parsed = parseAndSaveArticleMarkdown({
    rawMarkdown,
    category,
    targetDateStr,
    selectedChart,
  });

  return parsed;
}

/**
 * 고가용성 아티클 생성 파이프라인 (Tier 1: agy CLI -> Tier 2: Groq/Gemini 내장 엔진)
 */
export async function generateArticleWithFallback({
  category,
  sessionName,
  targetDateStr,
  prompt,
  selectedChart,
  options = {},
}) {
  const postsDir = path.join(BLOG_ROOT, 'content', 'posts');
  const beforeFiles = new Set(fs.readdirSync(postsDir));

  // 옵션으로 tier2Only 가 지정된 경우 Tier 1 건너뜀
  if (options.tier2Only) {
    log(`🧪 [--tier2-only 옵션] Tier 1을 건너뛰고 Tier 2 내장 생성기를 직접 호출합니다.`);
    const result = await runBuiltinDeepArticleGenerator({
      category,
      sessionName,
      targetDateStr,
      selectedChart,
    });
    result.tier = 'Tier 2 (Direct)';
    return result;
  }

  // ------------------------------------------------------------------
  // [Tier 1] agy CLI 실행 (안전 바이너리 검증 + stdin 파이핑)
  // ------------------------------------------------------------------
  const agyBin = findAgyBinary();
  let tier1Success = false;

  if (agyBin) {
    try {
      log(`🤖 [Tier 1] agy CLI를 통한 글 생성 시도... (바이너리: ${agyBin})`);
      const agyProc = spawnSync(agyBin, ['--dangerously-skip-permissions', '--print'], {
        cwd: BLOG_ROOT,
        input: prompt, // ★ stdin 스트림으로 안전 전달 (쉘 인라인 -p 제거)
        encoding: 'utf8',
        env: buildHardenedEnv(),
        timeout: 600000, // 최대 10분
        maxBuffer: 50 * 1024 * 1024,
      });

      if (!agyProc.error && agyProc.status === 0) {
        const afterFiles = fs
          .readdirSync(postsDir)
          .filter((f) => !beforeFiles.has(f) && f.endsWith('.md') && f !== 'template.md');

        if (afterFiles.length > 0) {
          log(`✅ [Tier 1 성공] 신규 포스트 생성 완료: ${afterFiles[0]}`);
          const postFile = path.join(postsDir, afterFiles[0]);
          const postContent = fs.readFileSync(postFile, 'utf8');
          const titleMatch = postContent.match(/title:\s*["']?([^"'\n]+)["']?/);
          const slugMatch = postContent.match(/slug:\s*["']?([^"'\n]+)["']?/);

          tier1Success = true;
          return {
            postFile,
            title: titleMatch ? titleMatch[1].trim() : afterFiles[0].replace('.md', ''),
            slug: slugMatch ? slugMatch[1].trim() : afterFiles[0].replace('.md', ''),
            tier: 'Tier 1 (agy CLI)',
          };
        }
      }

      log(
        `⚠️ [Tier 1 경고] agy 프로세스 실패 또는 신규 파일 미감지 (code: ${agyProc.status}, err: ${agyProc.error?.message || (agyProc.stderr || '').slice(0, 200)})`
      );
    } catch (tier1Err) {
      log(`⚠️ [Tier 1 예외] agy 실행 중 오류 발생: ${tier1Err.message}`);
    }
  } else {
    log(`⚠️ [Tier 1 건너뜀] 유효한 agy 실행 바이너리를 찾을 수 없습니다.`);
  }

  // agy에서 최근 15분 이내 생성된 파일이 혹시 있는지 2차 검사
  const recentMds = fs
    .readdirSync(postsDir)
    .filter((f) => f.endsWith('.md') && f !== 'template.md')
    .map((f) => ({
      file: f,
      mtime: fs.statSync(path.join(postsDir, f)).mtimeMs,
    }))
    .filter((f) => Date.now() - f.mtime < 15 * 60 * 1000 && !beforeFiles.has(f.file))
    .sort((a, b) => b.mtime - a.mtime);

  if (recentMds.length > 0) {
    const postFile = path.join(postsDir, recentMds[0].file);
    log(`ℹ️ [Tier 1 복구] 예외가 있었으나 신규 포스트 파일('${recentMds[0].file}')이 감지되어 채택합니다.`);
    const postContent = fs.readFileSync(postFile, 'utf8');
    const titleMatch = postContent.match(/title:\s*["']?([^"'\n]+)["']?/);
    const slugMatch = postContent.match(/slug:\s*["']?([^"'\n]+)["']?/);

    return {
      postFile,
      title: titleMatch ? titleMatch[1].trim() : recentMds[0].file.replace('.md', ''),
      slug: slugMatch ? slugMatch[1].trim() : recentMds[0].file.replace('.md', ''),
      tier: 'Tier 1 (agy CLI recovery)',
    };
  }

  // ------------------------------------------------------------------
  // [Tier 2] 내장 심층글 생성기 자동 가동 (Groq -> Gemini REST API)
  // ------------------------------------------------------------------
  log(`🚨 [Tier 2 자동 전환] agy CLI 실패로 인해 내장 심층글 생성기(Built-in Deep Article Generator)를 즉시 가동합니다!`);
  const result = await runBuiltinDeepArticleGenerator({
    category,
    sessionName,
    targetDateStr,
    selectedChart,
  });

  result.tier = 'Tier 2 (Built-in LLM Fallback)';
  return result;
}

/**
 * 실제 포스트 생성 및 배포 파이프라인
 */
export async function runPublishPipeline(sessionName, options = {}) {
  const { dateStr, timeStr } = getKSTDate();
  console.log(`\n========================================`);
  console.log(`🚀 [blogs 생활경제 자동 게시 시작] ${dateStr} (${sessionName}) 실행 시각: ${timeStr} KST`);
  console.log(`========================================`);

  const state = loadState();

  // 1. 중복 실행 검사 (--force 옵션 지원)
  if (isSessionAlreadyDone(state, sessionName, dateStr) && !options.force) {
    console.log(`ℹ️ [중복 방지] 오늘(${dateStr}) ${sessionName} 세션은 이미 성공적으로 완료되었습니다. 건너뜁니다.`);
    return true;
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
    // 4. 안전 프롬프트 작성 (백틱 및 커맨드 치환 방어)
    const prompt = `
당신은 대한민국 생활 경제 및 정부 정책 복지 혜택 전문 금융/행정 에디터입니다.
블로그 저장소 위치는 /workspace/blogs 입니다.
/workspace/blogs/docs/POST_STYLE_GUIDE.md 규격을 엄격히 준수하여 신규 포스트를 1개 작성해주세요.

- 대상 블로그: 포켓머니 (blogs, pockemoney)
- 세션: ${sessionName} (${dateStr})
- 카테고리: ${category}
- 작성 지침 (★ 구글 애드센스 고수익 승인 표준 및 AI 패턴 엄격 금지):
  1. [주제 다양성 및 난이도 (골디락스 난이도)] 특정 계층(청년 등)이나 특정 상품에만 편중되지 않도록 하세요. 직장인, 사회초년생, 자영업자, 신혼부부, 은퇴자 등 다양한 독자층이 일상에서 검색창에 자주 찾는 생활 금융, 세무(연말정산/소득공제/비과세), 주거/부동산(청약통장/전세보증보험), 복지/건강보험(피부양자 자격/실업급여), 생활 지원금(에너지포인트/근로장려금) 등 다채로운 실전 주제를 선정하세요.
  2. [필수 분량] 반드시 전체 공백 포함 2,500자 ~ 3,500자 이상(공백 제외 1,800자 이상)의 깊이 있는 전문 정보를 작성하세요. 분량이 짧은 얇은 글(Thin content)은 엄격히 금지됩니다.
  3. [금액 띄어쓰기 규범] '70만 원', '5,000만 원'처럼 띄어 쓰지 말고 반드시 '70만원', '5,000만원', '2.4만원'처럼 붙여 쓰세요.
  4. [데이터 시각화 차트 필수 - 이번 세션 지정 유형: ${selectedChart.name}]
${selectedChart.instruction}
반드시 본문 중간에 해당 반응형 차트 컴포넌트를 최소 1개 이상 HTML 구조로 삽입하세요. (수치 비교를 위한 막대 바/도넛 등 시각화 그래프 요소를 반드시 1~2개 포함)
  5. [테이블 가독성 최적화] 표 안의 글자가 뜬금없이 잘리지 않도록 셀 내용을 핵심 요약 문구 위주로 작성하고, 문장 길이와 줄바꿈을 깔끔하게 정돈하세요.
  6. [필수 구조] 본문 내 최소 5개 이상의 깊이 있는 대주제(H2)를 구성하고, 다음 요소를 모두 포함하세요:
     - 핵심 대상 자격 요건 정밀 분석표(Table: 대상자, 소득/재산 기준 등)
     - 실제 수혜/납입 금액 또는 혜택 비교표(Table)
     - 실무 비대면 신청/진행 절차 및 구비 서류
     - 신청 전 반드시 점검해야 할 불이익 방지 및 예외 규정
     - 독자들이 검색창에서 가장 자주 묻는 실전 Q&A (FAQ 4~5문항)
  7. [절대 금지] 기계적인 '들어가며', '마치며', '서론', '결론' 헤딩을 절대 쓰지 마세요. 상투적인 인트로/클로징 멘트('~에 대해 알아보겠습니다', '이 글에서는 ~를 정리합니다', '~해 보시기 바랍니다', '도움이 되셨기를 바랍니다')도 전면 금지합니다.
  8. [절대 금지] 불필요한 공백/자간(단어 앞뒤 두 칸 이상 공백)을 넣지 마세요.
  9. [절대 금지] 문장마다 키워드에 볼드체(별표 두 개)를 남발하지 마세요. 메뉴 경로나 액수는 인라인 코드(작은따옴표 또는 백틱 감싸기)로 표기하고, 볼드는 본문 전체에서 가장 중요한 결론 1~2개에만 극도로 절제하세요.
  10. 소제목에 '1.', '1.1', '2.' 식의 관료적 번호 매기기를 하지 말고 직관적인 텍스트 소제목을 쓰세요.
  11. 대충 쓴 글처럼 보이지 않도록 금융 및 행정 공문서 수준의 정확한 수치와 전문적 어조를 견지하세요.
  12. 완성된 글은 '/workspace/blogs/content/posts/YYMMDDNN-[고유-영문-슬러그].md' (예: 오늘 24일의 세 번째 글이면 26092403-[슬러그].md 처럼 날짜마다 01부터 시작하는 일련번호) 파일로 저장하세요.
  13. 글 작성이 완료되면 파일 경로와 제목, 슬러그를 명시하며 완료를 알리세요.
`.trim();

    // 5. Tier 1 (agy CLI) -> Tier 2 (Groq/Gemini 내장 엔진) 자동 Fallback 파이프라인 가동
    const generated = await generateArticleWithFallback({
      category,
      sessionName,
      targetDateStr: dateStr,
      prompt,
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

    // 6. D1 데이터베이스 발행
    console.log(`🗄️ Cloudflare D1 원격 데이터베이스에 발행합니다...`);
    execSync(`node scripts/publish-post.mjs "${latestPostFile}"`, {
      cwd: BLOG_ROOT,
      stdio: 'inherit',
    });

    // 7. 프로덕션 빌드 무결성 검증
    console.log(`⚙️ Astro 프로덕션 빌드 무결성을 검증합니다...`);
    execSync(`npm run build`, {
      cwd: BLOG_ROOT,
      stdio: 'inherit',
    });

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
    log(`📦 GitHub main에 커밋 및 푸시하여 Workers 배포를 트리거합니다...`);
    try {
      const filesToStage = ['content/posts/'];
      if (fs.existsSync(STATE_FILE)) {
        filesToStage.push('data/auto-publish-state.json');
      }
      execSync(`git add ${filesToStage.join(' ')}`, { cwd: BLOG_ROOT });

      const stagedChanges = execSync(`git status --porcelain`, { cwd: BLOG_ROOT }).toString().trim();
      if (stagedChanges) {
        execSync(`git commit -m "feat(post): auto publish [${sessionName}] ${generatedSlug}"`, { cwd: BLOG_ROOT });
      }

      // 커밋 완료 후 안전하게 최신 원격 변경사항 rebase 및 push
      try {
        execSync(`git pull --rebase origin main`, { cwd: BLOG_ROOT });
      } catch (_) {}

      execSync(`git push origin main`, { cwd: BLOG_ROOT });
    } catch (gitErr) {
      log(`⚠️ GitHub push 중 경고 발생 (D1 배포는 정상 완료됨): ${gitErr.message}`);
    }

    // 10. 텔레그램 성공 보고 발송
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
- 🚀 배포: GitHub push ➔ Workers 배포 완료`;

    await sendTelegramReport(successMsg);
    console.log(`✅ ${sessionName} 세션 자동 게시 작업이 성공적으로 완료되었습니다!`);
    return true;
  } catch (err) {
    console.error(`❌ [자동 게시 실패]`, err.message);

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
    const failMsg = `⚠️ *[blogs 자동 게시 실패]*

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
  log(`🤖 [blogs 포켓머니 2-Track 자동화 스케줄러 데몬 가동]`);
  log(`- 오전 범위: 08:20 ~ 08:50 KST (모닝 머니 다이제스트, ★ 주 7일 매일 무휴식)`);
  log(`- 오후 범위: 18:15 ~ 18:45 KST (생활금융 심층 가이드, 🎲 주 1회 랜덤 휴식)`);

  let currentMorningTarget = getRandomTargetMinutes(8, 20, 8, 50);
  let currentEveningTarget = getRandomTargetMinutes(18, 15, 18, 45);
  let lastCheckedDay = '';
  let isAfternoonSkippedToday = false;

  const formatTarget = (t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
  log(`📅 오늘의 랜덤 목표 시간: 오전 ${formatTarget(currentMorningTarget)}, 오후 ${formatTarget(currentEveningTarget)}`);

  while (true) {
    const { dateStr, hours, minutes, dayOfWeek } = getKSTDate();

    // 날짜가 바뀌면 새로운 랜덤 시간 배정 및 주간 스킵 점검
    if (lastCheckedDay !== dateStr) {
      currentMorningTarget = getRandomTargetMinutes(8, 20, 8, 50);
      currentEveningTarget = getRandomTargetMinutes(18, 15, 18, 45);
      lastCheckedDay = dateStr;

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

    // 1. 오전 다이제스트 시간 도달 확인 (★ 매일 주 7일 무휴식 구동)
    if (hours === currentMorningTarget.hour && minutes === currentMorningTarget.minute) {
      log(`🌅 오전 다이제스트 목표 시간(${formatTarget(currentMorningTarget)} KST) 도달: 파이프라인 가동`);
      await runMorningNewsDigestPipeline();
      await new Promise((r) => setTimeout(r, 65000)); // 중복 분 실행 방지
    }

    // 2. 오후 심층글 시간 도달 확인 (주 1회 랜덤 휴식 요일 반영)
    if (hours === currentEveningTarget.hour && minutes === currentEveningTarget.minute) {
      if (isAfternoonSkippedToday) {
        const state = loadState();
        const weeklyConfig = state.weekly_skip_config || {};
        log(`💤 오늘은 주 1회 오후 심층글 휴식일(${weeklyConfig.skip_day_name || '지정요일'})입니다. 오후 세션을 건너뜁니다.`);
        await sendTelegramReport(
          `💤 *[포켓머니 오후 세션 휴식 안내]*\n\n오늘은 주 1회 오후 심층글 휴식일(${weeklyConfig.skip_day_name || '휴식일'})입니다.\n오전 뉴스 다이제스트는 매일 무휴식 발행되며, 오후 심층글은 내일부터 다시 정상 발행됩니다.`
        );
      } else {
        log(`📚 오후 심층글 목표 시간(${formatTarget(currentEveningTarget)} KST) 도달: 파이프라인 가동`);
        await runPublishPipeline('evening');
      }
      await new Promise((r) => setTimeout(r, 65000)); // 중복 분 실행 방지
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
  const tier2Only = process.argv.includes('--tier2-only');

  if (arg === 'morning' || arg === 'lunch') {
    runMorningNewsDigestPipeline({ force, dryRun }).then((success) => process.exit(success ? 0 : 1));
  } else if (arg === 'evening') {
    runPublishPipeline(arg, { force, dryRun, tier2Only }).then((success) => process.exit(success ? 0 : 1));
  } else if (arg === 'daemon') {
    startDaemon();
  } else {
    console.log('사용법:');
    console.log('  node scripts/auto-publish-runner.mjs morning                 # 오전 뉴스 다이제스트 수동 실행');
    console.log('  node scripts/auto-publish-runner.mjs lunch                   # 오전 뉴스 다이제스트 수동 실행 (호환용)');
    console.log('  node scripts/auto-publish-runner.mjs evening                 # 오후 심층 가이드 수동 실행');
    console.log('  node scripts/auto-publish-runner.mjs evening --force         # 오늘 이미 완료되었어도 강제 실행');
    console.log('  node scripts/auto-publish-runner.mjs evening --dry-run       # D1/Git 건너뛰고 파일만 생성');
    console.log('  node scripts/auto-publish-runner.mjs evening --tier2-only    # Tier 2 내장 엔진 즉시 테스트');
    console.log('  node scripts/auto-publish-runner.mjs daemon                  # 상시 Two-Track 스케줄러 데몬 가동');
  }
}
