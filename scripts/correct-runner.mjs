#!/usr/bin/env node
/**
 * 발행 글 교정 자동화 러너 (Correct Runner · blog-post-correct 적용, 텔레그램 승인 게이트)
 * - 정오(12:00 KST) 검수: 당일 오전(morning) 발행분
 * - 자정(00:00 KST) 검수: 전일 저녁(evening) 발행분
 * - 위반 발견 시 텔레그램 리포트 + 인라인 버튼(수정 승인/반려) → 승인 시 자동 교정·빌드·D1 재발행·Git push
 *
 * 사용법:
 *   node scripts/correct-runner.mjs noon          # 정오 세션 감사·리포트
 *   node scripts/correct-runner.mjs midnight      # 자정 세션 감사·리포트
 *   node scripts/correct-runner.mjs audit <file>  # 지정 파일 감사·리포트 (재검수용)
 *   node scripts/correct-runner.mjs daemon        # 30초 루프 스케줄러 + 승인 폴링
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { sendTelegramReport } from './telegram-notify.mjs';

// 프로세스 무중단 방어 핸들러
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] 🚨 [uncaughtException 방어] ${err?.stack || err}`);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[${new Date().toISOString()}] 🚨 [unhandledRejection 방어] ${reason?.stack || reason}`);
});

// ===================== 프로젝트별 설정 =====================
const PROJECT = 'blogs';
const DISPLAY_NAME = '포켓머니(pockemoney) 생활경제 블로그 (blogs)';
const BLOG_ROOT = path.resolve(import.meta.dirname, '..');
const STATE_FILE = path.join(BLOG_ROOT, 'data', 'correct-state.json');
const LOG_FILE = path.join(BLOG_ROOT, 'data', 'correct.log');
const LOCK_FILE = path.join(BLOG_ROOT, 'data', 'correct.lock');
const APPROVAL_FILE = path.join(BLOG_ROOT, 'data', 'correct-approval.json');
const PUBLISH_STATE_FILE = path.join(BLOG_ROOT, 'data', 'auto-publish-state.json');

const OPENCODE_BIN = '/root/.opencode/bin/opencode';
const NODE22_BIN = '/opt/node22/bin';
const NOON_PUBLISH_SESSIONS = ['lunch'];   // 정오 검수 대상 (당일 오전 발행)
const MIDNIGHT_PUBLISH_SESSIONS = ['evening']; // 자정 검수 대상 (전일 저녁 발행)
const VALID_CATEGORIES = ['welfare', 'tax', 'finance', 'saving', 'subsidy', 'life-tips'];
// ===========================================================

function log(...args) {
  const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (_) {}
}

function loadState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
      log('교정 상태 파일 읽기 실패, 초기화합니다:', e.message);
    }
  }
  const initial = { last_updated: new Date().toISOString(), last_run: { noon: null, midnight: null }, pending: [], history: [] };
  saveState(initial);
  return initial;
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  state.last_updated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

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
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    now,
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hours: parseInt(parts.hour, 10),
    minutes: parseInt(parts.minute, 10),
    timeStr: `${parts.hour}:${parts.minute}`,
  };
}

function prevKSTDateStr(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function buildEnv() {
  const env = { ...process.env };
  const envPath = path.join(BLOG_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      if (env[key]) continue;
      env[key] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  env.PATH = [NODE22_BIN, path.join(BLOG_ROOT, 'node_modules', '.bin'), env.PATH].filter(Boolean).join(':');
  return env;
}

function safeExec(cmd, opts = {}) {
  try {
    const out = execSync(cmd, {
      cwd: BLOG_ROOT,
      env: buildEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 900000,
      ...opts,
    });
    return { ok: true, out: String(out || '') };
  } catch (err) {
    return { ok: false, out: String(err.stdout || ''), error: err.stderr?.toString().trim() || err.message };
  }
}

// frontmatter의 slug를 읽음 (없으면 null)
function slugFromFrontmatter(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 800);
    const m = head.match(/^slug:\s*["']?([^"'\n]+)["']?/m);
    return m ? m[1].trim() : null;
  } catch (_) {
    return null;
  }
}

// 위치 찾기: slug frontmatter와 일치하는 발행 포스트 파일
function findPostFile(slug) {
  const postsDir = path.join(BLOG_ROOT, 'content', 'posts');
  if (!fs.existsSync(postsDir)) return null;
  for (const f of fs.readdirSync(postsDir)) {
    if (!f.endsWith('.md') || f === 'template.md') continue;
    const head = fs.readFileSync(path.join(postsDir, f), 'utf8').slice(0, 800);
    const m = head.match(/^slug:\s*["']?([^"'\n]+)["']?/m);
    if (m && m[1].trim() === slug) return path.join(postsDir, f);
  }
  return null;
}

// 검수 대상 추출 (발행 러너 state 기반, 미검수 건만)
function findTargetPosts(sessionKey, state) {
  const { dateStr } = getKSTDate();
  const sessions = sessionKey === 'noon' ? NOON_PUBLISH_SESSIONS : MIDNIGHT_PUBLISH_SESSIONS;
  const targetDate = sessionKey === 'noon' ? dateStr : prevKSTDateStr(dateStr);

  let pState = { history: [] };
  if (fs.existsSync(PUBLISH_STATE_FILE)) {
    try { pState = JSON.parse(fs.readFileSync(PUBLISH_STATE_FILE, 'utf8')); } catch (_) {}
  }
  const doneKeys = new Set(
    (state.history || [])
      .filter((h) => ['clean', 'fixed', 'rejected'].includes(h.status))
      .map((h) => `${h.session}|${h.slug}`)
  );
  const candidates = (pState.history || []).filter(
    (h) => h.status === 'success' && h.slug && sessions.includes(h.session) && h.date === targetDate
  );
  const posts = [];
  for (const h of candidates) {
    if (doneKeys.has(`${sessionKey}|${h.slug}`)) continue;
    const file = findPostFile(h.slug);
    if (file) posts.push({ slug: h.slug, file, publishSession: h.session, date: targetDate });
  }
  return posts;
}

// ===================== 정적 스캔 =====================
const CLICHE_RULES = [
  { type: '클리셰(인트로)', rx: /(?:에\s*대해\s*알아보겠습니다|알아보도록\s*하겠습니다|살펴보(?:도록\s*)?하겠습니다|살펴보겠습니다)/g },
  { type: '클리셰(정리)', rx: /(?:정리해\s+드리겠|정리해\s+드리니|정리하도록\s+하겠|정리해\s+보도록\s+하겠|정리해\s+드립니다)/g },
  { type: '클리셰(안내)', rx: /(?:완벽하게\s*안내|안내해\s*드리겠|차근차근\s*안내)/g },
  { type: '클리셰(마무리)', rx: /(?:도움이\s+되(?:시)?(?:었|ㄹ)기를\s+바랍니다|도움이\s+되시길\s+바랍니다)/g },
  { type: '클리셰(헤딩)', rx: /^#{1,3}\s*(?:들어가며|서론|결론|마치며)\s*$/m },
];

function collectMatches(raw, rx, type, lines, out) {
  rx.lastIndex = 0;
  let m;
  while ((m = rx.exec(raw)) !== null) {
    const lineNo = raw.slice(0, m.index).split('\n').length;
    out.push({
      type,
      line: lineNo,
      text: m[0].slice(0, 80),
      suggestion: type.includes('헤딩') ? '헤딩을 내용 지향적 제목으로 교체 (알아보겠습니다류 금지)'
        : type.includes('금액') ? '숫자와 단위를 붙여 표기 (예: 70만원, 5,000만원)'
        : '상투적 표현을 사실·결과 중심 문장으로 대체',
    });
    if (out.length >= 12) break;
  }
}

function staticScan(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const out = [];
  const norm = raw.replace(/`[^`\n]*`/g, ' ');

  for (const rule of CLICHE_RULES) {
    collectMatches(norm, rule.rx, rule.type, lines, out);
  }

  const moneyRx = /(?:\d[\d,]*(?:\.\d+)?\s+(?:만|억)\s*원)|(?:\d[\d,]*(?:\.\d+)?(?:만|억)\s+원)/g;
  collectMatches(raw, moneyRx, '금액 띄어쓰기', lines, out);

  const linkRx = /\(\s*\/posts\/[^)\n]{0,200}\)/g;
  collectMatches(raw, linkRx, '링크 경로(/posts/)', lines, out);

  const catMatch = raw.match(/^category:\s*["']?([^"'\n]+)["']?/m);
  const catVal = catMatch ? catMatch[1].trim() : null;
  if (!catVal || !VALID_CATEGORIES.includes(catVal)) {
    out.push({
      type: '카테고리 slug',
      line: catMatch ? lines.length : 1,
      text: `category: ${catVal || '(없음)'}`,
      suggestion: `허용 목록(${VALID_CATEGORIES.join(', ')}) 중 하나로 교체`,
    });
  }

  return out.slice(0, 12);
}

// ===================== 심층 감사 (opencode · blog-post-correct) =====================
// opencode/에이전트 모델 실행용 env: Cloudflare 크레덴셜을 제외해야
// opencode가 CF Gateway 라우팅 모델을 오인 선택하지 않는다 (CLOUDFLARE_GATEWAY_ID 부재 시 오류 방지)
function opencodeEnv() {
  const env = { ...process.env };
  for (const key of [
    'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID',
    'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'GITHUB_TOKEN',
  ]) {
    delete env[key];
  }
  env.PATH = [NODE22_BIN, path.join(BLOG_ROOT, 'node_modules', '.bin'), env.PATH].filter(Boolean).join(':');
  return env;
}

function runOpenCode(args, timeoutMs = 900000) {
  return execFileSync(OPENCODE_BIN, args, {
    cwd: BLOG_ROOT,
    env: opencodeEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function parseReviewResult(out) {
  const m = out.match(/##\s*REVIEW_RESULT\s*\n?([\s\S]*)$/);
  if (!m) return [];
  const jsonStr = m[1].replace(/```(?:json)?/gi, '').trim();
  const start = jsonStr.indexOf('[');
  const end = jsonStr.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const list = JSON.parse(jsonStr.slice(start, end + 1));
    if (!Array.isArray(list)) return [];
    return list.filter((i) => i && typeof i === 'object').map((i) => ({
      type: String(i.type || '기타').slice(0, 40),
      line: typeof i.line === 'number' ? i.line : 0,
      text: String(i.text || '').slice(0, 120),
      suggestion: String(i.suggestion || '').slice(0, 160),
    }));
  } catch (_) {
    return [];
  }
}

function mergeViolations(staticV, deepV) {
  const seen = new Set();
  const merged = [];
  for (const v of [...staticV, ...deepV]) {
    const key = `${v.type}|${v.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(v);
  }
  return merged;
}

async function deepAudit(file, slug, sessionKey, date) {
  const prompt = `당신은 블로그 글 품질 감사 AI입니다. 'blog-post-correct' 스킬을 로드하여 아래 작업을 수행합니다.

대상 파일: ${file}
전체 위반 규칙은 스킬의 '클리셰 킬 리스트'와 '검수 가이드라인'을 따릅니다.

절대 조건:
1. 파일을 수정하면 안 됩니다. 읽기와 (필요 시) 웹 검색만 수행합니다.
2. 다음 6개 항목을 점검하세요:
   (1) 클리셰/상투어: '~에 대해 알아보겠습니다', '정리해 드리겠습니다', '완벽하게 안내해 드리겠습니다', '도움이 되셨기를 바랍니다', '들어가며/마치며' 류 및 스킬 킬 리스트의 모든 표현
   (2) 금액·숫자 띄어쓰기: '70만원', '5,000만원', '2.4억원'처럼 붙여 쓰기 규범 위반
   (3) '/posts/'로 잘못 남은 내부 링크 (올바른 경로는 '/blog/')
   (4) 카테고리 slug 유효성
   (5) 보안 위험: 절대경로·서버 IP·계정 정보 노출 등
   (6) 본문에 실사용 로그로 오인될 수 있는 예시 로그 표기
3. 팩트 검증: 본문의 주요 수치·조건이 실제 제도/기술 사실과 모순되는지 웹 검색으로 교차 확인하고, 확실한 모순만 표시하세요.
4. 위반이 없으면 빈 배열을 출력합니다.

응답 형식(반드시 마지막 응답에서 정확히 한 번만, 이 구분자 뒤에 JSON 배열):
## REVIEW_RESULT
[{"type":"유형","line":줄번호,"text":"원문 발췌","suggestion":"수정 제안"}]`;

  try {
    const out = runOpenCode(['run', '--agent', 'build', '--dir', BLOG_ROOT, '--auto', prompt], 900000);
    const violations = parseReviewResult(out);
    const reportFile = path.join(BLOG_ROOT, 'data', `review-report-${slug}.json`);
    fs.writeFileSync(reportFile, JSON.stringify({ slug, file, session: sessionKey, date, deep: violations }, null, 2), 'utf8');
    return { reportFile, violations };
  } catch (err) {
    log(`⚠️ 심층 감사 실패(${slug}):`, err.message);
    return { reportFile: null, violations: [] };
  }
}

// ===================== 리포트 발송 =====================
function reviewLabel(sessionKey) {
  return sessionKey === 'noon' ? '정오 검수(오전 발행분)' : '자정 검수(오후 발행분)';
}

async function sendReviewReport(target, violations) {
  const items = violations
    .slice(0, 10)
    .map((v, i) => `*${i + 1}.* ${v.type}${v.line ? ` (L${v.line})` : ''}\n   ⤷ "${v.text}"\n   ➜ ${v.suggestion}`)
    .join('\n');

  const msg = `🔍 *[${DISPLAY_NAME} 글 검수]*
📌 *구분:* ${reviewLabel(target.session)}
🗓️ *발행일:* ${target.date} · *세션:* ${target.publishSession}
📄 *파일:* ${path.basename(target.file)}
🔗 *slug:* ${target.slug}

⚠️ *발견 위반 ${violations.length}건:*
${items}

👆 아래 버튼으로 *승인* 또는 *반려*를 선택해 주세요.
(승인 시 자동 교정 → 빌드 검증 → D1 재발행 → Git push까지 진행됩니다.)`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '❌ 반려', callback_data: `correct_r_${PROJECT}_${target.slug}` },
        { text: '✅ 승인', callback_data: `correct_a_${PROJECT}_${target.slug}` },
      ],
    ],
  };
  return await sendTelegramReport(msg, { reply_markup: replyMarkup });
}

// ===================== 검수 실행 =====================
function recordHistory(state, rec, status, extra = {}) {
  state.history = state.history || [];
  state.history.push({ slug: rec.slug, file: rec.file, session: rec.session, publish_session: rec.publishSession, date: rec.date, status, at: new Date().toISOString(), ...extra });
}

async function runReview(sessionKey) {
  const state = loadState();
  const targets = findTargetPosts(sessionKey, state);
  log(`🔍 [${PROJECT}] ${reviewLabel(sessionKey)} 시작 — 검수 대상 ${targets.length}건`);
  if (targets.length === 0) {
    log(`📭 검수 대상 없음 (발행 내역 없음 또는 이미 검수 완료)`);
    return;
  }
  for (const target of targets) {
    const staticV = staticScan(target.file);
    const { reportFile, violations: deepV } = await deepAudit(target.file, target.slug, sessionKey, target.date);
    const combined = mergeViolations(staticV, deepV);
    log(`📄 ${target.slug}: 정적 ${staticV.length}건, 심층 ${deepV.length}건, 전체 ${combined.length}건`);

    const rec = {
      slug: target.slug,
      file: target.file,
      report_file: reportFile,
      session: sessionKey,
      publishSession: target.publishSession,
      date: target.date,
    };

    if (combined.length === 0) {
      recordHistory(state, rec, 'clean');
      saveState(state);
      log(`✅ ${target.slug} 클린 (수정 불필요)`);
      continue;
    }

    state.pending = (state.pending || []).filter((p) => p.slug !== target.slug);
    state.pending.push({ ...rec, sent_at: new Date().toISOString() });
    recordHistory(state, rec, 'pending');
    saveState(state);

    const sent = await sendReviewReport(target, combined);
    log(sent ? `📨 검수 리포트 발송 완료 (${target.slug}, 대기 중)` : `⚠️ 텔레그램 전송 실패 (${target.slug})`);
  }
}

// ===================== 승인 처리 / 수정 파이프라인 =====================
function gitStatusFor(relFile) {
  const r = safeExec(`git status --porcelain -- "${relFile}"`);
  return r.ok ? r.out.trim() : '';
}

async function runFixFlow(rec) {
  log(`🔧 [${PROJECT}] 수정 승인 접수 → 교정 파이프라인 시작 (${rec.slug})`);
  const prompt = `당신은 블로그 글 교정 AI입니다. 'blog-post-correct' 스킬을 로드합니다.

대상 파일: ${rec.file}
교정 기준(레포트): ${rec.report_file || '(없음)'} 에 나열된 위반 사항.

절대 조건:
1. 레포트에 나열된 위반 항목만 수정합니다. 그 외 임의 수정 금지.
2. 클리셰는 스킬 지침에 따라 에디터다운 자연스러운 문장으로 대체하고, 금액 띄어쓰기 규범(70만원/5,000만원/2.4억원)을 적용하며, 내부 링크는 '/posts/' → '/blog/'로 교정합니다. 확실한 팩트 오류 수치만 고치고 임의 숫자 변경 금지.
3. frontmatter의 title/description/category/slug 등 메타데이터도 위반에 해당하면 함께 수정합니다.
4. 아래 명령은 절대 실행하지 마세요: scripts/publish-post.mjs, publish-post, npm run build, npm, git, wrangler, d1, R2, cloudflare, workers 배포.
5. 변경 완료 후 수정한 항목 목록을 5줄 이내로 마지막에 출력하세요.`;

  const state = loadState();
  const relFile = path.relative(BLOG_ROOT, rec.file);

  try {
    runOpenCode(['run', '--agent', 'build', '--dir', BLOG_ROOT, '--auto', prompt], 1200000);
  } catch (err) {
    log(`❌ 교정 실행 실패(${rec.slug}):`, err.message);
    state.pending = (state.pending || []).filter((p) => p.slug !== rec.slug);
    recordHistory(state, rec, 'failed', { error: `교정 실행 실패: ${err.message}` });
    saveState(state);
    await sendTelegramReport(`⚠️ *[${DISPLAY_NAME} 교정 실패]*\n\n🔗 slug: ${rec.slug}\n❌ 교정 실행 중 오류: ${err.message}`);
    return;
  }

  if (!gitStatusFor(relFile)) {
    log(`ℹ️ ${rec.slug} 교정 실행 후 변경 없음`);
    state.pending = (state.pending || []).filter((p) => p.slug !== rec.slug);
    recordHistory(state, rec, 'rejected', { error: '교정 결과 변경 없음 (자동 반려)' });
    saveState(state);
    await sendTelegramReport(`ℹ️ *[${DISPLAY_NAME} 교정]*\n\n🔗 slug: ${rec.slug}\n교정 실행 결과 변경 사항이 없어 반려 처리했습니다.`);
    return;
  }

  // 빌드 검증 → 실패 시 push 금지
  const build = safeExec('npm run build');
  if (!build.ok) {
    log(`❌ 빌드 실패(${rec.slug}):`, build.error);
    state.pending = (state.pending || []).filter((p) => p.slug !== rec.slug);
    recordHistory(state, rec, 'failed', { error: `빌드 실패: ${build.error?.slice(0, 300)}` });
    saveState(state);
    await sendTelegramReport(`⛔ *[${DISPLAY_NAME} 교정 중단] 빌드 실패*\n\n🔗 slug: ${rec.slug}\n파일은 수정된 채로 남아 있습니다. 수동 검토 부탁드립니다.\n\`\`\`${(build.error || '').slice(0, 500)}\`\`\``);
    return;
  }

  // D1 재발행
  const publish = safeExec(`node scripts/publish-post.mjs "${rec.file}"`, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (!publish.ok) {
    log(`❌ D1 재발행 실패(${rec.slug}):`, publish.error);
    state.pending = (state.pending || []).filter((p) => p.slug !== rec.slug);
    recordHistory(state, rec, 'failed', { error: `D1 재발행 실패: ${publish.error?.slice(0, 300)}` });
    saveState(state);
    await sendTelegramReport(`⛔ *[${DISPLAY_NAME} 교정 중단] D1 재발행 실패*\n\n🔗 slug: ${rec.slug}\n\`\`\`${(publish.error || '').slice(0, 500)}\`\`\``);
    return;
  }

  // Git 커밋 & push (자동 발행 러너와 동일한 안전 순서)
  let pushMsg = '';
  try {
    const filesToStage = [relFile];
    if (fs.existsSync(STATE_FILE)) filesToStage.push('data/correct-state.json');
    safeExec(`git add ${filesToStage.map((f) => `"${f}"`).join(' ')}`);
    safeExec(`git commit -m "fix(post): 자동 교정 [${rec.session}] ${rec.slug}"`);
    safeExec('git pull --rebase origin main');
    const push = safeExec('git push origin main');
    const hash = execSync('git rev-parse --short HEAD', { cwd: BLOG_ROOT }).toString().trim();
    pushMsg = `🔄 Git push: OK (${hash})`;
    log(`📦 push 완료 (${hash})`);
  } catch (gitErr) {
    log(`⚠️ GitHub push 경고 (D1 배포는 정상):`, gitErr.message);
    pushMsg = '⚠️ Git push 경고 (로컬 커밋됨)';
  }

  state.pending = (state.pending || []).filter((p) => p.slug !== rec.slug);
  recordHistory(state, rec, 'fixed', { note: pushMsg });
  saveState(state);

  await sendTelegramReport(`✅ *[${DISPLAY_NAME} 교정 완료]*
🔗 slug: ${rec.slug}
📄 파일: ${path.basename(rec.file)}
⚙️ 빌드: PASS · 🗄️ D1 재발행: OK · ${pushMsg}`);
  log(`✅ ${rec.slug} 교정·배포 완료`);
}

function processApprovalFile() {
  if (!fs.existsSync(APPROVAL_FILE)) return;
  const raw = fs.readFileSync(APPROVAL_FILE, 'utf8');
  try { fs.unlinkSync(APPROVAL_FILE); } catch (_) {}

  let approval;
  try { approval = JSON.parse(raw); } catch (_) { return; }
  if (!approval || !approval.slug) return;

  const state = loadState();
  const rec = (state.pending || []).find((p) => p.slug === approval.slug);
  if (!rec) {
    log(`⚠️ 승인 요청이 접수되었지만 대기 중인 검수 건이 없습니다: ${approval.slug}`);
    sendTelegramReport(`⚠️ *[${DISPLAY_NAME} 승인 처리]*\n\n🔗 slug: ${approval.slug}\n대기 중인 검수 건을 찾을 수 없습니다 (이미 처리되었거나 만료).`);
    return;
  }

  if (approval.action === 'reject') {
    log(`❌ 반려 처리 (${approval.slug})`);
    state.pending = (state.pending || []).filter((p) => p.slug !== approval.slug);
    recordHistory(state, rec, 'rejected', { decided_by: approval.chat_id });
    saveState(state);
    sendTelegramReport(`❌ *[${DISPLAY_NAME} 교정 반려]*\n\n🔗 slug: ${approval.slug}\n수정 없이 반려 처리했습니다. 다음 검수 사이클에서 다시 제안됩니다.`);
    return;
  }

  // approve → 수정 파이프라인
  runFixFlow(rec).catch(async (e) => {
    log(`❌ 수정 파이프라인 예외(${rec.slug}):`, e.message);
    await sendTelegramReport(`⚠️ *[${DISPLAY_NAME} 교정 오류]*\n\n🔗 slug: ${rec.slug}\n${e.message}`);
  });
}

// ===================== 단일 인스턴스 락 =====================
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (pid && pid > 0) {
        try { process.kill(pid, 0); return false; } catch (_) {}
      }
      try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
    return true;
  } catch (_) { return false; }
}

function releaseLock() {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch (_) {}
}

// ===================== 데몬 스케줄러 =====================
async function startDaemon() {
  log(`🤖 [${PROJECT}] 교정 스케줄러 데몬 가동`);
  log(`- 정오: 12:00~12:05 KST (당일 오전 발행분 검수)`);
  log(`- 자정: 00:00~00:05 KST (전일 저녁 발행분 검수)`);
  log(`- 텔레그램 승인 폴링: 30초 간격`);

  while (true) {
    try {
      processApprovalFile();
    } catch (e) {
      log(`🚨 승인 처리 예외:`, e.message);
    }

    const { dateStr, hours, minutes } = getKSTDate();
    const state = loadState();

    if (hours === 12 && minutes <= 5 && state.last_run.noon !== dateStr) {
      if (acquireLock()) {
        state.last_run.noon = dateStr;
        saveState(state);
        try { await runReview('noon'); } catch (e) { log(`🚨 정오 검수 예외:`, e.message); }
        releaseLock();
      }
    }
    if (hours === 0 && minutes <= 5 && state.last_run.midnight !== dateStr) {
      if (acquireLock()) {
        state.last_run.midnight = dateStr;
        saveState(state);
        try { await runReview('midnight'); } catch (e) { log(`🚨 자정 검수 예외:`, e.message); }
        releaseLock();
      }
    }

    await new Promise((r) => setTimeout(r, 30000));
  }
}

// ===================== CLI 진입점 =====================
const arg = process.argv[2];

if (arg === 'noon' || arg === 'midnight') {
  if (!acquireLock()) {
    console.log('⚠️ 다른 교정 작업이 실행 중입니다. 잠시 후 다시 시도하세요.');
    process.exit(1);
  }
  runReview(arg)
    .then(() => { releaseLock(); process.exit(0); })
    .catch((e) => { releaseLock(); console.error(e); process.exit(1); });
} else if (arg === 'audit') {
  const fileArg = process.argv[3];
  if (!fileArg) { console.log('사용법: node scripts/correct-runner.mjs audit <markdown-file>'); process.exit(1); }
  if (!acquireLock()) { console.log('⚠️ 다른 교정 작업이 실행 중입니다.'); process.exit(1); }
  const resolved = path.isAbsolute(fileArg) ? fileArg : path.join(BLOG_ROOT, fileArg);
  const { dateStr } = getKSTDate();
  const slug = slugFromFrontmatter(resolved) || path.basename(resolved, '.md');
  const target = { slug, file: resolved, publishSession: 'manual', date: dateStr, session: 'noon' };
  (async () => {
    const staticV = staticScan(resolved);
    const { reportFile, violations: deepV } = await deepAudit(resolved, target.slug, 'noon', dateStr);
    const combined = mergeViolations(staticV, deepV);
    log(`📄 ${target.slug}: 정적 ${staticV.length}건, 심층 ${deepV.length}건, 전체 ${combined.length}건`);
    if (combined.length === 0) {
      log(`✅ ${target.slug} 클린`);
      return;
    }
    const state = loadState();
    target.report_file = reportFile;
    state.pending = (state.pending || []).filter((p) => p.slug !== target.slug);
    state.pending.push({ ...target, sent_at: new Date().toISOString() });
    saveState(state);
    const sent = await sendReviewReport(target, combined);
    log(sent ? `📨 검수 리포트 발송 완료 (${target.slug})` : `⚠️ 텔레그램 전송 실패`);
  })()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => releaseLock());
} else if (arg === 'daemon') {
  startDaemon();
} else {
  console.log(`사용법:
  node scripts/correct-runner.mjs noon       # 정오 세션 감사·리포트
  node scripts/correct-runner.mjs midnight   # 자정 세션 감사·리포트
  node scripts/correct-runner.mjs audit <file>  # 지정 파일 감사·리포트
  node scripts/correct-runner.mjs daemon     # 상시 스케줄러 + 승인 폴링`);
}