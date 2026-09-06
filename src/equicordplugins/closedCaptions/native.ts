/*
 * ClosedCaptions — native (Electron main process) side.
 *
 * Runs ONE warm whisper.cpp server (model loaded once, kept resident) and
 * transcribes short per-speaker utterances the renderer flushes to it. Discord
 * has no built-in transcription, and a system-wide (PC-level) STT can't tell
 * WHO is talking — but on the Vesktop/Chromium web-audio path every remote
 * participant is its own MediaStream (see ../PerUserAudioSinks), so the renderer
 * segments each speaker separately and hands us one utterance at a time,
 * attributed to that user's id. We just turn PCM → text.
 *
 * Why a warm server (whisper-server) rather than `whisper-cli` per utterance:
 * the CLI reloads the whole model on every invocation (seconds of latency, huge
 * waste) — the server loads it once and answers each /inference in ~model-time.
 *
 * ── Cross-platform, zero-install (the point of this file) ────────────────────
 * This plugin is meant to be handed to other people, some on Windows, who won't
 * have whisper.cpp installed. So the native side PROVISIONS everything itself,
 * resolving the server binary and the model in this order:
 *
 *   binary:  CC_WHISPER_BIN env  →  a previously-provisioned copy in userData
 *            →  download+extract the prebuilt whisper.cpp release for THIS
 *               platform (Win/Linux, x64/arm64)  →  "whisper-server" on PATH
 *   model:   CC_WHISPER_MODEL env  →  provisioned copy in userData
 *            →  download the chosen model (balanced=small, accurate=medium)
 *
 * The two env vars let a Nix/packaged install point straight at store paths and
 * skip all downloading (that's how this repo's own vesktop.nix wires it). For
 * everyone else the first run downloads a ~5–9 MB binary bundle + the model
 * (~490 MB balanced / ~1.5 GB accurate) into the app's userData dir, verifies
 * SHA-256, and caches them. Downloads report progress via getStatus() so the
 * renderer can surface "Downloading model… 45%".
 *
 * macOS has no upstream prebuilt server binary (the release ships only an
 * xcframework), so on darwin we fall back to CC_WHISPER_BIN / PATH and tell the
 * user to `brew install whisper-cpp` if neither is present. Everything is
 * guarded: a miss is a logged status=error, never a crash.
 *
 * Env overrides (all optional):
 *   CC_WHISPER_BIN      path to a whisper-server binary
 *   CC_WHISPER_LIBDIR   dir holding its shared libs (default: dirname of BIN)
 *   CC_WHISPER_MODEL    path to a ggml-*.bin model
 *   CC_WHISPER_LANG     language code or "auto"        (default from renderer)
 *   CC_WHISPER_THREADS  worker threads                 (default from renderer)
 *   CC_WHISPER_PORT     loopback port                  (default "58273")
 */

