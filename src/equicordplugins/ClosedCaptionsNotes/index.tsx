/*
 * ClosedCaptionsNotes — renderer side.
 *
 * Session-notes EXTENSION for the ClosedCaptions plugin: a local LLM
 * periodically reads the live transcript and maintains a per-channel
 * knowledge base (markdown vault, git-versioned). This plugin owns all the
 * notes UI and plumbing; ClosedCaptions owns the captions. The two talk
 * through ClosedCaptions' small extension API (registerCcExtension/ccApi):
 *
 *   - onTick       — the captions status tick drives the notes cadence
 *   - onUtterance  — finished utterances' PCM feeds the DM voice fingerprinting
 *   - mountHeader  — the 📝 button in the captions sidebar header
 *   - mountSection — the notes split at the bottom of the captions sidebar
 *
 * STRICTLY OPT-IN per channel: nothing is ever noted in a channel until the
 * toggle in the 📝 panel is flipped for that specific channel. Disabling this
 * plugin removes the whole subsystem; ClosedCaptions keeps captioning.
 */

import { definePluginSettings, Settings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { Toasts } from "@webpack/common";

import type { Caption, CcPalette, CcUtterance } from "../ClosedCaptions";
import { ccApi, registerCcExtension, unregisterCcExtension } from "../ClosedCaptions";

const Native = VencordNative.pluginHelpers.ClosedCaptionsNotes as PluginNative<typeof import("./native")>;
const logger = new Logger("ClosedCaptionsNotes");

const UserStore = findStoreLazy("UserStore");
const SelectedChannelStore = findStoreLazy("SelectedChannelStore");
const ChannelStore = findStoreLazy("ChannelStore");
// For the notes directory tree (one folder per guild).
const GuildStore = findStoreLazy("GuildStore");

// Theme palette, mirrored from ClosedCaptions (resolved there at start).
let C: CcPalette = ccApi.getPalette();

// ── Settings ─────────────────────────────────────────────────────────────────
// Keys intentionally match the old ClosedCaptions settings names so existing
// installs migrate their values (incl. the per-channel opt-ins) — see
// migrateFromClosedCaptions().
const settings = definePluginSettings({
    sessionNotes: {
        type: OptionType.BOOLEAN,
        description: "Session notes master switch. STRICTLY OPT-IN per channel — nothing is noted anywhere until you flip the toggle in the 📝 panel for that specific channel. This switch is the master kill switch.",
        default: true,
        onChange: () => pushNotesConfig(),
    },
    notesIntervalMinutes: {
        type: OptionType.NUMBER,
        description: "How often (minutes) the transcript is summarized into the notes while a call is ongoing.",
        default: 15,
        onChange: () => pushNotesConfig(),
    },
    notesDir: {
        type: OptionType.STRING,
        description: "Folder for the notes files (blank = Documents/discord-notes). One markdown file per channel, kept deduplicated and up to date.",
        default: "",
        onChange: () => pushNotesConfig(),
    },
    notesModel: {
        type: OptionType.SELECT,
        description: "Notes model. Auto scales to this machine like the caption models — better models give better notes but aren't required on weak hardware.",
        options: [
            { label: "Auto (pick for this machine)", value: "auto", default: true },
            { label: "Light — Qwen3 1.7B (~1.1 GB)", value: "small" },
            { label: "Standard — Qwen3 4B (~2.4 GB)", value: "standard" },
            { label: "Best — Qwen3 8B (~5 GB, wants a real GPU)", value: "large" },
        ],
        onChange: () => pushNotesConfig(),
    },
    notesPrompt: {
        type: OptionType.STRING,
        description: "Custom extraction prompt: describe in your own words what counts as key information worth noting (blank = sensible default for TTRPG / world notes).",
        default: "",
        onChange: () => pushNotesConfig(),
    },
    notesStyle: {
        type: OptionType.SELECT,
        description: "Default note style for channels without their own setting (switchable per channel from the notes header).",
        options: [
            { label: "Conversation — only things worth remembering (dates, plans, commitments); never builds profiles of people", value: "conversation", default: true },
            { label: "RPG — full world-building knowledge base (characters, places, items, quests)", value: "rpg" },
        ],
    },
    notesCleanup: {
        type: OptionType.BOOLEAN,
        description: "When a call ends, run ONE consolidation pass over that channel's notes (near-duplicates merged, misattributions fixed) — ideally by a bigger model via the external endpoint. Session-driven only; nothing runs outside calls.",
        default: true,
        onChange: () => pushNotesConfig(),
    },
    notesApiUrl: {
        type: OptionType.STRING,
        description: "External notes LLM: an OpenAI-compatible endpoint (e.g. http://host:8601 or https://…/v1). Blank = run the local engine above. Transcripts are sent to this server — only point it somewhere you trust.",
        default: "",
        onChange: () => pushNotesConfig(),
    },
    notesApiModel: {
        type: OptionType.STRING,
        description: "Model name to request from the external endpoint (blank = the server's default).",
        default: "",
        onChange: () => pushNotesConfig(),
    },
    notesApiKey: {
        type: OptionType.STRING,
        description: "API key for the external endpoint, if it needs one (sent as a Bearer token).",
        default: "",
        onChange: () => pushNotesConfig(),
    },
    // Per-channel on/off overrides, managed from the notes panel toggle —
    // JSON map of channelId → {on, style} (absent = OFF; strict opt-in).
    notesChannels: {
        type: OptionType.STRING,
        description: "Internal: per-channel notes overrides.",
        default: "",
        hidden: true,
    },
    // Notes share of the sidebar's vertical split %, persisted from the drag handle.
    notesSplitPct: {
        type: OptionType.NUMBER,
        description: "Internal: notes split height percent.",
        default: 45,
        hidden: true,
    },
    // One-shot migration marker (settings copied from ClosedCaptions).
    migratedFromCC: {
        type: OptionType.BOOLEAN,
        description: "Internal: settings migrated from ClosedCaptions.",
        default: false,
        hidden: true,
    },
});

// These settings lived in ClosedCaptions before the split — copy the old
// values over ONCE so nothing is lost (especially notesChannels: the strict
// per-channel opt-ins are privacy state and must survive the refactor).
function migrateFromClosedCaptions() {
    try {
        if (settings.store.migratedFromCC) return;
        settings.store.migratedFromCC = true;
        const old = (Settings.plugins as any)?.ClosedCaptions;
        if (!old) return;
        const keys = [
            "sessionNotes", "notesIntervalMinutes", "notesDir", "notesModel", "notesPrompt",
            "notesStyle", "notesCleanup", "notesApiUrl", "notesApiModel", "notesApiKey",
            "notesChannels", "notesSplitPct",
        ];
        let copied = 0;
        for (const k of keys) {
            if (old[k] !== undefined) { (settings.store as any)[k] = old[k]; copied++; }
        }
        if (copied) logger.info(`migrated ${copied} notes setting(s) from ClosedCaptions`);
    } catch (e) {
        logger.error("settings migration failed", e);
    }
}

function pushNotesConfig() {
    try {
        void Native.notesConfigure({
            enabled: !!settings.store.sessionNotes,
            dir: settings.store.notesDir || "",
            model: settings.store.notesModel || "auto",
            customPrompt: settings.store.notesPrompt || "",
            apiUrl: settings.store.notesApiUrl || "",
            apiModel: settings.store.notesApiModel || "",
            apiKey: settings.store.notesApiKey || "",
            cleanupAfterSession: settings.store.notesCleanup !== false,
        });
    } catch (e) {
        logger.error("pushNotesConfig failed", e);
    }
}

function toast(message: string, type: number) {
    Toasts.show({ message, type, id: Toasts.genId(), options: { position: Toasts.Position.BOTTOM } });
}

function makePill(): HTMLDivElement {
    const d = document.createElement("div");
    Object.assign(d.style, {
        cursor: "pointer", fontSize: "11px", fontWeight: "600", padding: "2px 8px",
        borderRadius: "10px", border: `1px solid ${C.border}`, color: C.dim, userSelect: "none", whiteSpace: "nowrap",
    } as Partial<CSSStyleDeclaration>);
    return d;
}

// ── Session-notes feed ───────────────────────────────────────────────────────
// Finalized transcript lines accumulate per voice channel and are shipped to the
// native LLM worker on a cadence (default every 15 min, plus on leaving voice and
// when the notes panel opens). Native keeps a per-channel fact store the model
// cross-references on every pass, so notes stay deduplicated and updated instead
// of growing as an append-only log. All LLM work is idle-priority — EXCEPT while
// the panel is open (boost), because then the user is actively waiting.

const NOTES_SETTLE_MS = 12_000;   // wait for tier-1/2 refinements before feeding a line
let notesFedId = 0;               // high-water caption id already fed to the buffer
let notesLines: string[] = [];
let notesChan = "";
let notesChanName = "";
let notesChanGuild = "";
let notesSession = "";            // call start stamp — names the per-call Sessions/ log
let notesLastSend = Date.now();

// Filesystem-safe local timestamp for the session file name.
function sessionStamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
}

