#!/usr/bin/env bash
# PID 1 for the CI upgrade container, standing in for systemd's Restart=always: runs the server and starts it again
# whenever it exits. The updater signals PID 1 to restart onto new code; tmux and the updater itself are not
# children of node, so they keep running, exactly as on a box with KillMode=process.
child=0
trap '[ "$child" -gt 0 ] && kill -TERM "$child" 2>/dev/null' TERM
while true; do
    (cd /opt/platopypus/server 2>/dev/null || cd /opt/porthole/server; exec node server.js) &
    child=$!
    wait "$child"; wait "$child" 2>/dev/null
    sleep 1
done
