#!/usr/bin/env node
/**
 * [SHARED] GitHub 자동 배포 트리거 (Commit -> Rebase -> Push)
 *
 * [왜 필요한가]
 * 기존 코드는 두 곳에서 동일한 결함을 가진다:
 *   auto-publish-runner.mjs : `git add` -> `git commit` -> `git pull --rebase`(catch 로 무음) -> `git push`
 *   generate-news-digest.mjs : 동일 구조
 * 그 결과:
 *   1) `data/auto-publish-state.json` 이 .gitignore 에 없어 dirty 상태로 남고,
 *      다음 세션의 `git pull --rebase` 가 "You have unstaged changes" 로 실패한다.
 *   2) 그 실패가 `catch (_) {}` 로 통째로 삼켜진 뒤 "🚀 GitHub Push 완료" 가 출력되어
 *      운영자가 실제 실패를認知하지 못한다. (로그 6건에서 재현)
 *   3) 데몬이 root 로 실행되고 저장소가 uid 1026 소유이면
 *      모든 git 호출이 `fatal: detected dubious ownership` 로 실패한다. (재현)
 *
 * [해결]
 *   - execFileSync(셸 없음) + safe.directory 주입으로 소유권/인젝션 문제 제거
 *   - rebase 실패를 절대 삼키지 않고 throw -> 텔레그램 경보가 실제로 울린다
 *   - 실패 시 git rebase --abort 로 저장소를 깨끗한 상태로 되돌린다
 *
 * [2026-09-29 추가 · GitHub 인증 전면 실패]
 *   당일 저녁 2건이 D1 등록까지 끝난 뒤 push 에서 죽었다.
 *     fatal: could not read Username for 'https://github.com': terminal prompts disabled
 *     remote: Invalid username or token.
 *   근본 원인: git 은 `env: { ...process.env }` 로 실행되지만,
 *   토큰을 담고 있는 .env 는 loadEnvConfig() 가 **로컬 객체**로만 파싱하고
 *   process.env 에는 쓰지 않는다. 전역 credential.helper 가 참조하는
 *   $GITHUB_TOKEN 이 비어 있어 빈 비밀번호가 전송되었다.
 *   (= 토큰이 유효한데도 실패하는, 조용하고 반복적인 결함)
 *
 *   조치:
 *   - git 은 더 이상 전역 환경변수에 의존하지 않는다. 토큰을 모듈이 직접
 *     .env 에서 읽어 GIT_ASKPASS 로 주입한다 (argv 에 노출되지 않음).
 *   - 깨진 전역 helper 는 `-c credential.helper=` 로 초기화해 우회한다.
 *   - publishPreflight() 로 세션 시작 시 인증을 먼저 검증해
 *     "D1 등록 후 push 실패" 로网站가 이전 빌드를 서빙하는 상황을 원천 차단.
 *
 * 공용 모듈: /workspace/projects/{blog,blogs}/scripts/lib/git-publish.mjs (동일 사본)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 120000;
const AUTH_RETRY = 3;

/** .env 파일에서 KEY=VALUE 를 읽는다 (process.env 는 건드리지 않음) */
function parseEnvFile(filePath) {
  const out = {};
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return out;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * GitHub 토큰을 모듈이 직접 확보한다.
 * 우선순위: process.env → 저장소 .env → /workspace/.env → /workspace/scripts/.env
 * (프로세스에 주입된 값이 데몬 기동 시점의 낡은 값일 수 있어 파일 값을 우선 보완)
 */
function resolveGithubToken(repoRoot) {
  const candidates = [
    process.env.GITHUB_TOKEN,
    repoRoot && parseEnvFile(path.join(repoRoot, '.env')).GITHUB_TOKEN,
    parseEnvFile('/workspace/.env').GITHUB_TOKEN,
    parseEnvFile('/workspace/scripts/.env').GITHUB_TOKEN,
  ];
  for (const c of candidates) {
    if (c && String(c).trim()) return String(c).trim();
  }
  return null;
}

const ASKPASS_SRC = `#!/bin/sh
case "$1" in
  *sername*) printf '%s\\n' "$GIT_ASKPASS_USERNAME" ;;
  *)         printf '%s\\n' "$GIT_ASKPASS_PASSWORD" ;;
esac
`;

let askpassPath = null;
function ensureAskpass() {
  if (askpassPath) return askpassPath;
  // PID 를 넣어 동시 실행되는 데몬끼리 경로가 겹치지 않게 한다
  const p = path.join(os.tmpdir(), `agy-git-askpass-${process.pid}.sh`);
  fs.writeFileSync(p, ASKPASS_SRC, { mode: 0o700 });
  try {
    fs.chmodSync(p, 0o700);
  } catch (_) {}
  askpassPath = p;
  return p;
}

/**
 * git 실행용 환경변수를 만든다.
 * GIT_ASKPASS 로 토큰을 직접 넘기고, GIT_TERMINAL_PROMPT=0 으로 프롬프트 대기를
 * 원천 봉쇄한다. 토큰은 argv 가 아닌 자식 프로세스 환경변수로만 전달된다.
 */
function buildGitEnv(repoRoot) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const token = resolveGithubToken(repoRoot);
  if (token) {
    env.GIT_ASKPASS = ensureAskpass();
    env.GIT_ASKPASS_USERNAME = 'x-access-token';
    env.GIT_ASKPASS_PASSWORD = token;
  }
  return env;
}