// Per-channel map: legacy entries are plain booleans (on/off), newer ones are
// { on?: boolean, style?: "conversation" | "rpg" } — both shapes accepted.
function notesOverrides(): Record<string, any> {
    try { return JSON.parse(settings.store.notesChannels || "{}"); } catch { return {}; }
}
function patchNotesChannel(ch: string, patch: { on?: boolean; style?: string }) {
    const o = notesOverrides();
    const cur = o[ch] && typeof o[ch] === "object" ? o[ch] : typeof o[ch] === "boolean" ? { on: o[ch] } : {};
    o[ch] = { ...cur, ...patch };
    settings.store.notesChannels = JSON.stringify(o);
}
function setNotesOverride(ch: string, on: boolean) {
    patchNotesChannel(ch, { on });
}
function notesChannelStyle(ch: string): string {
    const o = notesOverrides()[ch];
    const s = o && typeof o === "object" && o.style ? o.style : settings.store.notesStyle || "conversation";
    return s === "rpg" ? "rpg" : "conversation";
}
// STRICT OPT-IN (privacy incident 2026-10-03: a call was noted after being
// forgotten about): no channel is EVER recorded unless someone explicitly
// switched notes on there. Absence of an override means OFF, full stop.
function notesEnabledFor(ch: string): boolean {
    if (!settings.store.sessionNotes || !ch) return false;
    const o = notesOverrides()[ch];
    if (typeof o === "boolean") return o;
    if (o && typeof o === "object") return o.on === true;
    return false;
}

function channelDisplayName(chId: string): string {
    try {
        const ch = ChannelStore?.getChannel?.(chId);
        if (ch?.name) return ch.name;
        if (ch?.type === 1) {
            const other = String(ch.getRecipientId?.() || ch.recipients?.[0] || "");
            const u = other ? UserStore?.getUser?.(other) : null;
            return u ? `DM — ${u.globalName || u.username}` : "DM";
        }
    } catch { /* ignore */ }
    return "channel";
}

// Guild (server) name for the notes directory tree; "" for DM/group calls.
function channelGuildName(chId: string): string {
    try {
        const ch = ChannelStore?.getChannel?.(chId);
        const g = ch?.guild_id ? GuildStore?.getGuild?.(ch.guild_id) : null;
        return g?.name || "";
    } catch { return ""; }
}

// ── Voice fingerprinting (tier 1 — prosody, no deps) ────────────────────────
// For the DM's utterances in RPG channels we compute a tiny prosody vector
// from the PCM ClosedCaptions already captured — [log2 median F0, F0 spread,
// brightness (ZCR), syllable-ish rate] — and native clusters it into
// "[voice N]" tags that ride on the DM's transcript lines. A hint for the
// LLM, never proof: one voice can cover several NPCs (prompt says so).
// Tier 2 (real speaker embeddings) is the upgrade path if these clusters
// prove too mushy.
let notesDmName = "";                                   // from Cast.md, per current guild
const notesVoiceTags = new Map<number, string>();       // caption id → "voice N"

function voiceFeatures(chunks: Int16Array[], totalSamples: number, sr: number): number[] | null {
    if (totalSamples < sr * 0.4) return null;           // too short to fingerprint
    const pcm = new Float32Array(totalSamples);
    let off = 0;
    for (const c of chunks) { for (let i = 0; i < c.length; i++) pcm[off + i] = c[i] / 32768; off += c.length; }
    const frame = Math.round(sr * 0.032), hop = Math.round(sr * 0.016);
    const minLag = Math.floor(sr / 400), maxLag = Math.ceil(sr / 60);   // 60–400 Hz
    const f0s: number[] = [], zcrs: number[] = [], energies: number[] = [];
    for (let s = 0; s + frame <= pcm.length; s += hop) {
        let e = 0, zc = 0;
        for (let i = s; i < s + frame; i++) {
            e += pcm[i] * pcm[i];
            if (i > s && (pcm[i] >= 0) !== (pcm[i - 1] >= 0)) zc++;
        }
        energies.push(e / frame);
        zcrs.push(zc / frame);
    }
    const eMax = Math.max(...energies, 1e-9);
    let peaks = 0;
    for (let fi = 0; fi < energies.length; fi++) {
        const s = fi * hop;
        if (energies[fi] < eMax * 0.1) continue;
        // syllable-ish peaks: local energy maxima above half the loudest frame
        if (energies[fi] > eMax * 0.5 && energies[fi] >= (energies[fi - 1] ?? 0) && energies[fi] > (energies[fi + 1] ?? 0)) peaks++;
        // F0 via normalized autocorrelation on voiced frames only
        let bestCorr = 0, bestLag = 0, norm = 0;
        for (let i = s; i < s + frame; i++) norm += pcm[i] * pcm[i];
        if (norm < 1e-6) continue;
        for (let lag = minLag; lag <= maxLag && s + frame + lag <= pcm.length; lag += 1) {
            let corr = 0;
            for (let i = s; i < s + frame; i += 2) corr += pcm[i] * pcm[i + lag];   // stride 2: cheap enough
            if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
        }
        if (bestLag && bestCorr / (norm / 2) > 0.35) f0s.push(sr / bestLag);
    }
    if (f0s.length < 5) return null;                    // not enough voiced frames
    const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)]; };
    const f0med = med(f0s);
    return [
        Math.log2(f0med),                               // pitch (octaves)
        (q(f0s, 0.85) - q(f0s, 0.15)) / f0med,          // pitch spread (relative)
        med(zcrs),                                      // brightness proxy
        peaks / (totalSamples / sr),                    // syllable-ish rate (/s)
    ];
}

// Fingerprint the DM's utterances for [voice N] tags (RPG channels only).
// Fired by ClosedCaptions' onUtterance hook, BEFORE its buffers are cleared.
function maybeFingerprintVoice(u: CcUtterance) {
    try {
        if (!notesDmName || !notesChan || u.totalSamples === 0) return;
        if (notesChannelStyle(notesChan) !== "rpg") return;
        if (u.name.toLowerCase() !== notesDmName.toLowerCase()) return;
        const feats = voiceFeatures(u.chunks, u.totalSamples, u.sampleRate);
        if (!feats) return;
        const id = u.uttId;
        void Native.notesVoiceTag(notesChanGuild, feats)
            .then(tag => { if (tag && id) notesVoiceTags.set(id, tag); })
            .catch(() => { /* best-effort */ });
        if (notesVoiceTags.size > 400) {
            for (const k of [...notesVoiceTags.keys()].slice(0, 200)) notesVoiceTags.delete(k);
        }
    } catch { /* never break the caption path */ }
}

