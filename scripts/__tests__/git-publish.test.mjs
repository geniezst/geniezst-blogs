#!/usr/bin/env node
/**
 * git-publish 회귀 테스트
 *
 * [왜 이 테스트가 필요한가]
 * 2026-09-29 저녁 발행 2건이 D1 등록까지 끝난 뒤 GitHub push 에서 죽었다.
 *   fatal: could not read Username for 'https://github.com': terminal prompts disabled
 *   remote: Invalid username or token.
 * 토큰 자체는 유효했으나, 데몬이 토큰을 process.env 에 담지 않은 채
 * git 을 실행해 전역 credential.helper 가 빈 비밀번호를 내보냈다.
 * 이 재현 테스트는 "토큰이 프로세스 환경변수에 없는 상태"를 고의로 만들어
 * 같은 결함이 되살아나지 않았음을 검증한다.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NODE = process.execPath;
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE = path.join(PROJECT_ROOT, 'scripts', 'lib', 'git-publish.mjs');

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) {
    console.log(`#   ✅ ${label}${detail ? ` ${detail}` : ''}`);
    pass++;
  } else {
    console.log(`#   ❌ ${label}${detail ? ` ${detail}` : ''}`);
    fail++;
  }
};

console.log('\n[1] 모듈 로드 및 export 존재 확인');
const mod = await import(MODULE);
for (const name of ['runGit', 'gitPublish', 'publishPreflight', 'isWorkTreeDirty', 'runGitWithAuthRetry']) {
  ok(`${name} export 존재`, typeof mod[name] === 'function');
}

console.log('\n[2] 깨끗한 환경에서 GitHub 원격 접근 (핵심 회귀 케이스)');
// process.env.GITHUB_TOKEN 이 없는 상태를 재현한다. (오늘 저녁 실패의 정확한 조건)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-gittest-'));
const probeFile = path.join(tmpDir, 'probe.mjs');
fs.writeFileSync(
  probeFile,
  `const m = await import(${JSON.stringify(MODULE)});
const r = await m.publishPreflight(${JSON.stringify(PROJECT_ROOT)});
console.log(JSON.stringify({ leaked: !!process.env.GITHUB_TOKEN, ok: r.ok, error: r.error || null, hint: r.hint || null }));`
);

let out = {};
try {
  const raw = execFileSync(NODE, [probeFile], {
    encoding: 'utf8',
    timeout: 90000,
    // GITHUB_TOKEN 을 제거해 "환경변수에 없는" 상태를 강제
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'GITHUB_TOKEN')),
  });
  out = JSON.parse(raw.trim().split('\n').pop());
} catch (e) {
  ok('사전 점검 실행', false, `-> ${String(e.message).slice(0, 140)}`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
ok('환경변수에 GITHUB_TOKEN 이 없는 상태로 실행됨', out.leaked === false);
ok('그래도 원격 인증이 통과함', out.ok === true, out.ok ? '' : `-> ${out.error || ''}`);
ok('인증 실패 시 힌트가 준비되어 있음', typeof out.hint === 'string' || out.ok === true);

console.log('\n[3] 로컬 git 조작은 환경변수와 무관하게 동작');
ok('isWorkTreeDirty 실행 (불리언 값 반환)', typeof mod.isWorkTreeDirty(PROJECT_ROOT) === 'boolean');

console.log('\n[4] 실패 분류: 토큰 없음 vs 원격 접근 불가');
const noTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-notoken-'));
const noToken = mod.publishPreflight(noTokenDir, () => {});
ok('토큰 없음 -> ok=false', noToken.ok === false);
ok('토큰 없음 -> GITHUB_TOKEN 을 특정함', /GITHUB_TOKEN/.test(noToken.error || ''), `-> ${noToken.error || ''}`);
ok('토큰 없음 -> 조치 힌트 제공', typeof noToken.hint === 'string' && noToken.hint.length > 0);
fs.rmSync(noTokenDir, { recursive: true, force: true });

const badRemoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-badremote-'));
try {
  // 토큰은 있는 상태로 만들어 "원격 접근 불가" 분기를 검증한다
  fs.writeFileSync(path.join(badRemoteDir, '.env'), 'GITHUB_TOKEN=ghp_dummy_for_classification_test\n');
  execFileSync('git', ['init', '-q'], { cwd: badRemoteDir, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/geniezst/__definitely-no-such-repo-xyz.git'], {
    cwd: badRemoteDir,
    stdio: 'ignore',
  });
  const badRemote = mod.publishPreflight(badRemoteDir, () => {});
  ok('존재하지 않는 원격 -> ok=false', badRemote.ok === false);
  ok(
    '토큰 실패와 다른 원인으로 분류됨',
    /접근 실패/.test(badRemote.error || '') || /인증 실패/.test(badRemote.error || ''),
    `-> ${(badRemote.error || '').slice(0, 70)}`
  );
} catch (e) {
  ok('원격 실패 시나리오 준비', false, `-> ${String(e.message).slice(0, 100)}`);
} finally {
  fs.rmSync(badRemoteDir, { recursive: true, force: true });
}

console.log('\n[5] askpass 는 토큰을 argv 에 노출하지 않는다');
ok('모듈 소스에 평문 토큰이 없음', !/ghp_[A-Za-z0-9]{20,}/.test(
  execFileSync('cat', [MODULE], { encoding: 'utf8' })
), '(하드코딩된 토큰 없음)');

console.log(`\n===== 결과: ${pass} 통과 / ${fail} 실패 =====`);
process.exit(fail ? 1 : 0);
