/*
 * ClosedCaptionsNotes — native (Electron main process) side.
 *
 * Session-notes extension for ClosedCaptions: maintains a per-channel knowledge
 * base of key information extracted from the live call transcript — the D&D use
 * case: "the baron is secretly a lich" gets written down somewhere durable,
 * deduplicated, and easy to read later.
 *
 * This file is the whole notes backend: LLM provisioning (llama.cpp), the
 * markdown knowledge vault (+ git versioning), the summarization queue, and the
 * notes pop-out window. It plugs into the ClosedCaptions native module (same
 * Electron main-process bundle, shared module instance) for the parts that must
 * stay coordinated with the caption engine:
 *
 *   - shared download/extract/port helpers (one pause switch for all downloads)
 *   - the GPU governor: notes passes only run when the whisper lock is free and
 *     external GPU demand is low (registerEngineExtension ticks us at 1 Hz)
 *   - engine stop: killing the caption engine also drops the notes LLM
 *
 * Architecture mirrors the whisper engine exactly:
 *   - ONE warm llama.cpp server (llama-server, OpenAI-compatible), provisioned
 *     the same way: CC_LLM_BIN/CC_LLM_MODEL env (nix store paths) → cached copy
 *     in userData → download a pinned prebuilt release + a GGUF model → PATH.
 *   - Model auto-scales to the machine like the whisper tiers: <12 GB RAM gets
 *     Qwen3-1.7B, everything else Qwen3-4B-Instruct; Qwen3-8B is an explicit
 *     opt-in for big GPUs. Better models give better notes but aren't required.
 *   - Strictly lowest priority: OS priority 19, runs only when the whisper lock
 *     is free AND external GPU demand is low AND a duty-cycle cooldown has
 *     passed — EXCEPT while the user has the notes panel open (boost), where
 *     pending work runs immediately because they're actively waiting on it.
 *   - Idle-evicted after a few minutes so the model's RAM is only held around
 *     the (default 15-minute) summarization cadence.
 *
 * The knowledge store is the dedup mechanism: every pass feeds the EXISTING
 * facts back to the model, which replies with JSON ops — new facts, updates to
 * existing facts (by id), and removals — rather than an append-only summary.
 */

import { ChildProcess, execFile, spawn } from "child_process";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { arch, platform, setPriority, totalmem } from "os";
import { dirname, join } from "path";
import { promisify } from "util";

import { captionConfig, externalDemand, isDecodeBusy, isOnAC } from "../ClosedCaptions/native";
import type { BinAsset, Phase, ResolvedBin, Srv } from "../ClosedCaptions/nativeShared";
import {
    dataDir, downloadResumable, err, extract, freePort, log, PORT,
    registerEngineExtension, sha256File, sleep,
} from "../ClosedCaptions/nativeShared";

const pexecFile = promisify(execFile);
const HOST = "127.0.0.1";

// ── Notes pop-out window ──────────────────────────────────────────────────────
// Same pattern as the captions pop-out: its own OS window, pin-on-top, data
// pushed pre-rendered (file headers + rows) and only ever assigned textContent.
let notesPopoutWin: BrowserWindow | null = null;
let notesPopoutIpcWired = false;

function notesPopoutHtmlPath(): string {
    return join(dataDir(), "notes-popout.html");
}

function writeNotesPopoutHtml(theme: any) {
    const v = (k: string, d: string) => JSON.stringify(String(theme?.[k] ?? d));
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:hidden}
  body{font-family:${theme?.font || "sans-serif"};background:${theme?.bg || "#2b2d31"};color:${theme?.text || "#dbdee1"}}
  #bar{height:28px;display:flex;align-items:center;gap:6px;padding:0 8px;background:${theme?.headerBg || "#1e1f22"};border-bottom:1px solid ${theme?.border || "#111"};-webkit-app-region:drag;user-select:none}
  #title{flex:1;font-weight:700;font-size:12px;color:${theme?.accent || "#5865f2"}}
  .btn{-webkit-app-region:no-drag;cursor:pointer;color:${theme?.dim || "#949ba4"};font-size:12px;font-weight:700;padding:2px 5px;border-radius:4px}
  #body{box-sizing:border-box;padding:8px 12px;height:calc(100% - 28px);overflow-y:auto;display:flex;flex-direction:column;gap:5px;scrollbar-width:thin;scrollbar-color:${theme?.scrollThumb || "rgba(255,255,255,0.16)"} transparent}
  .file{font-size:11px;font-weight:700;color:${theme?.dim || "#949ba4"};margin-top:6px}
  .row{font-size:13px;line-height:1.45;word-break:break-word}
  .sj{font-weight:700}
</style></head><body>
<div id="bar"><span id="title">Notes</span><span class="btn" id="pin" title="Pin on top">📌</span><span class="btn" id="close" title="Close">✕</span></div>
<div id="body"></div>
<script>
const { ipcRenderer } = require('electron');
const body = document.getElementById('body'), pinEl = document.getElementById('pin');
const ACCENT = ${v("accent", "#5865f2")}, DIM = ${v("dim", "#949ba4")}, NAME = ${v("name", "#f2f3f5")};
let pinned = false;
document.getElementById('close').onclick = () => ipcRenderer.send('CC_NPOPOUT_CLOSE');
pinEl.onclick = () => { pinned = !pinned; ipcRenderer.send('CC_NPOPOUT_PIN', pinned); pinEl.style.color = pinned ? ACCENT : DIM; };
ipcRenderer.on('CC_NPOPOUT_DATA', (e, json) => { try { render(JSON.parse(json)); } catch (x) {} });
function render(sections) {
  body.replaceChildren();
  if (!sections.length) { const d = document.createElement('div'); d.className = 'row'; d.style.color = DIM; d.textContent = 'Nothing noted this session yet.'; body.appendChild(d); return; }
  for (const sec of sections) {
    const h = document.createElement('div'); h.className = 'file'; h.textContent = sec.file; body.appendChild(h);
    for (const r of sec.rows) {
      const row = document.createElement('div'); row.className = 'row';
      const dot = document.createElement('span'); dot.textContent = '• '; dot.style.color = ACCENT; row.appendChild(dot);
      if (r.subject) { const s = document.createElement('span'); s.className = 'sj'; s.style.color = NAME; s.textContent = r.subject + ': '; row.appendChild(s); }
      const t = document.createElement('span'); t.textContent = r.text; row.appendChild(t);
      body.appendChild(row);
    }
  }
}
</script></body></html>`;
    writeFileSync(notesPopoutHtmlPath(), html, "utf8");
}

function wireNotesPopoutIpc() {
    if (notesPopoutIpcWired) return;
    notesPopoutIpcWired = true;
    ipcMain.on("CC_NPOPOUT_PIN", (_e, pinned: boolean) => {
        try { notesPopoutWin?.setAlwaysOnTop(!!pinned); } catch { /* ignore */ }
    });
    ipcMain.on("CC_NPOPOUT_CLOSE", () => { try { notesPopoutWin?.close(); } catch { /* ignore */ } });
}

export async function notesPopout(_: IpcMainInvokeEvent, action: string, payload?: any): Promise<boolean> {
    try {
        if (action === "close") { notesPopoutWin?.close(); return false; }
        if (action === "data") {
            if (notesPopoutWin && !notesPopoutWin.isDestroyed()) {
                notesPopoutWin.webContents.send("CC_NPOPOUT_DATA", JSON.stringify(payload ?? []));
                return true;
            }
            return false;
        }
        if (action === "open") {
            if (notesPopoutWin && !notesPopoutWin.isDestroyed()) { notesPopoutWin.focus(); return true; }
            wireNotesPopoutIpc();
            writeNotesPopoutHtml(payload?.theme || {});
            notesPopoutWin = new BrowserWindow({
                width: 440, height: 420, minWidth: 220, minHeight: 140,
                frame: false, skipTaskbar: false, backgroundColor: payload?.theme?.bg || "#2b2d31",
                title: "Session notes",
                webPreferences: { nodeIntegration: true, contextIsolation: false },
            });
            notesPopoutWin.on("closed", () => { notesPopoutWin = null; });
            await notesPopoutWin.loadFile(notesPopoutHtmlPath());
            return true;
        }
    } catch (e) {
        err("notes popout failed", e);
        notesPopoutWin = null;
    }
    return !!notesPopoutWin;
}

// ── LLM models + engine (pinned, provisioned like whisper) ───────────────────

interface LlmModelInfo { file: string; url: string; sha256: string; size: number; }
const LLM_MODELS: Record<string, LlmModelInfo> = {
    // Hybrid-thinking model; thinking is suppressed by the JSON grammar +
    // enable_thinking=false. Small enough for weak/portable machines.
    small: {
        file: "Qwen3-1.7B-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf",
        sha256: "b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897",
        size: 1107409472,
    },
    // Non-thinking instruct variant — the default: strong extraction at ~2.4 GB.
    standard: {
        file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
        size: 2497281120,
    },
    // Explicit opt-in only (never auto-selected): ~5 GB, wants a real GPU.
    large: {
        file: "Qwen3-8B-Q4_K_M.gguf",
        url: "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf",
        sha256: "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785",
        size: 5027783488,
    },
};

// Pinned llama.cpp release (same philosophy as whisper's REL). Windows x64
// tries Vulkan first (works on every GPU vendor) and falls back to the CPU
// build if the Vulkan server can't start (no/old driver). Linux prebuilt is
// CPU-only — this repo's own machines inject a nix Vulkan build via CC_LLM_BIN.
const LLM_REL = "b11375";
const LLM_REL_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLM_REL}`;
const LLM_BIN_ASSETS: Record<string, BinAsset[]> = {
    "win32-x64": [
        { url: `${LLM_REL_BASE}/llama-${LLM_REL}-bin-win-vulkan-x64.zip`, sha256: "36ab68f330ee4ccde52c035167d54fc80f65410114df06d7c0a65eb03509f7f8", kind: "zip", label: "Vulkan" },
        { url: `${LLM_REL_BASE}/llama-${LLM_REL}-bin-win-cpu-x64.zip`, sha256: "90c6721cb0b8d37658b00da9f3e0521e1749c2e5593fb2553a397cc835f1fa9d", kind: "zip", label: "CPU" },
    ],
    "linux-x64": [
        { url: `${LLM_REL_BASE}/llama-${LLM_REL}-bin-ubuntu-x64.tar.gz`, sha256: "e74863674a364f111223a1832e3bec458326e0c24a6779d26a217decaaa71c56", kind: "tgz", label: "CPU" },
    ],
    "linux-arm64": [
        { url: `${LLM_REL_BASE}/llama-${LLM_REL}-bin-ubuntu-arm64.tar.gz`, sha256: "d566be1d9a0d41ef2fd1ce0fd28a473f8c54eb272cc7582fdf38178115d3741b", kind: "tgz", label: "CPU" },
    ],
    "darwin-arm64": [
        { url: `${LLM_REL_BASE}/llama-${LLM_REL}-bin-macos-arm64.tar.gz`, sha256: "a929fcaf78cf9975c177d5436cb4c2acae6484323b143c110119d3d1a20f367f", kind: "tgz", label: "Metal" },
    ],
};

const LLM_PORT = PORT + 2;
const LLM_IDLE_MS = 240_000;    // free the model's RAM between 15-min passes