// Nickname hints for the RPG prompt: transcript labels use SERVER NICKNAMES
// (ClosedCaptions' resolveName prefers the nick), and players often nickname
// themselves after their character — so "label is a nickname of account X" is
// a who-plays-whom hint. Only pairs where they differ are sent; Cast.md
// always outranks this.
function notesRosterEntries(): Array<{ label: string; account: string; id: string }> {
    const out: Array<{ label: string; account: string; id: string }> = [];
    try {
        for (const id of ccApi.participantIds()) {
            const u = UserStore?.getUser?.(id);
            const account = u?.username || u?.globalName || "";
            const label = ccApi.resolveName(id);
            // ALL participants go in (ids feed the character pages' "Played
            // by" line); native only uses label≠account pairs as nick hints.
            if (account && label) out.push({ label, account, id });
        }
    } catch { /* ignore */ }
    return out;
}

// Pass cadence scales with GPU pressure, same as the caption governor: a
// busy GPU (a game) stretches the interval so passes get rarer under load.
function notesEffectiveIntervalMs(): number {
    const base = Math.max(3, settings.store.notesIntervalMinutes || 15) * 60_000;
    const d = ccApi.getEngineGpu()?.external || 0;
    return d >= 45 ? base * 4 : d >= 25 ? base * 2 : base;
}

function notesFlush(min = 2) {
    if (notesChan && notesLines.length >= min) {
        if (notesChannelStyle(notesChan) === "rpg") {
            const roster = notesRosterEntries();
            if (roster.length) void Native.notesSetRoster(notesChanGuild, roster).catch(() => { /* ignore */ });
            // Re-read the DM each flush — Cast.md may have been edited mid-call.
            void Native.notesGetCast(notesChanGuild).then(c => { notesDmName = c?.dm || ""; }).catch(() => { /* ignore */ });
        }
        void Native.notesEnqueue(notesChan, notesChanName, notesChanGuild, notesSession, notesChannelStyle(notesChan), notesLines.join("\n"));
        notesLines = [];
        notesLastSend = Date.now();
    }
}

// Driven by ClosedCaptions' 1 s status tick (no extra timers). Feeds SETTLED
// final captions into the buffer in transcript order, then decides whether a
// pass is due.
function notesTick() {
    if (!settings.store.sessionNotes) return;
    const vc = (() => { try { return SelectedChannelStore?.getVoiceChannelId?.() || ""; } catch { return ""; } })();
    if (vc !== notesChan) {
        notesFlush(1);             // leaving / switching: summarize what we have
        // Session over → one consolidation pass for that channel (queued after
        // the final transcript pass; native skips it if nothing was noted).
        if (notesChan && notesSession && notesEnabledFor(notesChan)) {
            void Native.notesCleanup(notesChan, notesChanName, notesChanGuild, notesSession, notesChannelStyle(notesChan)).catch(() => { /* ignore */ });
        }
        notesLines = [];
        notesChan = vc;
        notesChanName = vc ? channelDisplayName(vc) : "";
        notesChanGuild = vc ? channelGuildName(vc) : "";
        notesSession = vc ? sessionStamp() : "";   // new call → new Sessions/ log file
        notesLastSend = Date.now();
        // Who's the DM here (Cast.md)? Needed to know whose voice to fingerprint.
        notesDmName = "";
        notesVoiceTags.clear();
        if (vc && notesChannelStyle(vc) === "rpg") {
            void Native.notesGetCast(notesChanGuild).then(c => { notesDmName = c?.dm || ""; }).catch(() => { /* ignore */ });
        }
    }
    if (!vc) return;
    const captions = ccApi.getCaptions();
    if (!notesEnabledFor(vc)) {
        // Notes off here — drop (don't stockpile) and keep the pointer current so
        // a later enable doesn't dump old conversation into the store.
        notesLines = [];
        if (captions.length) notesFedId = Math.max(notesFedId, captions[captions.length - 1].id);
        return;
    }
    const now = Date.now();
    for (const c of captions) {
        if (c.id <= notesFedId) continue;
        const age = now - c.ts;
        if (c.final && age > NOTES_SETTLE_MS) {
            notesFedId = c.id;
            // Private DM side-channel lines (🔒) stay OUT of the shared notes file.
            if (!c.dm && c.text) {
                const vt = notesVoiceTags.get(c.id);   // "[voice N]" on the DM's lines
                notesVoiceTags.delete(c.id);
                notesLines.push(`${c.chat ? "[chat] " : ""}${c.name}${vt ? ` [${vt}]` : ""}: ${c.text}`);
            }
        } else if (!c.final && age > 60_000) {
            notesFedId = c.id;     // abandoned partial — never finalized
        } else {
            break;                 // preserve transcript order; wait for this line to settle
        }
    }
    const intervalMs = notesEffectiveIntervalMs();
    if (notesLines.length >= 40) notesFlush(40);                 // don't outgrow the LLM context
    else if (now - notesLastSend >= intervalMs) {
        // The regular cadence — the panel shows a countdown to this moment, so
        // it must fire (or visibly restart) exactly when the timer hits zero.
        if (notesLines.length > 0) notesFlush(1);
        else notesLastSend = now;                                // nothing new — restart the countdown
    }
}

// ── Notes section (bottom split of the captions sidebar) ────────────────────
// Toggled by the 📝 button in the captions header: the sidebar splits
// vertically — captions on top, notes below — with a draggable divider to
// control the proportion. Notes can pop out to their own OS window (⧉), in
// which case the in-pane section hides, mirroring the captions pop-out.
let notesHeaderBtn: HTMLDivElement | null = null;
let notesWrapEl: HTMLDivElement | null = null;
let notesDividerEl: HTMLDivElement | null = null;
let notesPanelBody: HTMLDivElement | null = null;
let notesPanelFoot: HTMLDivElement | null = null;
let notesPanelTitle: HTMLSpanElement | null = null;
let notesPanelToggle: HTMLDivElement | null = null;
let notesPanelToggleKnob: HTMLDivElement | null = null;
let notesPanelStyle: HTMLDivElement | null = null;
let notesPanelStyleText: HTMLSpanElement | null = null;
let notesStyleMenu: HTMLDivElement | null = null;
let notesStyleMenuOpen = false;
let notesStyleDocClick: ((e: MouseEvent) => void) | null = null;
let notesPanelUpdate: HTMLDivElement | null = null;
let notesPanelChatBtn: HTMLDivElement | null = null;
let notesChatWrap: HTMLDivElement | null = null;
let notesChatLogEl: HTMLDivElement | null = null;
let notesChatInput: HTMLInputElement | null = null;
let notesChatOpen = false;
let notesChatPending = "";        // instruction sent, answer not yet in the log
let notesPanelPop: HTMLDivElement | null = null;
let notesPanelTabs: HTMLDivElement | null = null;
let notesActiveTab = "";          // "" = the All tab; otherwise a file path

