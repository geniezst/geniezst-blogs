#!/usr/bin/env node
/**
 * [SHARED] 런타임 단일 인스턴스 락 & 빌드 뮤텍스 락 (Daemon Single-Instance & Build-Deploy Lock)
 *
 * [왜 필요한가]
 * 1) 데몬 중복 상주 방지: 30초 메인 루프마다 isLockOwner(lockPath)를 검증하여
 *    락 소유권이 박탈된 유령 데몬은 즉시 자진 종료한다.
 * 2) 빌드/배포 파일 경합 방지: acquireBuildDeployLock(lockPath)으로 npm run build 및
 *    git 배포 구간을 원자적으로 보호한다.
 * 3) dist/ 사전 정리: cleanDistDir(distDir)을 통해 계정 권한 불일치(EACCES)를 방지한다.
 *
 * 공용 모듈: /workspace/projects/{blog,blogs}/scripts/lib/runtime-lock.mjs (동일 사본)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/** 프로세스가 실제로 살아 있는지 확인 (signal 0 존재 여부) */
export function isAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * 락 파일 판독 (빈 파일/기록 지연 방어를 위해 최대 maxRetries회 재시도)
 * @param {string} lockPath 락 파일 경로
 * @param {number} [maxRetries=3] 최대 재시도 횟수
 * @param {number} [delayMs=50] 재시도 간격(ms)
 * @returns {object|null}
 */
export function readLock(lockPath, maxRetries = 3, delayMs = 50) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (fs.existsSync(lockPath)) {
        const content = fs.readFileSync(lockPath, 'utf8');
        if (content && content.trim()) {
          const parsed = JSON.parse(content);
          if (parsed && (typeof parsed.pid === 'number' || parsed.status === 'completed')) {
            return parsed;
          }
        }
      }
    } catch (_) {}
    if (i < maxRetries - 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  return null;
}

/** 현재 프로세스가 해당 락의 정상 소유자인지 검증 */
export function isLockOwner(lockPath) {
  const holder = readLock(lockPath);
  return Boolean(holder && holder.pid === process.pid);
}

/**
 * /proc 을 스캔하여 동일 프로젝트 데몬을 실행 중인 프로세스 PID 목록 반환
 * @param {string} [scriptPattern] 예: 'auto-publish-runner.mjs daemon' 또는 'coffee-news-daemon.mjs daemon'
 * @param {string} [targetDir] 예: '/workspace/projects/blogs'
 * @returns {number[]}
 */
export function getSiblingDaemonPids(scriptPattern, targetDir) {
  const pids = [];
  try {
    const entries = fs.readdirSync('/proc');
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = parseInt(entry, 10);
      try {
        let cmdline = '';
        try {
          const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
          cmdline = raw.toString('utf8').replace(/\0/g, ' ');
        } catch (_) {
          continue;
        }

        // eval/테스트 프로세스 제외
        if (cmdline.includes(' -e ') || cmdline.includes('eval')) continue;

        if (scriptPattern && !cmdline.includes(scriptPattern)) {
          continue;
        }

        let cwd = '';
        try {
          cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        } catch (_) {}

        if (targetDir) {
          const normalizedTarget = path.resolve(targetDir);
          const isTargetBlog = normalizedTarget.endsWith('/blog');
          if (isTargetBlog) {
            // blog 인 경우 blogs 제외
            if (cwd.includes('/blogs') || cmdline.includes('/blogs')) {
              continue;
            }
            if (!cwd.startsWith(normalizedTarget) && !cmdline.includes(normalizedTarget)) {
              continue;
            }
          } else {
            if (!cwd.startsWith(normalizedTarget) && !cmdline.includes(normalizedTarget)) {
              continue;
            }
          }
        }

        pids.push(pid);
      } catch (_) {}
    }
  } catch (_) {}
  return pids;
}

/**
 * 데몬 단일 인스턴스 락 획득 (Two-Factor Process Lock)
 * @param {string} lockPath 락 파일 경로
 * @param {{ label?: string, scriptPattern?: string, projectDir?: string }} [opts]
 * @returns {{ acquired: true, release: () => void, pid: number } | { acquired: false, holder: object }}
 */
