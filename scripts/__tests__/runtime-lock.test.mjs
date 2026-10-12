import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireSessionLock,
  markSessionCompleted,
  readLock,
  SESSION_LOCK_TTL_MS,
} from '../lib/runtime-lock.mjs';

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

console.log('\n[1] SESSION_LOCK_TTL_MS 및 기본 상수 확인');
ok('SESSION_LOCK_TTL_MS 상수 (15분 = 900,000ms)', SESSION_LOCK_TTL_MS === 15 * 60 * 1000);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-lock-test-'));

try {
  console.log('\n[2] 세션 락 기본 획득 및 동일 프로세스 재진입');
  const dateStr = '2026-10-12';
  const lock1 = acquireSessionLock(tmpDir, 'morning', dateStr);
  ok('최초 락 획득 성공', lock1.acquired === true && lock1.alreadyHeld === false);
  ok('락 파일 생성됨', fs.existsSync(lock1.lockFile));

  const lockReentry = acquireSessionLock(tmpDir, 'morning', dateStr);
  ok('동일 프로세스 재진입 허용', lockReentry.acquired === true && lockReentry.alreadyHeld === true);

  console.log('\n[3] 15분 TTL (SESSION_LOCK_TTL_MS) 오판 방어 검증');
  // 다른 PID(존재하지 않는 999999)가 소유한 락 생성 (생성시각: 5분 전 = TTL 이내)
  const deadPidLockFile = path.join(tmpDir, `session-evening-${dateStr}.lock`);
  fs.writeFileSync(deadPidLockFile, JSON.stringify({
    pid: 999999,
    session: 'evening',
    date: dateStr,
    startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  }));
  // mtime을 5분 전으로 설정
  const fiveMinAgo = (Date.now() - 5 * 60 * 1000) / 1000;
  fs.utimesSync(deadPidLockFile, fiveMinAgo, fiveMinAgo);

  const lockTtlReject = acquireSessionLock(tmpDir, 'evening', dateStr);
  ok('15분 이내 죽은 프로세스 락이라도 unlinkSync하지 않고 거부', lockTtlReject.acquired === false);
  ok('락 파일 보존됨', fs.existsSync(deadPidLockFile));

  console.log('\n[4] 빈 파일(0바이트) 30초 이내 생성 방어 검증');
  const zeroByteFile = path.join(tmpDir, `session-zerobyte-${dateStr}.lock`);
  fs.writeFileSync(zeroByteFile, ''); // 0바이트
  const lockZeroByte = acquireSessionLock(tmpDir, 'zerobyte', dateStr);
  ok('0바이트 파일 30초 이내 생성 시 unlinkSync 금지 및 거부', lockZeroByte.acquired === false);
  ok('0바이트 락 파일 보존됨', fs.existsSync(zeroByteFile));

  console.log('\n[5] markSessionCompleted 및 status: "completed" 진입 거부 검증');
  const compLockFile = path.join(tmpDir, `session-comp-${dateStr}.lock`);
  fs.writeFileSync(compLockFile, JSON.stringify({
    pid: 12345,
    session: 'comp',
    date: dateStr,
  }));
  const marked = markSessionCompleted(compLockFile, { slug: 'test-slug' });
  ok('markSessionCompleted 호출 성공', marked === true);

  const parsed = readLock(compLockFile);
  ok('락 파일에 status === "completed" 기록됨', parsed?.status === 'completed');
  ok('completedAt 기록됨', !!parsed?.completedAt);

  const lockCompReject = acquireSessionLock(tmpDir, 'comp', dateStr);
  ok('completed 상태 락은 무조건 진입 거부', lockCompReject.acquired === false);
  ok('completed 락 파일 보존됨', fs.existsSync(compLockFile));

  // releaseOnFailure 가 completed 락을 삭제하지 않는지 검증
  lock1.releaseOnFailure();
  ok('완료되지 않은 lock1은 releaseOnFailure 시 삭제됨', !fs.existsSync(lock1.lockFile));
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n===== 결과: ${pass} 통과 / ${fail} 실패 =====`);
process.exit(fail ? 1 : 0);