import { ChildProcess, execFile, spawn } from "child_process";
import { createHash } from "crypto";
import { app, BrowserWindow, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { appendFileSync, chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { arch, platform, setPriority } from "os";
import { dirname, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { promisify } from "util";

const pexecFile = promisify(execFile);

function log(...a: any[]) { console.log("[ClosedCaptions]", ...a); fileLog("LOG", a); }
function err(...a: any[]) { console.error("[ClosedCaptions]", ...a); fileLog("ERR", a); }

// ── Pinned provisioning sources ──────────────────────────────────────────────
// Pinned to a specific whisper.cpp release tag so the assets (and their hashes)
// are stable; bump REL + the sha256s together to update. Each prebuilt bundle
// contains whisper-server plus the shared libs it needs, side by side.
const REL = "b4938";
const REL_BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${REL}`;

interface BinAsset { url: string; sha256: string; kind: "zip" | "tgz"; label: string; }
// Windows x64 comes in flavours; we pick by detected GPU vendor (see selectBinAsset).
// NVIDIA → CUDA (real GPU accel, self-contained, big); AMD/Intel → BLAS CPU
// (upstream ships NO Windows Vulkan build, so integrated/AMD GPUs run on CPU there —
// set CC_WHISPER_BIN to a Vulkan build if you have one). Linux prebuilts are CPU;
// this repo's own machine uses the nix Vulkan build via CC_WHISPER_BIN.
const WIN_X64_BLAS: BinAsset = {
    url: `${REL_BASE}/whisper-blas-bin-x64.zip`,
    sha256: "78568aa80b361382cb303438a7be3b05669651f2ca8258910394679e049d26ea",
    kind: "zip", label: "CPU (BLAS)",
};
const WIN_X64_CUDA: BinAsset = {
    url: `${REL_BASE}/whisper-cublas-11.8.0-bin-x64.zip`,
    sha256: "2510ae3fe25af5cd7fed55ff71a97a5b1bcc7ea27e88e98d1d53229761a0857d",
    kind: "zip", label: "NVIDIA CUDA",
};
const WIN_IA32: BinAsset = {
    url: `${REL_BASE}/whisper-bin-Win32.zip`,
    sha256: "b584fac6e15aa6714cd5c17f5efd0aa2d330c29f7f508e352333719b0e5b46a5",
    kind: "zip", label: "CPU 32-bit",
};
const LINUX_X64: BinAsset = {
    url: `${REL_BASE}/whisper-bin-ubuntu-x64.tar.gz`,
    sha256: "f4cfc1f969a13805908fb72043ce7cc896eb42e0b8afbe841dc8e7298923b061",
    kind: "tgz", label: "CPU",
};
const LINUX_ARM64: BinAsset = {
    url: `${REL_BASE}/whisper-bin-ubuntu-arm64.tar.gz`,
    sha256: "94a33318650c57cc3d9a91439e0e3f0b94ba96bacd34203a06db395cf9204e40",
    kind: "tgz", label: "CPU",
};

interface ModelInfo { file: string; url: string; sha256: string; size: number; }
const MODELS: Record<string, ModelInfo> = {
    balanced: {
        file: "ggml-small.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        size: 487601967,
    },
    accurate: {
        file: "ggml-medium.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
        sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
        size: 1533763059,
    },
    // Best accuracy for the cost — near large-v3 quality with far fewer decoder
    // layers, so it's GPU-friendly. Recommended when you have any GPU.
    turbo: {
        file: "ggml-large-v3-turbo.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
        sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
        size: 1624555275,
    },
};

const PORT = parseInt(process.env.CC_WHISPER_PORT || "58273", 10);
const HOST = "127.0.0.1";

function dataDir(): string {
    const d = join(app.getPath("userData"), "ClosedCaptions");
    mkdirSync(d, { recursive: true });
    return d;
}

// ── Persistent log file ───────────────────────────────────────────────────────
// A tester who hits an error only sees a transient toast — write everything to a
// file they can grab and send us. Every log()/err() is mirrored here. Location:
//   Windows  %APPDATA%\<App>\ClosedCaptions\closed-captions.log
//   Linux    ~/.config/<App>/ClosedCaptions/closed-captions.log
//   macOS    ~/Library/Application Support/<App>/ClosedCaptions/closed-captions.log
let logHeaderWritten = false;
function logFilePath(): string { return join(dataDir(), "closed-captions.log"); }
function fileLog(level: string, parts: any[]) {
    try {
        const p = logFilePath();
        if (!logHeaderWritten) {
            logHeaderWritten = true;
            // Cap growth across sessions — start fresh if the last file got large.
            try { if (existsSync(p) && statSync(p).size > 1_000_000) rmSync(p, { force: true }); } catch { /* ignore */ }
            appendFileSync(p, `\n===== ClosedCaptions session ${new Date().toISOString()} — ${platform()}-${arch()}, electron ${process.versions.electron || "?"}, node ${process.versions.node || "?"} =====\n`);
        }
        const line = parts.map(x => {
            if (x instanceof Error) return `${x.message}${x.stack ? "\n" + x.stack : ""}`;
            if (x && typeof x === "object") { try { return JSON.stringify(x); } catch { return String(x); } }
            return String(x);
        }).join(" ");
        appendFileSync(p, `[${new Date().toISOString()}] ${level} ${line}\n`);
    } catch { /* never let logging break anything */ }
}
// Renderer asks for this so it can show the tester exactly where the log lives.
export async function getLogPath(_: IpcMainInvokeEvent) { return logFilePath(); }

// ── Status (polled by the renderer for download/warm-up feedback) ─────────────
type Phase = "idle" | "provisioning" | "downloading-model" | "starting" | "ready" | "error";
// Pause state lives above the status helpers because setStatus reflects it.
let downloadPaused = false;
let currentDownloadAbort: AbortController | null = null;
const isDownloadPhase = (p: Phase) => p === "provisioning" || p === "downloading-model";

let status: { phase: Phase; pct: number; message: string; paused: boolean; done: number; total: number } =
    { phase: "idle", pct: 0, message: "", paused: false, done: 0, total: 0 };
function setStatus(phase: Phase, message = "", pct = 0) {
    // Byte counters reset on any phase change; the resumable downloader fills them
    // in via setProgress once the transfer starts. `paused` only means anything
    // during a download phase.
    status = { phase, pct, message, paused: isDownloadPhase(phase) && downloadPaused, done: 0, total: 0 };
    if (phase === "error") err("status:", message);
    else log("status:", phase, message || "", pct ? `${pct}%` : "");
}
// Live byte/percent progress from the downloader (preserves phase + message).
function setProgress(done: number, total: number) {
    status = { ...status, done, total, paused: downloadPaused, pct: total ? Math.floor((done / total) * 100) : status.pct };
}
export async function getStatus(_: IpcMainInvokeEvent) { return status; }

// Pause/resume the in-flight provisioning download (engine binary or model) so the
// user can free up bandwidth. Pausing aborts the current HTTP stream but KEEPS the
// partial file; the downloader loop waits, then resumes with a Range header on
// unpause (see downloadResumable). Frozen progress stays visible while paused.
export async function setDownloadPaused(_: IpcMainInvokeEvent, paused: boolean) {
    downloadPaused = !!paused;
    status = { ...status, paused: downloadPaused };
    if (downloadPaused && currentDownloadAbort) { try { currentDownloadAbort.abort(); } catch { /* ignore */ } }
    log(downloadPaused ? "download paused by user" : "download resumed by user");
    return status;
}

// GPU governor snapshot — includes the live effective tier for the sidebar label.
export async function getGpu(_: IpcMainInvokeEvent) {
    return {
        available: !!findGpuBusyPath(),
        idle: Math.round(gpuIdleEma),
        baseline: gpuBaseline > 100 ? null : Math.round(gpuBaseline),
        external: externalDemand(),
        lastDecodeMs: lastHeavyDur,
        onAC,
        cpuClockPct: Math.round(cpuFreqRatio * 100),   // how throttled the CPU is by power
        mode: cfg.mode,
        tier: effectiveTier(),
        partials: partialPolicy(),
    };
}

// ── Runtime config (from the renderer's settings) ────────────────────────────
interface Cfg {
    quality: string; language: string; threads: number; autoDownload: boolean;
    audioCtx: number;   // whisper -ac (0 = full 30s window); capping to the max
    //                     utterance length cuts GPU/CPU work with no quality loss
    gpuDuty: number;    // 0..1 target share of GPU time our PARTIALs may use
    mode: string;       // "auto" | "high" | "medium" | "low" — user override of
    //                     the adaptive governor (auto steps down for games)
    confidence: number; // 0..1 threshold below which a FINAL decode is retried
    beamSize: number;   // whisper beam search width (1 = greedy/fast, 5 = accurate)
}
let cfg: Cfg = { quality: "balanced", language: "auto", threads: 4, autoDownload: true, audioCtx: 0, gpuDuty: 0.5, mode: "auto", confidence: 0.55, beamSize: 2 };

// Tiered engine: a "fast" server (small model, kept warm — instant tier + the
// throttled corrective pass via per-request beam) and a "best" server (the big
// model — only run when there's spare GPU). Beam size is per-request, so one
// server per MODEL suffices. A single global lock still serializes ALL decodes
// across both servers (one shared GPU).
type Role = "fast" | "best";
interface Srv { proc: ChildProcess | null; readyPromise: Promise<boolean> | null; port: number; }
const servers: Record<Role, Srv> = {
    fast: { proc: null, readyPromise: null, port: PORT },
    best: { proc: null, readyPromise: null, port: PORT + 1 },
};
let lastBestUse = 0;              // ms of the last best-model decode
const BEST_IDLE_MS = 90_000;     // free the big model's RAM after this long unused

// whisper-server holds a single model context and processes one /inference at a
// time; concurrent requests (several people talking at once) race on it. A tiny
// lock serializes access. FINAL transcriptions wait their turn (correctness);
// interim PARTIALs are best-effort — if the engine is busy, the partial is
// dropped rather than queued, so live captions never pile up a backlog behind a
// slow decode (`transcribePartial` below).
let locked = false;
// Priority queue: higher `prio` is served first (remote speakers = 1, your OWN
// speech = 0 so it always yields the GPU to others), FIFO within a priority.
const waiters: Array<{ res: () => void; prio: number }> = [];
function acquire(prio = 1): Promise<void> {
    if (!locked) { locked = true; return Promise.resolve(); }
    return new Promise<void>(res => waiters.push({ res, prio }));   // resolved already holding the lock
}
function release() {
    if (waiters.length === 0) { locked = false; return; }
    let best = 0;
    for (let i = 1; i < waiters.length; i++) if (waiters[i].prio > waiters[best].prio) best = i;
    waiters.splice(best, 1)[0].res();   // hand the lock to the highest-priority waiter (stays locked)
}

// ── GPU governor (auto usage calibration) ────────────────────────────────────
// On a shared iGPU, whisper compute competes with the compositor AND any game.
// This estimates EXTERNAL GPU demand and steps our usage down under load. AMD/
// Linux reads `gpu_busy_percent`; sampled only while WE are idle so it reflects
// everything except our own decode. Baseline = a slowly-recovering rolling min
// (the compositor floor); externalDemand = current − baseline. On platforms
// without the sysfs knob the governor is inert (self duty-cycle throttle still
// applies). Two adaptive controls result:
//   1. self duty-cycle: partial cooldown derived from measured decode time so we
//      never use more than `gpuDuty` of GPU time — auto-scales to GPU power.
//   2. external backoff: as a game/app drives the GPU up, partials get rarer and
//      then stop, yielding the GPU; finals (one per utterance) still run.
let gpuBusyPath: string | null | undefined;   // undefined = not yet probed
function findGpuBusyPath(): string | null {
    if (gpuBusyPath !== undefined) return gpuBusyPath;
    gpuBusyPath = null;
    try {
        for (const card of readdirSync("/sys/class/drm")) {
            if (!/^card\d+$/.test(card)) continue;
            const p = `/sys/class/drm/${card}/device/gpu_busy_percent`;
            if (existsSync(p)) { gpuBusyPath = p; break; }
        }
    } catch { /* not linux / no sysfs */ }
    return gpuBusyPath;
}

let gpuIdleEma = 0;        // EMA of busy% while we're idle (baseline + external)
let gpuBaseline = 101;     // rolling min of idle EMA (compositor floor)
let gpuSampler: ReturnType<typeof setInterval> | null = null;
let lastHeavyDur = 300;   // ms, measured decode time of the last REFINEMENT pass
let nextHeavyAt = 0;      // duty-cycle budget for tier1/tier2 refinement (heavy, lull-only)
let lastPartialDur = 300; // ms, measured decode time of the last interim partial
let nextPartialAt = 0;    // SEPARATE, lighter budget for interim partials so the live
//                           captions stay snappy and aren't starved by a refinement pass.

function sampleGpu() {
    readPower();           // AC state + CPU clock (cheap, always)
    // Free the big "best" model's RAM (~1.6 GB) once it's been idle a while — RAM
    // is at a premium; the small "fast" model stays warm for instant captions.
    const bs = servers.best;
    if (bs.proc && !bs.proc.killed && lastBestUse && Date.now() - lastBestUse > BEST_IDLE_MS) {
        try { bs.proc.kill("SIGTERM"); } catch { /* ignore */ }
        bs.proc = null; bs.readyPromise = null;
        log("evicted idle best-model server to free RAM");
    }
    if (locked) return;    // don't measure our own decode
    const p = findGpuBusyPath();
    if (!p) return;
    let v = NaN;
    try { v = parseInt(readFileSync(p, "utf8").trim(), 10); } catch { return; }
    if (!Number.isFinite(v)) return;
    gpuIdleEma = gpuIdleEma ? gpuIdleEma * 0.7 + v * 0.3 : v;
    gpuBaseline = Math.min(gpuBaseline, gpuIdleEma);
    gpuBaseline = Math.min(101, gpuBaseline + 0.4);   // let the floor recover slowly
}

// External GPU demand estimate, 0..100 (0 if we can't measure).
function externalDemand(): number {
    if (!findGpuBusyPath() || gpuBaseline > 100) return 0;
    return Math.max(0, Math.round(gpuIdleEma - gpuBaseline));
}

// Are interim PARTIALs currently allowed, and at what duty? In "auto" this steps
// down as external demand rises (off under heavy load — yield to the game); the
// other modes are fixed user overrides (high uses the most GPU).
function partialPolicy(): { allow: boolean; duty: number } {
    switch (cfg.mode) {
        case "high": return { allow: true, duty: 0.7 };
        case "medium": return { allow: true, duty: 0.35 };
        case "low": return { allow: false, duty: 0 };
        default: break;   // "auto"
    }
    const d = externalDemand();
    if (d >= 45) return { allow: false, duty: 0 };       // heavy external load → finals only
    if (d >= 25) return { allow: true, duty: Math.min(cfg.gpuDuty, 0.2) };
    if (d >= 12) return { allow: true, duty: Math.min(cfg.gpuDuty, 0.35) };
    return { allow: true, duty: cfg.gpuDuty };
}

// ── Power state ───────────────────────────────────────────────────────────────
// On battery the CPU/GPU are clocked down (throttled), so decodes are slow and the
// desktop lags — back off hard there and open up on AC. Sampled with the governor.
let onAC = true;
let cpuFreqRatio = 1;   // current CPU clock / max (a direct "how throttled" reading)
let lastPowerPoll = 0;

// Linux: cheap sysfs reads (every tick). Windows/macOS: spawning a query is
// expensive, so throttle to ~10 s and update asynchronously.
function readPower() {
    if (platform() === "linux") {
        try {
            const base = "/sys/class/power_supply";
            let sawBattery = false, acOnline = false;
            for (const e of readdirSync(base)) {
                let type = "";
                try { type = readFileSync(`${base}/${e}/type`, "utf8").trim(); } catch { continue; }
                if (type === "Mains" || type === "USB") {
                    try { if (readFileSync(`${base}/${e}/online`, "utf8").trim() === "1") acOnline = true; } catch { /* ignore */ }
                } else if (type === "Battery") { sawBattery = true; }
            }
            onAC = sawBattery ? acOnline : true;   // no battery → desktop → treat as AC
        } catch { onAC = true; }
        try {
            const cur = parseInt(readFileSync("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq", "utf8"), 10);
            const max = parseInt(readFileSync("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq", "utf8"), 10);
            if (max > 0 && Number.isFinite(cur)) cpuFreqRatio = Math.min(1, cur / max);
        } catch { /* keep last */ }
        return;
    }
    const now = Date.now();
    if (now - lastPowerPoll < 10_000) return;
    lastPowerPoll = now;
    void refreshPowerWinMac();
}

async function refreshPowerWinMac() {
    try {
        if (platform() === "win32") {
            // Win32_Battery.BatteryStatus: 1 = discharging (on battery); anything
            // else = running on AC. No battery (desktop) → empty → AC.
            const { stdout } = await pexecFile(psExe(), [
                "-NoProfile", "-NonInteractive", "-Command",
                "(Get-CimInstance Win32_Battery | Select-Object -First 1 -ExpandProperty BatteryStatus)",
            ], { timeout: 8000 });
            const s = stdout.trim();
            onAC = s === "" ? true : s !== "1";
        } else if (platform() === "darwin") {
            const { stdout } = await pexecFile("pmset", ["-g", "batt"], { timeout: 8000 });
            onAC = /AC Power/i.test(stdout);
        }
    } catch { onAC = true; }
}

// Scale the target duty DOWN when decodes are slow OR we're on battery: a FAST GPU
// on AC keeps full duty (scales up, stays responsive); a SLOW iGPU — or any machine
// on battery, where clocks are throttled — yields far more GPU-idle time so the
// compositor/mouse stay smooth. Auto-adapts to hardware AND power state.
function effectiveDuty(base: number): number {
    const TARGET = 500;   // ms — a decode this quick barely disturbs the desktop
    let scaled = base * (TARGET / Math.max(TARGET, lastHeavyDur));
    if (!onAC) scaled *= 0.5;   // on battery, halve our GPU share on top of that
    return Math.min(0.95, Math.max(0.05, scaled));
}

// The current effective processing level, for the sidebar's live label:
//   "live"    — full interim captions
//   "reduced" — interim captions, throttled (GPU shared)
//   "finals"  — interim off, only final (post-utterance) captions
function effectiveTier(): "live" | "reduced" | "finals" {
    const p = partialPolicy();
    if (!p.allow) return "finals";
    return p.duty >= 0.5 ? "live" : "reduced";
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Kill whatever is holding our loopback port before we spawn. When Vesktop is
// hard-quit/restarted (or crashes) its whisper-server child is orphaned rather
// than terminated, and that orphan keeps the port AND a CPU core — a new session
// then either collides or, worse, talks to the STALE (possibly slower/old-build)
// server. Reaping the port on every (re)spawn guarantees the live server is
// always the one WE just started, with the current binary + flags. Best-effort
// and cross-platform; a failure just falls through to the spawn.
async function freePort(port: number): Promise<void> {
    const wantPort = String(port);
    try {
        if (platform() === "linux") {
            // Self-contained: scan /proc for a whisper-server started on our port.
            // No lsof/fuser dependency — those aren't guaranteed on Vesktop's PATH
            // (NixOS minimal env), which would make an external-tool reap a silent
            // no-op and let the orphan survive.
            let pids: string[] = [];
            try { pids = readdirSync("/proc").filter(d => /^\d+$/.test(d)); } catch { return; }
            for (const pid of pids) {
                let cmd = "";
                try { cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { continue; }
                const parts = cmd.split("\0");
                const pIdx = parts.indexOf("--port");
                if (parts.some(p => p.includes("whisper-server")) && pIdx >= 0 && parts[pIdx + 1] === wantPort) {
                    try { process.kill(parseInt(pid, 10), "SIGKILL"); log(`reaped stale whisper-server pid ${pid}`); } catch { /* ignore */ }
                }
            }
        } else if (platform() === "win32") {
            let out = "";
            try { out = (await pexecFile(sys32("netstat.exe"), ["-ano"])).stdout; } catch { return; }
            const pids = new Set<string>();
            for (const line of out.split("\n")) {
                if (line.includes(":" + port) && /LISTENING/i.test(line)) {
                    const cols = line.trim().split(/\s+/);
                    const pid = cols[cols.length - 1];
                    if (/^\d+$/.test(pid) && pid !== "0") pids.add(pid);
                }
            }
            for (const pid of pids) { try { await pexecFile(sys32("taskkill.exe"), ["/F", "/PID", pid]); } catch { /* ignore */ } }
        } else {
            // macOS / other: lsof is present by default on darwin.
            let out = "";
            try { out = (await pexecFile("lsof", ["-ti", `tcp:${port}`])).stdout; } catch { return; }
            for (const pid of out.split(/\s+/).filter(Boolean)) {
                const n = parseInt(pid, 10);
                if (n > 0) { try { process.kill(n, "SIGKILL"); } catch { /* ignore */ } }
            }
        }
    } catch { /* best-effort */ }
}

// ── Download / verify / extract helpers ──────────────────────────────────────
function sha256File(p: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const h = createHash("sha256");
        const s = createReadStream(p);
        s.on("data", d => h.update(d));
        s.on("end", () => resolve(h.digest("hex")));
        s.on("error", reject);
    });
}

// Resumable, pausable download. Continues an existing partial at `dest` via an
// HTTP Range request (so a paused/interrupted big-model download picks up where it
// left off instead of restarting), and can be paused mid-stream: setDownloadPaused
// aborts the fetch, we keep the bytes already on disk, wait, then re-request the
// remainder. Progress is reported as (bytesDone, bytesTotal). Safe against a torn
// tail — we always re-Range from the actual on-disk size, and the SHA check at the
// call site is the final guard.
async function downloadResumable(url: string, dest: string, onProgress: (done: number, total: number) => void): Promise<void> {
    let start = 0;
    try { if (existsSync(dest)) start = statSync(dest).size; } catch { start = 0; }
    let total = 0;
    for (;;) {
        while (downloadPaused) await sleep(400);   // hold here until the user resumes
        const ac = new AbortController();
        currentDownloadAbort = ac;
        let res: Awaited<ReturnType<typeof fetch>>;
        try {
            res = await fetch(url, {
                redirect: "follow",
                signal: ac.signal,
                headers: start > 0 ? { Range: `bytes=${start}-` } : {},
            });
        } catch (e) {
            currentDownloadAbort = null;
            if (downloadPaused) continue;          // aborted by a pause → loop & wait
            throw e;
        }
        if (res.status === 416) { currentDownloadAbort = null; return; }   // range past EOF → already complete
        if (!res.ok || !res.body) { currentDownloadAbort = null; throw new Error(`GET ${url} → ${res.status}`); }
        const partial = res.status === 206;
        if (start > 0 && !partial) {               // server ignored Range → restart clean
            start = 0;
            try { rmSync(dest, { force: true }); } catch { /* ignore */ }
        }
        const len = Number(res.headers.get("content-length") || 0);
        total = partial ? start + len : len;
        let done = start;
        onProgress(done, total);
        const body = Readable.fromWeb(res.body as any);
        body.on("data", (c: Buffer) => { done += c.length; onProgress(done, total); });
        try {
            await pipeline(body, createWriteStream(dest, { flags: partial ? "a" : "w" }));
            currentDownloadAbort = null;
            return;                                 // finished
        } catch (e) {
            currentDownloadAbort = null;
            if (downloadPaused) {                    // paused mid-stream → resume from on-disk size
                try { start = existsSync(dest) ? statSync(dest).size : start; } catch { /* keep */ }
                continue;
            }
            throw e;
        }
    }
}

// Absolute paths to Windows system tools. We do NOT trust the spawned Electron
// process's PATH — on a locked-down box it can lack System32, so a bare
// `powershell`/`tar`/`netstat` spawn fails with ENOENT (this is the most likely
// cause of the "ENOENT" a tester hit right after the model download: the engine
// unpack step shelled out to a bare `powershell`). Resolve from %SystemRoot%.
function winRoot(): string { return process.env.SystemRoot || process.env.windir || "C:\\Windows"; }
function sys32(exe: string): string { return join(winRoot(), "System32", exe); }
function psExe(): string { return join(winRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"); }

async function extract(archive: string, kind: "zip" | "tgz", destDir: string): Promise<void> {
    mkdirSync(destDir, { recursive: true });
    if (kind === "zip") {
        if (platform() === "win32") {
            // Windows 10 (1803+) ships bsdtar as System32\tar.exe, which extracts
            // .zip too — try it (absolute path) first; fall back to PowerShell's
            // Expand-Archive (also absolute). Both resolved from %SystemRoot% so a
            // missing PATH can't ENOENT us.
            try {
                await pexecFile(sys32("tar.exe"), ["-xf", archive, "-C", destDir]);
                return;
            } catch { /* fall through to PowerShell */ }
            await pexecFile(psExe(), [
                "-NoProfile", "-NonInteractive", "-Command",
                `Expand-Archive -Force -LiteralPath '${archive}' -DestinationPath '${destDir}'`,
            ]);
        } else {
            await pexecFile("unzip", ["-o", archive, "-d", destDir]);
        }
    } else {
        // GNU/bsd tar handles .tar.gz on Linux & macOS.
        await pexecFile("tar", ["-xzf", archive, "-C", destDir]);
    }
}

// Does this Windows box have an NVIDIA GPU (→ fetch the CUDA build)?
async function windowsHasNvidia(): Promise<boolean> {
    try {
        const { stdout } = await pexecFile(psExe(), [
            "-NoProfile", "-NonInteractive", "-Command",
            "(Get-CimInstance Win32_VideoController).Name -join ';'",
        ], { timeout: 8000 });
        return /nvidia|geforce|rtx|gtx|quadro|tesla/i.test(stdout);
    } catch {
        try {
            const { stdout } = await pexecFile(sys32("wbem\\wmic.exe"), ["path", "win32_VideoController", "get", "name"], { timeout: 8000 });
            return /nvidia|geforce|rtx|gtx/i.test(stdout);
        } catch { return false; }
    }
}

// Pick the right prebuilt for this machine. `key` scopes the cache dir so a
// vendor/variant switch re-provisions cleanly. null → no upstream prebuilt (macOS).
async function selectBinAsset(): Promise<{ asset: BinAsset; key: string } | null> {
    const p = platform(), a = arch();
    if (p === "win32") {
        if (a === "x64") {
            if (await windowsHasNvidia()) return { asset: WIN_X64_CUDA, key: "win-x64-cuda" };
            return { asset: WIN_X64_BLAS, key: "win-x64-blas" };
        }
        return { asset: WIN_IA32, key: "win-ia32" };
    }
    if (p === "linux" && a === "x64") return { asset: LINUX_X64, key: "linux-x64" };
    if (p === "linux" && a === "arm64") return { asset: LINUX_ARM64, key: "linux-arm64" };
    return null;
}

// Recursively locate whisper-server[.exe] under a dir — robust to differing
// archive layouts (CPU vs CUDA zips nest it differently).
function findServerBinary(dir: string): string | null {
    const want = platform() === "win32" ? "whisper-server.exe" : "whisper-server";
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop()!;
        let entries;
        try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const full = join(d, e.name);
            if (e.isDirectory()) stack.push(full);
            else if (e.name === want) return full;
        }
    }
    return null;
}

// ── Resolve the server binary (env → cached → download → PATH) ────────────────
interface ResolvedBin { bin: string; libDir: string; }
async function resolveBinary(): Promise<ResolvedBin | null> {
    if (process.env.CC_WHISPER_BIN) {
        const bin = process.env.CC_WHISPER_BIN;
        return { bin, libDir: process.env.CC_WHISPER_LIBDIR || dirname(bin) };
    }

    const sel = await selectBinAsset();
    if (!sel) {
        // No upstream prebuilt (e.g. macOS): rely on PATH; whisper-server there
        // finds its own libs. If it isn't installed the spawn fails loudly.
        log(`no prebuilt whisper-server for ${platform()}-${arch()}; falling back to PATH`);
        return { bin: "whisper-server", libDir: "" };
    }
    const { asset } = sel;
    const home = join(dataDir(), "bin", REL, sel.key);

    let bin = findServerBinary(home);
    if (bin) return { bin, libDir: dirname(bin) };

    if (!cfg.autoDownload) {
        log("auto-download disabled and no cached binary; falling back to PATH");
        return { bin: "whisper-server", libDir: "" };
    }

    // Download + verify + extract.
    const msg = `Downloading speech engine (${asset.label})…`;
    setStatus("provisioning", msg);
    const tmp = join(dataDir(), `bin-dl.${asset.kind === "zip" ? "zip" : "tar.gz"}`);
    // The engine bundle is small; a stale partial from a PREVIOUS run could be for a
    // different asset (vendor switch), and resuming that would corrupt it — start clean.
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    try {
        await downloadResumable(asset.url, tmp, setProgress);
        status.message = msg; status.phase = "provisioning";
        const got = await sha256File(tmp);
        if (got !== asset.sha256) throw new Error(`binary checksum mismatch (${got})`);
        rmSync(home, { recursive: true, force: true });
        try { await extract(tmp, asset.kind, home); }
        catch (e) { throw new Error(`could not unpack speech engine (${(e as Error)?.message || e})`); }
        bin = findServerBinary(home);
        if (!bin) throw new Error("extracted bundle has no whisper-server");
        if (platform() !== "win32") chmodSync(bin, 0o755);
        log(`provisioned whisper-server (${asset.label}) → ${bin}`);
        return { bin, libDir: dirname(bin) };
    } finally {
        try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
}

// Which model each role uses. fast = small (light encoder → truly instant);
// best = the user's chosen quality model. Env vars (set by the Nix wrapper) point
// straight at store paths and skip downloading.
function modelKeyFor(role: Role): string {
    if (role === "fast") return "balanced";              // small
    return cfg.quality === "balanced" ? "accurate" : cfg.quality;  // best ≥ medium
}

// ── Resolve a model file (env → cached → download) ────────────────────────────
async function resolveModel(role: Role): Promise<string | null> {
    const envPath = role === "fast" ? process.env.CC_WHISPER_MODEL_FAST : process.env.CC_WHISPER_MODEL;
    if (envPath) return envPath;

    const key = modelKeyFor(role);
    const info = MODELS[key] || MODELS.balanced;
    const dest = join(dataDir(), "models", info.file);
    mkdirSync(dirname(dest), { recursive: true });

    // Trust an existing file if its size matches — re-hashing a 1.5 GB model on
    // every launch would be absurd; we verify SHA only right after download.
    if (existsSync(dest) && statSync(dest).size === info.size) return dest;

    if (!cfg.autoDownload) {
        setStatus("error", "Model not downloaded and auto-download is off");
        return null;
    }

    const label = `${key} model`;
    const dlMsg = `Downloading ${label}…`;
    setStatus("downloading-model", dlMsg);
    const tmp = dest + ".part";   // stable name + URL → a paused/partial .part resumes here
    try {
        await downloadResumable(info.url, tmp, setProgress);
        status.message = dlMsg; status.phase = "downloading-model";
        const got = await sha256File(tmp);
        if (got !== info.sha256) throw new Error(`model checksum mismatch (${got})`);
        rmSync(dest, { force: true });
        renameSync(tmp, dest);   // atomic within a dir
        log(`provisioned model → ${dest}`);
        return dest;
    } finally {
        try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
}

// Spawn the whisper-server for `role` if not up, resolve once it answers. Beam is
// per-request now, so no beam flag here. Idempotent; never throws.
async function ensureServerFor(role: Role): Promise<boolean> {
    const s = servers[role];
    if (s.proc && !s.proc.killed && s.readyPromise) return s.readyPromise;

    s.readyPromise = (async () => {
        try {
            const model = await resolveModel(role);
            if (!model || !existsSync(model)) { setStatus("error", "No model available"); return false; }
            const rb = await resolveBinary();
            if (!rb) { setStatus("error", "No speech engine available"); return false; }

            if (role === "fast") setStatus("starting", "Starting speech engine…");
            const lang = process.env.CC_WHISPER_LANG || cfg.language || "auto";
            const threads = String(process.env.CC_WHISPER_THREADS || cfg.threads || 4);

            const env = { ...process.env };
            if (rb.libDir && platform() === "linux") {
                env.LD_LIBRARY_PATH = rb.libDir + (env.LD_LIBRARY_PATH ? ":" + env.LD_LIBRARY_PATH : "");
            }

            await freePort(s.port);   // reclaim from an orphaned server

            const args = ["-m", model, "--host", HOST, "--port", String(s.port), "-t", threads, "-l", lang, "-nt"];
            const ac = Math.round(process.env.CC_WHISPER_AC ? Number(process.env.CC_WHISPER_AC) : cfg.audioCtx);
            if (ac && ac > 0) args.push("-ac", String(ac));

            log(`starting ${role}: -m ${model} --port ${s.port}`);
            const proc = spawn(rb.bin, args, {
                stdio: ["ignore", "pipe", "pipe"],
                cwd: rb.libDir || undefined,
                env,
            });
            s.proc = proc;
            // A spawn failure (e.g. ENOENT — binary path wrong / PATH fallback with
            // nothing installed) is emitted ASYNChronously on the child; with no
            // listener Node re-throws it as an uncaught exception, which Electron
            // shows as a "JavaScript error in the main process" dialog. Handle it so
            // it becomes a clean, surfaced status the renderer can show instead.
            proc.on("error", e => {
                const code = (e as NodeJS.ErrnoException)?.code;
                err(`whisper-server ${role} failed to spawn`, e);
                setStatus("error", code === "ENOENT"
                    ? `Speech engine binary not found (${rb.bin})`
                    : `Speech engine failed to start: ${(e as Error)?.message || e}`);
                s.proc = null;
                s.readyPromise = null;
            });
            // Run at the LOWEST OS priority so the compositor, Electron and games
            // always win CPU scheduling — whisper should only use what's left over.
            try { if (proc.pid) setPriority(proc.pid, 19); } catch { /* not permitted / unsupported */ }
            proc.stdout?.on("data", d => log(`${role}:`, String(d).trim()));
            proc.stderr?.on("data", d => log(`${role}:`, String(d).trim()));
            proc.on("exit", code => {
                log(`whisper-server ${role} exited (${code})`);
                s.proc = null;
                s.readyPromise = null;
                if (role === "fast" && status.phase === "ready") setStatus("idle");
            });

            const deadline = Date.now() + 120_000;
            while (Date.now() < deadline) {
                if (!s.proc || s.proc.killed) return false;
                try {
                    const res = await fetch(`http://${HOST}:${s.port}/`, { method: "GET" });
                    if (res.ok || res.status === 400 || res.status === 404) {
                        if (role === "fast") setStatus("ready", "Captions active");
                        return true;
                    }
                } catch { /* not listening yet */ }
                await sleep(250);
            }
            setStatus("error", "Speech engine did not start in time");
            return false;
        } catch (e) {
            err(`ensureServerFor(${role}) failed`, e);   // full stack → log file
            setStatus("error", String((e as Error)?.message || e));
            s.proc = null;
            return false;
        }
    })();

    return s.readyPromise;
}