/**
 * 셸 없이 git 실행.
 * 데몬이 root 로 돌고 저장소가 다른 UID 소유일 때 생기는
 * `fatal: detected dubious ownership` 를 원천 차단한다.
 *
 * `credential.helper=` 로 전역 helper 목록을 초기화해, 환경변수에 의존하는
 * 깨진 helper 가 빈 비밀번호를 내보내는 경로를 제거한다.
 */
export function runGit(repoRoot, args, opts = {}) {
  const roots = new Set([repoRoot]);
  try {
    roots.add(fs.realpathSync(repoRoot));
  } catch (_) {}

  const safeDirs = [...roots].flatMap((r) => ['-c', `safe.directory=${r}`]);
  const noHelper = ['-c', 'credential.helper='];

  try {
    return execFileSync('git', [...safeDirs, ...noHelper, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: opts.timeout || GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildGitEnv(repoRoot),
    }).toString();
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    const stdout = (err.stdout || '').toString().trim();
    const reason = stderr || stdout || err.message;
    const e = new Error(`git ${args.join(' ')} 실패: ${reason}`);
    e.gitArgs = args;
    e.gitStderr = stderr;
    e.gitStatus = err.status;
    throw e;
  }
}

const AUTH_ERROR_HINTS = [
  'authentication failed',
  'invalid username or token',
  'could not read username',
  'terminal prompts disabled',
  'permission denied',
  '403',
  '401',
];

/** 실패가 인증/토큰 문제인지 판별한다 (네트워크 일시 오류와 구분) */
function isAuthFailure(err) {
  const text = `${err?.gitStderr || ''} ${err?.message || ''}`.toLowerCase();
  return AUTH_ERROR_HINTS.some((h) => text.includes(h));
}

/**
 * [세션 시작 전 인증 사전 점검]
 *
 * 목적: "D1 등록 성공 → GitHub push 실패" 로 사이트가 이전 빌드를 서빙하는
 * 상태를 만들지 않는다. 발행 작업에 착수하기 전에 원격 접근 권한부터 확인한다.
 *
 * @returns {{ ok: true } | { ok: false, error: string, hint: string }}
 */
