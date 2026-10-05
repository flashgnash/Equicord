# ClosedCaptions

Live, **per-speaker** closed captions for Discord voice calls. Discord has no
built-in transcription, and a PC-level (system-wide) speech-to-text can't tell
*who* is talking. This plugin transcribes each participant separately and shows
their words on screen, attributed by name — all **locally**, nothing leaves the
machine.

```
 Discord (Vesktop / Chromium web-audio path)
   each remote user ──► own MediaStream ──► 16 kHz capture graph ──► energy VAD
                                                                        │
                                     ┌──── interim (every ~0.9 s while talking) ───┐
                                     ▼                                             │
                        native whisper.cpp server (warm) ──► text ──► overlay "Name: …"
                                     ▲                                             │
                                     └──── final (on ~0.7 s of silence) ──────────┘
```

## The view + your own voice

- **Transcript pane** (primary) — a scrolling **full log docked as a real right
  sidebar**: opening it **shifts the whole Discord app left** (shrinks `#app-mount`
  from the right) rather than overlaying, so nothing is hidden. `Name: text` rows,
  auto-scrolls (pauses if you scroll up), header shows engine download/warm-up
  progress. Only active while you're in a voice call (or transcript remains).
- **Toggle buttons** — a **"CC" button** is injected into both Discord control
  bars (the big call-controls bar and the bottom-left voice panel), next to the
  screen-share button; it goes accent-coloured while the pane is open. A thin
  "Captions" **edge tab** on the right is a fallback if those bars change.
- **Themed like Discord** — colours come from Discord's own CSS variables so it's
  blurple-branded by default; a **BetterDiscord-style theme** (e.g. this repo's
  MaterialMonokai, which sets `--accentcolor`, `--backgroundsecondary`, `--font`,
  `--textbrightest`, …) **overrides per-token** where it defines them. Thin themed
  scrollbar. Falls back cleanly on any token a theme doesn't set.
- **Bottom overlay strip** — a floating TV-style caption line also exists but is
  **off by default** (enable `Overlay` if you want it).
- **Your own speech** is captioned too (`Caption self`): the plugin opens your
  mic (the same input device Discord uses) and gates it on Discord's real
  transmit state via `SpeakingStore`, so it only transcribes you while you're
  actually talking — muting or releasing push-to-talk stops it, matching what
  everyone else hears.

## Latency — this is why it feels live

Two things kill latency in a naïve build, and both are handled:

1. **Utterance-final captions.** If you only transcribe *after* someone stops
   talking, a full sentence shows nothing for its whole duration + decode time.
   Instead the plugin **streams interim results**: while someone is talking it
   re-transcribes the utterance-so-far every ~0.9 s and updates that caption line
   in place (dimmed), then locks it in on silence. Text appears ~1 s into speech,
   not seconds after it ends.
2. **Decode speed.** whisper runs its encoder over a fixed 30 s window, so on CPU
   even a 2 s clip costs ~3–4 s with the `small` model — too slow for streaming
   (interim requests would back up). Interim requests are therefore **best-effort**
   (dropped when the engine is busy) so they never build a backlog, and **a GPU
   engine is strongly recommended**: on an AMD Radeon 780M (Vulkan) the `small`
   model decodes a 7 s clip in ~0.7 s (~10× the CPU build), which is what makes
   streaming keep up. See "GPU acceleration" below.

## How it works

