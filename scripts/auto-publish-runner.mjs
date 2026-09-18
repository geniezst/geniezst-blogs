#!/usr/bin/env node
/**
 * blogs 자동 포스팅 오케스트레이터 및 스케줄러 (Auto Publish Runner & Daemon)
 * - 대상 블로그: 스마트 라이프 & 머니 (/workspace/blogs)
 * - 스케줄: 점심(11:15~11:45 KST), 저녁(18:15~18:45 KST)
 * 
 * 사용법:
 *   1) 수동 세션 즉시 실행:
 *      node scripts/auto-publish-runner.mjs lunch
 *      node scripts/auto-publish-runner.mjs evening
 * 
 *   2) 백그라운드 스케줄러 데몬 모드:
 *      node scripts/auto-publish-runner.mjs daemon
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { sendTelegramReport } from './telegram-notify.mjs';

const BLOG_ROOT = path.resolve(import.meta.dirname, '..');
const STATE_FILE = path.join(BLOG_ROOT, 'data', 'auto-publish-state.json');
const LOG_FILE = path.join(BLOG_ROOT, 'data', 'auto-publish.log');

function log(...args) {
  const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (_) {}
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
  return { now, dateStr, hours, minutes, timeStr };
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
const CHART_PRESETS = [
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
    name: '단계별 파이프라인 퍼널 차트 (Step Progression Flow)',
    instruction: `[선정된 차트 유형: 단계별 파이프라인 누적 차트]
제도 참여 단계별, 근속 기간별 또는 연차별 누적 수령액 흐름을 '단계별 파이프라인 차트'로 작성하세요.
HTML 구조 규격:
<div class="financial-chart-box">
<div class="chart-header">
<div class="chart-title"><span>🚀</span><span>[차트 제목: 단계별 누적 혜택 로드맵]</span></div>
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
    name: '통계 지표 비교 카드 그리드 (Stat Metric Comparison Grid)',
    instruction: `[선정된 차트 유형: 통계 지표 비교 카드 그리드]
핵심 3대 혜택 지표(금리, 월 지원금, 비과세 절세액 등)를 '통계 지표 카드 그리드'로 작성하세요.
HTML 구조 규격:
<div class="financial-chart-box">
<div class="chart-header">
<div class="chart-title"><span>⚡</span><span>[차트 제목: 핵심 3대 수혜 지표 요약]</span></div>
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
 * 실제 포스트 생성 및 배포 파이프라인
 */
