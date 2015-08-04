#!/bin/bash
# Copyright 2015 The Vanadium Authors. All rights reserved.
# Use of this source code is governed by a BSD-style
# license that can be found in the LICENSE file.

# Expects credentials in tmp/creds, generated as follows:
#
# make creds

set -euo pipefail
trap kill_child_processes INT TERM EXIT
silence() {
  "$@" &> /dev/null || true
}
# Copied from chat example app.
kill_child_processes() {
  # Attempt to stop child processes using the TERM signal.
  if [[ -n "$(jobs -p -r)" ]]; then
    silence pkill -P $$
    sleep 1
    # Kill any remaining child processes using the KILL signal.
    if [[ -n "$(jobs -p -r)" ]]; then
      silence sudo -u "${SUDO_USER}" pkill -9 -P $$
    fi
  fi
}
main() {
  local -r TMP=tmp
  local -r PORT=${port-4000}
  local -r MOUNTTABLED_ADDR=":$((PORT+1))"
  local -r SYNCBASED_ADDR=":$((PORT))"
  mkdir -p $TMP
  ${V23_ROOT}/release/go/bin/mounttabled \
    --v23.tcp.address=${MOUNTTABLED_ADDR} \
    --v23.credentials=${TMP}/creds &
  ./bin/syncbased \
    --v=5 \
    --alsologtostderr=false \
    --root-dir=${TMP}/syncbase_${PORT} \
    --name=syncbase \
    --v23.namespace.root=/${MOUNTTABLED_ADDR} \
    --v23.tcp.address=${SYNCBASED_ADDR} \
    --v23.credentials=${TMP}/creds \
    --v23.permissions.literal='{"Admin":{"In":["..."]},"Write":{"In":["..."]},"Read":{"In":["..."]},"Resolve":{"In":["..."]},"Debug":{"In":["..."]}}'
  tail -f /dev/null  # wait forever
}
main "$@"
