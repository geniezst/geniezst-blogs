import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireSessionLock,
  markSessionCompleted,
  readLock,
  SESSION_LOCK_TTL_MS,
} from '../lib/runtime-lock.mjs';
import { isPlaceholderOrLogo } from '../lib/image-pipeline.mjs';
import { decodeEntities } from '../generate-news-digest.mjs';

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('  ✅', label, extra);
  } else {
    fail++;
    console.log('  ❌', label, extra);
  }
};

console.log('\n[1] runtime-lock.mjs 안정화 검증');
ok('SESSION_LOCK_TTL_MS 는 15분(900,000ms)', SESSION_LOCK_TTL_MS === 15 * 60 * 1000);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blogs-stabilization-test-'));

try {
  const dateStr = '2026-10-12';

  // 1-1. 죽은 프로세스(PID 미생존)가 잡은 락은 15분 TTL 이내라도 즉시 회수 후 획득
  const ttlLockFile = path.join(tmpDir, `session-morning-${dateStr}.lock`);
  fs.writeFileSync(ttlLockFile, JSON.stringify({
    pid: 987654,
    session: 'morning',
    date: dateStr,
    startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  }));
  const fiveMinAgo = (Date.now() - 5 * 60 * 1000) / 1000;
  fs.utimesSync(ttlLockFile, fiveMinAgo, fiveMinAgo);

  const ttlResult = acquireSessionLock(tmpDir, 'morning', dateStr);
  ok('15분 TTL 이내라도 미생존 PID 락은 즉시 회수 후 획득', ttlResult.acquired === true && ttlResult.alreadyHeld === false);
  ok('회수된 락 소유자가 현재 프로세스로 갱신됨', readLock(ttlLockFile)?.pid === process.pid);

  // 1-2. 0바이트 락 파일 30초 이내 생성 방어
  const zeroLockFile = path.join(tmpDir, `session-zerobyte-${dateStr}.lock`);
  fs.writeFileSync(zeroLockFile, '');
  const zeroResult = acquireSessionLock(tmpDir, 'zerobyte', dateStr);
  ok('0바이트 파일 30초 이내 생성 시 unlink 금지 및 거부', zeroResult.acquired === false);
  ok('0바이트 락 파일 유지됨', fs.existsSync(zeroLockFile));

  // 1-3. status === 'completed' 진입 거부
  const compLockFile = path.join(tmpDir, `session-evening-${dateStr}.lock`);
  fs.writeFileSync(compLockFile, JSON.stringify({ pid: 1234, session: 'evening', date: dateStr }));
  markSessionCompleted(compLockFile, { slug: 'test-completed-post' });

  const compRead = readLock(compLockFile);
  ok('markSessionCompleted 로 status: completed 기록됨', compRead?.status === 'completed');
  ok('completedAt 필드 존재', Boolean(compRead?.completedAt));

  const compResult = acquireSessionLock(tmpDir, 'evening', dateStr);
  ok('status === "completed" 락은 무조건 진입 거부', compResult.acquired === false);
  ok('completed 락 파일 유지됨', fs.existsSync(compLockFile));

  console.log('\n[2] image-pipeline.mjs 단어 경계 정규식 검증');
  // 보도사진 / 기술단어 오탐 방지: 단어 경계가 아닐 때는 통과해야 함
  ok('circuit_board.jpg 통과 (circuit 내부 ci 오탐 방지)', !isPlaceholderOrLogo('https://cdn.example.com/circuit_board.jpg'));
  ok('fbi_agent.jpg 통과 (fbi 내부 bi 오탐 방지)', !isPlaceholderOrLogo('https://cdn.example.com/fbi_agent.jpg'));
  ok('participate_event.jpg 통과 (participate 내부 ci 오탐 방지)', !isPlaceholderOrLogo('https://cdn.example.com/participate_event.jpg'));
  ok('mobile_data.jpg 통과', !isPlaceholderOrLogo('https://cdn.example.com/mobile_data.jpg'));

  // 명백한 CI/BI/로고/기본 이미지는 기각되어야 함
  ok('company_ci.jpg 기각 (단어 경계 _ci)', isPlaceholderOrLogo('https://cdn.example.com/company_ci.jpg'));
  ok('ci_header.png 기각 (단어 경계 ci_)', isPlaceholderOrLogo('https://cdn.example.com/ci_header.png'));
  ok('brand_bi.jpg 기각 (단어 경계 _bi)', isPlaceholderOrLogo('https://cdn.example.com/brand_bi.jpg'));
  ok('bi_intro.png 기각 (단어 경계 bi_)', isPlaceholderOrLogo('https://cdn.example.com/bi_intro.png'));
  ok('site_logo.png 기각 (단어 경계 logo)', isPlaceholderOrLogo('https://cdn.example.com/site_logo.png'));
  ok('default_thumb.jpg 기각 (단어 경계 default)', isPlaceholderOrLogo('https://cdn.example.com/default_thumb.jpg'));

  console.log('\n[3] generate-news-digest.mjs HTML 엔티티 및 URL 정제 검증');
  const dirtyUrl = 'https://news.example.com/view.php?id=123&amp;type=main&amp;ref=portal';
  const cleanUrl = decodeEntities(dirtyUrl);
  ok('decodeEntities 로 &amp; -> & 정상 변환', cleanUrl === 'https://news.example.com/view.php?id=123&type=main&ref=portal');

  // data-src / data-original 파싱 정규식 검증
  const sampleHtml = `
    <div class="article-body">
      <img src="/placeholder.gif" data-src="https://img.news.com/photo/2026/01/main.jpg" alt="main" />
      <img data-original="https://img.news.com/upload/2026/01/sub.jpg" src="/blank.png" alt="sub" />
    </div>
  `;
  const extracted = [];
  for (const m of sampleHtml.matchAll(/<img\b([^>]+)>/gi)) {
    const tagAttrs = m[1];
    for (const attrMatch of tagAttrs.matchAll(/\b(?:src|data-src|data-original|data-lazy-src)=["']([^"']+)["']/gi)) {
      const srcVal = attrMatch[1];
      if (srcVal && /attaches|orgPhoto|photo|upload|news\/thumbnail|media/i.test(srcVal)) {
        extracted.push(srcVal);
      }
    }
  }
  ok('data-src 속성 이미지 추출', extracted.includes('https://img.news.com/photo/2026/01/main.jpg'));
  ok('data-original 속성 이미지 추출', extracted.includes('https://img.news.com/upload/2026/01/sub.jpg'));

  console.log('\n[4] auto-publish-runner.mjs 소스 코드 정적 무결성 검증');
  const runnerSrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'auto-publish-runner.mjs'), 'utf8');

  ok('isTTY 확인을 통한 로그 이중 쓰기 방지 코드 포함', runnerSrc.includes('process.stdout.isTTY'));
  ok('세션 진입 시 in_progress 상태 기록 코드 포함', runnerSrc.includes("status = 'in_progress'"));
  ok('발행 완료 시 markSessionCompleted 호출 코드 포함', runnerSrc.includes('markSessionCompleted(sessionLock.lockFile'));
  ok('일일 랜덤 목표 시간 영속화 함수 getOrAssignTargets 포함', runnerSrc.includes('getOrAssignTargets('));
  ok('QUALITY_GATE MIN_H2 기준값이 4로 설정됨', runnerSrc.includes('MIN_H2: 4'));
  ok('QUALITY_GATE MAX_LLM_RETRY 가 2회로 설정됨', runnerSrc.includes('MAX_LLM_RETRY: 2'));
  ok('프롬프트 H2 최소 기준이 4개 이상으로 명시됨', runnerSrc.includes('H2 최소 4개 이상 필수 구성'));
  ok('프롬프트 마크다운 표 템플릿의 백틱 이스케이프 정상 적용', runnerSrc.includes('\\`| 항목 | 기준 | 내용 |\\`'));
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n===== 결과: ${pass} 통과 / ${fail} 실패 =====`);
process.exit(fail ? 1 : 0);