// Auto-switch: when ON, the panel follows the conversation — new information
// in a file switches to that file's tab and scrolls to it. A manual tab pick
// LOCKS the view (padlock on the tab); the lock holds while the mouse is on
// the pane and releases 30 s after it leaves, letting autonav resume.
let notesAutoSwitch = false;                       // the toggle — defaults off
let notesPanelAuto: HTMLDivElement | null = null;  // its pill in the header
let notesTabLocked = false;
let notesLockTimer: ReturnType<typeof setTimeout> | null = null;
let notesMouseOnPane = false;
let notesAutoScrollTop = false;
// Relevance per file comes from the LIVE CONVERSATION: every time an entity
// with a tab is mentioned in the transcript, its file's score bumps (and
// decays with recency, τ = 5 min) — so whoever is being talked about right
// now ranks first, and in auto mode the panel switches to them.
const notesTabScores = new Map<string, { score: number; last: number }>();
const NOTES_RELEVANCE_TAU = 300_000;
// Outside auto mode, tabs order by when the USER last opened them.
const notesTabOpenedAt = new Map<string, number>();

function notesRelevance(file: string): number {
    const e = notesTabScores.get(file);
    return e ? e.score * Math.exp(-(Date.now() - e.last) / NOTES_RELEVANCE_TAU) : 0;
}

function notesClearLockTimer() {
    if (notesLockTimer) { clearTimeout(notesLockTimer); notesLockTimer = null; }
}

// Entity names ↔ tab files, rebuilt from the panel's current sections (only
// entity pages — People/Torvald.md etc. — have a name to listen for). For
// each entity we also precompute which OTHER tabs' file contents mention it
// (and how often) — talking about the Spear of Destiny then surfaces its
// maker and everyone connected to it, ordered by mention count, while the
// Spear's own page always outranks them (name weight > any content weight).
const NAME_WEIGHT = 5;        // a name match always beats content matches…
const CONTENT_CAP = 3;        // …because per-file content counts cap below it
// Anti-flap: auto-switch has a cooldown between swaps, and only swaps when
// the candidate is clearly MORE relevant than the current tab — one stray
// mention of someone else mid-discussion shouldn't yank the view away.
const NOTES_SWITCH_COOLDOWN = 15_000;
const NOTES_SWITCH_MARGIN = 3;
let notesLastAutoSwitchAt = 0;
let notesKnownEntities: Array<{ file: string; re: RegExp; contentHits: Array<{ file: string; count: number }> }> = [];
let notesMentionScanId = 0;   // high-water caption id already scanned

function rebuildEntityIndex(sections: Array<NoteSection & { content?: string }>) {
    notesKnownEntities = [];
    const indexed = new Set<string>();
    for (const s of sections) {
        if (indexed.has(s.file)) continue;   // the changelog stream repeats files
        indexed.add(s.file);
        const parts = s.file.split("/");
        if (parts.length !== 2) continue;
        const name = parts[1].replace(/\.md$/, "").replace(/\s*\(unnamed\)$/i, "").trim();
        if (name.length < 3) continue;
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const needle = name.toLowerCase();
        const contentHits: Array<{ file: string; count: number }> = [];
        for (const o of sections) {
            if (o.file === s.file || !o.content) continue;   // content only on each file's first section
            let count = 0, idx = 0;
            while ((idx = o.content.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; if (count >= CONTENT_CAP) break; }
            if (count) contentHits.push({ file: o.file, count });
        }
        notesKnownEntities.push({
            file: s.file,
            re: new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "iu"),
            contentHits,
        });
    }
}

// Scan freshly finalized captions for entity mentions. A mention bumps the
// entity's own tab by NAME_WEIGHT and every tab whose contents reference it
// by its (capped) mention count; in auto mode (unlocked) the panel switches
// to the strongest match of the batch — name matches win by construction.
function scanMentions() {
    const captions = ccApi.getCaptions();
    if (!notesKnownEntities.length) {
        if (captions.length) notesMentionScanId = Math.max(notesMentionScanId, captions[captions.length - 1].id);
        return;
    }
    const now = Date.now();
    let bestFile = "", bestWeight = 0;
    const bump = (file: string, weight: number) => {
        notesTabScores.set(file, { score: notesRelevance(file) + weight, last: now });
        if (weight > bestWeight) { bestWeight = weight; bestFile = file; }
    };
    for (const c of captions) {
        if (c.id <= notesMentionScanId) continue;
        if (!c.final) {
            if (now - c.ts > 60_000) { notesMentionScanId = c.id; continue; }   // abandoned partial
            break;                                                             // keep order; wait for it
        }
        notesMentionScanId = c.id;
        if (!c.text) continue;
        for (const e of notesKnownEntities) {
            if (!e.re.test(c.text)) continue;
            bump(e.file, NAME_WEIGHT);                            // the entity's own page
            for (const h of e.contentHits) bump(h.file, h.count); // pages that reference it
        }
    }
    if (!bestFile || !notesAutoSwitch || notesTabLocked || bestFile === notesActiveTab) return;
    if (now - notesLastAutoSwitchAt < NOTES_SWITCH_COOLDOWN) return;           // cooldown between swaps
    const current = notesActiveTab ? notesRelevance(notesActiveTab) : 0;
    if (notesRelevance(bestFile) < current + NOTES_SWITCH_MARGIN) return;      // must clearly outrank the view
    notesActiveTab = bestFile;
    notesAutoScrollTop = true;   // bring the now-relevant page into view
    notesLastAutoSwitchAt = now;
}
let notesPanelOpen = false;
let notesPopoutOpen = false;
let notesViewChan = "";
let notesViewChanName = "";

function notesTargetChannel(): { id: string; name: string } {
    try {
        const vc = SelectedChannelStore?.getVoiceChannelId?.();
        if (vc) return { id: vc, name: channelDisplayName(vc) };
        const tc = SelectedChannelStore?.getChannelId?.();
        if (tc) return { id: tc, name: channelDisplayName(tc) };
    } catch { /* ignore */ }
    return { id: "", name: "" };
}

function notesSplitPct(): number {
    const v = Number(settings.store.notesSplitPct);
    return Number.isFinite(v) && v > 0 ? Math.min(85, Math.max(15, v)) : 45;
}

// The 📝 toggle in the captions sidebar header (mounted via the extension API).
function mountNotesHeaderButton(header: HTMLElement, before: HTMLElement) {
    const notes = document.createElement("div");
    notes.textContent = "📝";
    notes.title = "Session notes";
    notes.setAttribute("data-cc-notes", "");
    Object.assign(notes.style, { cursor: "pointer", color: C.dim, fontSize: "13px", lineHeight: "1", padding: "0 3px" } as Partial<CSSStyleDeclaration>);
    notes.onmouseenter = () => { notes.style.color = C.text; };
    notes.onmouseleave = () => syncNotesButtons();
    notes.onclick = () => toggleNotesPanel();
    header.insertBefore(notes, before);
    notesHeaderBtn = notes;
}

function syncNotesButtons() {
    document.querySelectorAll<HTMLElement>("[data-cc-notes]").forEach(b => {
        b.style.color = notesPanelOpen || notesPopoutOpen ? C.accent : C.dim;
    });
}

