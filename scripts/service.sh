#! /usr/bin/env bash
# ==============================================================================
# blogs 서비스 관리 스크립트 (Service Manager)
# - 블로그 자동 발행 스케줄러 (auto-publish-runner.mjs)
# - 발행 글 교정 검수 스케줄러 (correct-runner.mjs): 12:00/00:00 KST + 텔레그램 승인
# - Antigravity 세션 종료나 터미널 닫힘과 무관하게 백그라운드에서 영구 독립 실행 (setsid)
# ==============================================================================

BLOG_DIR="/workspace/blogs"
SCHEDULER_SCRIPT="${BLOG_DIR}/scripts/auto-publish-runner.mjs"
SCHEDULER_LOG="${BLOG_DIR}/data/auto-publish.log"
CORRECT_SCRIPT="${BLOG_DIR}/scripts/correct-runner.mjs"
CORRECT_LOG="${BLOG_DIR}/data/correct.log"

check_status() {
  echo "=================================================="
  echo "🔍 [blogs 백그라운드 스케줄러 동작 상태 확인]"
  echo "=================================================="

  SCHED_PID=$(pgrep -f "blogs/scripts/auto-publish-runner.mjs daemon" | head -n 1)
  if [ -n "${SCHED_PID}" ]; then
    SCHED_PPID=$(ps -o ppid= -p "${SCHED_PID}" | tr -d ' ')
    echo "✅ blogs 자동 발행 스케줄러 (daemon): 실행 중 (PID: ${SCHED_PID}, 부모PID: ${SCHED_PPID})"
  else
    echo "❌ blogs 자동 발행 스케줄러 (daemon): 중지됨"
  fi

  CORR_PID=$(pgrep -f "blogs/scripts/correct-runner.mjs daemon" | head -n 1)
  if [ -n "${CORR_PID}" ]; then
    CORR_PPID=$(ps -o ppid= -p "${CORR_PID}" | tr -d ' ')
    echo "✅ blogs 교정 검수 스케줄러 (daemon): 실행 중 (PID: ${CORR_PID}, 부모PID: ${CORR_PPID})"
  else
    echo "❌ blogs 교정 검수 스케줄러 (daemon): 중지됨"
  fi
  echo "=================================================="
}

start_services() {
  echo "🚀 [blogs 독립 백그라운드 서비스 시작]"

  if pgrep -f "blogs/scripts/auto-publish-runner.mjs daemon" >/dev/null; then
    echo "ℹ️ blogs 스케줄러 데몬이 이미 실행 중입니다."
  else
    echo "▶️ blogs 자동 발행 스케줄러 데몬 가동 중..."
    mkdir -p "${BLOG_DIR}/data"
    setsid node "${SCHEDULER_SCRIPT}" daemon </dev/null >>"${SCHEDULER_LOG}" 2>&1 &
    sleep 1
  fi

  if pgrep -f "blogs/scripts/correct-runner.mjs daemon" >/dev/null; then
    echo "ℹ️ blogs 교정 검수 데몬이 이미 실행 중입니다."
  else
    echo "▶️ blogs 교정 검수 데몬 가동 중 (12:00 & 00:00 KST)..."
    mkdir -p "${BLOG_DIR}/data"
    setsid node "${CORRECT_SCRIPT}" daemon </dev/null >>"${CORRECT_LOG}" 2>&1 &
    sleep 1
  fi

  check_status
}

stop_services() {
  echo "🛑 [blogs 백그라운드 서비스 중지]"
  pkill -f "blogs/scripts/auto-publish-runner.mjs daemon" && echo "⏹️ blogs 스케줄러 데몬 중지 완료" || echo "ℹ️ blogs 스케줄러 데몬 실행 중 아님"
  pkill -f "blogs/scripts/correct-runner.mjs daemon" && echo "⏹️ blogs 교정 검수 데몬 중지 완료" || echo "ℹ️ blogs 교정 검수 데몬 실행 중 아님"
  sleep 1
  check_status
}

case "$1" in
  start)
    start_services
    ;;
  stop)
    stop_services
    ;;
  restart)
    stop_services
    start_services
    ;;
  status)
    check_status
    ;;
  *)
    echo "사용법: $0 {start|stop|restart|status}"
    echo ""
    echo "  start   - blogs 스케줄러/교정 데몬을 완전 독립 백그라운드로 실행"
    echo "  stop    - 실행 중인 서비스 중지"
    echo "  restart - 서비스 재시작"
    echo "  status  - 현재 PID 및 동작 상태 확인"
    exit 1
    ;;
esac