function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
    const numChannels = 1, bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcm.length;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write("WAVE", 8);
    buf.write("fmt ", 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);            // PCM
    buf.writeUInt16LE(numChannels, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(byteRate, 28);
    buf.writeUInt16LE(blockAlign, 32);
    buf.writeUInt16LE(bitsPerSample, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(dataSize, 40);
    pcm.copy(buf, 44);
    return buf;
}

// whisper for a silent/noise clip emits placeholder tokens like "[BLANK_AUDIO]",
// "(silence)", "[ Music ]" or bare punctuation. Drop those.
function isJunk(text: string): boolean {
    const t = text.trim();
    if (!t) return true;
    if (/^[\[(].*[\])]$/.test(t)) return true;
    if (!/[\p{L}\p{N}]/u.test(t)) return true;
    return false;
}

// Called from the renderer's plugin start() and whenever a relevant setting
// changes. Applies config; if the chosen model changed under a live server,
// tears it down so ensureServer respawns with the new one. Kicks off warm-up so
// the first speaker isn't waiting on the model load.
export async function start(_: IpcMainInvokeEvent, opts?: Partial<Cfg>): Promise<void> {
    const prev = cfg;
    cfg = { ...cfg, ...(opts || {}) };
    // model (quality) and audioCtx are server-start-time → restart if they change.
    // beamSize is now per-request, so it does NOT need a restart.
    if ((servers.fast.proc || servers.best.proc) && (prev.quality !== cfg.quality || prev.audioCtx !== cfg.audioCtx)) {
        log(`engine model/flags changed (quality ${prev.quality}→${cfg.quality}, ac ${prev.audioCtx}→${cfg.audioCtx}); restarting`);
        await stop(_);
    }
    // Governor + power sampler (also tracks AC / CPU clock, useful without a GPU).
    if (!gpuSampler) {
        readPower();
        gpuSampler = setInterval(sampleGpu, 1000);
    }
    void ensureServerFor("fast");   // warm the instant tier
}

// Result of one decode: the text, an overall confidence 0..1 (mean per-word
// probability from whisper's verbose_json), and per-word probabilities so the UI
// can flag the exact uncertain words. Empty text = junk/no-speech.
interface Infer { text: string; confidence: number; words: Array<{ w: string; p: number }>; }
const EMPTY: Infer = { text: "", confidence: 0, words: [] };

// Runs one /inference on `role`'s server at the given beam size. Assumes the lock
// is held. Returns null on transport/server failure, EMPTY on junk.
async function doInferOn(role: Role, pcmB64: string, sampleRate: number, beam: number, temperature: number): Promise<Infer | null> {
    if (role === "best") lastBestUse = Date.now();   // keep it warm while in use; idle-evict otherwise
    if (!(await ensureServerFor(role))) return null;
    const pcm = Buffer.from(pcmB64, "base64");
    if (pcm.length < 2) return EMPTY;
    const wav = pcm16ToWav(pcm, sampleRate);

    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "utt.wav");
    form.append("response_format", "verbose_json");   // gives per-word probabilities
    form.append("temperature", String(temperature));
    form.append("beam_size", String(Math.max(1, Math.round(beam))));   // per-request (verified supported)
    const lang = process.env.CC_WHISPER_LANG || cfg.language;
    if (lang) form.append("language", lang);

    const res = await fetch(`http://${HOST}:${servers[role].port}/inference`, { method: "POST", body: form });
    const body = await res.text();
    if (!res.ok) { err(`/inference ${res.status}: ${body.slice(0, 200)}`); return null; }

    let j: any;
    try { j = JSON.parse(body); } catch {
        const t = body.trim();
        return isJunk(t) ? EMPTY : { text: t, confidence: 1, words: [] };
    }

    const text = String(j?.text ?? "").trim();
    const segs: any[] = Array.isArray(j?.segments) ? j.segments : [];
    const words: Array<{ w: string; p: number }> = [];
    let noSpeech = 0;
    for (const s of segs) {
        noSpeech = Math.max(noSpeech, Number(s?.no_speech_prob) || 0);
        if (Array.isArray(s?.words)) {
            for (const w of s.words) words.push({ w: String(w?.word ?? ""), p: Number(w?.probability) || 0 });
        }
    }
    if (noSpeech > 0.8 || isJunk(text)) return EMPTY;

    let confidence: number;
    if (words.length) {
        confidence = words.reduce((a, b) => a + b.p, 0) / words.length;
    } else {
        const lps = segs.map(s => Number(s?.avg_logprob)).filter(Number.isFinite);
        confidence = lps.length ? Math.exp(lps.reduce((a, b) => a + b, 0) / lps.length) : 1;
    }
    return { text, confidence, words };
}

