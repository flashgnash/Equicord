# Shipping a Windows .exe test build (via Equicord + Equibop)

Goal: hand one Windows tester a real `.exe` (no toolchain, no folder-pointing) that
has **ClosedCaptions + the standard plugins**. You don't need a Windows machine —
both builds run in GitHub Actions (trigger as one-offs). VM is only a fallback.

## Why two forks
Equibop (the desktop `.exe`) does **not** build plugins in — on first run it
**downloads `equibop.asar` from `Equicord/Equicord` releases** and loads it. So:
- **Equicord fork** = where our plugin lives; its CI builds the `equibop.asar` that
  contains the plugin.
- **Equibop fork** = the `.exe`; we repoint its download URL at *our* Equicord
  release so the shipped app pulls our bundle.

(No-fork shortcut, if you'd rather: build only the Equicord fork's `equibop.asar`
and have the tester drop it into Equibop's `VENCORD_DIR` — replacing the downloaded
one. One file, but manual. The two-fork route gives a clean self-contained `.exe`.)

## 1. Fork Equicord, add the plugin
1. Fork <https://github.com/Equicord/Equicord>.
2. Copy BOTH plugin folders into the fork, keeping their names:
   **`src/equicordplugins/ClosedCaptions/`** and
   **`src/equicordplugins/ClosedCaptionsNotes/`** (the notes extension imports
   from `../ClosedCaptions`, so the folder names matter; the `.md` files are
   optional). They're standard Vencord plugins — the `@api/@utils/@webpack`
   imports all exist in Equicord, so they drop in unchanged. Nothing
   Vesktop-specific is required (they use their own plugin natives + Electron
   `BrowserWindow`/`child_process`, all available in Equibop).
3. Commit + push.
4. In the fork's **Actions** tab, run the build/release workflow (the one that
   produces `equibop.asar`). If it's `workflow_dispatch`, use "Run workflow"; if it
   only runs on release, push a tag (e.g. `git tag v0.0.1-cc && git push --tags`) or
   cut a GitHub Release. Confirm the run attaches **`equibop.asar`** to a release on
   your fork.

## 2. Fork Equibop, repoint the download
1. Fork <https://github.com/Equicord/Equibop>.
2. Edit `src/main/utils/vencordLoader.ts` — the hardcoded
   `https://github.com/Equicord/Equicord/releases/latest/download/equibop.asar`
   → change `Equicord/Equicord` to **`<your-user>/Equicord`** (your fork).
3. Commit + push.
4. Actions tab → run the packaging/release workflow, targeting **Windows**
   (`workflow_dispatch` if available, else tag/release). electron-builder produces
   the Windows installer as a workflow **artifact** (or release asset).

## 3. Give it to the tester
- Send the `.exe`. On first launch it downloads *your* `equibop.asar` (with the
  plugin), then the plugin **auto-provisions whisper on first use**: on Windows it
  fetches the CUDA build if an NVIDIA GPU is present, else the BLAS CPU build, plus
  the model — all SHA-verified and cached. No manual whisper install.
- Tester enables **ClosedCaptions** (and **ClosedCaptionsNotes** if they want
  session notes) in settings and joins a voice call.

## Notes
- Everything the plugin needs on Windows works (engine auto-provision, `os.setPriority`
  → IDLE class, AC/battery detection via `Win32_Battery`, adaptive duty, pop-out +
  pin). The only Linux-only nicety is the proactive external-GPU-demand governor;
  Windows relies on the decode-time adaptation instead.
- No env vars are needed on the tester's machine (those are only for this repo's Nix
  wrapper, which pins the models). The tester's default quality is "Balanced" (small)
  — they can pick a bigger model in settings; it downloads on demand.
- Updating the plugin later = re-run step 1's workflow (new `equibop.asar`); the
  tester's app picks it up (delete the cached asar in `VENCORD_DIR` if it doesn't
  auto-refresh).
