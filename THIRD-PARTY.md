# Third-party components

This source bundle includes the application source and the existing bundled SimpleWebAuthn server library. Inline third-party notices in lib/vendor/simplewebauthn.mjs are retained (including MIT/Apache-2.0 dependencies). It makes no new license grant for the application itself.

Locked npm dependencies are fetched at setup from registry.npmjs.org, not redistributed in this ZIP. Keep their shipped license/copyright notices with any resulting installation:

| Component | Locked version | License |
|---|---|---|
| @novnc/novnc | 1.7.0 | MPL-2.0 |
| @xterm/xterm | 6.0.0 | MIT |
| @xterm/addon-fit | 0.11.0 | MIT |
| node-pty | 1.1.0 | MIT |
| ws | 8.22.0 | MIT |
| qrcode | 1.5.4 | MIT |
| jsqr (test-only) | 1.4.0 | Apache-2.0 |
| pngjs (QR rendering/testing) | 5.0.0 | MIT |

See package-lock.json for exact transitive packages and integrity values. SimpleWebAuthn's bundled source is labeled @simplewebauthn/server 14.0.3; its full inline notices remain in that file.

TightVNC is optional and separate. No TightVNC MSI or binary is included. enable-full-desktop.ps1 fetches the original signed 2.8.89 GPL installer directly from [TightVNC](https://www.tightvnc.com/download/) and verifies pinned SHA-256 and publisher identity. The vendor supplies its license and corresponding C++ source on that page. Do not remove license notices or redistribute that binary without the required accompanying materials.

Node.js and Tailscale are obtained through their official Windows Package Manager entries or official vendor download pages. They are not included in this bundle.