// Tiered FINAL transcription. The renderer calls this per tier and upgrades the
// caption in place, escalating only when it's caught up + the GPU has room:
//   tier 0 — fast model, greedy: INSTANT first caption.
//   tier 1 — fast model, beam:  slower corrective pass (same warm server).
//   tier 2 — best (big) model, beam: heavily-throttled definitive pass.
// The renderer gates tiers 1/2 (see the cascade); here we just run the decode.
function tierSpec(tier: number): { role: Role; beam: number } {
    const beam = Math.max(1, Math.round(cfg.beamSize || 2));
    if (tier <= 0) return { role: "fast", beam: 1 };
    if (tier === 1) return { role: "fast", beam };
    return { role: "best", beam };
}

export async function transcribeTier(_: IpcMainInvokeEvent, pcmB64: string, sampleRate: number, tier: number, isSelf = false): Promise<Infer> {
    const heavy = tier >= 1;   // tier0 (instant) is never throttled; refinement is
    if (heavy) {
        if (Date.now() < nextHeavyAt) return EMPTY;         // still in the duty-cycle budget
        if (!partialPolicy().allow) return EMPTY;           // governor says no heavy work now
    }
    const { role, beam } = tierSpec(tier);
    await acquire(isSelf ? 0 : 1);   // own speech yields the GPU to remote speakers
    const t0 = Date.now();
    try { return (await doInferOn(role, pcmB64, sampleRate, beam, 0)) || EMPTY; }
    catch (e) { err(`transcribe tier ${tier} failed`, e); return EMPTY; }
    finally {
        if (heavy) {
            lastHeavyDur = Math.max(30, Date.now() - t0);
            const duty = effectiveDuty(partialPolicy().duty);
            nextHeavyAt = Date.now() + Math.round(lastHeavyDur * (1 / duty - 1));
        }
        release();
    }
}

