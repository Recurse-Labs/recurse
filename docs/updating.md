# Auto-updates

Recurse ships with Tauri's built-in updater (`tauri-plugin-updater`), so
installed builds keep themselves current without reinstalling.

## How it works

- On launch, the app silently checks
  `https://github.com/Recurse-Labs/recurse/releases/latest/download/latest.json`
  for a newer version than the one currently running.
- If a newer version is available, the ⚙ (settings) icon in the header shows
  a small dot, and the menu item changes to **"Update to vX.Y.Z — restart to
  install"**.
- Clicking it downloads the signed bundle for your platform, verifies its
  Ed25519 signature against the public key baked into the app
  (`tauri.conf.json` → `plugins.updater.pubkey`), installs it, and restarts
  the app.
- You can also click **"Check for updates"** in the same menu at any time.
- On Windows the installer runs in `passive` mode (a small progress window,
  no extra prompts). On macOS and Linux the new bundle replaces the app in
  place before relaunch.

If the running build has no updater artifacts (a local dev build via
`just dev`/`just build` without signing configured), the check silently
no-ops instead of showing an error — this is expected for anyone building
from source.

## Security

- Update payloads are signed with an Ed25519 keypair (`tauri signer
  generate`). Only the **public** half is committed, in
  `tauri/src-tauri/tauri.conf.json`. The private key lives only in the
  `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions secret and is never checked in.
- The updater refuses to install an update whose signature doesn't verify
  against that public key, so a compromised release asset (or a malicious
  mirror) can't silently update your install.
- See [docs/releasing.md](releasing.md) for how a maintainer cuts a release.

## Manual installs / first install

The updater only updates an *existing* install. For the first install, use
one of:

- **Quick install script** (macOS/Linux/Windows) — see the "Install" section
  in the [README](../README.md).
- **Download a bundle directly** from the
  [Releases page](https://github.com/Recurse-Labs/recurse/releases) — pick
  the `.dmg` (macOS), `.deb`/`.rpm`/`.AppImage` (Linux), or `.msi`/`.exe`
  (Windows) asset for your platform.
- **Build from source** — see the "Build" section in the README.