export function acquireDaemonLock(lockPath, opts = {}) {
  const label = opts.label || path.basename(lockPath);
  const scriptPattern = opts.scriptPattern;
  const projectDir = opts.projectDir;
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // [Two-Factor Step 1] 프로세스 테이블 사전 점검: 동일 프로젝트 데몬이 이미 살아있는지 확인
  if (scriptPattern && projectDir) {
    const siblings = getSiblingDaemonPids(scriptPattern, projectDir);
    const existingAlive = siblings.filter((pid) => pid !== process.pid && isAlive(pid));
    if (existingAlive.length > 0) {
      return { acquired: false, holder: { pid: existingAlive[0], reason: 'sibling_process_alive' } };
    }
  }

  const payload = { pid: process.pid, label, startedAt: new Date().toISOString() };

  // [Two-Factor Step 2] 원자적 락 파일 생성
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify(payload, null, 2));
      fs.closeSync(fd);
      return { acquired: true, pid: process.pid, release: installRelease(lockPath) };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // EEXIST 발생 시 readLock 최대 3회 재시도 (50ms 대기)
      const holder = readLock(lockPath, 3, 50);

      // 이미 다른 살아있는 프로세스가 소유 중이면 절대로 unlinkSync하지 않고 즉시 거부
      if (holder && isAlive(holder.pid) && holder.pid !== process.pid) {
        return { acquired: false, holder };
      }

      // 죽은 프로세스임이 확실할 때만 unlinkSync 후 재시도
      if (holder && !isAlive(holder.pid)) {
        try {
          fs.unlinkSync(lockPath);
        } catch (_) {}
        continue;
      }

      // 만약 3회 시도 후에도 holder가 null인데(파일이 비어있거나 손상됨),
      // 파일이 여전히 존재하고 mtime이 최근(5초 이내)이면 다른 프로세스가 막 생성 중일 수 있으므로
      // 함부로 unlink하지 않고 거부
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs < 5000) {
          return { acquired: false, holder: { pid: null, reason: 'lock_file_recently_created' } };
        }
        // 오래된 손상 락만 삭제
        fs.unlinkSync(lockPath);
      } catch (_) {}
    }
  }

  return { acquired: false, holder: readLock(lockPath, 3, 50) };
}

/**
 * 빌드/배포 전용 원자적 뮤텍스 락
 * @param {string} lockPath 락 파일 경로
 * @param {{ label?: string, staleTimeoutMs?: number }} [opts]
 * @returns {{ acquired: true, release: () => void, pid: number } | { acquired: false, holder: object }}
 */
export function acquireBuildDeployLock(lockPath, opts = {}) {
  const label = opts.label || path.basename(lockPath);
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const payload = { pid: process.pid, label, startedAt: new Date().toISOString() };
  const staleTimeoutMs = opts.staleTimeoutMs || 10 * 60 * 1000;
  const waitTimeoutMs = opts.waitTimeoutMs ?? 60000;
  const startTime = Date.now();

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify(payload, null, 2));
      fs.closeSync(fd);
      return {
        acquired: true,
        pid: process.pid,
        release: () => {
          try {
            const holder = readLock(lockPath);
            if (!holder || holder.pid === process.pid) {
              fs.unlinkSync(lockPath);
            }
          } catch (_) {}
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      const holder = readLock(lockPath);
      const isExpired = holder?.startedAt && (Date.now() - new Date(holder.startedAt).getTime() > staleTimeoutMs);
      if (holder && (!isAlive(holder.pid) || isExpired)) {
        try { fs.unlinkSync(lockPath); } catch (_) {}
        continue;
      }

      if (Date.now() - startTime >= waitTimeoutMs) {
        return { acquired: false, holder };
      }

      // 1초 대기 후 재시도
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
}

/**
 * 빌드 디렉토리 사전 정리 (계정 권한 불일치 EACCES 및 캐시 오염 방어)
 * @param {string} distDir
 * @param {(msg: string) => void} [logFn]
 */
export function cleanDistDir(distDir, logFn = console.log) {
  try {
    if (fs.existsSync(distDir)) {
      try {
        fs.rmSync(distDir, { recursive: true, force: true });
      } catch (rmErr) {
        // ENOTEMPTY 또는 EACCES 대응: chmod 후 rm -rf 쉘 폴백
        try {
          execSync(`chmod -R 777 "${distDir}" 2>/dev/null || true; rm -rf "${distDir}"`, { stdio: 'ignore' });
        } catch (_) {}
      }
      if (!fs.existsSync(distDir)) {
        if (logFn) logFn(`🧹 [dist 정리 완료] 이전 빌드 산출물(${distDir})을 정리했습니다.`);
        return true;
      }
    }
  } catch (err) {
    if (logFn) logFn(`⚠️ [dist 정리 경고] ${err.message}`);
  }
  return false;
}

function installRelease(lockPath) {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const holder = readLock(lockPath);
    if (!holder || holder.pid === process.pid) {
      try {
        fs.unlinkSync(lockPath);
      } catch (_) {}
    }
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit']) {
    process.on(sig, () => {
      release();
      if (sig !== 'exit') process.exit(sig === 'SIGINT' ? 130 : 0);
    });
  }
  return release;
}

export const SESSION_LOCK_TTL_MS = 15 * 60 * 1000;

