/*
 * ClosedCaptions — shared native infrastructure.
 *
 * Helpers used by BOTH the caption engine (./native.ts) and sibling plugin
 * natives (../ClosedCaptionsNotes/native.ts). All plugin natives are bundled
 * into one Electron main-process file, so importing from here gives every
 * consumer the SAME module instance: one log file, one download pause
 * switch, one engine-extension registry.
 *
 * This file exists separately from native.ts on purpose: Vencord registers
 * EVERY export of a plugin's native.ts as an ipcMain.handle() channel, so
 * native.ts must only export IPC-shaped functions — shared constants and
 * helpers with non-IPC signatures live here instead.
 */

import type { ChildProcess } from "child_process";
import { execFile } from "child_process";
import { createHash } from "crypto";
import { app } from "electron";
import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { arch, platform } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { promisify } from "util";

const pexecFile = promisify(execFile);

// ── Shared types ─────────────────────────────────────────────────────────────
export interface BinAsset { url: string; sha256: string; kind: "zip" | "tgz"; label: string; }
export interface ResolvedBin { bin: string; libDir: string; }
export interface Srv { proc: ChildProcess | null; readyPromise: Promise<boolean> | null; port: number; }
export type Phase = "idle" | "provisioning" | "downloading-model" | "starting" | "ready" | "error";

// Loopback base port (the whisper servers use PORT and PORT+1; the notes LLM
// uses PORT+2).
export const PORT = parseInt(process.env.CC_WHISPER_PORT || "58273", 10);

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function dataDir(): string {
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
export function logFilePath(): string { return join(dataDir(), "closed-captions.log"); }
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

export function log(...a: any[]) { console.log("[ClosedCaptions]", ...a); fileLog("LOG", a); }
export function err(...a: any[]) { console.error("[ClosedCaptions]", ...a); fileLog("ERR", a); }

// ── Engine extension hooks ───────────────────────────────────────────────────
// Sibling plugin natives (ClosedCaptionsNotes) register here at module load:
// `tick` rides the caption engine's 1 s governor sample (their drain
// heartbeat + idle eviction), `stop` fires when the caption engine stops so
// dependent processes (the notes LLM) go down with it. Callbacks must guard
// their own enabled state — registration is process-lifetime.
export interface EngineExtension { tick?: () => void; stop?: () => void; }
const engineExtensions: EngineExtension[] = [];
export function registerEngineExtension(ext: EngineExtension) {
    engineExtensions.push(ext);
}
export function fireEngineExtensions(hook: "tick" | "stop") {
    for (const ext of engineExtensions) {
        try { ext[hook]?.(); } catch (e) { err(`engine extension ${hook} failed`, e); }
    }
}

// ── Download pause state (one switch for every provisioning download) ───────
let downloadPaused = false;
let currentDownloadAbort: AbortController | null = null;

export function isDownloadPaused(): boolean { return downloadPaused; }

// Pause/resume the in-flight provisioning download (engine binary or model) so
// the user can free up bandwidth. Pausing aborts the current HTTP stream but
// KEEPS the partial file; the downloader loop waits, then resumes with a Range
// header on unpause (see downloadResumable).
export function setDownloadPausedState(paused: boolean) {
    downloadPaused = !!paused;
    if (downloadPaused && currentDownloadAbort) { try { currentDownloadAbort.abort(); } catch { /* ignore */ } }
    log(downloadPaused ? "download paused by user" : "download resumed by user");
}

// ── Download / verify / extract helpers ──────────────────────────────────────
export function sha256File(p: string): Promise<string> {
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
export async function downloadResumable(url: string, dest: string, onProgress: (done: number, total: number) => void): Promise<void> {
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
export function winRoot(): string { return process.env.SystemRoot || process.env.windir || "C:\\Windows"; }
export function sys32(exe: string): string { return join(winRoot(), "System32", exe); }
export function psExe(): string { return join(winRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"); }

export async function extract(archive: string, kind: "zip" | "tgz", destDir: string): Promise<void> {
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

// Kill whatever is holding our loopback port before we spawn. When Vesktop is
// hard-quit/restarted (or crashes) its whisper-server/llama-server child is
// orphaned rather than terminated, and that orphan keeps the port AND a CPU
// core — a new session then either collides or, worse, talks to the STALE
// (possibly slower/old-build) server. Reaping the port on every (re)spawn
// guarantees the live server is always the one WE just started, with the
// current binary + flags. Best-effort and cross-platform; a failure just
// falls through to the spawn.
export async function freePort(port: number, procName = "whisper-server"): Promise<void> {
    const wantPort = String(port);
    try {
        if (platform() === "linux") {
            // Self-contained: scan /proc for our server started on this port.
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
                if (parts.some(p => p.includes(procName)) && pIdx >= 0 && parts[pIdx + 1] === wantPort) {
                    try { process.kill(parseInt(pid, 10), "SIGKILL"); log(`reaped stale ${procName} pid ${pid}`); } catch { /* ignore */ }
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