interface NotesCfg {
    enabled: boolean;
    dir: string;          // "" = <Documents>/discord-notes
    model: string;        // "auto" | "small" | "standard" | "large"
    customPrompt: string; // user's own extraction criteria ("" = default)
    apiUrl: string;       // external OpenAI-compatible endpoint ("" = run locally)
    apiModel: string;     // model name sent to the external endpoint
    apiKey: string;       // bearer token for the external endpoint ("" = none)
    cleanupAfterSession: boolean; // one consolidation pass when a call ends
}
let notesCfg: NotesCfg = { enabled: true, dir: "", model: "auto", customPrompt: "", apiUrl: "", apiModel: "", apiKey: "", cleanupAfterSession: true };

// External provider instead of the self-provisioned local engine: any
// OpenAI-compatible /v1/chat/completions server (this repo's tailnet
// llama-server router, Ollama, a cloud key — the user's choice). Setting/env
// gives the BASE url (http://host:8601) or a full path; local provisioning
// stays the default for people with no setup of their own.
function llmApiBase(): string {
    return (notesCfg.apiUrl || process.env.CC_LLM_URL || "").trim().replace(/\/+$/, "");
}

// When the external endpoint is network-unreachable (mesh router not running
// here, tailnet down, …) we fall back to the local engine and only retry the
// external one after a backoff — notes keep flowing either way.
let externalBackoffUntil = 0;
function llmExternalActive(): boolean {
    return !!llmApiEndpoint() && Date.now() >= externalBackoffUntil;
}
function isNetErr(e: any): boolean {
    const s = String((e as any)?.name || "") + " " + String((e as any)?.cause?.code || (e as Error)?.message || e);
    return /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|TimeoutError|AbortError/i.test(s);
}

// Request-compat level for external providers, learned per session: 0 = full
// llama.cpp body, 1 = without the llama-specific chat_template_kwargs,
// 2 = plain OpenAI body (no response_format either). Strict providers reject
// unknown/unsupported params with a 400, so we step down and remember.
// (Declaration lives here with the other external-provider state — it was
// lost once in a refactor and took every notes pass down with it.)
let llmApiCompat = 0;
function llmApiEndpoint(): string {
    const base = llmApiBase();
    if (!base) return "";
    if (/\/chat\/completions$/.test(base)) return base;
    if (/\/v1$/.test(base)) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
}
let notesBoost = false;         // notes panel open → user is waiting, skip the gates

const llm: Srv = { proc: null, readyPromise: null, port: LLM_PORT };
let llmBusy = false;            // a summarization pass is in flight
let lastLlmUse = 0;
let lastLlmDur = 4000;          // ms, measured generation time of the last pass
let nextLlmAt = 0;              // duty-cycle cooldown (notes are the lowest tier)

// Separate status object — whisper's status drives the caption UI and must
// not flicker because a notes model is downloading in the background.
let notesStatus: { phase: Phase | "summarizing"; message: string; done: number; total: number } =
    { phase: "idle", message: "", done: 0, total: 0 };
function setNotesStatus(phase: Phase | "summarizing", message = "") {
    notesStatus = { phase, message, done: 0, total: 0 };
    if (phase === "error") err("notes:", message);
    else log("notes:", phase, message || "");
}

// ── Knowledge vault (markdown IS the source of truth) ───────────────────────
// There is no hidden database: the Obsidian-style markdown tree under the
// notes dir is the single source of truth. Every pass PARSES the guild's
// files into facts, hands them to the model with ephemeral ids, applies the
// returned ops, and writes the files back. Manual edits are therefore
// first-class — whatever you write (or delete) is simply what the model sees
// next pass. Git (below) is the history. Layout:
//
//   <dir>/<Guild>/<Channel>.md          general facts + minor entities
//   <dir>/<Guild>/People/<Name>.md      characters ALWAYS own a page;
//   <dir>/<Guild>/Places|Items|…/<Name>.md   other entities at 3+ facts
//   <dir>/<Guild>/Schedule.md           out-of-game scheduling ledger
//   <dir>/<Guild>/Timeline.md           campaign chronology (dated bullets)
//   <dir>/<Guild>/Cast.md               USER-OWNED: who is the DM, who plays
//                                       whom — read, never written (after seed)
//   <dir>/<Guild>/Sessions/…            append-only per-call logs (not parsed)

const ENTITY_FILE_MIN = 3;   // facts about one subject before it earns its own file…
// …EXCEPT people and places: characters and locations ALWAYS get their own
// file, however little there is — so every name mention can link to a page.
const entityMin = (cat: string) => (cat === "person" || cat === "place" ? 1 : ENTITY_FILE_MIN);
const CATEGORY_DIRS: Record<string, string> = {
    person: "People", place: "Places", item: "Items", faction: "Factions",
    quest: "Quests", event: "Events", lore: "Lore", other: "Notes",
};
const DIR_CATEGORY: Record<string, string> = Object.fromEntries(
    Object.entries(CATEGORY_DIRS).map(([k, v]) => [v, k]));
// Guild-level ledger files, not per-subject pages.
const isLedger = (cat: string) => cat === "schedule" || cat === "timeline";
const VALID_CATS = new Set([...Object.keys(CATEGORY_DIRS), "schedule", "timeline"]);
const normCategory = (c: any) => {
    const k = String(c ?? "").toLowerCase().trim();
    return VALID_CATS.has(k) ? k : "other";
};

function notesRootDir(): string {
    const d = notesCfg.dir || join(app.getPath("documents"), "discord-notes");
    mkdirSync(d, { recursive: true });
    return d;
}

function sanitizeName(name: string): string {
    const s = name.replace(/[^\p{L}\p{N} _()\[\]-]+/gu, "_").replace(/\s+/g, " ").trim();
    return s || "channel";
}

const stamp = () => new Date().toISOString().slice(0, 16).replace("T", " ");
const guildKey = (g: string) => g || "DMs";   // DM/group calls share one tree
const guildDir = (gName: string) => join(notesRootDir(), sanitizeName(gName));
const eKey = (category: string, subject: string) => `${category}|${subject.toLowerCase()}`;
const stripLinks = (t: string) => t.replace(/\[\[([^\]]*)\]\]/g, "$1");

// Obsidian-style [[wikilinks]]: mentions of entities that have their own page
// become links. Longest subject first so "Marrowgate Chapel" wins over
// "Marrowgate"; lookarounds stop re-wrapping text that's already linked.
function linkify(text: string, pageSubjects: string[], selfSubject = ""): string {
    const subjects = pageSubjects.filter(s => s && s !== selfSubject).sort((a, b) => b.length - a.length);
    if (!subjects.length) return text;
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\[\\p{L}\\p{N}])(?:${subjects.map(esc).join("|")})(?![\\]\\p{L}\\p{N}])`, "gu");
    return text.replace(re, m => `[[${m}]]`);
}

// One fact = one bullet somewhere in the tree. Where it lives IS its metadata:
// a bullet in People/Torvald.md is subject=Torvald/category=person; a
// `- **X** (item): …` bullet in a channel page is a minor entity; a plain
// bullet is general. Text is stored/compared with wikilink brackets stripped.
interface VFact {
    text: string;
    subject: string;      // "" = general
    category: string;
    date?: string;        // YYYY-MM-DD — timeline entries only (the EVENT date)
    noted?: string;       // YYYY-MM-DD the fact was added/last changed — persisted
    //                       by the "## <date>" section header the bullet sits under;
    //                       files render newest group first so changes lead
    chanFile?: string;    // channel page the fact renders into (general/minor)
}

// The "## YYYY-MM-DD" section header a bullet sits under IS its noted-date.
const DATE_HEADER_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;

function parseBullet(raw: string): { text: string; subject: string; category: string; date?: string } | null {
    const m = raw.match(/^\s*-\s+(.*)$/);
    if (!m) return null;
    let body = m[1].trim();
    let date: string | undefined;
    const dm = body.match(/^\((\d{4}-\d{2}-\d{2})\)\s+(.*)$/);
    if (dm) { date = dm[1]; body = dm[2]; }
    const sm = body.match(/^\*\*([^*]+)\*\*(?:\s*\(([a-z]+)\))?:\s*(.*)$/);
    if (sm) return { subject: stripLinks(sm[1]).trim(), category: normCategory(sm[2] || "other"), text: stripLinks(sm[3]).trim(), date };
    const text = stripLinks(body).trim();
    return text ? { subject: "", category: "other", text, date } : null;
}

function fileLines(p: string): string[] {
    try { return readFileSync(p, "utf8").split("\n"); } catch { return []; }
}

interface Vault { gName: string; gDir: string; facts: VFact[]; channelFiles: string[]; }

// Files at the guild root that are NOT channel pages.
const SPECIAL_FILES = new Set(["Schedule.md", "Timeline.md", "Cast.md", "Voices.md"]);

function parseGuild(gName: string, curChanFile: string): Vault {
    migrateLegacyStores();
    const gDir = guildDir(gName);
    const facts: VFact[] = [];
    const channelFiles = new Set<string>([curChanFile]);
    try {
        for (const e of readdirSync(gDir, { withFileTypes: true })) {
            if (e.isFile() && e.name.endsWith(".md")) {
                if (e.name === "Cast.md" || e.name === "Voices.md") continue;   // user-owned config
                if (e.name === "Schedule.md" || e.name === "Timeline.md") {
                    const cat = e.name === "Schedule.md" ? "schedule" : "timeline";
                    let noted: string | undefined;
                    for (const line of fileLines(join(gDir, e.name))) {
                        const dh = line.match(DATE_HEADER_RE);
                        if (dh) { noted = dh[1]; continue; }
                        const b = parseBullet(line);
                        if (b?.text) facts.push({ text: b.text, subject: "", category: cat, date: b.date, noted });
                    }
                } else {
                    channelFiles.add(e.name);
                    let inPages = false;
                    let noted: string | undefined;
                    for (const line of fileLines(join(gDir, e.name))) {
                        const dh = line.match(DATE_HEADER_RE);
                        if (dh) { noted = dh[1]; inPages = false; continue; }
                        if (/^##\s*Pages\s*$/.test(line)) { inPages = true; continue; }
                        if (/^#/.test(line)) { inPages = false; continue; }
                        if (inPages) continue;                        // links section, regenerated
                        const b = parseBullet(line);
                        if (b?.text) facts.push({ ...b, category: b.subject ? b.category : "other", chanFile: e.name, noted });
                    }
                }
            } else if (e.isDirectory() && DIR_CATEGORY[e.name]) {
                const cat = DIR_CATEGORY[e.name];
                for (const f of readdirSync(join(gDir, e.name))) {
                    if (!f.endsWith(".md")) continue;
                    const lines = fileLines(join(gDir, e.name, f));
                    const h1 = lines.find(l => /^#\s+/.test(l));
                    const subject = stripLinks(h1 ? h1.replace(/^#\s+/, "").trim() : f.slice(0, -3));
                    let noted: string | undefined;
                    for (const line of lines) {
                        const dh = line.match(DATE_HEADER_RE);
                        if (dh) { noted = dh[1]; continue; }
                        const b = parseBullet(line);
                        if (b?.text) facts.push({ text: b.text, subject, category: cat, date: b.date, noted });
                    }
                }
            }
        }
    } catch { /* guild dir may not exist yet */ }
    return { gName, gDir, facts, channelFiles: [...channelFiles] };
}

// Render a file body as newest-first date groups: changes lead at the top
// under today's "## <date>" header, older information sits below under its
// own date headers, legacy bullets without a date land under "## Earlier".
function dateGroupedLines(list: VFact[], render: (f: VFact) => string): string[] {
    const groups = new Map<string, VFact[]>();
    for (const f of list) {
        const k = f.noted || "";
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(f);
    }
    const keys = [...groups.keys()].sort((a, b) => (b || "0000").localeCompare(a || "0000"));   // newest first, "" last
    const out: string[] = [];
    for (const k of keys) {
        out.push("", `## ${k || "Earlier"}`, "");
        for (const f of groups.get(k)!) out.push(render(f));
    }
    return out;
}