/**
 * 당일 세션 완료 상태를 락 파일에 영속화 (당일 재발행 원천 차단)
 * @param {string} lockFile
 * @param {object} [meta]
 * @returns {boolean}
 */
export function markSessionCompleted(lockFile, meta = {}) {
  if (!lockFile) return false;
  try {
    let existing = {};
    try {
      if (fs.existsSync(lockFile)) {
        const raw = fs.readFileSync(lockFile, 'utf8');
        if (raw && raw.trim()) existing = JSON.parse(raw);
      }
    } catch (_) {}
    const completedInfo = {
      ...existing,
      ...meta,
      status: 'completed',
      completedAt: new Date().toISOString(),
    };
    fs.writeFileSync(lockFile, JSON.stringify(completedInfo, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`⚠️ [세션 완료 마킹 실패] ${lockFile}: ${err.message}`);
    return false;
  }
}

/**
 * [P0] 일별 세션 단위 원자적 락 (다중 데몬 및 동시 수동 실행 레이스 컨디션 원천 차단)
 * @param {string} lockDir 락 파일 저장 디렉토리 (보통 data 디렉토리)
 * @param {string} sessionName 세션명 ('morning', 'evening', 'coffee-news' 등)
 * @param {string} dateStr YYYY-MM-DD
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {{ acquired: boolean, alreadyHeld?: boolean, lockFile?: string, releaseOnFailure?: () => void }}
 */
export function acquireSessionLock(lockDir, sessionName, dateStr, opts = {}) {
  const log = opts.log || console.log;
  if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, `session-${sessionName}-${dateStr}.lock`);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      const info = {
        pid: process.pid,
        session: sessionName,
        date: dateStr,
        status: 'in_progress',
        startedAt: new Date().toISOString()
      };
      fs.writeSync(fd, JSON.stringify(info, null, 2), 'utf8');
      fs.closeSync(fd);
      log(`🔒 [세션 락 획득] ${sessionName} 세션 락 생성 (pid: ${process.pid}, ${lockFile})`);
      return {
        acquired: true,
        alreadyHeld: false,
        lockFile,
        releaseOnFailure: () => {
          try {
            const holder = readLock(lockFile);
            if (holder?.status === 'completed') {
              return; // 발행 완료된 세션 락은 절대 삭제하지 않음
            }
            if (!holder || holder.pid === process.pid) {
              fs.unlinkSync(lockFile);
            }
          } catch (_) {}
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      let stat = null;
      try {
        stat = fs.statSync(lockFile);
      } catch (_) {}

      // 0) 빈 파일(0바이트) 판독 시 30초 이내 생성 파일이면 unlink 금지 및 진입 거부
      if (stat && stat.size === 0 && Date.now() - stat.mtimeMs < 30000) {
        log(`⏳ [세션 락 대기] 락 파일이 막 생성 중입니다 (30초 이내 0바이트). 거부 (${lockFile}).`);
        return { acquired: false, lockFile };
      }

      const holder = readLock(lockFile);

      // 1) 락 파일 내용에 status === 'completed'가 있으면 당일 세션 완료로 무조건 진입 거부
      if (holder && holder.status === 'completed') {
        log(`⛔ [세션 락 거부] 오늘(${dateStr}) ${sessionName} 세션은 이미 완료(status: completed)되었습니다 (${lockFile}).`);
        return { acquired: false, lockFile };
      }

      // 2) 현재 동일 프로세스가 이미 상위에서 락을 획득하고 진입한 경우 (재진입 허용)
      if (holder && holder.pid === process.pid) {
        return {
          acquired: true,
          alreadyHeld: true,
          lockFile,
          releaseOnFailure: () => {}
        };
      }

      // 3) 15분 TTL 적용 (stat.mtimeMs 기준 15분 이내면 isAlive가 false라도 절대 unlink하지 않고 거부)
      const now = Date.now();
      if (stat && now - stat.mtimeMs < SESSION_LOCK_TTL_MS) {
        log(
          `⛔ [세션 락 거부] ${sessionName} 세션 락이 15분 이내(${Math.round(
            (now - stat.mtimeMs) / 1000
          )}초 전)에 생성되어 유지 중입니다. isAlive 여부와 무관하게 삭제하지 않고 거부합니다 (PID: ${holder?.pid || '알수없음'}).`
        );
        return { acquired: false, lockFile };
      }

      // 4) 다른 프로세스가 여전히 살아있는 경우 -> 거부
      if (holder && isAlive(holder.pid)) {
        log(`⛔ [세션 락 거부] 오늘(${dateStr}) ${sessionName} 세션이 이미 다른 활성 프로세스(PID: ${holder.pid})에 의해 진행 중입니다 (${lockFile}).`);
        return { acquired: false, lockFile };
      }

      // 5) 15분이 지났고 프로세스도 죽은 고아 락인 경우에만 회수 후 1회 재시도
      try {
        log(`🧹 고아 세션 락 회수 (PID: ${holder?.pid}, 경과: ${stat ? Math.round((now - stat.mtimeMs) / 1000) : '?'}초)`);
        fs.unlinkSync(lockFile);
      } catch (_) {}
    }
  }

  log(`⛔ [세션 락 거부] 오늘(${dateStr}) ${sessionName} 세션 락 획득 실패 (${lockFile}).`);
  return { acquired: false, lockFile };
}