// Built once per pane mount (via the extension API), appended after the
// captions body/backlog.
function mountNotesSection(pane: HTMLDivElement) {
    C = ccApi.getPalette();   // theme may have resolved after our import

    // Draggable divider — controls the captions/notes vertical proportion.
    const divider = document.createElement("div");
    divider.title = "Drag to resize captions / notes";
    Object.assign(divider.style, {
        flex: "0 0 5px", cursor: "ns-resize", background: C.border, display: "none",
    } as Partial<CSSStyleDeclaration>);
    divider.onmousedown = e => {
        e.preventDefault();
        const rect = pane.getBoundingClientRect();
        const move = (ev: MouseEvent) => {
            const pct = Math.min(85, Math.max(15, ((rect.bottom - ev.clientY) / rect.height) * 100));
            if (notesWrapEl) notesWrapEl.style.flex = `0 0 ${pct}%`;
            settings.store.notesSplitPct = Math.round(pct);
        };
        const up = () => {
            document.removeEventListener("mousemove", move, true);
            document.removeEventListener("mouseup", up, true);
        };
        document.addEventListener("mousemove", move, true);
        document.addEventListener("mouseup", up, true);
    };
    notesDividerEl = divider;

    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
        flex: `0 0 ${notesSplitPct()}%`, display: "none", flexDirection: "column",
        minHeight: "0", overflow: "hidden", position: "relative",   // anchors the style dropdown
    } as Partial<CSSStyleDeclaration>);

    const header = document.createElement("div");
    Object.assign(header.style, {
        display: "flex", alignItems: "center", gap: "6px", padding: "8px 12px",
        background: C.headerBg, borderBottom: `1px solid ${C.border}`, flex: "0 0 auto",
    } as Partial<CSSStyleDeclaration>);

    const title = document.createElement("span");
    title.textContent = "Notes";
    Object.assign(title.style, {
        color: C.accent, fontWeight: "700", fontSize: "12px", flex: "1",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    } as Partial<CSSStyleDeclaration>);
    notesPanelTitle = title;

    // "Update now" — summarize whatever transcript has accumulated, immediately.
    const upd = makePill();
    upd.textContent = "Update now";
    upd.onclick = () => {
        if (notesWorking) return;           // one at a time — it's already running
        notesFlush(1);
        setNotesUpdateBtn(true);            // spinner right away, not on the next poll
        void refreshNotesPanel();
    };
    notesPanelUpdate = upd;

    // Note style for this channel — a dropdown so the active mode is explicit.
    const stylePill = makePill();
    const styleText = document.createElement("span");
    const styleCaret = document.createElement("span");
    styleCaret.textContent = " ▾";
    stylePill.append(styleText, styleCaret);
    stylePill.title = "Note style for this channel";
    stylePill.onclick = e => {
        e.stopPropagation();
        notesStyleMenuOpen = !notesStyleMenuOpen;
        void refreshNotesPanel();
    };
    notesPanelStyle = stylePill;
    notesPanelStyleText = styleText;

    // Dropdown menu (absolute within the notes section).
    const styleMenu = document.createElement("div");
    Object.assign(styleMenu.style, {
        position: "absolute", top: "30px", right: "8px", zIndex: "5", minWidth: "230px",
        background: C.bg, border: `1px solid ${C.border}`, borderRadius: "6px",
        boxShadow: C.shadow, padding: "4px", display: "none", flexDirection: "column", gap: "2px",
    } as Partial<CSSStyleDeclaration>);
    for (const opt of [
        { v: "conversation", label: "Conversation", sub: "only things worth remembering — never profiles people" },
        { v: "rpg", label: "RPG", sub: "full world-building knowledge base (characters, places, items)" },
    ]) {
        const row = document.createElement("div");
        row.dataset.style = opt.v;
        Object.assign(row.style, { padding: "5px 8px", borderRadius: "4px", cursor: "pointer" } as Partial<CSSStyleDeclaration>);
        const l = document.createElement("div");
        l.textContent = opt.label;
        Object.assign(l.style, { fontSize: "12px", fontWeight: "600" } as Partial<CSSStyleDeclaration>);
        const s = document.createElement("div");
        s.textContent = opt.sub;
        Object.assign(s.style, { color: C.dim, fontSize: "10px" } as Partial<CSSStyleDeclaration>);
        row.append(l, s);
        row.onmouseenter = () => { row.style.background = "rgba(127,127,127,0.15)"; };
        row.onmouseleave = () => { row.style.background = notesViewChan && notesChannelStyle(notesViewChan) === opt.v ? "rgba(127,127,127,0.12)" : "transparent"; };
        row.onclick = e => {
            e.stopPropagation();
            if (notesViewChan) patchNotesChannel(notesViewChan, { style: opt.v });
            notesStyleMenuOpen = false;
            void refreshNotesPanel();
        };
        styleMenu.appendChild(row);
    }
    notesStyleMenu = styleMenu;

    // Close the dropdown on any outside click.
    notesStyleDocClick = e => {
        if (!notesStyleMenuOpen) return;
        const t = e.target as Node;
        if (notesStyleMenu?.contains(t) || notesPanelStyle?.contains(t)) return;
        notesStyleMenuOpen = false;
        if (notesStyleMenu) notesStyleMenu.style.display = "none";
    };
    document.addEventListener("click", notesStyleDocClick, true);

    // Per-channel on/off — a bare toggle slider (state is self-evident).
    const toggle = document.createElement("div");
    Object.assign(toggle.style, {
        position: "relative", width: "28px", height: "16px", borderRadius: "8px",
        background: "rgba(127,127,127,0.4)", cursor: "pointer", flex: "0 0 auto",
        transition: "background 150ms ease",
    } as Partial<CSSStyleDeclaration>);
    const knob = document.createElement("div");
    Object.assign(knob.style, {
        position: "absolute", top: "2px", left: "2px", width: "12px", height: "12px",
        borderRadius: "50%", background: "#fff", transition: "left 150ms ease",
        boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
    } as Partial<CSSStyleDeclaration>);
    toggle.appendChild(knob);
    toggle.onclick = () => {
        if (!notesViewChan) return;
        setNotesOverride(notesViewChan, !notesEnabledFor(notesViewChan));
        void refreshNotesPanel();
    };
    notesPanelToggle = toggle;
    notesPanelToggleKnob = knob;

    const folder = document.createElement("div");
    folder.textContent = "📂";
    folder.title = "Open the notes folder";
    Object.assign(folder.style, { cursor: "pointer", fontSize: "12px", padding: "0 2px" } as Partial<CSSStyleDeclaration>);
    folder.onclick = () => { void Native.notesOpenDir(); };

    // Purge this session's notes — two-stage so one stray click can't nuke.
    // Deletes the session's recorded facts AND (when possible) their git
    // history; also drops the un-summarized transcript buffer for the channel.
    const purge = document.createElement("div");
    purge.textContent = "🗑";
    purge.title = "Purge this session's notes (click twice)";
    Object.assign(purge.style, { cursor: "pointer", fontSize: "12px", padding: "0 2px", userSelect: "none" } as Partial<CSSStyleDeclaration>);
    let purgeArmed: ReturnType<typeof setTimeout> | null = null;
    purge.onclick = async () => {
        if (!purgeArmed) {
            purge.textContent = "Sure?";
            purge.style.color = C.crit;
            purgeArmed = setTimeout(() => { purgeArmed = null; purge.textContent = "🗑"; purge.style.color = ""; }, 4000);
            return;
        }
        clearTimeout(purgeArmed);
        purgeArmed = null;
        purge.textContent = "🗑";
        purge.style.color = "";
        try {
            if (notesViewChan === notesChan) notesLines = [];   // un-summarized buffer too
            const msg = await Native.notesPurgeSession(
                notesViewChan, notesViewChanName, channelGuildName(notesViewChan),
                notesViewChan === notesChan ? notesSession : "");
            toast(`Notes: ${msg}`, Toasts.Type.MESSAGE);
            void refreshNotesPanel();
        } catch (e) { logger.error("purge failed", e); }
    };

    // Auto-switch toggle (defaults off): follow the conversation across tabs.
    const autoPill = makePill();
    autoPill.textContent = "Auto";
    autoPill.title = "Auto-switch: follow the conversation — new information switches to its tab. Manual picks lock the view (30 s after the mouse leaves, it unlocks).";
    autoPill.onclick = () => {
        notesAutoSwitch = !notesAutoSwitch;
        if (!notesAutoSwitch) { notesTabLocked = false; notesClearLockTimer(); }
        autoPill.style.color = notesAutoSwitch ? C.accent : C.dim;
        autoPill.style.borderColor = notesAutoSwitch ? C.accent : C.border;
        void refreshNotesPanel();
    };
    notesPanelAuto = autoPill;

    // Chat with the note-taker: tell it to correct something it got wrong.
    const chatBtn = document.createElement("div");
    chatBtn.textContent = "💬";
    chatBtn.title = "Chat with the note-taker (corrections, instructions)";
    Object.assign(chatBtn.style, { cursor: "pointer", fontSize: "12px", padding: "0 2px" } as Partial<CSSStyleDeclaration>);
    chatBtn.onclick = () => {
        notesChatOpen = !notesChatOpen;
        if (notesChatWrap) notesChatWrap.style.display = notesChatOpen ? "flex" : "none";
        chatBtn.style.opacity = notesChatOpen ? "1" : "0.75";
        if (notesChatOpen) notesChatInput?.focus();
    };
    notesPanelChatBtn = chatBtn;

    // Pop the notes out into their own OS window, like the captions ⧉.
    const pop = document.createElement("div");
    pop.textContent = "⧉";
    pop.title = "Pop notes out to a window";
    Object.assign(pop.style, { cursor: "pointer", color: C.dim, fontSize: "13px", lineHeight: "1", padding: "0 3px" } as Partial<CSSStyleDeclaration>);
    pop.onmouseenter = () => { pop.style.color = C.text; };
    pop.onmouseleave = () => { pop.style.color = notesPopoutOpen ? C.accent : C.dim; };
    pop.onclick = () => { void toggleNotesPopout(); };
    notesPanelPop = pop;

    header.append(title, upd, stylePill, toggle, autoPill, chatBtn, folder, purge, pop);

    // Lock lifecycle: held while the mouse is on the pane; released 30 s
    // after it leaves (timer cancelled if the mouse comes back).
    wrap.onmouseenter = () => { notesMouseOnPane = true; notesClearLockTimer(); };
    wrap.onmouseleave = () => {
        notesMouseOnPane = false;
        if (notesTabLocked && notesAutoSwitch) {
            notesClearLockTimer();
            notesLockTimer = setTimeout(() => {
                notesLockTimer = null;
                if (!notesMouseOnPane) { notesTabLocked = false; void refreshNotesPanel(); }
            }, 30_000);
        }
    };

    // Tab bar: "All" + one tab per file touched this session. House tab style
    // (STYLE.md): no pill/box — tabs equally fill the full width, active =
    // accent + bold with a 3px accent underline spanning the whole tab.
    const tabs = document.createElement("div");
    Object.assign(tabs.style, {
        display: "flex", alignItems: "stretch", gap: "0", padding: "0",
        background: C.headerBg, borderBottom: `1px solid ${C.border}`, flex: "0 0 auto",
    } as Partial<CSSStyleDeclaration>);
    notesPanelTabs = tabs;

    const body = document.createElement("div");
    body.className = "cc-body";   // reuse the pane's thin themed scrollbar CSS
    Object.assign(body.style, {
        flex: "1", overflowY: "auto", padding: "8px 12px",
        display: "flex", flexDirection: "column", gap: "6px",
    } as Partial<CSSStyleDeclaration>);
    notesPanelBody = body;

    const foot = document.createElement("div");
    Object.assign(foot.style, {
        flex: "0 0 auto", padding: "5px 12px", borderTop: `1px solid ${C.border}`,
        background: C.headerBg, color: C.dim, fontSize: "11px",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "none",
    } as Partial<CSSStyleDeclaration>);
    notesPanelFoot = foot;

    // Chat strip (toggled by 💬): a tiny log + input. Typing "Torvald is a
    // woman, fix that" runs a correction pass over the vault and replies.
    const chatWrap = document.createElement("div");
    Object.assign(chatWrap.style, {
        display: "none", flexDirection: "column", flex: "0 0 auto",
        borderTop: `1px solid ${C.border}`, background: C.headerBg,
    } as Partial<CSSStyleDeclaration>);
    const chatLog = document.createElement("div");
    chatLog.className = "cc-body";
    Object.assign(chatLog.style, {
        overflowY: "auto", maxHeight: "110px", padding: "6px 10px",
        display: "flex", flexDirection: "column", gap: "3px", fontSize: "12px",
    } as Partial<CSSStyleDeclaration>);
    const chatInput = document.createElement("input");
    chatInput.type = "text";
    chatInput.placeholder = "Correct or instruct the notes… (Enter to send)";
    Object.assign(chatInput.style, {
        margin: "0 8px 8px", padding: "5px 8px", fontSize: "12px",
        background: C.bg, color: C.text, border: `1px solid ${C.border}`,
        borderRadius: "5px", outline: "none", fontFamily: C.font,
    } as Partial<CSSStyleDeclaration>);
    chatInput.onkeydown = e => {
        e.stopPropagation();   // don't let Discord's keybinds eat the typing
        if (e.key !== "Enter") return;
        const q = chatInput.value.trim();
        if (!q || !notesViewChan) return;
        chatInput.value = "";
        notesChatPending = q;
        void Native.notesChat(notesViewChan, notesViewChanName, channelGuildName(notesViewChan),
            notesViewChan === notesChan ? notesSession : "", notesChannelStyle(notesViewChan), q);
        renderNotesChatLog([]);   // show the pending row immediately
        void refreshNotesPanel();
    };
    chatWrap.append(chatLog, chatInput);
    notesChatWrap = chatWrap;
    notesChatLogEl = chatLog;
    notesChatInput = chatInput;

    wrap.append(header, styleMenu, tabs, body, chatWrap, foot);
    pane.append(divider, wrap);
    notesWrapEl = wrap;
    renderNotesSection();   // restore open/closed state across a pane re-mount
}

