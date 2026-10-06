#!/usr/bin/env bash
# Parse validated Node output as data. Do not source/eval a profile file.
load_vm_profile() {
  local source_profile=${1:?profile.json required} exported key value
  exported=$(node "$(dirname "${BASH_SOURCE[0]}")/vm-profile.mjs" env "$source_profile") || return 20
  while IFS='=' read -r key value; do
    [[ $key =~ ^JM_[A-Z_]+$ && $value =~ ^[A-Za-z0-9._/,:-]+$ ]] || return 21
    printf -v "$key" '%s' "$value"
    export "$key"
  done <<< "$exported"
}