/**
 * 마크다운 포스트 파일 물리적 2차 무결성 검증 (출처 이미지 필수 하드 게이트)
 * - 디스크에 실제로 저장된 파일을 다시 읽어 featured_image 및 본문 이미지 태그 존재 여부를 엄격히 확인
 * - 이미지 0개 시 저장된 파일을 즉시 삭제하고 예외를 throw하여 빌드/D1/Git 배포를 원천 차단
 * @param {string} filePath 검증할 마크다운 파일 절대 경로
 * @param {{ isDigest?: boolean, log?: (msg: string) => void }} [opts]
 * @returns {boolean}
 */
export function verifyPostImageIntegrityOrThrow(filePath, opts = {}) {
  const isDigest = opts.isDigest ?? true;
  const log = opts.log || console.log;

  if (!fs.existsSync(filePath)) {
    throw new Error(`[물리적 2차 품질 게이트 탈락] 검증할 포스트 파일이 디스크에 존재하지 않습니다: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    try { fs.unlinkSync(filePath); } catch (_) {}
    throw new Error(`[물리적 2차 품질 게이트 탈락] 포스트 파일의 Frontmatter 규격이 올바르지 않습니다: ${filePath}`);
  }

  const yaml = fmMatch[1];
  const body = content.slice(fmMatch[0].length);

  // 1) featured_image 추출
  const featMatch = yaml.match(/featured_image:\s*["']?([^"'\n]*)["']?/);
  const featuredImage = featMatch ? featMatch[1].trim() : '';

  // R2 미러링 이미지와 외부 이미지 구분 검출
  const r2ImageRegex = /!\[.*?\]\((\/api\/images\/[^\)]+)\)/gi;
  const externalImageRegex = /!\[.*?\]\((?!none|null|undefined|없음)(https?:\/\/[^\)]+)\)/gi;

  const r2Images = [...body.matchAll(r2ImageRegex)];
  const externalImages = [...body.matchAll(externalImageRegex)];

  if (isDigest) {
    // 1. featured_image 엄격 검증 (/api/images/... 또는 /og-default.jpg 허용)
    const isValidFeat = featuredImage && (featuredImage.startsWith('/api/images/') || featuredImage === '/og-default.jpg' || featuredImage.startsWith('/og-'));
    if (!isValidFeat) {
      try { fs.unlinkSync(filePath); } catch (_) {}
      throw new Error(
        `[물리적 2차 품질 게이트 탈락] 다이제스트 포스트(${path.basename(filePath)})에 유효한 대표 이미지(featured_image)가 없습니다. (값: "${featuredImage}")`
      );
    }

    // 2. 본문 R2 이미지 수 검증: 최소 1개 이상이면 통과 (이미지 미확보 카드는 텍스트 카드로 자연스럽게 폴백 허용)
    if (r2Images.length < 1) {
      log(`⚠️ [품질 게이트 알림] 다이제스트 포스트(${path.basename(filePath)})의 R2 미러링 이미지가 0개입니다 (텍스트 카드 구성).`);
    }

    // 3. 외부 URL 잔존 검증 (0개여야 함)
    if (externalImages.length > 0) {
      try { fs.unlinkSync(filePath); } catch (_) {}
      throw new Error(
        `[물리적 2차 품질 게이트 탈락] 다이제스트 포스트(${path.basename(filePath)})에 미러링되지 않은 외부 원본 이미지 태그가 ${externalImages.length}개 존재합니다.`
      );
    }
  } else {
    // 저녁 심층글: featured_image 빈 문자열 허용, 이미지가 없더라도 파일 삭제 금지
    // (기술 심층글/생활경제 분석글은 코드 블록, 표, 인포그래픽 박스 기반으로 구성됨)
    log(`ℹ️ [심층 가이드 이미지 검증] featured_image: "${featuredImage || '(없음 - 텍스트/컴포넌트 중심)'}", 본문 이미지 태그: ${r2Images.length + externalImages.length}개`);
  }

  log(`✅ [물리적 2차 품질 게이트 통과] ${path.basename(filePath)} (featured_image: "${featuredImage}", R2 이미지: ${r2Images.length}개)`);
  return true;
}

export default acquireDaemonLock;