// Regenerate the guild tree from the fact list. Only files whose content
// actually changed are rewritten; entity pages whose facts disappeared are
// deleted (git keeps the history). Cast.md and Sessions/ are never touched.
function writeGuild(v: Vault) {
    mkdirSync(v.gDir, { recursive: true });
    const entities = new Map<string, { subject: string; category: string; facts: VFact[] }>();
    for (const f of v.facts) {
        if (!f.subject || isLedger(f.category)) continue;
        const e = entities.get(eKey(f.category, f.subject)) || { subject: f.subject, category: f.category, facts: [] };
        e.facts.push(f);
        entities.set(eKey(f.category, f.subject), e);
    }
    const majors = [...entities.values()].filter(e => e.facts.length >= entityMin(e.category));
    const pageSubjects = majors.map(e => e.subject);

    // "Played by" identity line for character pages: which DISCORD USER plays
    // this character — name and id, resolved from Cast.md + the call roster.
    // Sticky: once written, the existing line is preserved whenever the
    // current session can't re-resolve it (fresh restart, player absent).
    const cast = parseCast(v.gName);
    const roster = notesRoster.get(v.gName);
    const voices = parseVoices(v.gName);
    const norm = (s: string) => s.toLowerCase().trim();
    const playedByLine = (subject: string, existingRel: string): string | null => {
        const base = subject.replace(/\s*\(unnamed\)$/i, "").trim();
        let player = "";
        for (const p of cast.players) {
            if (p.chars.split(",").some(c => norm(c) === norm(subject) || norm(c) === norm(base))) { player = p.name; break; }
        }
        // A placeholder like "bob (unnamed)" names the PLAYER — but only
        // count it when the base actually matches a known participant
        // (otherwise "Hooded stranger (unnamed)" would claim a played-by).
        if (!player && /\(unnamed\)$/i.test(subject)) {
            const known = cast.players.some(p => norm(p.name) === norm(base))
                || norm(cast.dm) === norm(base)
                || (!!roster && [...roster.entries()].some(([l, w]) => norm(l) === norm(base) || norm(w.account) === norm(base)));
            if (known) player = base;
        }
        let account = "", id = "";
        if (roster) {
            for (const [label, who] of roster) {
                if (player ? (norm(label) === norm(player) || norm(who.account) === norm(player)) : norm(label) === norm(subject)) {
                    account = who.account; id = who.id;
                    if (!player) player = label;
                    break;
                }
            }
        }
        if (player) {
            const idPart = account || id ? ` (Discord: ${account || "?"}${id ? `, id ${id}` : ""})` : "";
            return `_Played by ${player}${idPart}._`;
        }
        // Can't resolve right now — keep whatever an earlier session wrote.
        try {
            const old = readFileSync(join(v.gDir, existingRel), "utf8").split("\n").find(l => /^_Played by .*_\s*$/.test(l));
            if (old) return old;
        } catch { /* new page */ }
        return null;
    };

    const files = new Map<string, string>();   // rel path → content
    for (const e of majors) {
        const dir = CATEGORY_DIRS[e.category] || CATEGORY_DIRS.other;
        const label = e.category === "other" ? "" : `${e.category[0].toUpperCase()}${e.category.slice(1)} — `;
        // "X (unnamed)" = placeholder for a character whose real name isn't
        // known yet (player characters use the player's Discord name).
        // Resolved by the model when the name comes up, by the notes chat, or
        // by hand: renaming the file (and its bullets' mentions) IS the fix —
        // the markdown is the source of truth.
        const placeholder = /\(unnamed\)$/i.test(e.subject);
        const rel = join(dir, `${sanitizeName(e.subject)}.md`);
        const played = e.category === "person" ? playedByLine(e.subject, rel) : null;
        // Measured voice/cadence, logged with the character for later — from
        // the Voices.md mapping + the persisted prosody centroid.
        const charVoices = e.category === "person" ? voicesForSubject(voices, e.subject) : [];
        files.set(rel, [
            `# ${e.subject}`,
            "",
            `_${label}${v.gName}. Maintained automatically by ClosedCaptions session notes; updated ${stamp()}._`,
            ...(played ? ["", played] : []),
            ...(charVoices.length ? ["", `_Voice: ${charVoices.map(vl => describeVoice(v.gName, vl)).join("; ")}._`] : []),
            ...(placeholder ? [
                "",
                "_⚠ Placeholder name — the character's real name isn't known yet. Rename this",
                "file (or tell the notes chat) once it is._",
            ] : []),
            ...dateGroupedLines(e.facts, f => `- ${linkify(f.text, pageSubjects, e.subject)}`),
            "",
        ].join("\n"));
    }

    const schedule = v.facts.filter(f => f.category === "schedule");
    if (schedule.length) {
        files.set("Schedule.md", [
            `# Schedule — ${v.gName}`,
            "",
            `_Out-of-game scheduling. Maintained automatically by ClosedCaptions session notes; updated ${stamp()}._`,
            ...dateGroupedLines(schedule, f => `- ${linkify(f.text, pageSubjects)}`),
            "",
        ].join("\n"));
    }
    const timeline = v.facts.filter(f => f.category === "timeline");
    if (timeline.length) {
        files.set("Timeline.md", [
            `# Timeline — ${v.gName}`,
            "",
            `_Campaign chronology. Maintained automatically by ClosedCaptions session notes; updated ${stamp()}._`,
            ...dateGroupedLines(timeline, f => `- (${f.date || new Date().toISOString().slice(0, 10)}) ${linkify(f.text, pageSubjects)}`),
            "",
        ].join("\n"));
    }

    for (const chan of v.channelFiles) {
        const chanFacts = v.facts.filter(f => {
            if (isLedger(f.category) || (f.chanFile || v.channelFiles[0]) !== chan) return false;
            return !f.subject || (entities.get(eKey(f.category, f.subject))?.facts.length || 0) < entityMin(f.category);
        });
        files.set(chan, [
            `# Session notes — ${chan.replace(/\.md$/, "")}`,
            "",
            `_${v.gName}. Maintained automatically by ClosedCaptions session notes; updated ${stamp()}._`,
            ...dateGroupedLines(chanFacts, f => f.subject
                ? `- **${f.subject}**${f.category !== "other" ? ` (${f.category})` : ""}: ${linkify(f.text, pageSubjects)}`
                : `- ${linkify(f.text, pageSubjects)}`),
            ...(majors.length ? ["", "## Pages", "", ...majors.map(e => `- [[${e.subject}]]`)] : []),
            "",
        ].join("\n"));
    }

    // Write what changed; prune entity pages / ledgers we no longer produce.
    for (const [rel, content] of files) {
        const p = join(v.gDir, rel);
        let cur = "";
        try { cur = readFileSync(p, "utf8"); } catch { /* new file */ }
        // Ignore the volatile "updated <stamp>" line when deciding to rewrite,
        // so an unchanged file isn't churned (and git stays quiet).
        const strip = (s: string) => s.replace(/updated \d{4}-\d{2}-\d{2} \d{2}:\d{2}\./, "");
        if (strip(cur) !== strip(content)) {
            mkdirSync(dirname(p), { recursive: true });
            writeFileSync(p, content, "utf8");
        }
    }
    for (const dir of Object.values(CATEGORY_DIRS)) {
        let names: string[] = [];
        try { names = readdirSync(join(v.gDir, dir)); } catch { continue; }
        for (const f of names) {
            if (f.endsWith(".md") && !files.has(join(dir, f))) rmSync(join(v.gDir, dir, f), { force: true });
        }
    }
    for (const ledger of ["Schedule.md", "Timeline.md"]) {
        if (!files.has(ledger) && existsSync(join(v.gDir, ledger))) rmSync(join(v.gDir, ledger), { force: true });
    }
}

// ── Cast.md — who runs the game, who plays whom ─────────────────────────────
// User-owned config, read every RPG pass and injected into the prompt: the
// DM's narration is authoritative truth; the player→character map guards
// against misattribution. Seeded once from the speakers in the transcript.
function castPath(gName: string): string { return join(guildDir(gName), "Cast.md"); }

function seedCast(gName: string, speakers: string[]) {
    const p = castPath(gName);
    if (existsSync(p) || !speakers.length) return;
    mkdirSync(guildDir(gName), { recursive: true });
    writeFileSync(p, [
        `# Cast — ${gName}`,
        "",
        "_Edit me — the note-taker reads this file and never changes it. `- DM: <name>`",
        "marks whose narration is the source of truth; `- <name>: <character>, <character>`",
        "maps a player to the characters they play. Replace the ?s. Any plain sentence you",
        "write below the list is also given to the note-taker verbatim — use it for things",
        "the mappings can't express (name collisions, shared characters, nicknames)._",
        "",
        "- DM: ?",
        ...speakers.map(s => `- ${s}: ?`),
        "",
    ].join("\n"), "utf8");
    log(`seeded ${p} — edit it to mark the DM and character mappings`);
}

function parseCast(gName: string): { dm: string; players: Array<{ name: string; chars: string }>; notes: string[] } {
    const out = { dm: "", players: [] as Array<{ name: string; chars: string }>, notes: [] as string[] };
    let inItalicBlock = false;   // the seeded _Edit me…_ instruction paragraph
    for (const line of fileLines(castPath(gName))) {
        const m = line.match(/^\s*-\s+([^:]+):\s*(.+)$/);
        if (m) {
            const name = stripLinks(m[1]).trim();
            const val = stripLinks(m[2]).trim();
            if (!val || val === "?") continue;
            if (/^dm$/i.test(name)) out.dm = val;
            else out.players.push({ name, chars: val });
            continue;
        }
        // Any freeform prose in Cast.md rides into every prompt verbatim —
        // THE escape hatch for pathological naming ("two ethans: the player
        // ethan plays Greg, whose surname is also Ethan; a different player
        // Ethan plays a character literally named Ethan Vert Ethan").
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        if (inItalicBlock) { if (t.endsWith("_")) inItalicBlock = false; continue; }
        if (t.startsWith("_")) { if (!t.endsWith("_")) inItalicBlock = true; continue; }
        out.notes.push(t);
    }
    return out;
}

// ── Voice fingerprinting (tier 1: prosody, no ML deps) ──────────────────────
// The renderer computes a tiny prosody vector per DM utterance (pitch, pitch
// spread, brightness, syllable rate) and asks us for a cluster label; DM
// transcript lines then carry a "[voice N]" tag into the prompt. Clusters are
// a HEURISTIC HINT only — the DM may use one voice for several NPCs, may slip
// mid-scene, and subtle accents at the same pitch won't separate. Centroids
// persist per guild under .voices/ (cache data, not note content); the
// human-readable voice→NPC mapping lives in <Guild>/Voices.md, user-edited
// like Cast.md and read back into every RPG prompt. Tier 2 (real speaker
// embeddings via a small ONNX model) stays an upgrade option if these
// clusters prove too mushy in practice.
interface VoiceCluster { id: number; centroid: number[]; count: number; }
const VOICE_WEIGHTS = [4, 1, 1.5, 0.5];   // pitch dominates; see renderer's voiceFeatures
const VOICE_THRESHOLD = 0.3;              // ≈3+ semitone shift (log2 F0) reads as a new voice
const VOICE_MAX = 10;

