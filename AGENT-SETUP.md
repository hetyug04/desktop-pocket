# Coding agent handoff: Desktop Pocket on this Windows PC

The user wants a new independent installation, not access to the sender’s PC. Read README.md, setup.ps1 and desktop-pocket.ps1 first. Source is included; no credentials are included.

## Minimal path

1. Clone the repository or extract the ZIP to a permanent local folder. A clean packaged release includes RELEASE-MANIFEST.json; inspect it when present. `setup.ps1 -Check` verifies that manifest when present and checks prerequisites without changing anything. GitHub's source ZIP/clone does not include a generated release manifest. A checksum proves consistency, not publisher identity: accept this source only from the person the user trusts.
2. Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1`. A human double-clicks SETUP.cmd for the same flow. It installs missing Node LTS/Tailscale with winget if needed; when winget is unavailable, follow the official URLs it prints. Node >=22 and Windows x64/.NET Framework 4.x are required. Dependencies restore with npm ci, not npm install upgrades.
3. Have the user sign into their OWN Tailscale account on PC and phone. This is interactive; do not create a different tailnet, copy another person’s identity/key, or invite anyone into the sender’s tailnet.
4. Setup discovers this PC’s MagicDNS name, configures HTTPS :8443 → 127.0.0.1:4097, builds native/DesktopBridge.exe, creates a private random machine key, starts the app, and automatically displays a QR setup page. The user scans it, taps Create passkey and confirms with Face ID / Windows Hello; there is no link or code to type. The page has one-click recovery-kit saving. The user must enroll their passkey on their phone/browser. Do not print/save/copy these codes or secret-bearing QR images into chat logs, source files, or public assets. The generated pairing page is a restricted local file beside the machine key; do not expose that directory. Avoid rerunning enrollment once successful.
5. If HTTPS certificates are disabled, stop and direct the user to their Tailscale admin DNS page to enable HTTPS Certificates. Never use Funnel, disable TLS checks, or open firewall/LAN listeners.
6. Verify tailscale status/serve status and `/api/health`; verify unauthenticated `/api/files/inbox` and `/api/session` return 401, and POST `/api/login` returns 410 (password login is off). Use the genuine passkey session for browser testing, not a production authentication bypass. The URL is in run/config.json and STATUS.cmd.
7. Optional secure-desktop/UAC support: run enable-full-desktop.cmd only when the user wants it. They approve the administrator prompt on the PC. Download is from the official TightVNC publisher with pinned hash/signature checks; do not substitute an unverified binary. Verify run/full-install-result.json, service LocalSystem, loopback-only port 5905, no other VNC listeners, and unchanged EnableLUA / PromptOnSecureDesktop. Existing TightVNC is intentionally not overwritten.

## Important boundaries

- Fresh config sets `gates: off`: no OpenCode proxy/listener or port-443 changes. An existing configured app preserves its previous gate and key settings. Desktop Pocket does not require OpenCode.
- Opening and enrollment are QR-first. START.cmd opens a locally generated QR page; STATUS.cmd prints a QR; SECURITY-SETUP.cmd opens a temporary enrollment QR. Setup uses a single combined app/enrollment QR, not separate manual steps. An agent may use `desktop-pocket.ps1 start -NoQr` for unattended restarts, but display `show-phone-qr.ps1` when handing control back to the user.
- Keep passkey verification, owner checks, same-origin/CSRF validation, signed agent calls and fail-closed behavior. Do not turn authentication off to make setup easier.
- For another computer belonging to this SAME user/tailnet, the existing Security → Add a computer flow creates a short-lived setup token. Do not use it to give a friend the sender’s machine-to-machine key.
- Files’ authoritative host defaults to this PC. Additional app instances must use this first host in DP_FILES_HOST/run/config.json, not silently split the shared folder.
- Preserve `%LOCALAPPDATA%/DesktopPocket/security` and `run/files/{inbox,trash}` on upgrades. Legacy installations can have their configured secret in `.opencode-remote`; never migrate/replace that without checking run/config.json.
- The built-in terminal intentionally gives the signed-in owner a real user shell. Do not expose it publicly.
- `test/live.test.mjs` and `test/full.test.mjs` from old working trees are password-era tests; they are intentionally not shipped and must not be run against the passkey release. Shipped tests: `node --test --test-concurrency=1 test/files.test.mjs test/package.test.mjs test/qr.test.mjs`. Files tests bind only 127.0.0.1:4098, create disposable data under run/files, and include a streamed 1 GiB check. Do not conflict with another test instance on 4098.

## Troubleshooting

- No node/tailscale command after installing: reopen the setup console, or refresh PATH from Windows Machine/User environment. Official Node and Tailscale downloads are linked in README/script errors.
- npm ci fails on node-pty: use supported Node LTS x64. Inspect its prebuilt/native build output. If a source build is required, install the necessary Python/MSVC build tools from official sources with the user’s approval.
- Port 4097 or 8443 in use: find the owning app. Do not kill unrelated processes or overwrite another Serve route. Stop an older Desktop Pocket instance using its own STOP.cmd.
- Setup QR expired: SECURITY-SETUP.cmd displays a new one; do not reset/remove the passkey store or change the RP ID.
- Normal capture cannot see UAC: complete the optional verified service setup. Do not disable secure desktop.
- All local routes must be loopback-only; user URL is their own `https://<machine>.<tailnet>.ts.net:8443/`.

## Release maintenance

Develop and test requested changes, then rebuild with `powershell -File scripts/package-windows.ps1`. This is a source release, not an independently signed installer. Build/test without touching other apps or production credentials. Setup does not install an auto-start service; START.cmd or the desktop shortcut starts it after login.
