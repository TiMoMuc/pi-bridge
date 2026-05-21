#!/usr/bin/env bash
set -euo pipefail

# Inversion first: the worst version of this helper would mutate the wrong sandbox,
# attach to the wrong network, leave that network attached, and keep no audit trail.
# So this script does four things on purpose:
#   1) resolves the sandbox name from an explicit workspace key
#   2) auto-detects the bridge container network unless overridden
#   3) disconnects on exit if it attached the network itself
#   4) appends a replayable host-side history entry for every run

usage() {
  cat <<'EOF'
Usage:
  ./sandbox-admin.sh --ws <workspaceKey> --cmd '<shell command>'

Options:
  --ws <workspaceKey>       Workspace key, e.g. ws_a7b3c9
  --cmd '<shell command>'   Command to run inside the sandbox via sh -lc
  --bridge-container <name> Bridge container name (default: pi-bridge)
  --network <name>          Docker network to use instead of auto-detecting from the bridge
  --user <uid[:gid]>        User for docker exec (default: 0)
  --cwd <path>              Working directory inside the sandbox (default: /workspace)
  --log <path>              History log path (default: ./bridge-data/admin/sandbox-admin-history.shlog)
  -h, --help                Show this help
EOF
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
workspace_key=""
command_text=""
bridge_container="${BRIDGE_CONTAINER_NAME:-pi-bridge}"
network_name=""
exec_user="${SANDBOX_ADMIN_USER:-0}"
exec_cwd="/workspace"
log_file="${SANDBOX_ADMIN_LOG:-$script_dir/bridge-data/admin/sandbox-admin-history.shlog}"
attached_here=0
disconnect_done=0
disconnect_failed=0

sanitize_workspace_key() {
  printf '%s' "$1" | sed -e 's/^+/p/' -e 's/[^a-zA-Z0-9_.-]/-/g'
}

sandbox_container_name() {
  printf 'pi-sandbox-%s' "$(sanitize_workspace_key "$1")"
}

list_container_networks() {
  local container="$1"
  docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$container"
}

resolve_bridge_network() {
  list_container_networks "$bridge_container" | grep -Ev '^(host|none)$' | head -n 1
}

container_has_network() {
  local container="$1"
  local target_network="$2"
  list_container_networks "$container" | grep -Fxq "$target_network"
}

cleanup() {
  if [[ "$attached_here" -eq 1 && "$disconnect_done" -eq 0 ]]; then
    docker network disconnect "$network_name" "$sandbox_container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ws)
      workspace_key="${2:-}"
      shift 2
      ;;
    --cmd)
      command_text="${2:-}"
      shift 2
      ;;
    --bridge-container)
      bridge_container="${2:-}"
      shift 2
      ;;
    --network)
      network_name="${2:-}"
      shift 2
      ;;
    --user)
      exec_user="${2:-}"
      shift 2
      ;;
    --cwd)
      exec_cwd="${2:-}"
      shift 2
      ;;
    --log)
      log_file="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$workspace_key" || -z "$command_text" ]]; then
  usage >&2
  exit 2
fi

sandbox_container="$(sandbox_container_name "$workspace_key")"

if ! docker inspect "$bridge_container" >/dev/null 2>&1; then
  echo "Bridge container not found: $bridge_container" >&2
  exit 1
fi

if ! docker inspect "$sandbox_container" >/dev/null 2>&1; then
  echo "Sandbox container not found: $sandbox_container" >&2
  echo "Hint: trigger the workspace once after the bridge is up so the sandbox gets created." >&2
  exit 1
fi

if [[ "$(docker inspect -f '{{.State.Running}}' "$sandbox_container")" != "true" ]]; then
  echo "Sandbox container is not running: $sandbox_container" >&2
  echo "Hint: let the bridge recreate or restart it by triggering that workspace." >&2
  exit 1
fi

if [[ -z "$network_name" ]]; then
  network_name="$(resolve_bridge_network || true)"
fi

if [[ -z "$network_name" ]]; then
  echo "Could not resolve a usable network from bridge container: $bridge_container" >&2
  exit 1
fi

mkdir -p "$(dirname "$log_file")"

timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if ! container_has_network "$sandbox_container" "$network_name"; then
  docker network connect "$network_name" "$sandbox_container"
  attached_here=1
fi

set +e
docker exec -u "$exec_user" -w "$exec_cwd" "$sandbox_container" sh -lc "$command_text"
exit_code=$?
set -e

final_exit_code="$exit_code"
if [[ "$attached_here" -eq 1 ]]; then
  if docker network disconnect "$network_name" "$sandbox_container"; then
    disconnect_done=1
  else
    disconnect_failed=1
    if [[ "$final_exit_code" -eq 0 ]]; then
      final_exit_code=1
    fi
  fi
fi

{
  printf '# %s ws=%s container=%s network=%s cwd=%s user=%s exit=%s\n' \
    "$timestamp" "$workspace_key" "$sandbox_container" "$network_name" "$exec_cwd" "$exec_user" "$exit_code"
  if [[ "$attached_here" -eq 1 ]]; then
    printf 'docker network connect %q %q\n' "$network_name" "$sandbox_container"
  else
    printf '# network already attached: %s\n' "$network_name"
  fi
  printf 'docker exec -u %q -w %q %q sh -lc %q\n' \
    "$exec_user" "$exec_cwd" "$sandbox_container" "$command_text"
  if [[ "$attached_here" -eq 1 ]]; then
    printf 'docker network disconnect %q %q\n' "$network_name" "$sandbox_container"
    if [[ "$disconnect_failed" -eq 1 ]]; then
      printf '# warning: disconnect failed; inspect container network attachments manually\n'
    fi
  fi
  printf '\n'
} >> "$log_file"

exit "$final_exit_code"
