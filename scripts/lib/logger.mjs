#!/usr/bin/env node
/**
 * [SHARED] 단일 기록자 로거 (Single-Writer Logger)
 *
 * [왜 필요한가]
 * 기존 구현은 `console.log` + `fs.appendFileSync(LOG_FILE)` 를 동시에 수행하고,
 * service.sh 는 stdout 을 다시 같은 LOG_FILE 로 리다이렉트한다.
 * 결과적으로 모든 로그가 정확히 2번씩 기록되어 로그가 오염되고 파일이 2배로 불어난다.
 *
 * [해결]
 * stdout(파일 디스크립터 1)이 이미 LOG_FILE 을 가리키고 있는지 stat 으로 확인하고,
 * 그렇다면 수동 append 를 생략한다. 어떤 방식이든 로그는 정확히 1번만 남는다.
 *
 * 공용 모듈: /workspace/projects/{blog,blogs}/scripts/lib/logger.mjs (동일 사본)
 */

import fs from 'node:fs';
import path from 'node:path';

/** fd 1 과 targetPath 가 같은 파일을 가리키는지 확인 */
function stdoutPointsTo(targetPath) {
  try {
    const target = fs.statSync(targetPath);
    const stdout = fs.fstatSync(1);
    // dev + ino 가 모두 같으면 같은 파일이다 (하드링크/리다이렉트 모두 커버)
    return target.dev === stdout.dev && target.ino === stdout.ino;
  } catch (_) {
    return false;
  }
}

/**
 * 로거 생성기
 * @param {string} logFilePath 로그 파일 절대 경로
 */
export function createLogger(logFilePath) {
  const dir = path.dirname(logFilePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // 최초 1회만 판정. 데몬은 로그 파일을 열기 전에 로거를 만들므로 이 시점이 정확하다.
  let skipFileAppend = stdoutPointsTo(logFilePath);

  const write = (line) => {
    process.stdout.write(line + '\n');
    if (!skipFileAppend) {
      try {
        fs.appendFileSync(logFilePath, line + '\n', 'utf8');
      } catch (_) {
        skipFileAppend = false; // 파일 쓰기가 불가능하면 stdout 만으로 버틴다
      }
    }
  };

  return {
    /** 타임스탬프 로그 */
    log(...args) {
      const msg = args
        .map((a) => (a instanceof Error ? a.message : typeof a === 'object' ? safeJson(a) : String(a)))
        .join(' ');
      write(`[${new Date().toISOString()}] ${msg}`);
    },
    /** 타임스탬프 없이 원문 그대로 기록 (하위 프로세스 stdout 등) */
    raw(text) {
      write(String(text).replace(/\n+$/, ''));
    },
    logFilePath,
    /** fd 상태가 달라진 경우(리다이렉트 변경) 판정 갱신 */
    refreshRedirection() {
      skipFileAppend = stdoutPointsTo(logFilePath);
    },
  };
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch (_) {
    return String(obj);
  }
}

export default createLogger;