function voiceClustersPath(gName: string): string {
    const d = join(notesRootDir(), ".voices");
    mkdirSync(d, { recursive: true });
    return join(d, `${sanitizeName(gName)}.json`);
}

function voicesPath(gName: string): string { return join(guildDir(gName), "Voices.md"); }

function parseVoices(gName: string): Array<{ voice: string; who: string }> {
    const out: Array<{ voice: string; who: string }> = [];
    for (const line of fileLines(voicesPath(gName))) {
        const m = line.match(/^\s*-\s+(voice \d+):\s*(.+)$/i);
        if (m && m[2].trim() && m[2].trim() !== "?") out.push({ voice: m[1].toLowerCase(), who: stripLinks(m[2]).trim() });
    }
    return out;
}

// Make sure Voices.md exists and has a line for this cluster id — appended
// once, never rewritten (the file is the user's, like Cast.md).
function ensureVoiceLine(gName: string, id: number) {
    const p = voicesPath(gName);
    if (!existsSync(p)) {
        mkdirSync(guildDir(gName), { recursive: true });
        writeFileSync(p, [
            `# Voices — ${gName}`,
            "",
            "_Edit me — the note-taker tags the DM's transcript lines with [voice N] using a",
            "voice-similarity heuristic and lists newly heard voices here. Fill in",
            "`- voice N: <who>` once you know which NPC (or plain narration) a voice is;",
            "one voice can cover several NPCs — write them all. Read every pass._",
            "",
        ].join("\n"), "utf8");
    }
    const has = fileLines(p).some(l => new RegExp(`^\\s*-\\s+voice ${id}:`, "i").test(l));
    if (!has) appendFileSync(p, `- voice ${id}: ?\n`);
}

export async function notesVoiceTag(_: IpcMainInvokeEvent, guildName: string, feats: number[]): Promise<string> {
    try {
        if (!Array.isArray(feats) || feats.length !== VOICE_WEIGHTS.length || feats.some(x => !Number.isFinite(x))) return "";
        const gName = guildKey(guildName);
        const p = voiceClustersPath(gName);
        let clusters: VoiceCluster[] = [];
        try { clusters = JSON.parse(readFileSync(p, "utf8")); } catch { /* fresh */ }
        let best: VoiceCluster | null = null;
        let bestD = Infinity;
        for (const c of clusters) {
            const d = Math.sqrt(c.centroid.reduce((s, v, i) => s + VOICE_WEIGHTS[i] * (v - feats[i]) ** 2, 0));
            if (d < bestD) { bestD = d; best = c; }
        }
        if (!best || bestD > VOICE_THRESHOLD) {
            if (clusters.length >= VOICE_MAX) return best ? `voice ${best.id}` : "";
            best = { id: clusters.length + 1, centroid: [...feats], count: 1 };
            clusters.push(best);
        } else {
            const n = Math.min(best.count, 50);   // cap so old sessions don't freeze the centroid
            best.centroid = best.centroid.map((v, i) => (v * n + feats[i]) / (n + 1));
            best.count++;
        }
        writeFileSync(p, JSON.stringify(clusters), "utf8");
        ensureVoiceLine(gName, best.id);
        return `voice ${best.id}`;
    } catch (e) {
        err("notesVoiceTag failed", e);
        return "";
    }
}

// The measured voice, attached to the character page as raw data — the label
// plus the persisted prosody centroid [log2 F0, F0 spread, ZCR, syllable
// rate]. Not meant to be human-readable: it logs the cadence WITH the
// character so it survives for later use (re-seeding clusters, tier-2
// speaker-embedding upgrades, cross-machine moves of the vault).
function describeVoice(gName: string, voiceLabel: string): string {
    try {
        const id = Number(voiceLabel.match(/\d+/)?.[0]);
        const clusters: VoiceCluster[] = JSON.parse(readFileSync(voiceClustersPath(gName), "utf8"));
        const c = clusters.find(x => x.id === id);
        if (!c) return voiceLabel;
        return `${voiceLabel} = [${c.centroid.map(x => Number(x.toFixed(4))).join(", ")}] n=${c.count}`;
    } catch { return voiceLabel; }
}

// Voices.md entries naming this character (the `who` side may list several
// NPCs for one voice — match on any comma-separated part or substring).
function voicesForSubject(voices: Array<{ voice: string; who: string }>, subject: string): string[] {
    const n = (s: string) => s.toLowerCase().trim();
    const base = subject.replace(/\s*\(unnamed\)$/i, "");
    return voices
        .filter(v => v.who.split(",").some(w => n(w) === n(subject) || n(w) === n(base)) || n(v.who).includes(n(base)))
        .map(v => v.voice);
}

// Renderer asks who the DM is (from Cast.md) so it knows whose utterances to
// fingerprint — tags are DM-only, players don't need them.
export async function notesGetCast(_: IpcMainInvokeEvent, guildName: string) {
    const cast = parseCast(guildKey(guildName));
    return { dm: cast.dm };
}

// ── Legacy migration (.store JSON → markdown vault) ─────────────────────────
let legacyMigrated = false;
function migrateLegacyStores() {
    if (legacyMigrated) return;
    legacyMigrated = true;
    const sdir = join(notesRootDir(), ".store");
    if (!existsSync(sdir)) return;
    try {
        const byGuild = new Map<string, { facts: VFact[]; chans: Set<string> }>();
        for (const f of readdirSync(sdir)) {
            if (!f.endsWith(".json") || f.startsWith("manifest-")) continue;
            let s: any;
            try { s = JSON.parse(readFileSync(join(sdir, f), "utf8")); } catch { continue; }
            if (!Array.isArray(s?.facts)) continue;
            const gName = guildKey(s.guildName || "");
            const g = byGuild.get(gName) || { facts: [], chans: new Set<string>() };
            const chan = s.file || "notes.md";
            g.chans.add(chan);
            for (const fa of s.facts) {
                const text = stripLinks(String(fa?.text || "")).trim();
                if (text) g.facts.push({ text, subject: String(fa?.subject || ""), category: normCategory(fa?.category), chanFile: chan });
            }
            byGuild.set(gName, g);
        }
        for (const [gName, g] of byGuild) {
            const existing = parseGuild(gName, [...g.chans][0] || "notes.md");
            const have = new Set(existing.facts.map(f => f.text.toLowerCase()));
            const merged = [...existing.facts, ...g.facts.filter(f => !have.has(f.text.toLowerCase()))];
            writeGuild({ gName, gDir: guildDir(gName), facts: merged, channelFiles: [...new Set([...existing.channelFiles, ...g.chans])] });
        }
        rmSync(sdir, { recursive: true, force: true });
        log("migrated legacy .store JSON to the markdown vault");
        void notesGitCommit("migrate: legacy JSON store → markdown vault");
    } catch (e) {
        err("legacy store migration failed", e);
    }
}

// ── LLM provisioning (env → cached → download → PATH) ───────────────────────
function llmModelKey(): string {
    if (notesCfg.model && notesCfg.model !== "auto") return notesCfg.model;
    // Auto-scale like the whisper tiers: weak machines get the small model.
    // "large" is never auto-picked — it's an explicit choice for big GPUs.
    return totalmem() < 12 * 1024 ** 3 ? "small" : "standard";
}

async function resolveLlmModel(): Promise<string | null> {
    // A tier-specific env pin wins for that tier; CC_LLM_MODEL pins auto/standard
    // (that's how vesktop.nix wires the nix store path in).
    const envByTier: Record<string, string | undefined> = {
        small: process.env.CC_LLM_MODEL_SMALL,
        standard: process.env.CC_LLM_MODEL,
        large: process.env.CC_LLM_MODEL_LARGE,
    };
    const key = llmModelKey();
    const envPath = envByTier[key] || (notesCfg.model === "auto" ? process.env.CC_LLM_MODEL : undefined);
    if (envPath) return envPath;

    const info = LLM_MODELS[key] || LLM_MODELS.standard;
    const dest = join(dataDir(), "models", info.file);
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(dest) && statSync(dest).size === info.size) return dest;

    if (!captionConfig().autoDownload) {
        setNotesStatus("error", "Notes model not downloaded and auto-download is off");
        return null;
    }
    setNotesStatus("downloading-model", `Downloading notes model (${key})…`);
    const tmp = dest + ".part";
    try {
        await downloadResumable(info.url, tmp, (done, total) => { notesStatus = { ...notesStatus, done, total }; });
        const got = await sha256File(tmp);
        if (got !== info.sha256) throw new Error(`notes model checksum mismatch (${got})`);
        rmSync(dest, { force: true });
        renameSync(tmp, dest);
        log(`provisioned notes model → ${dest}`);
        return dest;
    } finally {
        try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
}

