#!/bin/sh
set -eu

to_lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

bool_json() {
  case "$(to_lower "${1:-false}")" in
    1|true|yes|on) printf 'true' ;;
    *) printf 'false' ;;
  esac
}

is_true() {
  [ "$(bool_json "${1:-false}")" = "true" ]
}

trim() {
  printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

CONFIG_HOME="${XDG_CONFIG_HOME:-/root/.config}"
DATA_HOME="${XDG_DATA_HOME:-/root/.local/share}"
CONFIG_FILE="$CONFIG_HOME/code-server/config.yaml"
USER_SETTINGS_DIR="$DATA_HOME/code-server/User"
USER_SETTINGS_FILE="$USER_SETTINGS_DIR/settings.json"
EXTENSIONS_DIR="$DATA_HOME/code-server/extensions"

mkdir -p "$(dirname "$CONFIG_FILE")" "$USER_SETTINGS_DIR" "$EXTENSIONS_DIR"

cat > "$CONFIG_FILE" <<EOF
bind-addr: ${CS_BIND_ADDR:-0.0.0.0:8080}
auth: ${CS_AUTH:-password}
cert: false
EOF

if [ -n "${CS_HASHED_PASSWORD:-}" ]; then
  printf 'hashed-password: "%s"\n' "$CS_HASHED_PASSWORD" >> "$CONFIG_FILE"
elif [ "${CS_AUTH:-password}" = "password" ]; then
  printf 'password: "%s"\n' "${CS_PASSWORD:-change-me}" >> "$CONFIG_FILE"
fi

ACTIVITY_BAR_LOCATION='default'
SECONDARY_SIDEBAR='visible'
MENU_BAR='classic'
STATUS_BAR_VISIBLE='true'
PANEL_DEFAULT='bottom'
LAYOUT_CONTROL='true'
WORKSPACE_TRUST='true'
AI_DISABLED='false'

if is_true "${CS_HIDE_ACTIVITY_BAR:-false}"; then
  ACTIVITY_BAR_LOCATION='hidden'
fi
if is_true "${CS_HIDE_SECONDARY_SIDEBAR:-false}"; then
  SECONDARY_SIDEBAR='hidden'
fi
if is_true "${CS_HIDE_MENU_BAR:-false}"; then
  MENU_BAR='hidden'
fi
if is_true "${CS_HIDE_STATUS_BAR:-false}"; then
  STATUS_BAR_VISIBLE='false'
fi
if ! is_true "${CS_TRUST_WORKSPACE:-true}"; then
  WORKSPACE_TRUST='false'
fi
if is_true "${CS_DISABLE_AI:-false}"; then
  AI_DISABLED='true'
fi
if [ "${CS_PROFILE:-minimal}" = "minimal" ]; then
  PANEL_DEFAULT='bottom'
  LAYOUT_CONTROL='false'
fi

cat > "$USER_SETTINGS_FILE" <<EOF
{
  "workbench.startupEditor": "none",
  "workbench.activityBar.location": "$ACTIVITY_BAR_LOCATION",
  "workbench.secondarySideBar.defaultVisibility": "$SECONDARY_SIDEBAR",
  "workbench.layoutControl.enabled": $LAYOUT_CONTROL,
  "workbench.statusBar.visible": $STATUS_BAR_VISIBLE,
  "window.menuBarVisibility": "$MENU_BAR",
  "workbench.panel.defaultLocation": "$PANEL_DEFAULT",
  "workbench.tips.enabled": false,
  "update.mode": "none",
  "extensions.autoCheckUpdates": false,
  "extensions.autoUpdate": false,
  "telemetry.telemetryLevel": "off",
  "remote.autoForwardPorts": false,
  "security.workspace.trust.enabled": $WORKSPACE_TRUST,
  "chat.disableAIFeatures": $AI_DISABLED,
  "editor.minimap.enabled": false,
  "breadcrumbs.enabled": false,
  "terminal.integrated.enablePersistentSessions": false,
  "terminal.integrated.shellIntegration.enabled": false,
  "terminal.integrated.tabs.enabled": false,
  "debug.toolBarLocation": "hidden",
  "debug.openDebug": "neverOpen",
  "typescript.disableAutomaticTypeAcquisition": true,
  "git.enabled": false,
  "npm.autoDetect": "off",
  "gulp.autoDetect": "off",
  "grunt.autoDetect": "off",
  "jake.autoDetect": "off"
}
EOF

if [ -n "${CS_EXTRA_EXTENSIONS:-}" ]; then
  INSTALLED_EXTENSIONS="$(code-server --extensions-dir "$EXTENSIONS_DIR" --list-extensions 2>/dev/null || true)"
  OLD_IFS="$IFS"
  IFS=','
  set -- $CS_EXTRA_EXTENSIONS
  IFS="$OLD_IFS"
  for raw_extension in "$@"; do
    extension="$(trim "$raw_extension")"
    [ -n "$extension" ] || continue
    if ! printf '%s\n' "$INSTALLED_EXTENSIONS" | grep -Fx "$extension" >/dev/null 2>&1; then
      echo "[code-server-bootstrap] Installing extension: $extension"
      code-server \
        --user-data-dir "$DATA_HOME/code-server" \
        --extensions-dir "$EXTENSIONS_DIR" \
        --install-extension "$extension" >/dev/null
      INSTALLED_EXTENSIONS="$INSTALLED_EXTENSIONS
$extension"
    fi
  done
fi

set -- \
  --config "$CONFIG_FILE" \
  --user-data-dir "$DATA_HOME/code-server" \
  --extensions-dir "$EXTENSIONS_DIR"

if is_true "${CS_DISABLE_TELEMETRY:-false}"; then
  set -- "$@" --disable-telemetry
fi
if is_true "${CS_DISABLE_PROXY:-false}"; then
  set -- "$@" --disable-proxy
fi
if is_true "${CS_DISABLE_GETTING_STARTED:-false}"; then
  set -- "$@" --disable-getting-started-override
fi
if is_true "${CS_DISABLE_DOWNLOADS:-false}"; then
  set -- "$@" --disable-file-downloads
fi

set -- "$@" "${CS_WORKSPACE:-/workspace}"
exec code-server "$@"
