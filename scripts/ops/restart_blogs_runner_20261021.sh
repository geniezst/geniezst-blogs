#!/usr/bin/env bash
# 2026-10-21 blog(지니제스트)·blogs(포켓머니) 자동 발행 데몬을 재시작해 근거 기반 파이프라인
# (리서치 → 집필 → 팩트체크, docs/SPEC_FACT_GROUNDED_PIPELINE.md)을 반영한다.
# 실행: NAS 에서  bash /volume3/docker/workspace/projects/blogs/scripts/ops/restart_blogs_runner_20261021.sh
# 주의: 24:00 전에 실행하면 오늘 실패한 blogs 저녁 세션을 곧바로 보상 실행(새 글 1편 발행)한다.
#       blog 는 오늘 저녁 세션이 이미 성공해서 다시 돌지 않는다. 오늘 재발행을 원하지 않으면 자정 이후에 실행한다.
set -euo pipefail
C=code-server
docker exec -u 0 "$C" sh -c 'for p in $(pgrep -f "[a]uto-publish-runner.mjs daemon"); do
  echo "⏹️ 데몬 종료 pid $p ($(readlink /proc/$p/cwd))"; kill "$p"
done'
sleep 3
docker exec -u 0 "$C" bash /workspace/service.sh start
sleep 2
docker exec -u 0 "$C" sh -c 'ps -eo pid,lstart,cmd | grep "[a]uto-publish-runner.mjs daemon"'
for r in blog blogs; do
  echo "== $r"; docker exec -u 0 "$C" tail -n 3 "/workspace/projects/$r/data/auto-publish.log"
done
