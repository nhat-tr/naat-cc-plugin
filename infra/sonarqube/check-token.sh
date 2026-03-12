#!/usr/bin/env bash
# Check SONAR_TOKEN is set. Exits 0 if set, 1 if not.
if [ -n "$SONAR_TOKEN" ]; then
  echo "SONAR_TOKEN: SET"
  exit 0
else
  echo "SONAR_TOKEN: NOT SET" >&2
  exit 1
fi