function findLlamaServerBinary(dir: string): string | null {
    const want = platform() === "win32" ? "llama-server.exe" : "llama-server";
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

// Candidate index into LLM_BIN_ASSETS[platKey] — bumped when a variant's server
// fails to start (Windows Vulkan → CPU fallback), sticky for the session.
let llmBinCandidate = 0;

async function resolveLlmBinary(): Promise<ResolvedBin | null> {
    if (process.env.CC_LLM_BIN) {
        const bin = process.env.CC_LLM_BIN;
        return { bin, libDir: process.env.CC_LLM_LIBDIR || dirname(bin) };
    }
    const platKey = `${platform() === "win32" ? "win32" : platform()}-${arch()}`;
    const candidates = LLM_BIN_ASSETS[platKey];
    if (!candidates || !candidates[llmBinCandidate]) {
        log(`no prebuilt llama-server for ${platKey} (candidate ${llmBinCandidate}); falling back to PATH`);
        return { bin: "llama-server", libDir: "" };
    }
    const asset = candidates[llmBinCandidate];
    const home = join(dataDir(), "llm-bin", LLM_REL, `${platKey}-${llmBinCandidate}`);
    let bin = findLlamaServerBinary(home);
    if (bin) return { bin, libDir: dirname(bin) };

    if (!captionConfig().autoDownload) {
        log("auto-download disabled and no cached llama-server; falling back to PATH");
        return { bin: "llama-server", libDir: "" };
    }
    setNotesStatus("provisioning", `Downloading notes engine (${asset.label})…`);
    const tmp = join(dataDir(), `llm-bin-dl.${asset.kind === "zip" ? "zip" : "tar.gz"}`);
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    try {
        await downloadResumable(asset.url, tmp, (done, total) => { notesStatus = { ...notesStatus, done, total }; });
        const got = await sha256File(tmp);
        if (got !== asset.sha256) throw new Error(`notes engine checksum mismatch (${got})`);
        rmSync(home, { recursive: true, force: true });
        await extract(tmp, asset.kind, home);
        bin = findLlamaServerBinary(home);
        if (!bin) throw new Error("extracted bundle has no llama-server");
        if (platform() !== "win32") chmodSync(bin, 0o755);
        log(`provisioned llama-server (${asset.label}) → ${bin}`);
        return { bin, libDir: dirname(bin) };
    } finally {
        try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
}

// Spawn llama-server if not up. Same shape as the whisper ensureServerFor;
// -ngl 999 offloads everything a GPU build can (harmlessly ignored by CPU builds).
async function ensureLlm(): Promise<boolean> {
    if (llm.proc && !llm.proc.killed && llm.readyPromise) return llm.readyPromise;
    llm.readyPromise = (async () => {
        try {
            const model = await resolveLlmModel();
            if (!model || !existsSync(model)) { setNotesStatus("error", "No notes model available"); return false; }
            const rb = await resolveLlmBinary();
            if (!rb) { setNotesStatus("error", "No notes engine available"); return false; }

            setNotesStatus("starting", "Starting notes engine…");
            const env = { ...process.env };
            if (rb.libDir && platform() === "linux") {
                env.LD_LIBRARY_PATH = rb.libDir + (env.LD_LIBRARY_PATH ? ":" + env.LD_LIBRARY_PATH : "");
            }
            await freePort(llm.port, "llama-server");

            const args = ["-m", model, "--host", HOST, "--port", String(llm.port), "-c", "8192", "-ngl", "999", "--threads", String(captionConfig().threads || 4), "--no-webui"];
            log(`starting notes llm: -m ${model} --port ${llm.port}`);
            const proc = spawn(rb.bin, args, { stdio: ["ignore", "pipe", "pipe"], cwd: rb.libDir || undefined, env });
            llm.proc = proc;
            proc.on("error", e => {
                const code = (e as NodeJS.ErrnoException)?.code;
                err("llama-server failed to spawn", e);
                setNotesStatus("error", code === "ENOENT" ? `Notes engine binary not found (${rb.bin})` : `Notes engine failed to start: ${(e as Error)?.message || e}`);
                llm.proc = null; llm.readyPromise = null;
            });
            // Lowest OS priority — notes are the most deferrable work in the system.
            try { if (proc.pid) setPriority(proc.pid, 19); } catch { /* ignore */ }
            proc.stdout?.on("data", d => log("llm:", String(d).trim()));
            proc.stderr?.on("data", d => log("llm:", String(d).trim()));
            proc.on("exit", code => {
                log(`llama-server exited (${code})`);
                // 0xC0000135 = STATUS_DLL_NOT_FOUND — same VC++ runtime gap the
                // whisper engine hits on debloated Windows (see ../ClosedCaptions).
                if (platform() === "win32" && (code === 3221225781 || code === -1073741515)) {
                    setNotesStatus("error", "Notes engine needs the Microsoft Visual C++ runtime — install https://aka.ms/vs/17/release/vc_redist.x64.exe and restart Discord.");
                }
                llm.proc = null; llm.readyPromise = null;
            });

            const deadline = Date.now() + 180_000;   // big model load can be slow cold
            while (Date.now() < deadline) {
                if (!llm.proc || llm.proc.killed) break;
                try {
                    const res = await fetch(`http://${HOST}:${llm.port}/health`);
                    if (res.ok) { setNotesStatus("ready", "Notes engine ready"); return true; }
                } catch { /* not listening yet */ }
                await sleep(500);
            }
            // A dead/never-ready server on a downloaded candidate → try the next
            // variant next time (Windows Vulkan → CPU).
            if (!process.env.CC_LLM_BIN) llmBinCandidate++;
            if (notesStatus.phase !== "error") setNotesStatus("error", "Notes engine did not start in time");
            try { llm.proc?.kill("SIGKILL"); } catch { /* ignore */ }
            llm.proc = null;
            return false;
        } catch (e) {
            err("ensureLlm failed", e);
            setNotesStatus("error", String((e as Error)?.message || e));
            llm.proc = null;
            return false;
        }
    })();
    return llm.readyPromise;
}

// ── Git versioning of the notes vault ───────────────────────────────────────
// The whole notes dir (every guild tree) is a git repo. A snapshot commit runs
// BEFORE each pass — capturing any manual edits made in Obsidian since the
// last session — and a commit lands after each change, so a cleanup pass or
// the next session can never clobber anything irrecoverably: `git log`/`git
// diff` in the notes dir shows it all. Best-effort: no git on the machine →
// versioning quietly off, notes still work.
let notesGitMissing = false;
let notesGitChain: Promise<void> = Promise.resolve();

function notesGitCommit(message: string): Promise<void> {
    notesGitChain = notesGitChain.then(() => doNotesGitCommit(message)).catch(() => { /* logged inside */ });
    return notesGitChain;
}

async function doNotesGitCommit(message: string): Promise<void> {
    if (notesGitMissing) return;
    const root = notesRootDir();
    try {
        if (!existsSync(join(root, ".git"))) {
            await pexecFile("git", ["init", "-q"], { cwd: root });
            log("initialized git repo for the notes vault");
        }
        await pexecFile("git", ["add", "-A"], { cwd: root });
        try {
            // Identity pinned per-invocation so a machine with no global
            // git config (fresh Windows box) can still commit.
            await pexecFile("git", [
                "-c", "user.name=ClosedCaptions",
                "-c", "user.email=closedcaptions@localhost",
                "commit", "-q", "-m", message,
            ], { cwd: root });
            log(`notes vault committed: ${message}`);
        } catch { /* clean tree — nothing to commit */ }
    } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
            notesGitMissing = true;
            log("git not found — notes vault versioning disabled");
        } else {
            err("notes git commit failed", e);
        }
    }
}

// ── Summarization queue + worker ─────────────────────────────────────────────
// `session` is the call's start stamp ("2026-10-03 21-40") — it names the
// per-call log file and tags this session's git commits.
// `cleanup` = consolidation pass (no transcript, repairs the whole vault).
// `chat`    = a user instruction from the notes chat ("Torvald is a woman,
//             fix that") — same ops contract, plus a reply for the chat log.
interface NotesJob {
    channelId: string; channelName: string; guildName: string;
    session: string; style: string; text: string;
    cleanup?: boolean; chat?: boolean;
}
const notesQueue: NotesJob[] = [];

// Note styles. "rpg" is the world-building mode (entity pages for NPCs,
// places, items…). "conversation" is the default for ordinary calls and is
// deliberately NOT a profiler: it keeps only things that need remembering —
// anything about people beyond their commitments is out of scope, and
// subjects are stripped post-parse so person pages can never form.
const STYLE_CRITERIA: Record<string, string> = {
    rpg:
        "Record durable, useful information: how the world or game works, lore, names and roles of " +
        "characters/NPCs/places, quests and goals, decisions the group made, rules clarifications, " +
        "important items, story events as they happen, and out-of-game scheduling. Do NOT record " +
        "small talk, jokes, or moment-to-moment combat chatter.",
    conversation:
        "Record ONLY things that need to be remembered later: appointments, dates, times, events, " +
        "plans, deadlines, commitments, decisions made, logistics, and anything someone explicitly " +
        "asks to have remembered or that is clearly important to recall later. Do NOT record " +
        "personal information about people, their opinions, their life details, or anything that " +
        "amounts to building a profile of a person. Do NOT summarize the conversation itself, and " +
        "do NOT note down what people merely said or discussed.",
};
const normStyle = (s: any) => (String(s ?? "").toLowerCase() === "rpg" ? "rpg" : "conversation");

// Speaker handling for RPG transcripts. Transcript lines are labelled with
// DISCORD USERS, not characters — and one player may voice several characters
// (e.g. one person playing both Hank and Greg). The model must work out from
// context which of a player's characters is acting, and when it can't, a
// missing subject is always better than a wrong one. Cast.md supplies the DM
// (source of truth) and the player→character map; server nicknames (pushed by
// the renderer — players often nickname themselves after their character) are
// offered as a HINT when Cast.md doesn't already cover the speaker.
const notesRoster = new Map<string, Map<string, { account: string; id: string }>>();   // guild → label → identity

function castPromptSection(gName: string): string {
    const cast = parseCast(gName);
    const bits: string[] = [
        "SPEAKERS: transcript lines are labelled with the DISCORD USER speaking — a PLAYER, not a character. " +
        "Players speak both out-of-character and in-character.",
    ];
    const roster = notesRoster.get(gName);
    if (roster) {
        const covered = new Set([cast.dm.toLowerCase(), ...cast.players.map(p => p.name.toLowerCase())]);
        for (const [label, who] of roster) {
            if (label === who.account) continue;              // no nickname in play
            if (covered.has(label.toLowerCase())) continue;   // Cast.md already authoritative for them
            bits.push(`The speaker label "${label}" is a Discord server nickname (the account is "${who.account}"); ` +
                "players often set their nickname to the character they play — treat the nickname as a HINT " +
                "about who is being played, not as proof.");
        }
    }
    if (cast.dm) {
        bits.push(`${cast.dm} is the DM (game master): ${cast.dm}'s narration and rulings are the authoritative ` +
            "source of truth about the world. If a player's claim conflicts with the DM, the DM is right.");
    }
    for (const p of cast.players) bits.push(`${p.name} plays: ${p.chars}.`);
    if (cast.players.some(p => p.chars.includes(","))) {
        bits.push("Where a player has several characters, infer from context which one is currently acting; " +
            "if the context does not make it clear, do not guess.");
    }
    if (cast.notes.length) {
        bits.push("CAST NOTES (written by the group — authoritative): " + cast.notes.join(" "));
    }
    if (existsSync(voicesPath(gName)) || existsSync(voiceClustersPath(gName))) {
        const voices = parseVoices(gName);
        bits.push(
            "Some of the DM's transcript lines carry a \"[voice N]\" tag from an automatic voice-similarity " +
            "heuristic: the same tag usually means the same performed voice. BUT the DM may use one voice for " +
            "SEVERAL different NPCs, may slip in and out of a voice mid-scene, and plain narration is tagged " +
            "too — treat tags as a hint to combine with dialogue content and scene context, never as proof on " +
            "their own. Never copy the tags into facts." +
            (voices.length ? " Known voice mappings (from Voices.md, authoritative): " +
                voices.map(v => `${v.voice} = ${v.who}`).join("; ") + "." : ""));
    }
    bits.push(
        "ATTRIBUTION RULES — misattribution is worse than omission: NEVER attribute an action, trait, " +
        "possession or statement to a specific character unless the transcript makes it explicit or " +
        "unambiguous from context. Player statements about the world are claims, not facts, unless the DM " +
        "confirms them. Real names and character names CAN collide: a player may share a name with another " +
        "player's character, a character may be named after a player, and speakers sometimes refer to a " +
        "character by the player's real name (or vice versa) — resolve every name by ROLE and context using " +
        "the cast information above, never by string match alone. When unsure which character or entity a " +
        "fact belongs to, set subject \"\" and write the fact generally — a missing subject is fine, a " +
        "wrong one is not.");
    return bits.join("\n");
}

// Facts are numbered 1..N for ONE request only (their position in `ctx`) —
// the ids exist just so ops can point back at bullets; nothing persists them.
function factsList(ctx: VFact[]): string {
    return ctx.length
        ? ctx.map((f, i) => `#${i + 1}${f.subject ? ` [${f.category}: ${f.subject}]` : f.category !== "other" ? ` [${f.category}]` : ""}: ${f.text}`).join("\n")
        : "(none yet)";
}

const OPS_SHAPE =
    "Respond with ONLY a JSON object of this exact shape:\n" +
    "{\"new\": [{\"text\": \"fact\", \"subject\": \"Entity Name\", \"category\": \"person\"}, ...], " +
    "\"updated\": [{\"id\": N, \"text\": \"rewritten fact\", \"subject\": \"...\", \"category\": \"...\"}, ...], \"removed\": [N, ...]}\n";

