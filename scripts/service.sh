#! /usr/bin/env bash
# ==============================================================================
# blogs 서비스 관리 스크립트 (Service Manager)
# - 블로그 자동 발행 스케줄러 (auto-publish-runner.mjs)
# - 검수 스케줄러(correct-runner.mjs)는 2026-09-29 운영자 요청으로 완전히 제거되었다.
# - Antigravity 세션 종료나 터미널 닫힘과 무관하게 백그라운드에서 영구 독립 실행 (setsid)
# ==============================================================================

BLOG_DIR="/workspace/projects/blogs"
SCHEDULER_SCRIPT="${BLOG_DIR}/scripts/auto-publish-runner.mjs"
SCHEDULER_LOG="${BLOG_DIR}/data/auto-publish.log"

# 데몬은 Node 22 로 기동
NODE22_BIN="/workspace/.node22/bin"
NODE_BIN="$(command -v node || true)"
if [ -x "${NODE22_BIN}/node" ]; then
  NODE_BIN="${NODE22_BIN}/node"
  export PATH="${NODE22_BIN}:${PATH}"
fi

# 환경 변수 일괄 로드 (Cloudflare R2, D1, Gemini API Key 등 전체 데몬에 전달)
if [ -f "/workspace/.env" ]; then
  set -a
  source "/workspace/.env"
  set +a
elif [ -f "${BLOG_DIR}/.env" ]; then
  set -a
  source "${BLOG_DIR}/.env"
  set +a
fi

get_blog2_pids() {
  local pids=()
  for pid in $(pgrep -f "auto-publish-runner.mjs daemon" 2>/dev/null); do
    cwd=$(readlink /proc/${pid}/cwd 2>/dev/null)
    cmd=$(tr '\0' ' ' < /proc/${pid}/cmdline 2>/dev/null)
    if [[ "$cwd" == *"/blogs"* || "$cmd" == *"/blogs/"* ]]; then
      pids+=("$pid")
    fi
  done
  echo "${pids[@]}"
}

check_status() {
  echo "=================================================="
  echo "🔍 [blogs 백그라운드 스케줄러 동작 상태 확인]"
  echo "=================================================="

  local pids=($(get_blog2_pids))
  if [ ${#pids[@]} -gt 0 ]; then
    echo "✅ blogs 자동 발행 스케줄러 (daemon): 실행 중 (PID: ${pids[*]})"
  else
    echo "❌ blogs 자동 발행 스케줄러 (daemon): 중지됨"
  fi
  echo "=================================================="
}

start_services() {
  echo "🚀 [blogs 독립 백그라운드 서비스 시작]"

  local pids=($(get_blog2_pids))
  if [ ${#pids[@]} -gt 0 ]; then
    echo "ℹ️ blogs 스케줄러 데몬이 이미 실행 중입니다 (PID: ${pids[*]})."
  else
    echo "▶️ blogs 자동 발행 스케줄러 데몬 가동 중..."
    mkdir -p "${BLOG_DIR}/data"
    setsid "${NODE_BIN}" "${SCHEDULER_SCRIPT}" daemon </dev/null >>"${SCHEDULER_LOG}" 2>&1 &
    sleep 1
  fi

  check_status
}

stop_services() {
  echo "🛑 [blogs 백그라운드 서비스 중지]"
  local pids=($(get_blog2_pids))
  for pid in "${pids[@]}"; do
    kill -9 "${pid}" 2>/dev/null && echo "⏹️ blogs 스케줄러 데몬 중지 완료 (PID: ${pid})"
  done
  rm -f "${BLOG_DIR}/data/auto-publish-runner.lock" 2>/dev/null
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
