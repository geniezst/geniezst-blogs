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
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
      log('상태 파일 읽기 실패, 초기화합니다:', e.message);
    }
  }
  return {
    last_updated: new Date().toISOString(),
    category_counts: Object.fromEntries(ALL_CATEGORIES.map((c) => [c, 0])),
    last_session: null,
    history: [],
  };
}

/**
 * 상태 파일 저장
 */
function saveState(state) {
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

  let generatedSlug = '';
  let generatedTitle = '';

  try {
    // 3. Antigravity AI를 통한 생활경제 고품질 글 작성
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
  3. [데이터 시각화 차트 필수] 의미 없는 단순 AI 이미지 생성 대신, 글 내용의 핵심 수치를 요약하는 반응형 차트(원형/도넛 또는 막대 그래프)를 본문 중간에 최소 1개 이상 HTML/SVG 구조로 반드시 포함하세요.
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

    // 6. GitHub commit & push (Cloudflare Workers 자동 배포)
    log(`📦 GitHub main에 커밋 및 푸시하여 Workers 배포를 트리거합니다...`);
    try {
      execSync(`git pull --rebase origin main`, { cwd: BLOG_ROOT });
    } catch (_) {}
    execSync(`git add content/posts/ data/auto-publish-state.json`, { cwd: BLOG_ROOT });
    execSync(`git commit -m "feat(post): auto publish [${sessionName}] ${generatedSlug}"`, { cwd: BLOG_ROOT });
    execSync(`git push origin main`, { cwd: BLOG_ROOT });

    // 7. 상태 파일 갱신
    state.category_counts[category] = (state.category_counts[category] || 0) + 1;
    state.last_session = sessionName;
    state.history.push({
      date: dateStr,
      session: sessionName,
      time: timeStr,
      category,
      title: generatedTitle,
      slug: generatedSlug,
      status: 'success',
    });
    saveState(state);

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