function styleRules(style: string): string {
    return (style === "rpg"
        ? "- \"subject\": the single named entity the fact is primarily about, exactly as it is named; \"\" for general facts. " +
          "Use the SAME subject spelling for every fact about the same entity. ALWAYS set the subject for any fact " +
          "about a character/NPC or a place — characters and places each get their own page.\n" +
          "- If a character clearly exists but their NAME is not yet known, do not drop the fact and do not guess a name: " +
          "use a short descriptive placeholder subject ending in \" (unnamed)\" — e.g. \"Hooded stranger (unnamed)\". " +
          "For a PLAYER's character whose name hasn't been established, use that player's Discord name as the placeholder: " +
          "e.g. \"bob (unnamed)\". Reuse the SAME placeholder for the same character every time. The moment the real name " +
          "is learned, rename: rewrite the placeholder's existing facts via \"updated\" with the real subject.\n" +
          "- \"category\": one of person, place, item, faction, quest, event, lore, schedule, timeline, other.\n" +
          "- Use category \"timeline\" for story events that HAPPEN (what the party did, battles, discoveries, deaths, " +
          "arrivals) so the campaign's chronology can be rebuilt from them.\n" +
          "- Category \"schedule\" is ONLY for REAL-WORLD, out-of-game scheduling between the players: when the " +
          "next session is, who is free or busy, pizza orders. It is NEVER for things characters do or plan " +
          "inside the story — \"the party rented rooms at the inn\" or \"the party plans to sell the loot " +
          "tonight\" are in-world (timeline or general), even though they mention plans and times.\n"
        : "- \"subject\": always \"\" — facts are never attached to or filed under a person.\n" +
          "- \"category\": one of event, schedule, item, place, other.\n");
}

function buildNotesMessages(ctx: VFact[], channelName: string, gName: string, chunk: string, style: string) {
    const criteria = (notesCfg.customPrompt || "").trim() || STYLE_CRITERIA[style] || STYLE_CRITERIA.conversation;
    return [
        {
            role: "system",
            content:
                "You maintain a knowledge base of key information from a live voice-call transcript " +
                `for the channel "${channelName}". ${criteria}\n` +
                (style === "rpg" ? castPromptSection(gName) + "\n" : "") +
                "You are given the EXISTING FACTS (numbered, with [category: subject] tags) and a NEW TRANSCRIPT SEGMENT.\n" +
                OPS_SHAPE +
                "- \"new\": concise self-contained facts from the segment NOT already covered by an existing fact.\n" +
                "- \"updated\": existing facts whose information changed or got more complete — rewrite the whole fact.\n" +
                "- \"removed\": ids of existing facts now known to be wrong or obsolete.\n" +
                styleRules(style) +
                "Never duplicate an existing fact, and never put the same fact in both \"new\" and \"updated\". " +
                "A REWORDING of an existing fact IS a duplicate — if the segment adds detail to something already " +
                "known, use \"updated\" on the existing id; never add it as new.\n" +
                "If nothing in the segment is worth keeping, return empty lists.\n" +
                "Write each fact as one plain-language sentence naming people and places explicitly (no pronouns). " +
                "Where a pronoun is unavoidable, use they/them for any character whose gender has not been " +
                "explicitly established in the transcript or the existing facts.\n" +
                "The transcript is speech-to-text and contains mishearings — ignore garbled or low-content lines.",
        },
        { role: "user", content: `EXISTING FACTS:\n${factsList(ctx)}\n\nNEW TRANSCRIPT SEGMENT:\n${chunk}` },
    ];
}

// Consolidation ("cleanup") pass: no transcript — the model re-reads the WHOLE
// vault and repairs it. Audited 2026-10-03: small live models occasionally
// re-add near-duplicates with new wording and misattribute merged facts;
// a bigger model (the mesh 27B when reachable) run at session end fixes both.
function buildCleanupMessages(ctx: VFact[], channelName: string, gName: string, style: string) {
    return [
        {
            role: "system",
            content:
                "You maintain a knowledge base built automatically from voice-call transcripts " +
                `for the channel "${channelName}". Below is the FULL list of facts. Clean it up:\n` +
                "- Merge duplicates and near-duplicates: rewrite ONE fact to carry all the information (\"updated\") and list the other ids in \"removed\".\n" +
                "- Fix facts that misattribute information (wrong person/place) ONLY when the other facts make the correct attribution clear.\n" +
                "- Unify subject spellings and fix wrong categories (person, place, item, faction, quest, event, lore, schedule, timeline, other). " +
                "In particular: \"schedule\" is ONLY real-world player scheduling (sessions, availability) — " +
                "re-categorize any in-world plans or actions wrongly filed there.\n" +
                "- Tighten wording: one plain-language sentence per fact, explicit names, no pronouns. Where a pronoun " +
                "is unavoidable, use they/them unless the character's gender is explicitly established by the facts — " +
                "rewrite gendered pronouns that nothing supports.\n" +
                "- Subjects ending in \" (unnamed)\" are placeholder names for characters whose real name wasn't known. " +
                "If the other facts reveal the real name, rename: rewrite those facts via \"updated\" with the real subject. " +
                "Otherwise leave the placeholder alone.\n" +
                (style === "rpg" ? castPromptSection(gName) + "\n" : "") +
                OPS_SHAPE +
                "Do NOT invent information — \"new\" must stay empty. If the list is already clean, return empty lists.",
        },
        { role: "user", content: `FACTS:\n${factsList(ctx)}` },
    ];
}

// Notes chat: the user tells the note-taker to correct something ("Maretta
// runs the Drowned Rat, not the Gilded Eel"). Same ops contract + a short
// reply for the chat window. The instruction is trusted over the stored facts.
function buildChatMessages(ctx: VFact[], channelName: string, gName: string, instruction: string, style: string) {
    return [
        {
            role: "system",
            content:
                "You maintain a knowledge base of notes from voice calls " +
                `for the channel "${channelName}". The USER is giving you an instruction about the knowledge base — ` +
                "usually a correction. Their instruction is authoritative: apply it even where it contradicts the stored facts.\n" +
                (style === "rpg" ? castPromptSection(gName) + "\n" : "") +
                "You are given the EXISTING FACTS (numbered). " +
                OPS_SHAPE.replace("}\n", ", \"reply\": \"one short sentence saying what you changed (or why nothing needed changing)\"}\n") +
                styleRules(style) +
                "Change ONLY what the instruction implies — do not rework unrelated facts. " +
                "You may add facts (\"new\") when the user states new information.",
        },
        { role: "user", content: `EXISTING FACTS:\n${factsList(ctx)}\n\nINSTRUCTION:\n${instruction}` },
    ];
}

// Apply the model's JSON ops to the parsed fact list. Defensive: bad ids and
// junk entries are dropped, fact text is length-capped, exact duplicates are
// refused. Returns what changed for the session log / chat reply.
// Lexical near-duplicate guard: the model sometimes re-adds an existing fact
// in new words ("Sadriel's patron the Whispering Flame…" three ways), which
// exact-text dedup can't catch. Overlap coefficient of content words
// (>3 chars): intersection over the SMALLER set — the right measure for "is
// this short rewording contained in that longer fact" (Jaccard fails there:
// the long fact's extra words dilute it). ≥0.6 = same information, refuse.
function factWords(t: string): Set<string> {
    return new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(w => w.length > 3));
}
function factSimilarity(a: Set<string>, b: Set<string>): number {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    return inter / Math.min(a.size, b.size);
}
const NEAR_DUP_THRESHOLD = 0.6;

interface OpsResult { changed: number; added: VFact[]; edited: VFact[]; dropped: string[]; }
function applyVaultOps(vault: Vault, ctx: VFact[], ops: any, style: string, curChanFile: string): OpsResult {
    const clean = (t: any) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
    const cleanSubject = (t: any) => (style === "rpg" ? clean(t).slice(0, 64) : "");
    const res: OpsResult = { changed: 0, added: [], edited: [], dropped: [] };
    const today = new Date().toISOString().slice(0, 10);
    const toDrop = new Set<VFact>();
    for (const id of Array.isArray(ops?.removed) ? ops.removed : []) {
        const f = ctx[Number(id) - 1];
        if (f && !toDrop.has(f)) { toDrop.add(f); res.dropped.push(f.text); res.changed++; }
    }
    for (const u of Array.isArray(ops?.updated) ? ops.updated : []) {
        const f = ctx[Number(u?.id) - 1];
        const text = clean(u?.text);
        if (!f || !text || toDrop.has(f)) continue;
        const subject = u?.subject !== undefined ? cleanSubject(u.subject) : f.subject;
        const category = u?.category !== undefined ? normCategory(u.category) : f.category;
        if (text !== f.text || subject !== f.subject || category !== f.category) {
            f.text = text; f.subject = subject; f.category = category;
            f.noted = today;   // a change — bump it to the top date group
            if (category === "timeline" && !f.date) f.date = today;
            res.edited.push(f); res.changed++;
        }
    }
    const kept = vault.facts.filter(f => !toDrop.has(f));
    const have = new Set(kept.map(f => f.text.toLowerCase()));
    const haveWords = kept.map(f => factWords(f.text));
    for (const n of (Array.isArray(ops?.new) ? ops.new : []).slice(0, 20)) {
        const text = clean(typeof n === "string" ? n : n?.text);
        if (!text || text.length < 8 || have.has(text.toLowerCase())) continue;
        const w = factWords(text);
        if (haveWords.some(hw => factSimilarity(w, hw) >= NEAR_DUP_THRESHOLD)) {
            log(`refused near-duplicate fact: ${text.slice(0, 80)}`);
            continue;
        }
        const category = normCategory(typeof n === "object" ? n?.category : "");
        const f: VFact = {
            text,
            subject: cleanSubject(typeof n === "object" ? n?.subject : ""),
            category,
            chanFile: curChanFile,
            date: category === "timeline" ? today : undefined,
            noted: today,
        };
        vault.facts.push(f);
        have.add(text.toLowerCase());
        haveWords.push(w);
        res.added.push(f); res.changed++;
    }
    if (toDrop.size) vault.facts = vault.facts.filter(f => !toDrop.has(f));
    return res;
}

// Per-call session log: one timestamped file per call under the guild's
// Sessions/, each pass appending what it learned. Append-only and never
// parsed or pruned — the historical record beside the living vault.
function appendSessionLog(job: NotesJob, res: OpsResult) {
    if (!job.session || res.changed === 0) return;
    const dir = join(guildDir(guildKey(job.guildName)), "Sessions");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${job.session} ${sanitizeName(job.channelName)}.md`);
    const label = job.cleanup ? " (cleanup)" : job.chat ? " (chat)" : "";
    // Obsidian wikilink prefix — resolves once the entity has its page.
    const tag = (f: VFact) => (f.subject ? `[[${f.subject}]]: ` : "");
    const lines: string[] = [];
    if (!existsSync(p)) {
        lines.push(
            `# Session — ${job.channelName}, ${job.session.replace(/-(\d\d)$/, ":$1")}`,
            "",
            `_${guildKey(job.guildName)}. What the note-taker learned during this call._`,
        );
    }
    lines.push("", `## ${new Date().toTimeString().slice(0, 5)}${label}`, "");
    for (const f of res.added) lines.push(`- ${tag(f)}${f.text}`);
    for (const f of res.edited) lines.push(`- (updated) ${tag(f)}${f.text}`);
    for (const t of res.dropped) lines.push(`- (removed) ${t}`);
    appendFileSync(p, lines.join("\n") + "\n");
}