// The captions pane was torn down — drop every reference to mounted DOM.
function onPaneUnmount() {
    notesHeaderBtn = null;
    notesWrapEl = null; notesDividerEl = null; notesPanelBody = null; notesPanelFoot = null;
    notesPanelTitle = null; notesPanelToggle = null; notesPanelToggleKnob = null;
    if (notesStyleDocClick) { document.removeEventListener("click", notesStyleDocClick, true); notesStyleDocClick = null; }
    notesPanelStyle = null; notesPanelStyleText = null; notesStyleMenu = null; notesStyleMenuOpen = false;
    notesPanelUpdate = null; notesPanelPop = null; notesPanelTabs = null; notesPanelAuto = null;
    notesPanelChatBtn = null; notesChatWrap = null; notesChatLogEl = null; notesChatInput = null; notesChatOpen = false;
}

// Remove everything we mounted into the (still-live) captions pane — used
// when THIS plugin stops while ClosedCaptions keeps running.
function removeMountedDom() {
    notesHeaderBtn?.remove();
    notesDividerEl?.remove();
    notesWrapEl?.remove();
    onPaneUnmount();
}

let notesChatLast: Array<{ q: string; a: string }> = [];
function renderNotesChatLog(log: Array<{ q: string; a: string }>) {
    if (log.length) notesChatLast = log;
    if (!notesChatLogEl) return;
    if (notesChatPending && notesChatLast.some(e => e.q === notesChatPending)) notesChatPending = "";
    notesChatLogEl.replaceChildren();
    const add = (prefix: string, text: string, color: string) => {
        const row = document.createElement("div");
        row.style.wordBreak = "break-word";
        const p = document.createElement("span");
        p.textContent = prefix;
        Object.assign(p.style, { color: C.dim, fontWeight: "600" } as Partial<CSSStyleDeclaration>);
        const t = document.createElement("span");
        t.textContent = text;
        t.style.color = color;
        row.append(p, t);
        notesChatLogEl!.appendChild(row);
    };
    for (const e of notesChatLast.slice(-8)) {
        add("you: ", e.q, C.text);
        add("↳ ", e.a, C.dim);
    }
    if (notesChatPending) { add("you: ", notesChatPending, C.text); add("↳ ", "…", C.dim); }
    notesChatLogEl.scrollTop = notesChatLogEl.scrollHeight;
}