- **Renderer** (`index.tsx`): mirrors [`../PerUserAudioSinks`](../PerUserAudioSinks)
  / Vencord's VolumeBooster hook — patches the per-user `StreamData` method that
  sets `.volume = this._volume/100` and, on the same `this`, taps that user's
  `MediaStream` into a private 16 kHz `AudioContext` → `ScriptProcessorNode`
  (silent, zero-gain sink — it only *reads* the audio). A simple energy VAD cuts
  the stream into utterances (speech, then ~0.7 s of silence), which are sent to
  the native side. Guarded to `!IS_DISCORD_DESKTOP` (the native Electron client
  mixes audio in C++ where JS can't reach it → no-op). A 15 s reaper releases
  captures for users who left. The overlay is plain DOM (no React/ReactDOM
  dependency) and inserts transcript text via `textContent`, never `innerHTML`.
- **Native** (`native.ts`, Electron main process): runs **one warm**
  `whisper-server` (the model stays resident — vastly faster than re-running
  `whisper-cli` per utterance), serializes `/inference` requests through a queue
  (the server has a single model context), and returns the text. Junk results
  (`[BLANK_AUDIO]`, `(silence)`, bare punctuation) are dropped.

## Cross-platform, zero-install (for people you share it with)

The native side **provisions everything itself** so recipients don't have to
install anything. Resolution order:

- **Binary:** `CC_WHISPER_BIN` env → a copy cached in userData → download +
  extract the right prebuilt whisper.cpp release for this machine → `whisper-server`
  on `PATH`. The build is chosen by **detected GPU** (the binary is located by
  scanning the extracted bundle, so layout differences don't matter):
  - **Windows + NVIDIA** → the **CUDA** build (`whisper-cublas-*`, self-contained,
    ~257 MB) — real GPU acceleration.
  - **Windows + AMD/Intel** → the **BLAS CPU** build (~20 MB). Upstream ships **no
    Windows Vulkan build**, so AMD/Intel GPUs (incl. integrated) run on CPU there;
    point `CC_WHISPER_BIN` at a Vulkan `whisper-server.exe` if you have one.
  - **Linux** → the CPU tarball. For GPU on Linux use a Vulkan build via
    `CC_WHISPER_BIN` (this repo does exactly that with nix — see `vesktop.nix`).
- **Model:** `CC_WHISPER_MODEL` env → cached copy → download the model for the
  chosen quality.

Everything downloaded is SHA-256 verified and cached; progress shows in the pane
header. **macOS** has no upstream prebuilt server binary, so install whisper.cpp
yourself (`brew install whisper-cpp`) or set `CC_WHISPER_BIN`.

**GPU support summary:** NVIDIA → GPU everywhere (CUDA on Win, Vulkan/CUDA on
Linux). AMD/Intel incl. **integrated** → GPU on **Linux via Vulkan**, **CPU on
Windows** (no upstream Vulkan). Everyone without a GPU build still works on CPU
(use Low / Streaming-off).

> The **binaries are tiny and identical** regardless of model choice (~5–9 MB) —
> only the **model file** differs in size. The quality setting just picks which
> model gets fetched.

## Session notes (extension plugin)

Session notes — a local LLM that reads the transcript and maintains a
per-channel knowledge base (markdown vault, git-versioned) — live in the
sibling **[ClosedCaptionsNotes](../ClosedCaptionsNotes)** plugin. It depends on
this one and plugs into the sidebar via the extension API exported here
(`registerCcExtension` / `ccApi`): a 📝 button in the captions header and a
notes split at the bottom of the pane. Captions work standalone without it.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| **Quality** | Balanced | Balanced = `small` (~490 MB); Accurate = `medium` (~1.5 GB) |
| **Language** | `auto` | e.g. `en`, `de`, `fr`, or `auto` to detect |
| **Auto-download** | on | Off = you provide the binary/model via env yourself |
| **Threads** | 8 | CPU threads the engine may use |
| **Caption self** | on | Also transcribe your own mic (respects mute / push-to-talk) |
| **Overlay** | off | Optional floating caption strip at the bottom of the call |
| **Transcript pane** | on | Scrolling full-log panel docked to the right (primary view) |
| **Streaming** | on | Live interim captions while talking; off = only after they stop |
| **Partial interval** | 1000 ms | Min gap between live-caption refreshes (governor may widen it) |
| **Performance mode** | Auto | Auto adapts to GPU load; High/Medium/Low override (also in sidebar) |
| **GPU duty %** | 50 | Auto mode: max share of GPU time live captions may use |
| **Audio context** | 0 (auto) | whisper `-ac`; auto-sized to utterance length (big GPU saving) |
| **VAD sensitivity** | 0.012 | Lower catches quieter speech but more noise |
| **Silence hangover** | 700 ms | Silence that ends an utterance |
| **Min / Max utterance** | 350 / 9000 ms | Ignore blips; force-flush long talkers |
| **Linger / Max lines** | 7 s / 4 | Overlay caption lifetime + how many at once |

## Environment overrides

Used by this repo's `hm-modules/vesktop.nix` to skip all downloading — it sets
`CC_WHISPER_BIN` + `CC_WHISPER_MODEL` to nix-store paths so the setup is
reproducible. When `CC_WHISPER_MODEL` is set it wins over the in-app Quality
selector.

```
CC_WHISPER_BIN      path to a whisper-server binary
CC_WHISPER_LIBDIR   dir with its shared libs (default: dirname of BIN)
CC_WHISPER_MODEL    path to a ggml-*.bin model
CC_WHISPER_LANG     language code or "auto"
CC_WHISPER_THREADS  worker threads
CC_WHISPER_PORT     loopback port for the server (default 58273)
```

## GPU usage & the governor (shared iGPU / games)

whisper decode is GPU-heavy, and on a shared iGPU it competes with the compositor
and any game. Several layers keep it from lagging the system:

- **`-ac` (audio context)** — the encoder's window is capped to just past the max
  utterance length instead of the full fixed 30 s, roughly halving GPU work per
  decode with **no quality loss** for short clips. The single biggest saving.
- **Only-when-visible partials** — live interim decodes run only while the pane
  (or overlay) is actually on screen. Hidden → **finals only** (one decode per
  utterance); the log stays complete and simply catches up when you open it.
- **Self duty-cycle throttle** — the gap between partials is derived from the
  *measured* decode time to keep partials under `GPU duty %` of GPU time. This
  **auto-scales to the GPU's power**: weak GPU → sparse partials, strong → frequent.
- **External-demand backoff (auto governor)** — on AMD/Linux it samples
  `gpu_busy_percent` while we're idle to estimate *other* GPU load (a game,
  compositor); as that rises it lowers the duty and then **turns partials off
  entirely, yielding the GPU**. Finals (sparse) still run. Inert on platforms
  without the sysfs knob (duty-cycle throttle still applies).
- **Sidebar level pill** — the header shows the current level (`Auto · Live` /
  `Auto · Reduced` / `Auto · Finals only`), turning warning-coloured when it has
  stepped down for a game. Click it to override (High/Medium/Low); High/Medium
  carry a "more GPU" warning.

Debug: `await __closedCaptions.gpu()` shows `{ external, baseline, tier, lastDecodeMs, … }`.

## GPU acceleration

Live streaming really wants a GPU engine. `CC_WHISPER_BIN` can point at any
whisper.cpp `whisper-server` build:

- **This repo (mettaton, AMD)** builds whisper.cpp with Vulkan
  (`pkgs.whisper-cpp.override { vulkanSupport = true; }`) and points the wrapper
  at it — see `hm-modules/vesktop.nix`. Radeon 780M via radv decodes ~10× faster
  than CPU.
- **NVIDIA:** use a CUDA build; whisper.cpp ships `whisper-cublas-*` Windows
  release zips, or build with `cudaSupport = true`.
- **No GPU:** it still works on CPU — turn **Streaming off** (or raise Partial
  interval) so interim requests don't pile up, and captions appear after each
  utterance instead of live.

The auto-provisioned binaries (for people you share it with) are the upstream
**CPU** builds — portable everywhere, but point `CC_WHISPER_BIN` at a GPU build
for the live experience.

## Verifying live

After a full Vesktop relaunch, join a voice call with someone and, in devtools:

```js
__closedCaptions.version            // "cc-1"
await __closedCaptions.status()     // { phase: "ready", ... } once the model is loaded
__closedCaptions.captures()         // [{ id, name, speaking }, ...] — one per remote speaker
__closedCaptions.say("Test", "hello world")   // draw a fake caption to check the overlay
```

Open questions that only a live call answers (same caveat as PerUserAudioSinks):
whether plain VOICE (not just Go-Live) populates `StreamData.stream` on this
Vesktop build. If it doesn't, `handleStream` logs a guarded no-op and no captions
appear — check the `ClosedCaptions` logger. If captions are missing words, lower
the VAD threshold; if noisy/hallucinated, raise it.

## Distributing to others

This is a standard Vencord **userplugin** (`index.tsx` + `native.ts`). Recipients
drop the `ClosedCaptions/` folder into their Vencord `src/userplugins/` and build
Vencord (or use a Vencord distro that loads userplugins). They need **Vesktop**
(or the web client) — the plugin no-ops on the official native Discord client.
With auto-download on, first run fetches the engine + model automatically.
