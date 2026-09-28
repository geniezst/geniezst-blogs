#!/usr/bin/env node
/**
 * [SHARED] 런타임 단일 인스턴스 락 (Daemon Single-Instance Lock)
 *
 * [왜 필요한가]
 * 기존 auto-publish-runner.mjs 는 PID 파일을 쓰기만 하고 읽지 않는다.
 * 실제로 data/auto-publish-runner.pid 에는 죽은 PID(15286)가 남아 있고,
 * 같은 데몬이 두 번 기동되면 같은 시간대에 파이프라인이 이중으로 도는 문제가 있다.
 *
 * [해결]
 * - O_EXCL 로 락 파일을 원자적으로 생성해 중복 기동을 차단
 * - 락 파일에 PID + 부팅 시각을 남기고, 프로세스 생존 여부를 검사해
 *   죽은 데몬의 락만 회수(가장 흔한 "데몬이 안 올라온다" 원인 제거)
 * - 종료 시(PID 종료 시그널) 락을 정리
 *
 * 공용 모듈: /workspace/projects/{blog,blogs}/scripts/lib/runtime-lock.mjs (동일 사본)
 */

import fs from 'node:fs';
import path from 'node:path';

/** 프로세스가 실제로 살아 있는지 확인 (signal 0 존재 여부) */
function isAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 이면 다른 사용자 소유지만 살아있다는 뜻
    return err && err.code === 'EPERM';
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * 데몬 단일 인스턴스 락 획득
 * @param {string} lockPath 락 파일 경로
 * @param {{ label?: string }} [opts]
 * @returns {{ acquired: true, release: () => void, pid: number } | { acquired: false, holder: object }}
 */
export function acquireDaemonLock(lockPath, opts = {}) {
  const label = opts.label || path.basename(lockPath);
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const payload = { pid: process.pid, label, startedAt: new Date().toISOString() };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify(payload, null, 2));
      fs.closeSync(fd);
      return { acquired: true, pid: process.pid, release: installRelease(lockPath) };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      const holder = readLock(lockPath);
      if (holder && isAlive(holder.pid) && holder.pid !== process.pid) {
        return { acquired: false, holder };
      }

      // 죽은 데몬 락 회수 (또는 판독 불가한 손상 락)
      try {
        fs.unlinkSync(lockPath);
      } catch (_) {
        /* 다른 프로세스가 이미 회수했을 수 있으므로 무시 */
      }
    }
  }

  return { acquired: false, holder: readLock(lockPath) };
}

function installRelease(lockPath) {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const holder = readLock(lockPath);
    // 다른 프로세스가 이미 회수했거나 인계받은 경우 내 락만 지우지 않는다
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

export default acquireDaemonLock;
