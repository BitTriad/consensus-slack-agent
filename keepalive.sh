#!/bin/zsh
# Consensus keep-alive supervisor.
# - caffeinate prevents the Mac from sleeping while this runs
# - the loop restarts `slack run` if it ever dies
# Usage:  ./keepalive.sh   (leave the Terminal window open, or run under nohup)
cd "$(dirname "$0")"
echo "[keepalive] starting — Mac will not sleep while this window is open"
caffeinate -dimsu &
CAF_PID=$!
trap "kill $CAF_PID 2>/dev/null" EXIT
while true; do
  echo "[keepalive] $(date '+%F %T') launching slack run"
  slack run --team E0BFUERRSLF --org-workspace-grant all --force >> /tmp/consensus-run.log 2>&1
  echo "[keepalive] $(date '+%F %T') slack run exited — restarting in 10s"
  sleep 10
done
