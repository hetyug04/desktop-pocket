#!/bin/bash
# Desktop Pocket for Mac: puts this Mac's terminal (and files) in the same app as your PC, over Tailscale.
#
#   curl -fsS "__SOURCE__/install/mac?t=<code>" | bash      (make the command in the app: ... > Security > Add a computer)
#
# What it does (all in your user account; no system changes except installing Node.js if it's missing):
#   1. Checks Tailscale and Node.js (offers to install Node.js with Homebrew or the official installer).
#   2. Downloads the app and the machine-to-machine key from __SOURCE__ with the one-time code
#      (key saved in ~/.opencode-remote/password.txt, readable only by you).
#   3. Starts it at login (a LaunchAgent) and publishes it to your tailnet only: https://<this-mac>:8443
#   4. Your passkeys come over from your PC automatically; sign in with Face ID / Touch ID.
# Undo: ~/DesktopPocket/uninstall-mac.sh
set -euo pipefail
SOURCE="__SOURCE__"
TOKEN="__TOKEN__"
FILES_HOST="__FILES_HOST__"
APP="$HOME/DesktopPocket"
PW_DIR="$HOME/.opencode-remote"; PW_FILE="$PW_DIR/password.txt"
LABEL="net.desktop-pocket"; PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT=4097
say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || die "This installer is for macOS."

# --- Tailscale ---------------------------------------------------------------
TS="$(command -v tailscale || true)"
[ -z "$TS" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -n "$TS" ] || die "Tailscale isn't installed. Install it from tailscale.com/download, sign in, then run this again."
"$TS" status >/dev/null 2>&1 || die "Tailscale isn't connected. Open Tailscale, sign in, then run this again."

# --- Node.js -----------------------------------------------------------------
node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; }
if ! node_ok; then
  say "Desktop Pocket needs Node.js 22 or newer."
  if command -v brew >/dev/null; then
    say "Installing it with Homebrew…"; brew install node
  else
    say "Installing the official Node.js package (macOS will ask for your Mac password)…"
    PKG=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk '/\.pkg$/{print $2; exit}')
    [ -n "$PKG" ] || die "Couldn't find the Node.js installer. Install Node.js 22 from nodejs.org, then run this again."
    curl -fL --progress-bar -o "/tmp/$PKG" "https://nodejs.org/dist/latest-v22.x/$PKG"
    sudo installer -pkg "/tmp/$PKG" -target / >/dev/null
    export PATH="/usr/local/bin:$PATH"
  fi
  node_ok || die "Node.js didn't install. Install Node.js 22 from nodejs.org, then run this again."
fi
NODE="$(command -v node)"; NPM="$(command -v npm)"

# --- App and machine key (one-time code) ------------------------------------
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
EXPIRED="The setup link expired. Make a new one in Desktop Pocket: ... > Security > Add a computer."
curl -fsS -o "$TMP/app.tgz" "$SOURCE/install/package.tgz?t=$TOKEN" || die "$EXPIRED"
mkdir -p "$PW_DIR"; chmod 700 "$PW_DIR"
( umask 077; curl -fsS "$SOURCE/install/key?t=$TOKEN" > "$PW_FILE.new" ) || die "$EXPIRED"
[ -s "$PW_FILE.new" ] || die "Couldn't get the machine key."
mv "$PW_FILE.new" "$PW_FILE"; chmod 600 "$PW_FILE"
say "Saved the machine key to $PW_FILE"

# --- App ---------------------------------------------------------------------
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
mkdir -p "$APP" "$APP/logs" "$APP/run"
tar -xzf "$TMP/app.tgz" -C "$APP"
say "Installing app parts…"
( cd "$APP" && "$NPM" install --omit=dev --no-audit --no-fund --loglevel=error )
chmod +x "$APP"/node_modules/node-pty/prebuilds/darwin-*/spawn-helper 2>/dev/null || true

DNS="$("$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(String(j.Self.DNSName).replace(/\.$/,""))})' < <("$TS" status --json))"
ORIGIN="https://$DNS:8443"

cat > "$APP/uninstall-mac.sh" <<EOF
#!/bin/bash
launchctl bootout "gui/\$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
"$TS" serve --https=8443 off 2>/dev/null || true
echo "Desktop Pocket stopped and removed from login items. Delete $APP to remove the files."
EOF
chmod +x "$APP/uninstall-mac.sh"
cat > "$APP/security-setup.sh" <<SETUP
#!/bin/bash
# Passkey setup code, recovery codes, status:  ./security-setup.sh [setup|recovery|status|signout-all]
cd "$APP" && DESKTOP_PASSWORD_FILE="$PW_FILE" "$NODE" lib/auth-cli.mjs "\$@"
SETUP
chmod +x "$APP/security-setup.sh"

mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$APP/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>EnvironmentVariables</key><dict>
    <key>DESKTOP_ORIGIN</key><string>$ORIGIN</string>
    <key>DESKTOP_PORT</key><string>$PORT</string>
    <key>DESKTOP_PASSWORD_FILE</key><string>$PW_FILE</string>
    <key>DP_TAILSCALE</key><string>$TS</string>
    <key>DP_FILES_HOST</key><string>$FILES_HOST</string>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$APP/logs/server.log</string>
  <key>StandardErrorPath</key><string>$APP/logs/error.log</string>
</dict></plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"

for i in $(seq 1 30); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.5; done
curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null || die "Desktop Pocket didn't start. See $APP/logs/error.log"

"$TS" serve --bg --https=8443 "http://127.0.0.1:$PORT" >/dev/null || die "tailscale serve failed. Turn on HTTPS Certificates on the DNS page of the Tailscale admin console, then run this again."

echo
say "Desktop Pocket is running on this Mac."
echo "  Open on any of your devices: $ORIGIN"
echo "  Or from the PC's app: Terminal tab → choose this Mac."
echo "  Sign in with your passkey (Face ID / Touch ID); it comes over from your PC."
echo "  macOS may ask once to let Node use the terminal or files; allow it."