// ── Git session queries (replaces per-fact timestamps) ──────────────────────
// Commits are tagged "[session <stamp>]"; "what changed this session" is a
// git diff from just before the session's first commit — which also means
// manual edits made mid-session show up in the panel. No git → best effort.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";   // git's well-known empty tree

async function gitSessionBase(session: string): Promise<string | null> {
    if (notesGitMissing || !session) return null;
    try {
        const { stdout } = await pexecFile("git", ["log", "--fixed-strings", `--grep=[session ${session}]`, "--format=%H"], { cwd: notesRootDir() });
        const hashes = stdout.trim().split("\n").filter(Boolean);
        if (!hashes.length) return null;
        const oldest = hashes[hashes.length - 1];
        try {
            const { stdout: parent } = await pexecFile("git", ["rev-parse", "--verify", `${oldest}~1`], { cwd: notesRootDir() });
            return parent.trim();
        } catch { return EMPTY_TREE; }
    } catch { return null; }
}

interface NoteRow { subject: string; text: string; category: string; updated: string; }
interface NoteSection { file: string; rows: NoteRow[]; }

// Parse one diff's added bullets into sections, appended in encounter order.
// Each diff keeps its own per-file sections — the stream is a CHANGELOG, so
// the same file legitimately heads multiple sections across commits.
function diffToSections(stdout: string, rel: string, out: NoteSection[]) {
    let curFile = "";
    let sec: NoteSection | null = null;
    for (const line of stdout.split("\n")) {
        if (line.startsWith("+++ b/")) {
            curFile = line.slice(6).startsWith(rel + "/") ? line.slice(6 + rel.length + 1) : line.slice(6);
            sec = null;
            continue;
        }
        if (!curFile || curFile.startsWith("Sessions/") || curFile === "Cast.md" || curFile === "Voices.md") continue;
        if (!line.startsWith("+") || line.startsWith("++")) continue;
        const b = parseBullet(line.slice(1));
        if (!b?.text) continue;
        let subject = b.subject;
        if (!subject) {
            const parts = curFile.split("/");
            if (parts.length === 2 && DIR_CATEGORY[parts[0]]) subject = parts[1].replace(/\.md$/, "");
        }
        if (!sec || sec.file !== curFile) { sec = { file: curFile, rows: [] }; out.push(sec); }
        sec.rows.push({ subject, text: b.text, category: b.category, updated: "" });
    }
}

// The session's change stream, NEWEST FIRST: one group of sections per commit
// (walked newest → oldest), so the panel's All tab reads as a changelog and a
// file's header repeats whenever it changed again. Cached by HEAD — the 1 s
// panel poll only re-walks commits after something new lands.
let sessionSectionsCache: { gName: string; session: string; head: string; sections: NoteSection[] } | null = null;