export function publishPreflight(repoRoot, log = () => {}) {
  if (!resolveGithubToken(repoRoot)) {
    return {
      ok: false,
      error: 'GITHUB_TOKEN 을 찾을 수 없습니다',
      hint: '프로젝트 .env 또는 /workspace/.env 에 GITHUB_TOKEN 을 확인하세요.',
    };
  }

  try {
    // 가장 저렴한 원격 왕복. HEAD 가 없어도 인증 실패는 정상적으로 드러난다.
    runGit(repoRoot, ['ls-remote', '--exit-code', 'origin', 'HEAD'], { timeout: 30000 });
    log('✅ GitHub 인증 사전 점검 통과 (원격 접근 정상)');
    return { ok: true };
  } catch (err) {
    if (isAuthFailure(err)) {
      return {
        ok: false,
        error: `GitHub 인증 실패: ${err.gitStderr || err.message}`,
        hint:
          '토큰이 만료되었거나 스코프(repo)가 없습니다. ' +
          'https://github.com/settings/tokens 에서 ' +
          '"repo" 스코프를 가진 토큰을 발급받아 .env 의 GITHUB_TOKEN 을 갱신하세요.',
      };
    }
    return {
      ok: false,
      error: `원격 저장소 접근 실패: ${err.gitStderr || err.message}`,
      hint: '네트워크/DNS 문제일 수 있습니다. git ls-remote origin 을 직접 확인하세요.',
    };
  }
}

/**
 * 인증 실패에 한해 지수 백오프로 재시도한다.
 * (일시적인 네트워크 오류와 인증 실패를 구분하기 위해 authOnly 옵션 제공)
 */
export function runGitWithAuthRetry(repoRoot, args, opts = {}) {
  const retries = opts.retries ?? (opts.authOnly ? AUTH_RETRY : 0);
  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return runGit(repoRoot, args, opts);
    } catch (err) {
      lastErr = err;
      if (attempt > retries) break;
      if (opts.authOnly && !isAuthFailure(err)) break;
      const waitMs = 2000 * attempt;
      if (opts.log) opts.log(`⚠️ git ${args[0]} 실패 (${attempt}/${retries}회), ${waitMs}ms 후 재시도`);
      execFileSync('sleep', [String(waitMs / 1000)]);
    }
  }
  throw lastErr;
}

/** 워킹트리에 커밋되지 않은 변경이 있는지 확인 */
export function isWorkTreeDirty(repoRoot) {
  return runGit(repoRoot, ['status', '--porcelain']).trim().length > 0;
}

/** 아직 rebase 진행 중인지 확인 */
function isRebaseInProgress(repoRoot) {
  const gitDir = runGit(repoRoot, ['rev-parse', '--git-dir']).trim();
  const abs = path.isAbsolute(gitDir) ? gitDir : path.join(repoRoot, gitDir);
  return (
    fs.existsSync(path.join(abs, 'rebase-merge')) ||
    fs.existsSync(path.join(abs, 'rebase-apply')) ||
    fs.existsSync(path.join(abs, 'MERGE_HEAD'))
  );
}

/**
 * 커밋 -> rebase -> push 로 Workers 자동 배포를 트리거한다.
 *
 * @param {object}   p
 * @param {string}   p.repoRoot   저장소 루트
 * @param {string[]} p.paths      stage 대상 경로 (저장소 루트 기준, 존재하지 않으면 경고만)
 * @param {string}   p.message    커밋 메시지
 * @param {string}   [p.branch]   기본 'main'
 * @param {(msg: string) => void} [p.log]
 * @returns {{ committed: boolean, pushed: boolean, reason?: string }}
 */