// INTERIM transcription of the utterance-so-far while the speaker is still
// talking — always the fast model, greedy. Best-effort and GPU-aware: dropped
// (EMPTY) if busy, inside the duty-cycle cooldown, or under high external GPU
// demand, so live partials never backlog nor starve the compositor / a game.
export async function transcribePartial(_: IpcMainInvokeEvent, pcmB64: string, sampleRate: number, isSelf = false): Promise<Infer> {
    if (locked) return EMPTY;
    if (Date.now() < nextPartialAt) return EMPTY;   // own light budget (NOT the heavy one)
    const pol = partialPolicy();
    if (!pol.allow) return EMPTY;
    await acquire(isSelf ? 0 : 1);
    const t0 = Date.now();
    try { return (await doInferOn("fast", pcmB64, sampleRate, 1, 0)) || EMPTY; }
    catch { return EMPTY; }
    finally {
        lastPartialDur = Math.max(30, Date.now() - t0);
        // Partials are cheap (fast model, greedy) and are the "instant" feedback, so
        // their cooldown scales only with decode time (stay snappy on a fast GPU,
        // space out on a slow one) — NOT battery-halved like the refinement tiers.
        const duty = Math.min(0.9, Math.max(0.1, pol.duty * 500 / Math.max(500, lastPartialDur)));
        nextPartialAt = Date.now() + Math.round(lastPartialDur * (1 / duty - 1));
        release();
    }
}