// "All" + per-file tabs for everything touched this session. House tab style
// (STYLE.md): tabs equally fill the full width (flex 1 1 0, centered label),
// active = accent + bold over a 3px accent underline spanning the whole tab,
// inactive = dim, hover = faint accent underline. Snug vertical padding.
function renderNotesTabs(sections: NoteSection[]) {
    if (!notesPanelTabs) return;
    if (notesActiveTab && !sections.some(s => s.file === notesActiveTab)) notesActiveTab = "";
    notesPanelTabs.replaceChildren();
    const faint = `color-mix(in srgb, ${C.accent} 45%, transparent)`;
    const mk = (label: string, key: string, titleText: string) => {
        const t = document.createElement("div");
        const active = notesActiveTab === key;
        t.title = titleText;
        Object.assign(t.style, {
            cursor: "pointer", userSelect: "none",
            flex: "1 1 0", minWidth: "0",                       // equal stretch, full width
            display: "flex", flexDirection: "column", alignItems: "stretch",
        } as Partial<CSSStyleDeclaration>);
        const lbl = document.createElement("div");
        // Padlock on a manually picked tab while auto-switch is on.
        lbl.textContent = active && notesAutoSwitch && notesTabLocked ? `🔒 ${label}` : label;
        Object.assign(lbl.style, {
            fontSize: "11px", textAlign: "center", padding: "1px 4px 0",
            fontWeight: active ? "700" : "500",
            color: active ? C.accent : C.dim,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        } as Partial<CSSStyleDeclaration>);
        const underline = document.createElement("div");
        Object.assign(underline.style, {
            height: "3px", background: active ? C.accent : "transparent",
        } as Partial<CSSStyleDeclaration>);
        t.append(lbl, underline);
        t.onmouseenter = () => { if (!active) underline.style.background = faint; };
        t.onmouseleave = () => { underline.style.background = active ? C.accent : "transparent"; };
        t.onclick = () => {
            notesActiveTab = key;
            if (key) notesTabOpenedAt.set(key, Date.now());
            if (notesAutoSwitch) { notesTabLocked = true; notesClearLockTimer(); }   // manual pick → lock
            void refreshNotesPanel();
        };
        return t;
    };
    notesPanelTabs.appendChild(mk("All", "", "Everything noted this session"));
    // The changelog stream repeats files — one TAB per file (first/newest
    // appearance sets the base order). Auto mode ranks tabs by conversational
    // relevance (recency-decayed mention score); manual mode by when the user
    // last opened each tab. All stays pinned left; ties keep stream order.
    const files = [...new Set(sections.map(s => s.file))];
    const ordered = notesAutoSwitch
        ? files.sort((a, b) => notesRelevance(b) - notesRelevance(a))
        : files.sort((a, b) => (notesTabOpenedAt.get(b) || 0) - (notesTabOpenedAt.get(a) || 0));
    for (const f of ordered) {
        const base = f.split("/").pop() || f;
        notesPanelTabs.appendChild(mk(base.replace(/\.md$/, ""), f, f));
    }
}

// Update-now pill contents: spinner + label while a pass is running.
let notesWorking = false;
function setNotesUpdateBtn(working: boolean) {
    notesWorking = working;
    if (!notesPanelUpdate) return;
    notesPanelUpdate.replaceChildren();
    if (working) {
        const sp = document.createElement("span");
        sp.className = "cc-spin";
        sp.textContent = "⟳";
        notesPanelUpdate.append(sp, document.createTextNode(" Updating…"));
    } else {
        notesPanelUpdate.textContent = "Update now";
    }
    notesPanelUpdate.style.color = working ? C.dim : C.accent;
    notesPanelUpdate.style.borderColor = working ? C.border : C.accent;
    notesPanelUpdate.style.cursor = working ? "default" : "pointer";
}

function renderNotesSection() {
    const show = notesPanelOpen && !notesPopoutOpen;
    if (notesWrapEl) notesWrapEl.style.display = show ? "flex" : "none";
    if (notesDividerEl) notesDividerEl.style.display = show ? "block" : "none";
    if (notesPanelPop) notesPanelPop.style.color = notesPopoutOpen ? C.accent : C.dim;
    syncNotesButtons();
}

// Session changes grouped by destination file — rendered in the pane AND
// pushed to the pop-out window (which only ever assigns textContent).
interface NoteSection { file: string; rows: Array<{ subject: string; text: string; category: string; updated: string }>; }