async function gitSessionSections(gName: string, session: string): Promise<NoteSection[]> {
    if (notesGitMissing || !session) return [];
    try {
        const root = notesRootDir();
        const { stdout: logOut } = await pexecFile("git", ["log", "--fixed-strings", `--grep=[session ${session}]`, "--format=%H"], { cwd: root });
        const hashes = logOut.trim().split("\n").filter(Boolean);   // newest first
        if (!hashes.length) return [];
        const c = sessionSectionsCache;
        if (c && c.gName === gName && c.session === session && c.head === hashes[0]) return c.sections;
        const rel = sanitizeName(gName);
        const sections: NoteSection[] = [];
        for (const h of hashes.slice(0, 40)) {
            let baseRef = `${h}~1`;
            try { await pexecFile("git", ["rev-parse", "--verify", "-q", baseRef], { cwd: root }); }
            catch { baseRef = EMPTY_TREE; }
            const { stdout } = await pexecFile("git", ["diff", "--unified=0", baseRef, h, "--", rel], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
            diffToSections(stdout, rel, sections);
        }
        sessionSectionsCache = { gName, session, head: hashes[0], sections };
        return sections;
    } catch { return []; }
}

async function runNotesPass(job: NotesJob): Promise<void> {
    const gName = guildKey(job.guildName);
    const chanFile = `${sanitizeName(job.channelName)}.md`;
    const style = normStyle(job.style);
    const vault = parseGuild(gName, chanFile);
    // End-of-session cleanup only makes sense if this session actually
    // committed anything (and there's enough vault to be worth consolidating).
    if (job.cleanup && (vault.facts.length < 6 || !(await gitSessionBase(job.session)) && !notesGitMissing)) {
        log(`skipping cleanup for ${job.channelName}: nothing this session or vault too small`);
        return;
    }
    if (style === "rpg" && !job.cleanup && !job.chat) {
        // First sight of this guild's transcript: seed Cast.md from speakers.
        const speakers = [...new Set(
            job.text.split("\n")
                .map(l => l.match(/^(?:\[chat\]\s+)?([^:]{1,40}):\s/)?.[1]?.trim())
                .filter((s): s is string => !!s)
        )];
        seedCast(gName, speakers);
    }

    // Facts get ephemeral ids (position in ctx) for this one request.
    const ctx = vault.facts.slice(0, 200);
    const external = llmExternalActive() ? llmApiEndpoint() : "";
    const url = external || `http://${HOST}:${llm.port}/v1/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const apiKey = notesCfg.apiKey || process.env.CC_LLM_API_KEY || "";
    if (external && apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const modelName = external ? (notesCfg.apiModel || process.env.CC_LLM_MODEL_NAME || "") : "";

    // Reachability preflight: a dead-but-black-holing endpoint would hang the
    // real request on TCP timeout for ages before we could fall back to the
    // local engine. Any HTTP answer (even a 404) proves reachability — only a
    // network-level failure/timeout throws, which the caller turns into an
    // immediate local-engine retry.
    if (external) {
        await fetch(llmApiBase() + "/health", { signal: AbortSignal.timeout(2500) });
    }

    const messages = job.chat
        ? buildChatMessages(ctx, job.channelName, gName, job.text, style)
        : job.cleanup
            ? buildCleanupMessages(ctx, job.channelName, gName, style)
            : buildNotesMessages(ctx, job.channelName, gName, job.text, style);

    let txt = "";
    for (let compat = external ? llmApiCompat : 0; ; compat++) {
        const body: any = { messages, temperature: 0.2, max_tokens: job.cleanup ? 2000 : 1200 };
        if (modelName) body.model = modelName;
        // JSON grammar constrains the output (also forecloses <think> rambling
        // on hybrid-thinking models); enable_thinking=false belt-and-braces it.
        if (compat <= 1) body.response_format = { type: "json_object" };
        if (compat === 0) body.chat_template_kwargs = { enable_thinking: false };
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        txt = await res.text();
        if (res.ok) { if (external) llmApiCompat = compat; break; }
        if (external && res.status === 400 && compat < 2) {
            log(`external llm rejected request at compat ${compat}, stepping down: ${txt.slice(0, 120)}`);
            continue;
        }
        throw new Error(`notes llm ${res.status}: ${txt.slice(0, 200)}`);
    }
    let content = "";
    try { content = String(JSON.parse(txt)?.choices?.[0]?.message?.content ?? ""); } catch { content = txt; }
    content = content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    let ops: any = null;
    try { ops = JSON.parse(content); } catch { throw new Error(`notes llm returned non-JSON: ${content.slice(0, 120)}`); }

    // Cleanup passes must never grow the vault — belt and braces on the prompt.
    if (job.cleanup) ops.new = [];
    const res = applyVaultOps(vault, ctx, ops, style, chanFile);
    if (res.changed > 0) {
        // Snapshot whatever is on disk FIRST (manual Obsidian edits included)
        // so this pass's rewrite can always be rolled back or diffed.
        await notesGitCommit(`snapshot before ${job.cleanup ? "cleanup" : job.chat ? "chat" : "pass"} — ${gName} / ${job.channelName}${job.session ? ` [session ${job.session}]` : ""}`);
        writeGuild(vault);
        await notesGitCommit(`${job.cleanup ? "cleanup" : job.chat ? "chat" : "notes"}: ${gName} / ${job.channelName} — ${res.changed} change(s), ${vault.facts.length} fact(s)${job.session ? ` [session ${job.session}]` : ""}`);
    }
    try { appendSessionLog(job, res); } catch (e) { err("session log failed", e); }
    if (job.chat) {
        const reply = String(ops?.reply || "").trim()
            || (res.changed ? `Done — ${res.changed} change(s) applied.` : "Nothing needed changing.");
        notesChatLog.push({ q: job.text, a: reply, ts: Date.now() });
        if (notesChatLog.length > 50) notesChatLog.splice(0, notesChatLog.length - 50);
    }
    log(`notes ${job.cleanup ? "cleanup" : job.chat ? "chat" : "pass"} for ${job.channelName}: ${res.changed} change(s), ${vault.facts.length} fact(s) total`);
}

// Drain heartbeat — called from the caption engine's 1 s governor tick (via
// registerEngineExtension) and directly on enqueue/boost. Gates (skipped under
// boost): whisper engine idle, low external GPU demand, duty-cycle cooldown
// elapsed. One pass at a time, always.
async function drainNotesQueue(): Promise<void> {
    if (llmBusy || notesQueue.length === 0 || !notesCfg.enabled) return;
    const external = llmExternalActive();
    if (!notesBoost && !external) {
        // Local engine shares the GPU with captions and games — defer politely.
        // An external provider costs us nothing locally, so just run.
        if (isDecodeBusy()) return;                  // a caption decode is running
        if (externalDemand() >= 25) return;          // a game/app needs the GPU
        if (Date.now() < nextLlmAt) return;          // our own cooldown
    }
    // HARD ceiling, boost included: at game-level external GPU demand a LOCAL
    // pass never runs — the queue just waits for the load to drop. External
    // passes still go out (the mesh defense arbitrates on the serving side).
    if (!external && externalDemand() >= 60) return;
    llmBusy = true;
    const t0 = Date.now();
    let job: NotesJob | undefined;
    try {
        if (!external && !(await ensureLlm())) { notesQueue.length = 0; return; }   // engine broken — don't spin
        job = notesQueue.shift()!;
        setNotesStatus("summarizing", `Updating notes for ${job.channelName}…`);
        lastLlmUse = Date.now();
        await runNotesPass(job);
        setNotesStatus("ready", "");
    } catch (e) {
        // Mesh busy (all hosts defending their GPUs → 502/503) is transient;
        // unreachable is sturdier. Either way: requeue the job and rerun it on
        // the LOCAL engine immediately (the re-kick below fires as soon as
        // llmBusy clears) — no latency added. The backoff only says how long
        // we stop RETRYING the external endpoint.
        const meshBusy = external && /notes llm 50[23]\b/.test(String((e as Error)?.message || ""));
        if (external && (isNetErr(e) || meshBusy)) {
            if (job) notesQueue.unshift(job);
            externalBackoffUntil = Date.now() + (meshBusy ? 60_000 : 300_000);
            log(`external notes LLM ${meshBusy ? "busy" : "unreachable"} (${String((e as Error)?.message || e).slice(0, 120)}); using local engine, retrying external in ${meshBusy ? 1 : 5} min`);
            setNotesStatus("ready", "");
            setTimeout(() => void drainNotesQueue(), 10);   // after finally releases llmBusy
        } else {
            err("notes pass failed", e);
            setNotesStatus("error", String((e as Error)?.message || e));
        }
    } finally {
        lastLlmUse = Date.now();
        lastLlmDur = Math.max(500, Date.now() - t0);
        // Generous cooldown: notes never need to be snappy unless boosted, and on
        // battery we space passes out further still.
        nextLlmAt = Date.now() + Math.round(lastLlmDur * (isOnAC() ? 4 : 8));
        llmBusy = false;
    }
}

// ── Hook into the caption engine's governor tick + stop ─────────────────────
// Runs at module load (the natives bundle is imported eagerly). The tick is
// the drain heartbeat AND the idle-eviction sweep: the notes LLM frees its
// RAM/VRAM after a few idle minutes — and EARLY when something else wants the
// GPU (a game): holding VRAM through a firefight is the opposite of
// low-priority. Stopping the caption engine also drops the notes LLM.
registerEngineExtension({
    tick() {
        const llmIdleMs = lastLlmUse ? Date.now() - lastLlmUse : 0;
        if (llm.proc && !llm.proc.killed && lastLlmUse && !llmBusy
            && (llmIdleMs > LLM_IDLE_MS || (externalDemand() >= 45 && llmIdleMs > 10_000))) {
            try { llm.proc.kill("SIGTERM"); } catch { /* ignore */ }
            llm.proc = null; llm.readyPromise = null;
            log(`evicted ${llmIdleMs > LLM_IDLE_MS ? "idle" : "GPU-contended"} notes LLM server to free RAM/VRAM`);
        }
        void drainNotesQueue();
    },
    stop() {
        // The notes queue is intentionally NOT cleared: a pending summarization
        // job survives a plugin restart and runs once the engine is back.
        if (llm.proc && !llm.proc.killed) { try { llm.proc.kill("SIGTERM"); } catch { /* ignore */ } }
        llm.proc = null; llm.readyPromise = null;
        try { notesPopoutWin?.close(); } catch { /* ignore */ }
        notesPopoutWin = null;
    },
});

// ── IPC surface for the renderer ─────────────────────────────────────────────
export async function notesConfigure(_: IpcMainInvokeEvent, cfgIn: Partial<NotesCfg>): Promise<void> {
    notesCfg = { ...notesCfg, ...(cfgIn || {}) };
}

export async function notesEnqueue(_: IpcMainInvokeEvent, channelId: string, channelName: string, guildName: string, session: string, style: string, text: string): Promise<void> {
    if (!notesCfg.enabled || !channelId || !text?.trim()) return;
    // Coalesce with an already-queued job for the same channel so a backlog
    // becomes one bigger pass instead of several model warm-ups.
    const ex = notesQueue.find(j => j.channelId === channelId && j.session === session && !j.cleanup && !j.chat);
    if (ex) { ex.text += "\n" + text; ex.channelName = channelName || ex.channelName; ex.style = style || ex.style; }
    else notesQueue.push({ channelId, channelName: channelName || "channel", guildName: guildName || "", session: session || "", style: normStyle(style), text });
    void drainNotesQueue();
}

// Queue ONE consolidation pass for a channel — called by the renderer when a
// call ends. Strictly session-driven: no timers, nothing runs while idle.
// FIFO means it lands after the session's final transcript pass.
export async function notesCleanup(_: IpcMainInvokeEvent, channelId: string, channelName: string, guildName: string, session: string, style: string): Promise<void> {
    if (!notesCfg.enabled || !notesCfg.cleanupAfterSession || !channelId || !session) return;
    if (notesQueue.some(j => j.channelId === channelId && j.cleanup)) return;
    notesQueue.push({ channelId, channelName: channelName || "channel", guildName: guildName || "", session, style: normStyle(style), text: "", cleanup: true });
    void drainNotesQueue();
}

// Notes chat: a user instruction/correction typed in the panel's chat box.
const notesChatLog: Array<{ q: string; a: string; ts: number }> = [];

export async function notesChat(_: IpcMainInvokeEvent, channelId: string, channelName: string, guildName: string, session: string, style: string, text: string): Promise<void> {
    if (!notesCfg.enabled || !channelId || !text?.trim()) return;
    notesQueue.push({ channelId, channelName: channelName || "channel", guildName: guildName || "", session: session || "", style: normStyle(style), text: text.trim(), chat: true });
    void drainNotesQueue();
}

export async function notesGetChat(_: IpcMainInvokeEvent) {
    return notesChatLog.slice(-20);
}

// Renderer pushes {label (transcript name = server nick), account, id} for
// the current call's participants — kept in memory per guild. Nickname hints
// go in the prompt; account+id feed the "Played by" line on character pages.
export async function notesSetRoster(_: IpcMainInvokeEvent, guildName: string, entries: Array<{ label: string; account: string; id: string }>): Promise<void> {
    const g = notesRoster.get(guildKey(guildName)) || new Map<string, { account: string; id: string }>();
    for (const e of Array.isArray(entries) ? entries : []) {
        if (e?.label && e?.account) g.set(String(e.label), { account: String(e.account), id: String(e.id || "") });
    }
    notesRoster.set(guildKey(guildName), g);
}

export async function notesSetBoost(_: IpcMainInvokeEvent, boost: boolean): Promise<void> {
    notesBoost = !!boost;
    if (notesBoost) void drainNotesQueue();
}

export async function notesState(_: IpcMainInvokeEvent) {
    return {
        ...notesStatus,
        queued: notesQueue.length,
        busy: llmBusy,
        dir: notesRootDir(),
        provider: llmExternalActive() ? llmApiBase() : "local",
    };
}

// Panel data: ONLY what changed this call (git diff since the session's
// first commit — manual edits included). No fallback to the whole vault: the
// panel is a this-session view; the full knowledge base lives in the files.
// No session yet / no git / nothing changed → empty, and the renderer shows
// "Nothing noted this session yet."
export async function notesGet(_: IpcMainInvokeEvent, channelId: string, channelName: string, guildName: string, session: string) {
    const gName = guildKey(guildName);
    const chanFile = `${sanitizeName(channelName)}.md`;
    const sections = await gitSessionSections(gName, session);
    // Attach each file's full (lowercased, de-wikilinked) content — the
    // renderer's mention scanner uses it for content-relevance: talking about
    // the Spear of Destiny also surfaces the characters whose files mention it.
    // The changelog stream repeats files; content rides on the FIRST (newest)
    // occurrence only, so the 1 s poll payload stays small.
    const seen = new Set<string>();
    for (const s of sections as Array<NoteSection & { content?: string }>) {
        if (seen.has(s.file)) continue;
        seen.add(s.file);
        try { s.content = readFileSync(join(guildDir(gName), s.file), "utf8").toLowerCase().replace(/\[\[|\]\]/g, ""); }
        catch { s.content = ""; }
    }
    return { sections, file: join(guildDir(gName), chanFile) };
}

export async function notesOpenDir(_: IpcMainInvokeEvent): Promise<void> {
    try { await shell.openPath(notesRootDir()); } catch (e) { err("openPath failed", e); }
}

// Purge everything this session recorded for a channel's guild — a privacy
// control, so it must REALLY delete: when the session's commits sit on top
// of history uninterrupted (the normal case), the branch is hard-rewound and
// the objects pruned, leaving no trace in git either. Only when another
// session's commits interleave does it fall back to reverting the files with
// a purge commit (content then survives in history — reported as such).
export async function notesPurgeSession(_: IpcMainInvokeEvent, channelId: string, channelName: string, guildName: string, session: string): Promise<string> {
    try {
        if (!session) return "nothing to purge — no active session for this channel";
        // Drop anything still queued or buffered for this channel first.
        for (let i = notesQueue.length - 1; i >= 0; i--) {
            if (notesQueue[i].channelId === channelId) notesQueue.splice(i, 1);
        }
        sessionSectionsCache = null;
        const gName = guildKey(guildName);
        const root = notesRootDir();
        const relDir = sanitizeName(gName);
        const sessionLog = join(guildDir(gName), "Sessions", `${session} ${sanitizeName(channelName)}.md`);
        if (notesGitMissing) {
            try { rmSync(sessionLog, { force: true }); } catch { /* ignore */ }
            return "removed the session log (no git — vault files left as-is)";
        }
        const { stdout: logOut } = await pexecFile("git", ["log", "--fixed-strings", `--grep=[session ${session}]`, "--format=%H"], { cwd: root });
        const hashes = logOut.trim().split("\n").filter(Boolean);
        if (!hashes.length) {
            try { rmSync(sessionLog, { force: true }); } catch { /* ignore */ }
            return "nothing recorded this session";
        }
        const oldest = hashes[hashes.length - 1];
        const { stdout: allOut } = await pexecFile("git", ["log", "--format=%H%x09%s"], { cwd: root });
        const all = allOut.trim().split("\n");
        const idx = all.findIndex(l => l.startsWith(oldest));
        const sinceOldest = all.slice(0, idx + 1);
        const allOurs = sinceOldest.every(l => l.includes(`[session ${session}]`));
        if (allOurs) {
            if (idx + 1 < all.length) {
                await pexecFile("git", ["reset", "--hard", all[idx + 1].split("\t")[0]], { cwd: root });
            } else {
                // The session IS the whole history — the vault was born in it.
                rmSync(join(root, ".git"), { recursive: true, force: true });
                rmSync(join(root, relDir), { recursive: true, force: true });
                log(`purged session ${session}: entire vault removed (created this session)`);
                return "purged — the vault only contained this session";
            }
            // Make the deletion real: expire reflogs and prune the objects.
            try { await pexecFile("git", ["reflog", "expire", "--expire=now", "--all"], { cwd: root }); } catch { /* ignore */ }
            try { await pexecFile("git", ["gc", "--prune=now", "--quiet"], { cwd: root }); } catch { /* ignore */ }
            try { rmSync(sessionLog, { force: true }); } catch { /* already reverted */ }
            log(`purged session ${session} for ${gName}: history rewound and pruned`);
            return "purged — this session's notes and their git history are gone";
        }
        // Interleaved with other sessions' commits: revert this guild's files
        // to the pre-session state and record the purge as a commit.
        let baseRef = `${oldest}~1`;
        try { await pexecFile("git", ["rev-parse", "--verify", "-q", baseRef], { cwd: root }); } catch { baseRef = ""; }
        if (baseRef) {
            await pexecFile("git", ["checkout", baseRef, "--", relDir], { cwd: root });
            // Files created after base (incl. the session log) survive a
            // checkout — remove anything not present at base.
            const { stdout: baseFiles } = await pexecFile("git", ["ls-tree", "-r", "--name-only", baseRef, "--", relDir], { cwd: root });
            const keep = new Set(baseFiles.trim().split("\n").filter(Boolean));
            const { stdout: nowFiles } = await pexecFile("git", ["ls-files", "--", relDir], { cwd: root });
            for (const f of nowFiles.trim().split("\n").filter(Boolean)) {
                if (!keep.has(f)) { try { rmSync(join(root, f), { force: true }); } catch { /* ignore */ } }
            }
        } else {
            rmSync(join(root, relDir), { recursive: true, force: true });
        }
        await notesGitCommit(`purge: session ${session} — ${gName}`);
        log(`purged session ${session} for ${gName}: files reverted (history interleaved, kept)`);
        return "notes reverted — git history kept (another session's commits interleave)";
    } catch (e) {
        err("notesPurgeSession failed", e);
        return `purge failed: ${String((e as Error)?.message || e).slice(0, 120)}`;
    }
}
