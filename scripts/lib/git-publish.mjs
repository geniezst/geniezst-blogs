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
 * 공용 모듈: /workspace/projects/{blog,blogs}/scripts/lib/git-publish.mjs (동일 사본)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 120000;

/**
 * 셸 없이 git 실행.
 * 데몬이 root 로 돌고 저장소가 다른 UID 소유일 때 생기는
 * `fatal: detected dubious ownership` 를 원천 차단한다.
 */
export function runGit(repoRoot, args, opts = {}) {
  const roots = new Set([repoRoot]);
  try {
    roots.add(fs.realpathSync(repoRoot));
  } catch (_) {}

  const safeDirs = [...roots].flatMap((r) => ['-c', `safe.directory=${r}`]);

  try {
    return execFileSync('git', [...safeDirs, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: opts.timeout || GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
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
  runGit(repoRoot, ['fetch', 'origin', branch], { timeout: 60000 });

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

  // 3) push
  runGit(repoRoot, ['push', 'origin', branch], { timeout: 180000 });

  if (!committed) {
    return { committed: false, pushed: true, reason: 'no-local-changes' };
  }
  return { committed: true, pushed: true };
}

export default gitPublish;
