# Releasing (maintainers)

`.github/workflows/release.yml` builds signed desktop bundles for macOS
(arm64 + x64), Linux (.deb/.rpm/.AppImage), and Windows (.msi/.exe) and
publishes them as a **draft** GitHub Release with the `latest.json` manifest
the in-app updater reads (see [docs/updating.md](updating.md)).

## One-time setup

1. Generate an updater signing keypair:

   ```bash
   cd tauri && npx tauri signer generate -w ~/.tauri/recurse.key
   ```

   This prints a public key and writes the private key (optionally
   password-protected) to `~/.tauri/recurse.key`.

2. Paste the **public** key into
   `tauri/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`, replacing
   the `REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY` placeholder. Commit it — it's
   public by design.

3. In the repo's GitHub Settings → Secrets and variables → Actions, add:
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of `~/.tauri/recurse.key`.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password you set in step 1
     (or an empty secret if you didn't set one).

   Never commit the private key.

## Cutting a release

1. Bump the version in `tauri/src-tauri/tauri.conf.json` (`"version"`) and
   `tauri/package.json` (`"version"`) — keep them in sync.
2. Commit, merge to `master`.
3. Tag and push:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. The `Release` workflow builds all four targets and opens a **draft**
   release with the bundles and `latest.json` attached. Review it, edit the
   notes, and publish.
5. Once published, every existing install picks up the update automatically
   (or immediately via **"Check for updates"** in the settings menu) because
   the updater endpoint reads the `latest` release's assets.

To rebuild a single platform without re-tagging, use the workflow's "Run
workflow" button (`workflow_dispatch`) with the existing tag name.