export async function runPublishPipeline(sessionName) {
  const { dateStr, timeStr } = getKSTDate();
  console.log(`\n========================================`);
  console.log(`🚀 [blogs 생활경제 자동 게시 시작] ${dateStr} (${sessionName}) 실행 시각: ${timeStr} KST`);
  console.log(`========================================`);

  const state = loadState();

  // 1. 중복 실행 검사
  if (isSessionAlreadyDone(state, sessionName, dateStr)) {
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

  let generatedSlug = '';
  let generatedTitle = '';

  try {
    // 4. Antigravity AI를 통한 생활경제 고품질 글 작성
    console.log(`🤖 AI 에이전트(blogs)를 호출하여 생활경제 포스트 생성을 시작합니다...`);

    const prompt = `
당신은 대한민국 생활 경제 및 정부 정책 복지 혜택 전문 금융/행정 에디터입니다.
블로그 저장소 위치는 /workspace/blogs 입니다.
/workspace/blogs/docs/POST_STYLE_GUIDE.md 규격을 엄격히 준수하여 신규 포스트를 1개 작성해주세요.

- 대상 블로그: 스마트 라이프 & 머니 (blogs)
- 세션: ${sessionName} (${dateStr})
- 카테고리: ${category}
- 작성 지침 (★ 구글 애드센스 고수익 승인 표준 및 AI 패턴 엄격 금지):
  1. [필수 분량] 반드시 전체 공백 포함 2,500자 ~ 3,500자 이상(공백 제외 1,800자 이상)의 깊이 있는 전문 정보를 작성하세요. 분량이 짧은 얇은 글(Thin content)은 엄격히 금지됩니다.
  2. [금액 띄어쓰기 규범] '70만 원', '5,000만 원'처럼 띄어 쓰지 말고 반드시 '70만원', '5,000만원', '2.4만원'처럼 붙여 쓰세요.
  3. [데이터 시각화 차트 필수 - 이번 세션 지정 유형: ${selectedChart.name}]
${selectedChart.instruction}
반드시 본문 중간에 해당 반응형 차트 컴포넌트를 최소 1개 이상 HTML 구조로 삽입하세요.
  4. [테이블 가독성 최적화] 표 안의 글자가 뜬금없이 잘리지 않도록 셀 내용을 핵심 요약 문구 위주로 작성하고, 문장 길이와 줄바꿈을 깔끔하게 정돈하세요.
  5. [필수 구조] 본문 내 최소 5개 이상의 깊이 있는 대주제(H2)를 구성하고, 다음 요소를 모두 포함하세요:
     - 지원 대상 자격 요건 정밀 분석표(Table: 연령, 개인소득, 가구 중위소득 250% 등)
     - 실제 납입/수령 금액별 시뮬레이션 비교표(Table)
     - 모바일/온라인 3단계 비대면 신청 경로
     - 중도해지 패널티 및 특별 중도해지 혜택 보전 예외 규정
     - 독자들이 검색창에서 가장 자주 묻는 실전 Q&A (FAQ 4~5문항)
  6. [절대 금지] 기계적인 '들어가며', '마치며', '서론', '결론' 헤딩을 절대 쓰지 마세요. 상투적인 인트로/클로징 멘트('~에 대해 알아보겠습니다', '이 글에서는 ~를 정리합니다', '~해 보시기 바랍니다', '도움이 되셨기를 바랍니다')도 전면 금지합니다.
  7. [절대 금지] 불필요한 공백/자간(단어 앞뒤 두 칸 이상 공백)을 넣지 마세요.
  8. [절대 금지] 문장마다 키워드에 볼드체(**단어**)를 남발하지 마세요. 메뉴 경로나 액수는 인라인 코드(\`code\`)로 표기하고, 볼드는 본문 전체에서 가장 중요한 결론 1~2개에만 극도로 절제하세요.
  9. 소제목에 '1.', '1.1', '2.' 식의 관료적 번호 매기기를 하지 말고 직관적인 텍스트 소제목을 쓰세요.
  10. 대충 쓴 글처럼 보이지 않도록 금융 및 행정 공문서 수준의 정확한 수치와 전문적 어조를 견지하세요.
  11. 완성된 글은 '/workspace/blogs/content/posts/[고유-영문-슬러그].md' 파일로 저장하세요.
  12. 글 작성이 완료되면 파일 경로와 제목, 슬러그를 명시하며 완료를 알리세요.
`.trim();

    // agy 명령어로 글 생성 실행
    const agyCmd = `/usr/local/bin/agy --dangerously-skip-permissions -p="${prompt.replace(/"/g, '\\"')}"`;
    const agyOutput = execSync(agyCmd, {
      cwd: BLOG_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `/usr/local/bin:/root/.local/bin:${process.env.PATH || ''}`,
      },
      timeout: 300000, // 최대 5분
    });

    console.log(`AI 생성 응답:\n`, agyOutput.slice(0, 300), '...');

    // 생성된 최신 마크다운 파일 탐색
    const postsDir = path.join(BLOG_ROOT, 'content', 'posts');
    const mdFiles = fs.readdirSync(postsDir)
      .filter((f) => f.endsWith('.md') && f !== 'template.md')
      .map((f) => ({
        file: f,
        mtime: fs.statSync(path.join(postsDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (mdFiles.length === 0) {
      throw new Error('생성된 마크다운 포스트 파일을 찾을 수 없습니다.');
    }

    const latestPostFile = path.join(postsDir, mdFiles[0].file);
    const postContent = fs.readFileSync(latestPostFile, 'utf8');

    // Title 및 Slug 파싱
    const titleMatch = postContent.match(/title:\s*["']?([^"'\n]+)["']?/);
    const slugMatch = postContent.match(/slug:\s*["']?([^"'\n]+)["']?/);

    generatedTitle = titleMatch ? titleMatch[1] : mdFiles[0].file.replace('.md', '');
    generatedSlug = slugMatch ? slugMatch[1] : mdFiles[0].file.replace('.md', '');

    console.log(`📄 신규 포스트 생성 확인: "${generatedTitle}" (slug: ${generatedSlug})`);

    // 4. D1 데이터베이스 발행
    console.log(`🗄️ Cloudflare D1 원격 데이터베이스에 발행합니다...`);
    execSync(`node scripts/publish-post.mjs "${latestPostFile}"`, {
      cwd: BLOG_ROOT,
      stdio: 'inherit',
    });

    // 5. 프로덕션 빌드 무결성 검증
    console.log(`⚙️ Astro 프로덕션 빌드 무결성을 검증합니다...`);
    execSync(`npm run build`, {
      cwd: BLOG_ROOT,
      stdio: 'inherit',
    });

    // 6. 상태 파일 갱신 및 안전 저장 (Git 커밋 전 최신 상태 파일 디스크 반영)
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
      status: 'success',
    });
    saveState(state);

    // 7. GitHub commit & push (Cloudflare Workers 자동 배포)
    log(`📦 GitHub main에 커밋 및 푸시하여 Workers 배포를 트리거합니다...`);
    try {
      execSync(`git pull --rebase origin main`, { cwd: BLOG_ROOT });
    } catch (_) {}

    const filesToStage = ['content/posts/'];
    if (fs.existsSync(STATE_FILE)) {
      filesToStage.push('data/auto-publish-state.json');
    }
    execSync(`git add ${filesToStage.join(' ')}`, { cwd: BLOG_ROOT });

    const stagedChanges = execSync(`git status --porcelain`, { cwd: BLOG_ROOT }).toString().trim();
    if (stagedChanges) {
      execSync(`git commit -m "feat(post): auto publish [${sessionName}] ${generatedSlug}"`, { cwd: BLOG_ROOT });
      execSync(`git push origin main`, { cwd: BLOG_ROOT });
    }

    // 8. 텔레그램 성공 보고 발송
    const successMsg = `🎉 *[스마트 라이프 & 머니(blogs) 자동 게시 완료]*

⏰ *실행 시간:* ${timeStr} KST
🏷️ *구분:* ${sessionName}
📂 *카테고리:* ${category}
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
 * 데몬 스케줄러 메인 루프
 * - 점심: 11:15 ~ 11:45 KST
 * - 저녁: 18:15 ~ 18:45 KST
 */
async function startDaemon() {
  log(`🤖 [blogs 생활경제 자동화 스케줄러 데몬 가동]`);
  log(`- 점심 범위: 11:15 ~ 11:45 KST`);
  log(`- 저녁 범위: 18:15 ~ 18:45 KST`);

  let currentLunchTarget = getRandomTargetMinutes(11, 15, 11, 45);
  let currentEveningTarget = getRandomTargetMinutes(18, 15, 18, 45);
  let lastCheckedDay = '';

  const formatTarget = (t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
  log(`📅 오늘의 랜덤 목표 시간: 점심 ${formatTarget(currentLunchTarget)}, 저녁 ${formatTarget(currentEveningTarget)}`);

  while (true) {
    const { dateStr, hours, minutes } = getKSTDate();

    // 날짜가 바뀌면 새로운 랜덤 시간 배정
    if (lastCheckedDay !== dateStr) {
      currentLunchTarget = getRandomTargetMinutes(11, 15, 11, 45);
      currentEveningTarget = getRandomTargetMinutes(18, 15, 18, 45);
      lastCheckedDay = dateStr;
      log(`\n🌅 [새 날짜 감지: ${dateStr}] 새로운 랜덤 목표 배정:`);
      log(`- 점심: ${formatTarget(currentLunchTarget)} KST`);
      log(`- 저녁: ${formatTarget(currentEveningTarget)} KST`);
    }

    // 점심 타깃 시간 도달 확인
    if (hours === currentLunchTarget.hour && minutes === currentLunchTarget.minute) {
      await runPublishPipeline('lunch');
      await new Promise((r) => setTimeout(r, 65000)); // 중복 분 실행 방지
    }

    // 저녁 타깃 시간 도달 확인
    if (hours === currentEveningTarget.hour && minutes === currentEveningTarget.minute) {
      await runPublishPipeline('evening');
      await new Promise((r) => setTimeout(r, 65000)); // 중복 분 실행 방지
    }

    // 30초마다 체크
    await new Promise((r) => setTimeout(r, 30000));
  }
}

// CLI 진입점
const arg = process.argv[2];
if (arg === 'lunch' || arg === 'evening') {
  runPublishPipeline(arg).then((success) => process.exit(success ? 0 : 1));
} else if (arg === 'daemon') {
  startDaemon();
} else {
  console.log('사용법:');
  console.log('  node scripts/auto-publish-runner.mjs lunch    # 점심 세션 수동 실행');
  console.log('  node scripts/auto-publish-runner.mjs evening  # 저녁 세션 수동 실행');
  console.log('  node scripts/auto-publish-runner.mjs daemon   # 상시 스케줄러 데몬 가동');
}