async function refreshNotesPanel() {
    if (!notesPanelOpen && !notesPopoutOpen) return;
    if (!notesPanelBody || !notesPanelFoot || !notesPanelTitle || !notesPanelToggle) return;
    notesPanelTitle.textContent = `Notes — ${notesViewChanName || "no channel"}`;
    notesPanelTitle.title = notesPanelTitle.textContent;
    const on = notesEnabledFor(notesViewChan);
    notesPanelToggle.title = on ? "Note-taking is ON for this channel" : "Note-taking is OFF for this channel";
    notesPanelToggle.style.background = on ? C.accent : "rgba(127,127,127,0.4)";
    if (notesPanelToggleKnob) notesPanelToggleKnob.style.left = on ? "14px" : "2px";
    if (notesPanelStyle && notesPanelStyleText) {
        const style = notesChannelStyle(notesViewChan);
        notesPanelStyleText.textContent = style === "rpg" ? "RPG" : "Conversation";
        notesPanelStyle.style.color = notesStyleMenuOpen ? C.accent : C.text;
        notesPanelStyle.style.borderColor = notesStyleMenuOpen ? C.accent : C.border;
        if (notesStyleMenu) {
            notesStyleMenu.style.display = notesStyleMenuOpen ? "flex" : "none";
            notesStyleMenu.querySelectorAll<HTMLElement>("[data-style]").forEach(r => {
                const active = r.dataset.style === style;
                r.style.background = active ? "rgba(127,127,127,0.12)" : "transparent";
                (r.firstElementChild as HTMLElement).style.color = active ? C.accent : C.text;
            });
        }
    }
    try {
        const [st, data] = await Promise.all([
            Native.notesState(),
            notesViewChan
                ? Native.notesGet(notesViewChan, notesViewChanName, channelGuildName(notesViewChan),
                    notesViewChan === notesChan ? notesSession : "")
                : Promise.resolve(null),
        ]);

        // Update-now button reflects in-flight work (spinner while running).
        const working = st.busy || st.queued > 0 || st.phase === "downloading-model" || st.phase === "provisioning";
        setNotesUpdateBtn(working);

        // Native computes "changes this session" from git (manual edits
        // included), falling back to the whole vault grouped by file.
        const sections: NoteSection[] = (data?.sections as NoteSection[]) || [];

        rebuildEntityIndex(sections);
        scanMentions();              // before tabs render, so a switch shows active
        renderNotesTabs(sections);
        const shown = notesActiveTab ? sections.filter(s => s.file === notesActiveTab) : sections;

        notesPanelBody.replaceChildren();
        if (!shown.length) {
            const empty = document.createElement("div");
            empty.textContent = notesViewChan
                ? (on ? "Nothing noted this session yet." : "Note-taking is off for this channel.")
                : "Open a channel (or join a call) to see its notes.";
            Object.assign(empty.style, { color: C.dim, fontSize: "13px" } as Partial<CSSStyleDeclaration>);
            notesPanelBody.appendChild(empty);
        }
        for (const sec of shown) {
            // On the All tab, each file heads its group; a file tab already
            // names the file, so skip the redundant heading there.
            if (!notesActiveTab) {
                const h = document.createElement("div");
                h.textContent = sec.file;   // guild-relative page path as the heading
                Object.assign(h.style, {
                    fontSize: "11px", fontWeight: "700", color: C.dim, letterSpacing: "0.02em",
                    marginTop: notesPanelBody.childElementCount ? "6px" : "0",
                } as Partial<CSSStyleDeclaration>);
                notesPanelBody.appendChild(h);
            }
            for (const r of sec.rows) {
                const row = document.createElement("div");
                Object.assign(row.style, { fontSize: "13px", lineHeight: "1.45", wordBreak: "break-word", display: "flex", gap: "7px" } as Partial<CSSStyleDeclaration>);
                const dot = document.createElement("span");
                dot.textContent = "•";
                dot.style.color = C.accent;
                const tx = document.createElement("span");
                if (r.subject) {
                    const sj = document.createElement("span");
                    sj.textContent = `${r.subject}: `;
                    Object.assign(sj.style, { fontWeight: "700", color: C.name } as Partial<CSSStyleDeclaration>);
                    sj.title = r.category;
                    tx.appendChild(sj);
                }
                tx.appendChild(document.createTextNode(r.text));   // textContent path only — notes can't inject markup
                if (r.updated) tx.title = `Updated ${r.updated.slice(0, 16).replace("T", " ")}`;
                row.append(dot, tx);
                notesPanelBody.appendChild(row);
            }
        }

        if (notesAutoScrollTop) { notesAutoScrollTop = false; notesPanelBody.scrollTop = 0; }

        // Footer: just the countdown (errors still surface — they matter).
        if (st.phase === "error") {
            notesPanelFoot.textContent = `⚠ ${st.message}`;
            notesPanelFoot.style.color = C.crit;
        } else if (notesViewChan && notesViewChan === notesChan && notesEnabledFor(notesViewChan) && !working) {
            const intervalMs = notesEffectiveIntervalMs();
            const left = Math.max(0, intervalMs - (Date.now() - notesLastSend));
            const mm = Math.floor(left / 60_000);
            const ss = Math.floor((left % 60_000) / 1000);
            notesPanelFoot.textContent = `next update in ${mm}:${String(ss).padStart(2, "0")}`;
            notesPanelFoot.style.color = C.dim;
        } else {
            notesPanelFoot.textContent = "";
        }
        notesPanelFoot.style.display = notesPanelFoot.textContent ? "block" : "none";

        // Chat log (answers arrive asynchronously via the queue).
        if (notesChatOpen) {
            try { renderNotesChatLog(await Native.notesGetChat()); } catch { /* ignore */ }
        }

        if (notesPopoutOpen) {
            // Strip the content payload — the window only renders file + rows.
            const alive = await Native.notesPopout("data", sections.map(s => ({ file: s.file, rows: s.rows })));
            if (!alive) { notesPopoutOpen = false; renderNotesSection(); }
        }
    } catch (e) {
        logger.error("refreshNotesPanel failed", e);
    }
}

function toggleNotesPanel() {
    notesPanelOpen = !notesPanelOpen;
    if (notesPanelOpen) {
        const t = notesTargetChannel();
        notesViewChan = t.id;
        notesViewChanName = t.name;
        // Fresh view: autonav state resets (no stale locks or scores); the
        // mention scanner starts from "now" rather than replaying old captions.
        notesTabScores.clear();
        notesTabLocked = false;
        notesClearLockTimer();
        notesLastAutoSwitchAt = 0;
        const captions = ccApi.getCaptions();
        if (captions.length) notesMentionScanId = captions[captions.length - 1].id;
        // The user clicked in — they want fresh notes NOW: trigger a
        // summarization of whatever transcript has accumulated (even a single
        // line) and lift the idle-only gating while the section is open.
        notesFlush(1);
        void Native.notesSetBoost(true).catch(() => { /* ignore */ });
        void refreshNotesPanel();
    } else {
        if (notesPopoutOpen) { notesPopoutOpen = false; void Native.notesPopout("close").catch(() => { /* ignore */ }); }
        void Native.notesSetBoost(false).catch(() => { /* ignore */ });
    }
    renderNotesSection();
}

async function toggleNotesPopout() {
    try {
        if (notesPopoutOpen) { notesPopoutOpen = false; await Native.notesPopout("close"); renderNotesSection(); return; }
        const alive = await Native.notesPopout("open", { theme: { ...ccApi.popoutTheme(), name: C.name } });
        notesPopoutOpen = !!alive;
        renderNotesSection();
        void refreshNotesPanel();   // push the first data frame
    } catch (e) { logger.error("toggleNotesPopout failed", e); }
}

export default definePlugin({
    name: "ClosedCaptionsNotes",
    description:
        "Session notes for ClosedCaptions voice-call transcripts — a local LLM maintains a per-channel " +
        "knowledge base (markdown vault, git-versioned). Strictly opt-in per channel.",
    authors: [{ name: "flashgnash", id: 0n }],
    dependencies: ["ClosedCaptions"],
    settings,

    async start() {
        migrateFromClosedCaptions();
        C = ccApi.getPalette();
        pushNotesConfig();      // notes dir/model/prompt → native (no engine spawn yet)

        registerCcExtension({
            id: "ClosedCaptionsNotes",
            onTick: () => {
                try { notesTick(); } catch (e) { logger.error("notes tick", e); }
                if (notesPanelOpen || notesPopoutOpen) void refreshNotesPanel();
            },
            onUtterance: u => maybeFingerprintVoice(u),
            mountHeader: (header, before) => mountNotesHeaderButton(header, before),
            mountSection: pane => mountNotesSection(pane),
            onPaneUnmount: () => onPaneUnmount(),
            syncState: () => syncNotesButtons(),
            onCcStop: () => {
                // Don't lose the tail of the session's transcript when the
                // captions plugin shuts down under us.
                notesFlush(1);
                notesPanelOpen = false; notesPopoutOpen = false; notesActiveTab = "";
                void Native.notesSetBoost(false).catch(() => { /* ignore */ });
                void Native.notesPopout("close").catch(() => { /* ignore */ });
            },
        });

        // Debug handle — inspect notes state from the console.
        (window as any).__closedCaptionsNotes = {
            toggle: toggleNotesPanel,
            state: () => Native.notesState(),
            flush: () => notesFlush(1),
            enabledFor: (ch: string) => notesEnabledFor(ch),
        };
        logger.info("ClosedCaptionsNotes started");
    },

    async stop() {
        unregisterCcExtension("ClosedCaptionsNotes");
        notesFlush(1);   // don't lose the tail of the session's transcript
        if (notesPopoutOpen) { notesPopoutOpen = false; void Native.notesPopout("close").catch(() => { /* ignore */ }); }
        void Native.notesSetBoost(false).catch(() => { /* ignore */ });
        notesPanelOpen = false; notesActiveTab = "";
        notesFedId = 0; notesLines = []; notesChan = ""; notesChanName = ""; notesChanGuild = ""; notesSession = "";
        notesDmName = ""; notesVoiceTags.clear();
        notesTabScores.clear(); notesTabOpenedAt.clear(); notesKnownEntities = []; notesMentionScanId = 0;
        notesClearLockTimer();
        removeMountedDom();
        delete (window as any).__closedCaptionsNotes;
    },
});
