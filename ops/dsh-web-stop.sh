#!/bin/bash
set -u
UID_N="$(id -u)"
for LABEL in com.deepseek.dsh-web.self-dsh-plugins com.deepseek.dsh-web.dshdiscussion; do
  if /bin/launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; then
    if /bin/launchctl bootout "gui/$UID_N/$LABEL"; then echo "dsh web stopped ($LABEL)."; fi
  fi
done