export async function stop(_: IpcMainInvokeEvent): Promise<void> {
    for (const role of ["fast", "best"] as Role[]) {
        const s = servers[role];
        if (s.proc && !s.proc.killed) { try { s.proc.kill("SIGTERM"); } catch { /* ignore */ } }
        s.proc = null;
        s.readyPromise = null;
    }
    if (gpuSampler) { clearInterval(gpuSampler); gpuSampler = null; }
    try { popoutWin?.close(); } catch { /* ignore */ }
    popoutWin = null;
    if (status.phase === "ready" || status.phase === "starting") setStatus("idle");
}

// ── Pop-out window (own OS window, optional always-on-top) ────────────────────
// A real Electron BrowserWindow rendering the captions, so it can float over other
// apps. The renderer pushes ready-to-render caption data (names/colours/word-flags
// already computed — the window only ever assigns textContent, so a transcript
// can't inject markup). Pin/close live in the window's own titlebar (like Discord's
// popouts); pin → setAlwaysOnTop. All wrapped so it can never crash the main process.
let popoutWin: BrowserWindow | null = null;
let popoutIpcWired = false;

function popoutHtmlPath(): string {
    return join(dataDir(), "popout.html");
}

function writePopoutHtml(theme: any) {
    const v = (k: string, d: string) => JSON.stringify(String(theme?.[k] ?? d));
    // Colours are injected as JS string literals; the page reads them from CC_THEME.
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:hidden}
  body{font-family:${theme?.font || "sans-serif"};background:${theme?.bg || "#2b2d31"};color:${theme?.text || "#dbdee1"}}
  #bar{height:28px;display:flex;align-items:center;gap:6px;padding:0 8px;background:${theme?.headerBg || "#1e1f22"};border-bottom:1px solid ${theme?.border || "#111"};-webkit-app-region:drag;user-select:none}
  #title{flex:1;font-weight:700;font-size:12px;color:${theme?.accent || "#5865f2"}}
  .btn{-webkit-app-region:no-drag;cursor:pointer;color:${theme?.dim || "#949ba4"};font-size:12px;font-weight:700;padding:2px 5px;border-radius:4px;display:flex;align-items:center}
  .btn:hover{color:${theme?.text || "#fff"};background:rgba(127,127,127,.15)}
  .btn svg{display:block;width:15px;height:15px;fill:currentColor}
  #body{padding:8px 10px;height:calc(100% - 28px);overflow-y:auto;display:flex;flex-direction:column;gap:5px;scrollbar-width:thin}
  .row{font-size:14px;line-height:1.4;word-break:break-word}
  .nm{font-weight:700}
