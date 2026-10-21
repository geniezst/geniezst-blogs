#!/usr/bin/env bash
# 2026-10-21 blogs(포켓머니) 자동 발행 데몬만 재시작해 e2ba0b4 수정(링크 게이트·재시도)을 반영한다.
# 실행: NAS 에서  bash /volume3/docker/workspace/projects/blogs/scripts/ops/restart_blogs_runner_20261021.sh
# 주의: 24:00 전에 실행하면 오늘 실패한 저녁 세션을 곧바로 보상 실행(새 글 1편 발행)한다.
#       오늘 재발행을 원하지 않으면 자정 이후에 실행한다.
set -euo pipefail
C=code-server
docker exec -u 0 "$C" sh -c 'for p in $(pgrep -f "[a]uto-publish-runner.mjs daemon"); do
  case "$(readlink /proc/$p/cwd) $(tr "\0" " " < /proc/$p/cmdline)" in *projects/blogs*) echo "⏹️ blogs 데몬 종료 pid $p"; kill "$p";; esac
done'
sleep 3
docker exec -u 0 "$C" bash /workspace/service.sh start
sleep 2
docker exec -u 0 "$C" sh -c 'ps -eo pid,lstart,cmd | grep "[a]uto-publish-runner.mjs daemon"'
docker exec -u 0 "$C" tail -n 5 /workspace/projects/blogs/data/auto-publish.log