export function gitPublish({ repoRoot, paths, message, branch = 'main', log = () => {} }) {
  // 0) 이전 실행이 rebase 도중 죽어 저장소가 묶여있는 경우를 먼저 복구한다
  if (isRebaseInProgress(repoRoot)) {
    log('⚠️ 미완료 rebase 상태 감지 → 되돌리고 재시도합니다.');
    try {
      runGit(repoRoot, ['rebase', '--abort']);
    } catch (err) {
      log(`⚠️ rebase --abort 실패: ${err.message}`);
      throw new Error(`저장소가 미완료 rebase 상태로 묶여 있습니다. 수동 확인 필요: ${repoRoot}`);
    }
  }

  // 1) 존재하는 stage 대상만 남긴다 (없던 경로로 인한 `pathspec did not match` 원천 차단)
  const existing = paths.filter((p) => fs.existsSync(path.resolve(repoRoot, p)));
  const missing = paths.filter((p) => !fs.existsSync(path.resolve(repoRoot, p)));
  if (missing.length) log(`ℹ️ stage 대상 중 존재하지 않아 제외: ${missing.join(', ')}`);

  let committed = false;
  if (existing.length) {
    runGit(repoRoot, ['add', '-A', '--', ...existing]);
    // porcelain 전체가 아니라 "스테이징된 변경"만으로 커밋 여부를 판단한다
    const staged = runGit(repoRoot, ['diff', '--cached', '--name-only']).trim();
    if (staged) {
      runGit(repoRoot, ['commit', '-m', message]);
      committed = true;
      log(`✅ 커밋 완료: ${staged.split('\n').length}개 파일`);
    } else {
      log('ℹ️ 스테이징된 변경이 없어 커밋을 건너뜁니다.');
    }
  }

  // 2) 원격 동기화 — 실패를 삼키지 않는다
  runGitWithAuthRetry(repoRoot, ['fetch', 'origin', branch], { timeout: 60000, authOnly: true, log });

  try {
    runGit(repoRoot, ['-c', 'rebase.autoStash=true', 'rebase', `origin/${branch}`]);
  } catch (err) {
    // 흔한 원인(미스테이징 파일)으로 인한 실패를 1회 복구 시도한다
    const dirty = isWorkTreeDirty(repoRoot);
    log(`⚠️ rebase 실패 (미커밋 변경 ${dirty ? '있음' : '없음'}): ${err.gitStderr || err.message}`);

    if (isRebaseInProgress(repoRoot)) {
      try {
        runGit(repoRoot, ['rebase', '--abort']);
      } catch (_) {}
    }

    // 상태 파일 등 런타임 산출물이 남아 있으면 격리 후 1회 재시도
    if (dirty) {
      try {
        runGit(repoRoot, ['reset', '--hard', 'HEAD']);
        log('ℹ️ 미커밋 변경을 리셋한 뒤 rebase를 1회 재시도합니다.');
        runGit(repoRoot, ['-c', 'rebase.autoStash=true', 'rebase', `origin/${branch}`]);
      } catch (retryErr) {
        if (isRebaseInProgress(repoRoot)) {
          try {
            runGit(repoRoot, ['rebase', '--abort']);
          } catch (_) {}
        }
        throw new Error(
          `원격 rebase 실패로 배포를 중단했습니다. 원격 반영 없이 로컬에만 반영됩니다. ` +
            `원인: ${retryErr.gitStderr || retryErr.message}`
        );
      }
    } else {
      throw new Error(
        `원격 rebase 충돌로 배포를 중단했습니다. 로컬 커밋은 보존되어 있습니다. ` +
          `원인: ${err.gitStderr || err.message}`
      );
    }
  }

  // 3) push — 인증 실패는 지수 백오프로 재시도하고, 그래도 실패하면
  //    어떤 경로로 토큰을 고쳐야 하는지 actionable 한 힌트를 함께 던진다.
  try {
    runGitWithAuthRetry(repoRoot, ['push', 'origin', branch], { timeout: 180000, authOnly: true, log });
  } catch (err) {
    if (isAuthFailure(err)) {
      throw new Error(
        `GitHub 인증으로 push 에 실패했습니다. D1/R2 등록은 완료되었으나 사이트는 이전 빌드를 서빙합니다. ` +
          `토큰이 만료되었거나 스코프(repo)가 없는지 확인하세요. 원인: ${err.gitStderr || err.message}`
      );
    }
    throw err;
  }

  if (!committed) {
    return { committed: false, pushed: true, reason: 'no-local-changes' };
  }
  return { committed: true, pushed: true };
}

export default gitPublish;