</style></head><body>
<div id="bar"><span id="title">Captions</span><span class="btn" id="pin" title="Pin on top"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.38 11.38a3 3 0 0 0 4.24 0l.03-.03a.5.5 0 0 0 0-.7L13.35.35a.5.5 0 0 0-.7 0l-.03.03a3 3 0 0 0 0 4.24L9 8.29a5 5 0 0 0-5.36 1.1l-.85.86a.5.5 0 0 0 0 .7l4.24 4.25L2.3 20.3a1 1 0 1 0 1.42 1.42l4.09-4.09 4.25 4.24a.5.5 0 0 0 .7 0l.86-.85a5 5 0 0 0 1.1-5.36l3.66-3.62Z"></path></svg></span><span class="btn" id="close" title="Close">\u2715</span></div>
<div id="body"></div>
<script>
const { ipcRenderer } = require('electron');
const body = document.getElementById('body'), pinEl = document.getElementById('pin');
const ACCENT = ${v("accent", "#5865f2")}, DIM = ${v("dim", "#949ba4")}, TEXT = ${v("text", "#dbdee1")}, WARN = ${v("warn", "#eab308")};
let pinned = false, auto = true;
document.getElementById('close').onclick = () => ipcRenderer.send('CC_POPOUT_CLOSE');
pinEl.onclick = () => { pinned = !pinned; ipcRenderer.send('CC_POPOUT_PIN', pinned); pinEl.style.color = pinned ? ACCENT : DIM; pinEl.style.background = pinned ? 'rgba(127,127,127,.15)' : ''; };
body.addEventListener('scroll', () => { auto = body.scrollHeight - body.scrollTop - body.clientHeight < 40; });
ipcRenderer.on('CC_POPOUT_DATA', (e, json) => { try { render(JSON.parse(json)); } catch (x) {} });
function render(caps) {
  body.replaceChildren();
  for (const c of caps) {
    const row = document.createElement('div'); row.className = 'row';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = c.name + ': '; nm.style.color = c.color || ACCENT; row.appendChild(nm);
    if (c.low) { const t = document.createElement('span'); t.textContent = '\u26A0\uFE0F '; row.appendChild(t); }
    const base = c.final ? TEXT : DIM;
    if (c.words && c.words.length) { for (const w of c.words) { const s = document.createElement('span'); s.textContent = w.w; s.style.color = w.low ? WARN : base; row.appendChild(s); } }
    else { const s = document.createElement('span'); s.textContent = c.text; s.style.color = c.low ? WARN : base; row.appendChild(s); }
    body.appendChild(row);
  }
  if (auto) body.scrollTop = body.scrollHeight;
}
</script></body></html>`;
    writeFileSync(popoutHtmlPath(), html, "utf8");
}

function wirePopoutIpc() {
    if (popoutIpcWired) return;
    popoutIpcWired = true;
    ipcMain.on("CC_POPOUT_PIN", (_e, pinned: boolean) => {
        try { popoutWin?.setAlwaysOnTop(!!pinned); } catch { /* ignore */ }
    });
    ipcMain.on("CC_POPOUT_CLOSE", () => { try { popoutWin?.close(); } catch { /* ignore */ } });
}

// Called from the renderer. action: "open" | "close" | "data" | "pin".
// Returns whether the window is currently alive (so the renderer can sync state).
export async function popout(_: IpcMainInvokeEvent, action: string, payload?: any): Promise<boolean> {
    try {
        if (action === "close") { popoutWin?.close(); return false; }
        if (action === "pin") { popoutWin?.setAlwaysOnTop(!!payload); return !!popoutWin; }
        if (action === "data") {
            if (popoutWin && !popoutWin.isDestroyed()) { popoutWin.webContents.send("CC_POPOUT_DATA", JSON.stringify(payload ?? [])); return true; }
            return false;
        }
        if (action === "open") {
            if (popoutWin && !popoutWin.isDestroyed()) { popoutWin.focus(); return true; }
            wirePopoutIpc();
            writePopoutHtml(payload?.theme || {});
            popoutWin = new BrowserWindow({
                width: 440, height: 340, minWidth: 220, minHeight: 120,
                frame: false, skipTaskbar: false, backgroundColor: payload?.theme?.bg || "#2b2d31",
                title: "Captions",
                webPreferences: { nodeIntegration: true, contextIsolation: false },
            });
            popoutWin.on("closed", () => { popoutWin = null; });
            await popoutWin.loadFile(popoutHtmlPath());
            return true;
        }
    } catch (e) {
        err("popout failed", e);
        popoutWin = null;
    }
    return !!popoutWin;
}
