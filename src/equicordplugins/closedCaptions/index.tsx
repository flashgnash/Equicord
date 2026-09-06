/*
 * ClosedCaptions — renderer side.
 *
 * Live per-speaker closed captions for a Discord voice call. Discord has no
 * built-in transcription, and a PC-level (system-wide) STT can't attribute a
 * transcript to WHO said it. The trick — proven by ../PerUserAudioSinks and
 * Vencord's VolumeBooster — is that on the WEB / Vesktop (Chromium) audio path
 * every remote participant is kept as its OWN JS object with its own
 * MediaStream:
 *
 *     interface StreamData { id: string; stream: MediaStream; audioContext; ... }
 *
 * So we hook the exact same class method those plugins hook (the one that sets
 * `.volume = this._volume/100`), and for each user tap `this.stream` into our
 * own 16 kHz capture graph. A simple energy VAD segments that user's audio into
 * utterances; each finished utterance is shipped to the native side (./native.ts)
 * which turns it into text with a warm whisper.cpp server. The text is rendered
 * in an on-screen overlay, attributed to that speaker by name.
 *
 * On the NATIVE Electron Discord client audio is mixed in C++ and never reaches
 * JS, so this is impossible there — guarded by the same `!IS_DISCORD_DESKTOP`
 * predicate VolumeBooster/PerUserAudioSinks use. Everything is guarded so a miss
 * is a logged no-op, never a crash.
 *
 * The overlay is built with plain DOM (not React) so it doesn't depend on which
 * React/ReactDOM a given Vencord build exposes, and transcribed text is inserted
 * via textContent — never innerHTML — so a spoken "<script>" is just characters.
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { Toasts } from "@webpack/common";

const Native = VencordNative.pluginHelpers.ClosedCaptions as PluginNative<typeof import("./native")>;
const logger = new Logger("ClosedCaptions");
const VERSION = "cc-2";

const UserStore = findStoreLazy("UserStore");
// For capturing your OWN voice: SpeakingStore mirrors Discord's real transmit
// state (respects mute / push-to-talk / voice-activity), MediaEngineStore gives
// the selected input device + a self-mute fallback, and SelectedChannelStore
// tells us whether we're actually in a voice channel.
const SpeakingStore = findStoreLazy("SpeakingStore");
const MediaEngineStore = findStoreLazy("MediaEngineStore");
const SelectedChannelStore = findStoreLazy("SelectedChannelStore");
// For colouring speaker names by their role colour (and respecting the IrcColors
// plugin, which recolours everyone by a hash of their id).
const GuildMemberStore = findStoreLazy("GuildMemberStore");
const ChannelStore = findStoreLazy("ChannelStore");

// We ask for a 16 kHz capture context (whisper's native rate — Chromium resamples
// each source into it), but fall back gracefully if the browser refuses that
// rate: everything downstream reads the context's ACTUAL sampleRate, and native
// resamples the WAV anyway, so timing stays correct either way.
const WANT_SR = 16000;
const FRAME = 4096;                        // samples per ScriptProcessor callback
const PREROLL_FRAMES = 3;                  // ~0.75 s kept so we don't clip word onsets

// ONE shared capture AudioContext for every speaker. Chromium caps the number of
// live AudioContexts (~6) and Discord already holds one per user, so a context
// per participant would blow the limit on a full call — all our taps share this.
let capCtx: AudioContext | null = null;
function getCapCtx(): AudioContext {
    if (capCtx && capCtx.state !== "closed") return capCtx;
    try {
        capCtx = new AudioContext({ sampleRate: WANT_SR });
    } catch {
        capCtx = new AudioContext();       // rate unsupported — use whatever we get
    }
    void capCtx.resume();
    return capCtx;
}

// Follow whatever theme Discord has loaded. Two conventions exist and we detect
// which is present at runtime: BetterDiscord-style themes (e.g. this repo's
// MaterialMonokai) define RGB-triplet vars like `--accentcolor: 157,255,0`,
// `--backgroundsecondary`, `--font`, `--textbrightest`; Discord-native / Vencord
// themes override `--brand-experiment`, `--background-secondary`, `--text-normal`
// etc. We map to whichever set the active theme actually defines, so the pane
// matches the theme exactly (and is Discord-blurple-branded when there's none).
interface Palette {
    bg: string; headerBg: string; border: string; text: string; name: string; accent: string;
    dim: string; crit: string; warn: string; shadow: string; font: string; scrollThumb: string;
}

function cssVar(name: string): string {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch { return ""; }
}

function resolvePalette(): Palette {
    // Per token: Discord-native (or vanilla blurple) is the base; a
    // BetterDiscord-style theme overrides ONLY the tokens it actually defines,
    // so a partial BD theme still gets Discord-native for the rest.
    const has = (v: string) => !!cssVar(v);
    const rgb = (v: string, fb: string) => `rgb(var(${v}, ${fb}))`;
    return {
        bg: has("--backgroundsecondary") ? rgb("--backgroundsecondary", "38,50,56") : "var(--background-secondary, #2b2d31)",
        headerBg: has("--backgroundtertiary") ? rgb("--backgroundtertiary", "25,34,39") : "var(--background-tertiary, #1e1f22)",
        border: has("--framecolor") ? "rgba(var(--framecolor, 56,73,81,0.75))"
            : has("--backgroundtertiary") ? rgb("--backgroundtertiary", "30,31,34")
                : "var(--border-subtle, var(--background-tertiary, #1e1f22))",
        text: has("--textbrighter") ? rgb("--textbrighter", "222,222,222") : "var(--text-normal, #dbdee1)",
        name: has("--textbrightest") ? rgb("--textbrightest", "255,255,255") : "var(--header-primary, #f2f3f5)",
        accent: has("--accentcolor") ? rgb("--accentcolor", "157,255,0") : "var(--brand-experiment, var(--brand-500, #5865f2))",
        dim: has("--textdark") ? rgb("--textdark", "140,140,140") : "var(--text-muted, #949ba4)",
        crit: has("--dangercolor") ? rgb("--dangercolor", "237,66,69") : "var(--text-danger, #f23f42)",
        warn: has("--warningcolor") ? rgb("--warningcolor", "234,179,8") : "var(--text-warning, #eab308)",
        shadow: "var(--elevation-high, 0 8px 24px rgba(0,0,0,0.5))",
        font: has("--font") ? "var(--font, ui-monospace, monospace)" : "var(--font-primary, \"gg sans\", \"Noto Sans\", sans-serif)",
        scrollThumb: has("--textdarkest") ? rgb("--textdarkest", "80,80,80") : "var(--scrollbar-thin-thumb, rgba(255,255,255,0.16))",
    };
}

// Resolved at start() (once the theme's stylesheet is present).
let C: Palette = resolvePalette();

const PANE_WIDTH = 340;   // docked sidebar width (px)

// ── Settings ─────────────────────────────────────────────────────────────────
const settings = definePluginSettings({
    quality: {
        type: OptionType.SELECT,
        description: "Transcription model (downloaded once, cached). Bigger = more accurate, needs a stronger CPU/GPU.",
        options: [
            { label: "Balanced — small (~490 MB)", value: "balanced", default: true },
            { label: "Accurate — medium (~1.5 GB)", value: "accurate" },
            { label: "Best — large-v3-turbo (~1.6 GB, needs a GPU)", value: "turbo" },
        ],
        onChange: () => pushConfig(),
    },
    language: {
        type: OptionType.STRING,
        description: "Spoken language code (e.g. en, de, fr) or \"auto\" to detect.",
        default: "auto",
        onChange: () => pushConfig(),
    },
    autoDownload: {
        type: OptionType.BOOLEAN,
        description: "Automatically download the speech engine + model on first run (off = you must provide them yourself).",
        default: true,
        onChange: () => pushConfig(),
    },
    threads: {
        type: OptionType.NUMBER,
        description: "CPU threads the speech engine may use. Lower = gentler on the rest of the system (whisper spins all threads even on GPU).",
        default: 4,
        onChange: () => pushConfig(),
    },
    captureSelf: {
        type: OptionType.BOOLEAN,
        description: "Also caption YOUR OWN speech (respects Discord mute / push-to-talk — only while you're actually transmitting).",
        default: true,
        onChange: () => syncOwnCapture(),
    },
    overlay: {
        type: OptionType.BOOLEAN,
        description: "Also show a floating caption strip at the bottom of the call (off by default — the transcript pane is the main view).",
        default: false,
        onChange: () => render(),
    },
    transcriptPane: {
        type: OptionType.BOOLEAN,
        description: "Show the scrolling transcript panel docked to the right of the call window.",
        default: true,
        onChange: () => render(),
    },
    streaming: {
        type: OptionType.BOOLEAN,
        description: "Show captions live WHILE someone talks (interim results), not just after they stop. Best with a GPU engine; turn off if CPU can't keep up.",
        default: true,
    },
    partialIntervalMs: {
        type: OptionType.NUMBER,
        description: "Minimum ms between live-caption refreshes while someone is still speaking (also sets how soon the first interim caption appears). The GPU governor may space them out further.",
        default: 600,
    },
    flagLowConfidence: {
        type: OptionType.BOOLEAN,
        description: "Flag uncertain transcriptions: colour low-confidence words yellow and mark shaky lines with a ⚠ — so you know when a caption may be wrong rather than trusting garbage.",
        default: true,
    },
    confidencePercent: {
        type: OptionType.SLIDER,
        description: "A whole line below this confidence is retried and, if still low, marked with a ⚠ warning.",
        markers: [40, 50, 55, 65, 75],
        default: 55,
        stickToMarkers: false,
        onChange: () => pushConfig(),
    },
    wordConfidencePercent: {
        type: OptionType.SLIDER,
        description: "Individual words below this confidence are coloured yellow.",
        markers: [30, 40, 50, 60, 70],
        default: 50,
        stickToMarkers: false,
    },
    performanceMode: {
        type: OptionType.SELECT,
        description: "Processing level. Auto adapts to GPU load (steps down for games); the fixed modes override it — higher = more GPU. Also switchable from the sidebar header.",
        options: [
            { label: "Auto (adapt to GPU load)", value: "auto", default: true },
            { label: "High — always live (most GPU)", value: "high" },
            { label: "Medium — throttled live", value: "medium" },
            { label: "Low — finals only (least GPU)", value: "low" },
        ],
        onChange: () => { pushConfig(); render(); },
    },
    gpuDutyPercent: {
        type: OptionType.SLIDER,
        description: "In Auto mode: max share of GPU time live captions may use. Auto-scales to your GPU's speed and BACKS OFF when a game or other app needs the GPU. Lower = gentler.",
        markers: [20, 35, 50, 65, 80],
        default: 50,
        stickToMarkers: false,
        onChange: () => pushConfig(),
    },
    beamSize: {
        type: OptionType.NUMBER,
        description: "Beam search width — HIGHER is more accurate (fewer mishears) but uses more GPU. 5 = quality (default), 1 = fastest (greedy).",
        default: 5,
        onChange: () => pushConfig(),
    },
    audioContext: {
        type: OptionType.NUMBER,
        description: "Advanced: whisper audio-context (-ac). 0 = FULL window (best quality, default). A positive value trims GPU but can cut off the end of longer utterances — only lower it if you must save GPU.",
        default: 0,
        onChange: () => pushConfig(),
    },
    vadThreshold: {
        type: OptionType.SLIDER,
        description: "Voice-detection sensitivity — LOWER catches quieter speech but more noise.",
        markers: [0.004, 0.008, 0.012, 0.02, 0.03, 0.05],
        default: 0.012,
        stickToMarkers: false,
    },
    silenceHangoverMs: {
        type: OptionType.NUMBER,
        description: "Silence (ms) that ends an utterance. Higher keeps sentences together (better context = better accuracy); lower is snappier.",
        default: 900,
    },
    minUtteranceMs: {
        type: OptionType.NUMBER,
        description: "Ignore utterances shorter than this (ms) — kills stray blips.",
        default: 350,
    },
    maxUtteranceMs: {
        type: OptionType.NUMBER,
        description: "Force-flush a long talker every this many ms so captions keep flowing.",
        default: 9000,
    },
    lingerSeconds: {
        type: OptionType.NUMBER,
        description: "How long each caption stays on screen (seconds).",
        default: 7,
    },
    maxLines: {
        type: OptionType.NUMBER,
        description: "Max caption lines shown at once.",
        default: 4,
    },
});

function pushConfig() {
    try {
        void Native.start({
            quality: settings.store.quality,
            language: settings.store.language,
            threads: settings.store.threads,
            autoDownload: settings.store.autoDownload,
            // 0 = full window (best quality); >0 caps -ac to save GPU (may truncate).
            audioCtx: Math.max(0, settings.store.audioContext | 0),
            beamSize: Math.max(1, settings.store.beamSize | 0),
            gpuDuty: Math.min(0.95, Math.max(0.05, (settings.store.gpuDutyPercent || 50) / 100)),
            mode: settings.store.performanceMode || "auto",
            confidence: Math.min(0.95, Math.max(0.05, (settings.store.confidencePercent || 55) / 100)),
        });
    } catch (e) {
        logger.error("pushConfig failed", e);
    }
}

function toast(message: string, type: number) {
    Toasts.show({ message, type, id: Toasts.genId(), options: { position: Toasts.Position.BOTTOM } });
}

function resolveName(userId: string): string {
    try {
        const u = UserStore?.getUser?.(userId);
        if (u) return u.globalName || u.username || ("User " + userId.slice(-4));
    } catch { /* ignore */ }
    return "User " + userId.slice(-4);
}

// The IrcColors plugin recolours everyone by a hash of their id, overriding role
// colours everywhere — so if it's enabled we match it (same hash → hsl mapping).
function ircColorFor(userId: string): string | null {
    try {
        const p = (window as any).Vencord?.Settings?.plugins?.IrcColors;
        if (!p?.enabled) return null;
        let hash = 0;
        for (let i = 0; i < userId.length; i++) { hash = userId.charCodeAt(i) + ((hash << 5) - hash); hash |= 0; }
        const hue = Math.abs(hash) % 360;
        const sat = typeof p.saturation === "number" ? p.saturation : 100;
        const light = typeof p.lightness === "number" ? p.lightness : 70;
        return `hsl(${hue}, ${sat}%, ${light}%)`;
    } catch { return null; }
}

// The speaker's top role colour in the current voice channel's guild.
function roleColorFor(userId: string): string | null {
    try {
        const vc = SelectedChannelStore?.getVoiceChannelId?.();
        const guildId = vc ? ChannelStore?.getChannel?.(vc)?.guild_id : null;
        if (!guildId) return null;
        const cs = GuildMemberStore?.getMember?.(guildId, userId)?.colorString;
        return cs && cs !== "#000000" ? cs : null;
    } catch { return null; }
}

// Name colour: IrcColors (if on) → role colour → the theme accent.
function nameColor(userId: string): string {
    return ircColorFor(userId) || roleColorFor(userId) || C.accent;
}

// Discord's hashed username CSS class(es), lifted from a live message-author
// element and cached. Applying them to our name spans makes theme/CSS-based
// username styling (and any extension that styles usernames via CSS) apply in the
// CC pane too. Not cached until found, so it retries once a message is on screen.
let cachedUserClass: string | null = null;
function discordUsernameClass(): string {
    if (cachedUserClass) return cachedUserClass;
    try {
        const el = document.querySelector('[class*="username_"]');
        if (el) {
            const cls = [...el.classList].filter(c => /username/i.test(c)).join(" ");
            if (cls) { cachedUserClass = cls; return cls; }
        }
    } catch { /* ignore */ }
    return "";
}

// ── Caption store ────────────────────────────────────────────────────────────
// One caption line per utterance, keyed by a monotonic utterance id so interim
// (partial) results update the SAME line in place while the speaker talks, and
// the final result replaces it. `final` drives a subtle dimming of live text.
interface Word { w: string; p: number; }
interface Caption { id: number; userId: string; name: string; text: string; ts: number; final: boolean; confidence: number; words: Word[]; }
interface Infer { text: string; confidence: number; words: Word[]; }
// FULL history — the transcript pane shows all of it (scrollable); the overlay
// derives a recent, time-limited slice from the tail. Capped so a marathon call
// can't grow unbounded.
const MAX_HISTORY = 500;
let captions: Caption[] = [];
let uttCounter = 0;

// Engine status mirrored from native (download/warm-up progress) for the overlay.
let engineStatus: { phase: string; pct: number; message: string } = { phase: "idle", pct: 0, message: "" };

function upsertCaption(id: number, userId: string, res: Infer, final: boolean) {
    const now = Date.now();
    const existing = captions.find(c => c.id === id);
    if (existing) {
        existing.text = res.text;
        existing.confidence = res.confidence;
        existing.words = res.words || [];
        existing.ts = now;
        existing.final = final;
    } else {
        captions.push({ id, userId, name: resolveName(userId), text: res.text, ts: now, final, confidence: res.confidence, words: res.words || [] });
    }
    if (captions.length > MAX_HISTORY) captions = captions.slice(-MAX_HISTORY);
    render();
}

// Mark an utterance's line final without changing its text (used when the final
// decode comes back empty but we already showed a good partial).
function finalizeCaption(id: number) {
    const ex = captions.find(c => c.id === id);
    if (ex && !ex.final) { ex.final = true; ex.ts = Date.now(); render(); }
}

// ── Per-user audio capture + VAD ─────────────────────────────────────────────
interface Capture {
    src: MediaStreamAudioSourceNode;
    proc: ScriptProcessorNode;
    gain: GainNode;
    stream: WeakRef<MediaStream>;
    userId: string;
    isSelf: boolean;             // our own mic (gate on Discord transmit state)
    speaking: boolean;
    silenceMs: number;
    voicedMs: number;
    pending: Int16Array[];
    pendingSamples: number;
    preroll: Int16Array[];
    uttId: number;               // current utterance's caption id (0 = none)
    lastPartialVoicedMs: number; // voicedMs at the last interim transcription
    partialInFlight: boolean;    // an interim request is currently out
}
const captures = new Map<string, Capture>();

function floatToInt16(f: Float32Array): Int16Array {
    const out = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
        const s = Math.max(-1, Math.min(1, f[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
}

function bytesToBase64(bytes: Uint8Array): string {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
    }
    return btoa(bin);
}

// Encode the currently-accumulated utterance to base64 16-bit PCM.
function encodePending(cap: Capture): string {
    const merged = new Int16Array(cap.pendingSamples);
    let off = 0;
    for (const c of cap.pending) { merged.set(c, off); off += c.length; }
    return bytesToBase64(new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength));
}

// Interim transcription of the utterance-so-far — updates the live caption line
// in place. Best-effort: native drops it if the engine is busy, and we never
// have more than one in flight per speaker.
function firePartial(cap: Capture) {
    if (cap.partialInFlight || cap.pendingSamples === 0) return;
    cap.partialInFlight = true;
    cap.lastPartialVoicedMs = cap.voicedMs;
    const id = cap.uttId;
    const userId = cap.userId;
    const b64 = encodePending(cap);
    const sr = Math.round(getCapCtx().sampleRate);
    Native.transcribePartial(b64, sr, cap.isSelf)
        .then(r => { if (r && r.text && id === cap.uttId) upsertCaption(id, userId, r, false); })
        .catch(() => { /* best-effort */ })
        .finally(() => { cap.partialInFlight = false; });
}

// Utterances whose INSTANT (tier-0) caption hasn't landed yet, id → flush time.
// Drives the "N s behind" backlog indicator and gates the slower refinement tiers.
const pendingFinals = new Map<number, number>();

function flush(cap: Capture) {
    const voicedMs = cap.voicedMs;
    const total = cap.pendingSamples;
    const id = cap.uttId;
    const b64 = total > 0 ? encodePending(cap) : "";
    cap.pending = [];
    cap.pendingSamples = 0;
    cap.speaking = false;
    cap.silenceMs = 0;
    cap.voicedMs = 0;
    cap.uttId = 0;
    if (voicedMs < settings.store.minUtteranceMs || total === 0) return;
    // Don't transcribe at all while captions aren't being shown — no point
    // spending GPU on output nobody's looking at (user request).
    if (!captionsVisible()) return;

    const userId = cap.userId;
    const sr = Math.round(getCapCtx().sampleRate);
    void runCascade(id, userId, b64, sr, cap.isSelf);
}

// Progressive refinement: an INSTANT caption first, then a corrective pass, then
// the big-model pass — escalating only when we're caught up (no backlog) and the
// GPU governor says there's room. Each tier upgrades the same caption line.
async function runCascade(id: number, userId: string, b64: string, sr: number, isSelf: boolean) {
    // Tier 0 — instant (fast model, greedy). Own speech is lowest priority, so it
    // yields the GPU to remote speakers (native priority lock).
    pendingFinals.set(id, Date.now());
    renderBacklog();
    let r0: Infer | null = null;
    try { r0 = await Native.transcribeTier(b64, sr, 0, isSelf); }
    catch (e) { logger.error("tier0 ipc failed", e); }
    pendingFinals.delete(id);
    renderBacklog();

    if (!r0 || !r0.text) { finalizeCaption(id); return; }
    upsertCaption(id, userId, r0, true);

    // Only refine during a lull — caught up (no instant caption waiting) AND nobody
    // currently talking — so the heavy beam/turbo passes don't hammer the GPU mid
    // conversation. They run in the gaps instead.
    if (pendingFinals.size > 0 || anyoneSpeaking()) return;
    const gt = engineGpu.tier;                       // governor: live | reduced | finals
    if (gt === "finals") return;                     // GPU busy → keep instant result

    // Tier 1 — corrective (fast model, beam).
    try {
        const r1 = await Native.transcribeTier(b64, sr, 1, isSelf);
        if (r1 && r1.text) upsertCaption(id, userId, r1, true);
    } catch (e) { logger.error("tier1 ipc failed", e); }

    // Tier 2 — best (big model). Skipped for your OWN speech, on BATTERY (clocks
    // throttled — protect responsiveness + battery), and unless there's plenty of
    // spare GPU while still caught up.
    if (isSelf || !engineGpu.onAC || gt !== "live" || pendingFinals.size > 0) return;
    try {
        const r2 = await Native.transcribeTier(b64, sr, 2, isSelf);
        if (r2 && r2.text) upsertCaption(id, userId, r2, true);
    } catch (e) { logger.error("tier2 ipc failed", e); }
}

function onFrame(cap: Capture, input: Float32Array) {
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    const i16 = floatToInt16(input);
    // For our own mic (an always-live getUserMedia tap), only treat frames as
    // speech while Discord says we're actually transmitting — so muting or
    // releasing push-to-talk stops captioning us, matching what others hear.
    const voiced = rms > settings.store.vadThreshold && (!cap.isSelf || ownTransmitting());

    // Timing is derived from the context's real rate, not a hard-coded 16 kHz,
    // so VAD thresholds stay honest even if the browser gave us another rate.
    const sr = getCapCtx().sampleRate;
    const frameMs = (input.length / sr) * 1000;

    if (voiced) {
        if (!cap.speaking) {
            cap.speaking = true;
            cap.voicedMs = 0;
            cap.silenceMs = 0;
            cap.uttId = ++uttCounter;        // new line for this utterance
            cap.lastPartialVoicedMs = 0;
            for (const p of cap.preroll) { cap.pending.push(p); cap.pendingSamples += p.length; }
        }
        cap.pending.push(i16);
        cap.pendingSamples += i16.length;
        cap.voicedMs += frameMs;
        cap.silenceMs = 0;
        if ((cap.pendingSamples / sr) * 1000 >= settings.store.maxUtteranceMs) { flush(cap); return; }
        // Interim caption while they're still talking, so text appears live
        // instead of only after they stop (the main latency win). Skipped entirely
        // when the captions aren't actually visible — no point spending GPU on live
        // partials nobody's looking at; the final (on silence) still lands, so the
        // log is complete and simply catches up when you open the pane.
        if (settings.store.streaming && captionsVisible()
            && cap.voicedMs >= settings.store.minUtteranceMs
            && cap.voicedMs - cap.lastPartialVoicedMs >= settings.store.partialIntervalMs) {
            firePartial(cap);
        }
    } else if (cap.speaking) {
        cap.pending.push(i16);           // keep trailing silence for a clean word tail
        cap.pendingSamples += i16.length;
        cap.silenceMs += frameMs;
        if (cap.silenceMs >= settings.store.silenceHangoverMs) flush(cap);
    }

    cap.preroll.push(i16);
    if (cap.preroll.length > PREROLL_FRAMES) cap.preroll.shift();
}

function teardownCapture(userId: string) {
    const cap = captures.get(userId);
    if (!cap) return;
    captures.delete(userId);
    // Only disconnect this user's nodes — the AudioContext is shared, so it
    // stays alive for the other speakers (closed in stop() when we're done).
    try { cap.proc.onaudioprocess = null; } catch { /* ignore */ }
    try { cap.proc.disconnect(); } catch { /* ignore */ }
    try { cap.src.disconnect(); } catch { /* ignore */ }
    try { cap.gain.disconnect(); } catch { /* ignore */ }
}

// Build one capture graph for a (userId, stream). Shared by remote participants
// (handleStream) and our own mic (startOwnCapture).
function createCapture(userId: string, stream: MediaStream, isSelf: boolean) {
    if (stream.getAudioTracks().length === 0) return;

    const existing = captures.get(userId);
    if (existing) {
        if (existing.stream.deref() === stream) return;   // already capturing this exact stream
        teardownCapture(userId);                          // new stream — rebuild
    }

    const ctx = getCapCtx();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(FRAME, 1, 1);
    const gain = ctx.createGain();
    gain.gain.value = 0;            // silent — this graph only TAPS, never plays

    const cap: Capture = {
        src, proc, gain, stream: new WeakRef(stream), userId, isSelf,
        speaking: false, silenceMs: 0, voicedMs: 0,
        pending: [], pendingSamples: 0, preroll: [],
        uttId: 0, lastPartialVoicedMs: 0, partialInFlight: false,
    };

    proc.onaudioprocess = e => {
        try { onFrame(cap, e.inputBuffer.getChannelData(0)); } catch (err) { logger.error("frame", err); }
    };
    // A ScriptProcessorNode only fires while it's connected through to a
    // destination, hence the zero-gain sink into ctx.destination.
    src.connect(proc);
    proc.connect(gain);
    gain.connect(ctx.destination);

    captures.set(userId, cap);
    logger.info(`capturing ${isSelf ? "self" : "user"} ${userId} (${resolveName(userId)})`);
}

// Called from the patched StreamData method (`$self.handleStream(this)`), same
// hook point as PerUserAudioSinks — one capture per REMOTE participant.
function handleStream(data: any) {
    try {
        const stream: MediaStream | undefined = data?.stream;
        const userId: string | undefined = data?.id;
        if (stream && userId) createCapture(userId, stream, false);
    } catch (e) {
        logger.error("handleStream failed", e);
    }
}

// ── Own mic ──────────────────────────────────────────────────────────────────
let ownStream: MediaStream | null = null;
let ownUserId = "";
let ownStarting = false;   // guards the async getUserMedia against re-entry

function inVoice(): boolean {
    try { return !!SelectedChannelStore?.getVoiceChannelId?.(); } catch { return false; }
}

// Whether Discord is currently transmitting our mic — prefers SpeakingStore
// (reflects mute + push-to-talk + voice-activity), falls back to self-mute, and
// if neither store is reachable defaults to true (energy VAD still gates).
function ownTransmitting(): boolean {
    try { if (SpeakingStore?.isSpeaking && ownUserId) return !!SpeakingStore.isSpeaking(ownUserId); } catch { /* ignore */ }
    try { if (MediaEngineStore?.isSelfMute) return !MediaEngineStore.isSelfMute(); } catch { /* ignore */ }
    return true;
}

async function startOwnCapture() {
    if (ownStream || ownStarting || !settings.store.captureSelf) return;
    ownStarting = true;
    try {
        const me = UserStore?.getCurrentUser?.();
        if (!me?.id) return;
        ownUserId = me.id;
        // Capture the SAME input device Discord uses, with the SAME processing
        // settings Discord uses (echo-cancel / noise-suppress / auto-gain). Two
        // reasons: (1) the point of self-captioning is to verify you're intelligible
        // AFTER the mic effects — so we want processed, not raw; (2) Chromium shares
        // one processing pipeline per device, so matching Discord's settings avoids
        // reconfiguring that shared pipeline (which muffled the transmitted mic when
        // our settings differed). (Discord's Krisp noise-cancel runs in-app, past
        // getUserMedia, so it isn't reflected here — this matches the browser-level
        // processing, the closest we can tap without Discord's outgoing track.)
        let deviceId: string | undefined;
        const g = (m: string, d: boolean) => { try { const v = (MediaEngineStore as any)?.[m]?.(); return typeof v === "boolean" ? v : d; } catch { return d; } };
        try { deviceId = MediaEngineStore?.getInputDeviceId?.(); } catch { /* ignore */ }
        const audio: MediaTrackConstraints = {
            echoCancellation: g("getEchoCancellation", true),
            noiseSuppression: g("getNoiseSuppression", true),
            autoGainControl: g("getAutomaticGainControl", true),
        };
        if (deviceId && deviceId !== "default") audio.deviceId = { exact: deviceId };
        const s = await navigator.mediaDevices.getUserMedia({ audio });
        // A late toggle-off / channel-leave could have raced the await.
        if (!settings.store.captureSelf || !inVoice()) { s.getTracks().forEach(t => t.stop()); return; }
        ownStream = s;
        createCapture(ownUserId, s, true);
    } catch (e) {
        logger.error("own mic capture failed", e);
    } finally {
        ownStarting = false;
    }
}

function stopOwnCapture() {
    if (ownUserId) teardownCapture(ownUserId);
    if (ownStream) { try { ownStream.getTracks().forEach(t => t.stop()); } catch { /* ignore */ } ownStream = null; }
    ownUserId = "";
}

// Start/stop own capture to match the setting + whether we're in a voice call.
function syncOwnCapture() {
    if (settings.store.captureSelf && inVoice()) void startOwnCapture();
    else stopOwnCapture();
}

// Prune captures whose stream has ended/GC'd — self-contained, no Discord
// voice-state internals (same approach as PerUserAudioSinks' reaper).
function reap() {
    for (const [userId, cap] of [...captures.entries()]) {
        const s = cap.stream.deref();
        const gone = !s || s.getAudioTracks().every(t => t.readyState === "ended");
        if (gone) {
            teardownCapture(userId);
            if (userId === ownUserId) ownStream = null;   // mic ended (device unplugged)
            logger.info(`released departed ${cap.isSelf ? "self" : "user"} ${userId}`);
        }
    }
}

// ── Overlay (plain DOM) ──────────────────────────────────────────────────────
let overlayEl: HTMLDivElement | null = null;

function mountOverlay() {
    if (overlayEl) return;
    const el = document.createElement("div");
    el.id = "closed-captions-overlay";
    Object.assign(el.style, {
        position: "fixed", left: "0", right: "0", bottom: "84px",
        display: "flex", flexDirection: "column", alignItems: "center", gap: "6px",
        pointerEvents: "none", zIndex: "4000", padding: "0 12px",
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(el);
    overlayEl = el;
    renderOverlay();
}

function unmountOverlay() {
    overlayEl?.remove();
    overlayEl = null;
}

// Append a caption's text to `parent`, colouring low-confidence WORDS yellow and
// (for finalized low-confidence lines) prefixing a ⚠ warning triangle — so the
// reader can see exactly where the transcription is shaky instead of trusting it.
function appendCaptionText(parent: HTMLElement, c: Caption) {
    const flag = settings.store.flagLowConfidence !== false;
    const baseColor = c.final ? C.text : C.dim;
    const wordThresh = (settings.store.wordConfidencePercent ?? 50) / 100;
    const lineThresh = (settings.store.confidencePercent ?? 55) / 100;
    const lineLow = flag && c.final && c.confidence > 0 && c.confidence < lineThresh;

    if (lineLow) {
        const tri = document.createElement("span");
        tri.textContent = "\u26A0\uFE0F ";   // yellow warning triangle emoji
        tri.title = `Low confidence (${Math.round(c.confidence * 100)}%) - may be inaccurate`;
        parent.appendChild(tri);
    }

    if (flag && c.words && c.words.length) {
        for (const w of c.words) {
            const sp = document.createElement("span");
            sp.textContent = w.w;   // whisper words include their leading space
            sp.style.color = w.p < wordThresh ? C.warn : baseColor;
            parent.appendChild(sp);
        }
    } else {
        const sp = document.createElement("span");
        sp.textContent = c.text;
        sp.style.color = lineLow ? C.warn : baseColor;
        parent.appendChild(sp);
    }
}

function makeChip(fontSize: string): HTMLDivElement {
    const chip = document.createElement("div");
    Object.assign(chip.style, {
        maxWidth: "62%", background: C.bg, border: `1px solid ${C.border}`,
        borderRadius: "8px", padding: "4px 12px", fontFamily: C.font, fontSize,
        lineHeight: "1.35", color: C.text, boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
    } as Partial<CSSStyleDeclaration>);
    return chip;
}

function renderOverlay() {
    if (!overlayEl) return;
    overlayEl.replaceChildren();
    if (!settings.store.overlay) return;

    const now = Date.now();
    const linger = Math.max(1, settings.store.lingerSeconds) * 1000;
    const max = Math.max(1, settings.store.maxLines | 0);
    const shown = captions.filter(c => now - c.ts < linger).slice(-max);

    const s = engineStatus;
    if (s.phase === "provisioning" || s.phase === "downloading-model" || s.phase === "starting" || s.phase === "error") {
        const col = s.phase === "error" ? C.crit : C.dim;
        const chip = makeChip("13px");
        chip.style.color = col;
        chip.textContent = (s.message || "Captions engine…") + (s.pct ? ` ${s.pct}%` : "");
        overlayEl.appendChild(chip);
    }

    for (const c of shown) {
        const age = now - c.ts;
        const fade = age > linger - 600 ? Math.max(0, (linger - age) / 600) : 1;
        const chip = makeChip("15px");
        chip.style.opacity = String(fade);

        const nm = document.createElement("span");
        nm.className = discordUsernameClass();   // inherit theme/plugin username CSS
        nm.textContent = c.name;
        Object.assign(nm.style, { color: nameColor(c.userId), fontWeight: "700", whiteSpace: "nowrap", marginRight: "8px" } as Partial<CSSStyleDeclaration>);

        chip.appendChild(nm);
        appendCaptionText(chip, c);   // per-word yellow + ⚠ on low confidence
        overlayEl.appendChild(chip);
    }
}

// ── Transcript pane (right-docked, scrolling full log) ───────────────────────
let paneEl: HTMLDivElement | null = null;
let paneBodyEl: HTMLDivElement | null = null;
let paneStatusEl: HTMLDivElement | null = null;
let paneBacklogEl: HTMLDivElement | null = null;
let paneTabEl: HTMLDivElement | null = null;
let paneStyleEl: HTMLStyleElement | null = null;
let paneCollapsed = false;
let paneAutoScroll = true;   // stick to bottom unless the user scrolls up to read back
let paneModeBtn: HTMLDivElement | null = null;
let paneModeText: HTMLSpanElement | null = null;
let paneModeMenu: HTMLDivElement | null = null;
let paneModeOpen = false;
let paneDocClick: ((e: MouseEvent) => void) | null = null;
let panePopBtn: HTMLDivElement | null = null;
let popoutOpen = false;

// GPU governor snapshot mirrored from native, for the sidebar's live level label.
let engineGpu: { available: boolean; tier: string; mode: string; external: number; onAC: boolean } = { available: false, tier: "live", mode: "auto", external: 0, onAC: true };

const TIER_LABEL: Record<string, string> = { live: "Live", reduced: "Reduced", finals: "Finals only" };
const MODE_LABEL: Record<string, string> = { auto: "Auto", high: "High", medium: "Medium", low: "Low" };
const MODE_OPTIONS: Array<{ v: string; label: string; sub: string; warn?: boolean }> = [
    { v: "auto", label: "Auto", sub: "adapt to GPU load" },
    { v: "high", label: "High", sub: "always live — most GPU, may affect games", warn: true },
    { v: "medium", label: "Medium", sub: "throttled live — more GPU", warn: true },
    { v: "low", label: "Low", sub: "finals only — least GPU" },
];

const engineBusy = () => ["provisioning", "downloading-model", "starting", "error"].includes(engineStatus.phase);

function mountPane() {
    if (paneEl) return;

    // Just the thin themed scrollbar (inline styles can't target
    // ::-webkit-scrollbar). The pane reserves space by being a real flex child of
    // Discord's layout row (see dockPane) — no app-shrinking hacks.
    const style = document.createElement("style");
    style.id = "closed-captions-style";
    style.textContent = `
        #closed-captions-pane .cc-body { scrollbar-width: thin; scrollbar-color: ${C.scrollThumb} transparent; }
        #closed-captions-pane .cc-body::-webkit-scrollbar { width: 8px; height: 8px; }
        #closed-captions-pane .cc-body::-webkit-scrollbar-thumb { background: ${C.scrollThumb}; border-radius: 4px; }
        #closed-captions-pane .cc-body::-webkit-scrollbar-track { background: transparent; }
        #closed-captions-pane .cc-body::-webkit-scrollbar-corner { background: transparent; }
    `;
    document.head.appendChild(style);
    paneStyleEl = style;

    const el = document.createElement("div");
    el.id = "closed-captions-pane";
    // Base look; layout (in-flow flex column vs fixed fallback) is applied by
    // dockPane()/renderPane so it takes real space in Discord's flex row.
    Object.assign(el.style, {
        background: C.bg, borderLeft: `1px solid ${C.border}`,
        display: "flex", flexDirection: "column", overflow: "hidden",
        boxShadow: C.shadow, fontFamily: C.font, color: C.text,
        flex: `0 0 ${PANE_WIDTH}px`, minWidth: `${PANE_WIDTH}px`, alignSelf: "stretch",
    } as Partial<CSSStyleDeclaration>);

    const header = document.createElement("div");
    Object.assign(header.style, {
        display: "flex", alignItems: "center", gap: "8px",
        padding: "12px 14px", background: C.headerBg,
        borderBottom: `1px solid ${C.border}`,
        boxShadow: "0 1px 0 rgba(0,0,0,0.2)", flex: "0 0 auto",
    } as Partial<CSSStyleDeclaration>);
    const title = document.createElement("span");
    title.textContent = "Captions";
    Object.assign(title.style, { color: C.accent, fontWeight: "700", fontSize: "13px", letterSpacing: "0.02em" } as Partial<CSSStyleDeclaration>);

    // Processing-level pill: shows the CURRENT level (e.g. "Auto · Reduced" when
    // throttled down for a game); click to override via a dropdown.
    const modeBtn = document.createElement("div");
    Object.assign(modeBtn.style, {
        marginLeft: "auto", display: "flex", alignItems: "center", gap: "4px",
        cursor: "pointer", fontSize: "11px", color: C.dim,
        padding: "2px 6px", borderRadius: "5px", border: `1px solid ${C.border}`, whiteSpace: "nowrap",
    } as Partial<CSSStyleDeclaration>);
    modeBtn.title = "Processing level";
    const modeText = document.createElement("span");
    const caret = document.createElement("span");
    caret.textContent = "▾";
    modeBtn.append(modeText, caret);
    modeBtn.onclick = e => { e.stopPropagation(); paneModeOpen = !paneModeOpen; renderModeControl(); };
    paneModeBtn = modeBtn;
    paneModeText = modeText;

    // Pop the captions out into their own OS window (which can be pinned on top).
    const pop = document.createElement("div");
    pop.textContent = "⧉";   // "open in window"
    pop.title = "Pop out to a window";
    Object.assign(pop.style, { cursor: "pointer", color: C.dim, fontSize: "14px", lineHeight: "1", padding: "0 3px" } as Partial<CSSStyleDeclaration>);
    pop.onmouseenter = () => { pop.style.color = C.text; };
    pop.onmouseleave = () => { pop.style.color = popoutOpen ? C.accent : C.dim; };
    pop.onclick = () => togglePopout();
    panePopBtn = pop;

    const close = document.createElement("div");
    close.textContent = "×";
    close.title = "Hide";
    Object.assign(close.style, { cursor: "pointer", color: C.dim, fontSize: "18px", lineHeight: "1", padding: "0 2px" } as Partial<CSSStyleDeclaration>);
    close.onmouseenter = () => { close.style.color = C.text; };
    close.onmouseleave = () => { close.style.color = C.dim; };
    close.onclick = () => { paneCollapsed = true; renderPane(); };
    header.append(title, modeBtn, pop, close);

    // Dropdown menu for the processing level (absolute within the fixed pane).
    const menu = document.createElement("div");
    Object.assign(menu.style, {
        position: "absolute", top: "38px", right: "8px", zIndex: "5", minWidth: "190px",
        background: C.bg, border: `1px solid ${C.border}`, borderRadius: "6px",
        boxShadow: C.shadow, padding: "4px", display: "none", flexDirection: "column", gap: "2px",
    } as Partial<CSSStyleDeclaration>);
    for (const opt of MODE_OPTIONS) {
        const row = document.createElement("div");
        row.dataset.mode = opt.v;
        Object.assign(row.style, { padding: "5px 8px", borderRadius: "4px", cursor: "pointer" } as Partial<CSSStyleDeclaration>);
        const l = document.createElement("div");
        l.textContent = opt.label;
        Object.assign(l.style, { color: C.text, fontSize: "12px", fontWeight: "600" } as Partial<CSSStyleDeclaration>);
        const s = document.createElement("div");
        s.textContent = opt.sub;
        Object.assign(s.style, { color: opt.warn ? C.crit : C.dim, fontSize: "10px" } as Partial<CSSStyleDeclaration>);
        row.append(l, s);
        row.onmouseenter = () => { row.style.background = "rgba(127,127,127,0.15)"; };
        row.onmouseleave = () => { row.style.background = settings.store.performanceMode === opt.v ? "rgba(127,127,127,0.12)" : "transparent"; };
        row.onclick = e => {
            e.stopPropagation();
            settings.store.performanceMode = opt.v;
            paneModeOpen = false;
            if (opt.warn) toast(`Captions: ${opt.label} uses more GPU — may affect games`, Toasts.Type.MESSAGE);
            pushConfig();
            render();
        };
        menu.appendChild(row);
    }
    paneModeMenu = menu;

    // Status row (engine download / warm-up / error), hidden unless busy.
    const status = document.createElement("div");
    Object.assign(status.style, { padding: "0 10px 6px", color: C.dim, fontSize: "11px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "none" } as Partial<CSSStyleDeclaration>);
    paneStatusEl = status;

    const body = document.createElement("div");
    body.className = "cc-body";
    Object.assign(body.style, {
        flex: "1", overflowY: "auto", padding: "8px 10px",
        display: "flex", flexDirection: "column", gap: "5px",
    } as Partial<CSSStyleDeclaration>);
    body.addEventListener("scroll", () => {
        paneAutoScroll = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    });

    // Footer: "N s behind…" backlog indicator (how far transcription trails speech).
    const backlog = document.createElement("div");
    Object.assign(backlog.style, {
        flex: "0 0 auto", padding: "5px 12px", borderTop: `1px solid ${C.border}`,
        background: C.headerBg, color: C.dim, fontSize: "11px", display: "none",
    } as Partial<CSSStyleDeclaration>);
    paneBacklogEl = backlog;

    el.append(header, menu, status, body, backlog);
    paneEl = el;
    paneBodyEl = body;
    // Placed into Discord's layout row (or fixed fallback) by dockPane() on render.

    // Close the mode menu on any outside click.
    paneDocClick = e => {
        if (!paneModeOpen) return;
        const t = e.target as Node;
        if (paneModeMenu?.contains(t) || paneModeBtn?.contains(t)) return;
        paneModeOpen = false;
        renderModeControl();
    };
    document.addEventListener("click", paneDocClick, true);

    // A thin edge tab to re-open the pane after it's collapsed.
    const tab = document.createElement("div");
    tab.textContent = "Captions";
    tab.title = "Show captions";
    Object.assign(tab.style, {
        position: "fixed", top: "50%", right: "0", transform: "translateY(-50%)",
        background: C.bg, border: `1px solid ${C.border}`, borderRight: "none",
        borderRadius: "6px 0 0 6px", color: C.accent, fontWeight: "700",
        fontFamily: C.font, fontSize: "12px", letterSpacing: "0.5px",
        padding: "10px 5px", cursor: "pointer", zIndex: "3900",
        writingMode: "vertical-rl", boxShadow: C.shadow,
    } as Partial<CSSStyleDeclaration>);
    tab.onclick = () => { paneCollapsed = false; paneAutoScroll = true; renderPane(); };
    document.body.appendChild(tab);
    paneTabEl = tab;

    renderPane();
}

function unmountPane() {
    if (paneDocClick) { document.removeEventListener("click", paneDocClick, true); paneDocClick = null; }
    paneEl?.remove(); paneEl = null; paneBodyEl = null; paneStatusEl = null; paneBacklogEl = null;
    paneModeBtn = null; paneModeText = null; paneModeMenu = null; paneModeOpen = false; panePopBtn = null;
    paneTabEl?.remove(); paneTabEl = null;
    paneStyleEl?.remove(); paneStyleEl = null;
}

// Discord's top layout row (holds the guilds rail + the rest of the app). We dock
// the pane there as a real flex column so Discord's own layout reserves its space
// — content reflows within the window instead of being overlaid or shoved off.
function isRowFlex(el: HTMLElement): boolean {
    try {
        const cs = getComputedStyle(el);
        return cs.display.includes("flex") && !cs.flexDirection.startsWith("column");
    } catch { return false; }
}

function layoutRow(): HTMLElement | null {
    // Primary anchor: the parent of the main content area ([class*="base_"]) is the
    // app's HORIZONTAL row (guilds rail + everything else). The guilds rail's own
    // parent is often just a narrow wrapper — appending there put us on the LEFT —
    // so we validate that we've got a real horizontal flex row.
    const base = document.querySelector<HTMLElement>('[class*="base_"]');
    if (base?.parentElement && isRowFlex(base.parentElement)) return base.parentElement;
    // Fallback: walk up from the guilds rail to the first horizontal flex ancestor
    // that holds more than just the rail.
    let n: HTMLElement | null = document.querySelector<HTMLElement>('[class*="guilds_"], [class*="guilds-"]');
    n = n?.parentElement || null;
    while (n && n !== document.body) {
        if (isRowFlex(n) && n.childElementCount >= 2) return n;
        n = n.parentElement;
    }
    return null;
}

function dockPane() {
    if (!paneEl) return;
    const row = layoutRow();
    if (row) {
        if (paneEl.parentElement !== row) {
            Object.assign(paneEl.style, {
                position: "relative", top: "", right: "", bottom: "", left: "",
                height: "auto", zIndex: "", order: "9999",   // far RIGHT of the flex row
                flex: `0 0 ${PANE_WIDTH}px`, alignSelf: "stretch",
            } as Partial<CSSStyleDeclaration>);
            row.appendChild(paneEl);
        }
    } else if (paneEl.parentElement !== document.body) {
        // Fallback if no horizontal flex row is found: float fixed on the right.
        Object.assign(paneEl.style, {
            position: "fixed", top: "0", right: "0", bottom: "0", height: "",
            width: `${PANE_WIDTH}px`, zIndex: "100",
        } as Partial<CSSStyleDeclaration>);
        document.body.appendChild(paneEl);
    }
}

// Update the processing-level pill + dropdown from the current mode / governor tier.
function renderModeControl() {
    if (!paneModeBtn || !paneModeText || !paneModeMenu) return;
    const mode = settings.store.performanceMode || "auto";
    const tier = engineGpu.tier || "live";
    // Auto shows the live effective level (so a step-down for a game is visible);
    // fixed modes show the mode name.
    paneModeText.textContent = mode === "auto" ? `Auto · ${TIER_LABEL[tier] || "Live"}` : MODE_LABEL[mode];
    const steppedDown = mode === "auto" && tier !== "live";
    paneModeBtn.style.color = paneModeOpen ? C.accent : steppedDown ? C.crit : C.dim;
    paneModeBtn.style.borderColor = paneModeOpen ? C.accent : C.border;
    paneModeMenu.style.display = paneModeOpen ? "flex" : "none";
    paneModeMenu.querySelectorAll<HTMLElement>("[data-mode]").forEach(r => {
        r.style.background = r.dataset.mode === mode ? "rgba(127,127,127,0.12)" : "transparent";
    });
}

function renderPane() {
    if (!paneEl || !paneBodyEl || !paneTabEl || !paneStatusEl) return;
    // Show while in a call, when there's transcript to read back, or while the
    // engine is downloading/warming up (so first-run progress is visible).
    const on = settings.store.transcriptPane && (inVoice() || captions.length > 0 || engineBusy());
    const shown = on && !paneCollapsed;
    // Dock as a flex column so Discord reserves the space; display:none gives the
    // space straight back to the app when hidden.
    if (shown) dockPane();
    paneEl.style.display = shown ? "flex" : "none";
    paneTabEl.style.display = on && paneCollapsed ? "block" : "none";
    updateInjectedStates();
    renderModeControl();
    if (panePopBtn) panePopBtn.style.color = popoutOpen ? C.accent : C.dim;
    if (!shown) return;

    const s = engineStatus;
    paneStatusEl.textContent = engineBusy() ? (s.message || "…") + (s.pct ? ` ${s.pct}%` : "") : "";
    paneStatusEl.style.color = s.phase === "error" ? C.crit : C.dim;

    paneBodyEl.replaceChildren();
    for (const c of captions) {
        const row = document.createElement("div");
        Object.assign(row.style, { fontSize: "14px", lineHeight: "1.4", wordBreak: "break-word" } as Partial<CSSStyleDeclaration>);
        const nm = document.createElement("span");
        nm.className = discordUsernameClass();   // inherit theme/plugin username CSS
        nm.textContent = c.name + ": ";
        Object.assign(nm.style, { color: nameColor(c.userId), fontWeight: "700" } as Partial<CSSStyleDeclaration>);
        row.appendChild(nm);
        appendCaptionText(row, c);   // per-word yellow + ⚠ on low confidence
        if (c.confidence > 0) row.title = `${Math.round(c.confidence * 100)}% confidence`;
        paneBodyEl.appendChild(row);
    }
    if (paneAutoScroll) paneBodyEl.scrollTop = paneBodyEl.scrollHeight;
}

// "N s behind…" — how far the instant transcription trails live speech (age of
// the oldest utterance still waiting for its tier-0 caption).
function renderBacklog() {
    if (!paneBacklogEl) return;
    let oldest = 0;
    const now = Date.now();
    for (const ts of pendingFinals.values()) oldest = Math.max(oldest, now - ts);
    const sec = oldest / 1000;
    if (sec >= 1.5) {
        paneBacklogEl.style.display = "block";
        paneBacklogEl.style.color = sec >= 5 ? C.warn : C.dim;
        paneBacklogEl.textContent = `~${Math.round(sec)}s behind…`;
    } else {
        paneBacklogEl.style.display = "none";
    }
}

// Render both surfaces from the one store.
function render() {
    renderOverlay();
    renderPane();
    renderBacklog();
    pushPopout();
}

function togglePane() {
    // If it's off/hidden for lack of content, opening should still work — clear
    // the collapse flag; renderPane decides visibility from context.
    paneCollapsed = !paneCollapsed;
    renderPane();
}

// Are captions actually on screen right now (pane, overlay, or the pop-out
// window)? Drives whether we transcribe at all.
function captionsVisible(): boolean {
    return popoutOpen || settings.store.overlay || (!!paneEl && paneEl.style.display !== "none");
}

// Theme values handed to the pop-out window so it matches the current Discord theme.
function popoutTheme() {
    return { bg: C.bg, headerBg: C.headerBg, border: C.border, text: C.text, dim: C.dim, accent: C.accent, warn: C.warn, font: C.font };
}

// Caption data for the pop-out window, with low-confidence flags precomputed so the
// window only ever assigns textContent (never markup).
function popoutData() {
    const flag = settings.store.flagLowConfidence !== false;
    const wordThresh = (settings.store.wordConfidencePercent ?? 50) / 100;
    const lineThresh = (settings.store.confidencePercent ?? 55) / 100;
    return captions.map(c => ({
        name: c.name,
        color: nameColor(c.userId),
        final: c.final,
        low: flag && c.final && c.confidence > 0 && c.confidence < lineThresh,
        text: c.text,
        words: flag ? (c.words || []).map(w => ({ w: w.w, low: w.p < wordThresh })) : [],
    }));
}

function pushPopout() {
    if (!popoutOpen) return;
    Native.popout("data", popoutData())
        .then(alive => { if (!alive) { popoutOpen = false; renderPane(); } })
        .catch(() => { /* ignore */ });
}

async function togglePopout() {
    try {
        if (popoutOpen) { popoutOpen = false; await Native.popout("close"); renderPane(); return; }
        const alive = await Native.popout("open", { theme: popoutTheme() });
        popoutOpen = !!alive;
        renderPane();
        pushPopout();
    } catch (e) { logger.error("togglePopout failed", e); }
}

// Is anyone currently mid-utterance? Used to defer the heavy refinement tiers to
// conversational lulls so they don't pin the GPU while people are talking.
function anyoneSpeaking(): boolean {
    for (const c of captures.values()) if (c.speaking) return true;
    return false;
}

// ── Toggle buttons injected into Discord's own control bars ───────────────────
// A "CC" button placed in the big call-controls bar AND the bottom-left voice
// panel, next to the screen-share button (a stable anchor present in both). We
// CLONE Discord's own button so it inherits native size/hover/theme, then swap
// its icon for "CC" and rewire the click — robust to Discord's hashed classes.
const SHARE_RE = /share\s*(your\s*)?screen|screen\s*share/i;

function accessibleName(el: HTMLElement): string {
    const direct = el.getAttribute("aria-label") || el.getAttribute("title");
    if (direct) return direct;
    const refs = ((el.getAttribute("aria-labelledby") || "") + " " + (el.getAttribute("aria-describedby") || "")).trim();
    if (refs) return refs.split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ").trim();
    return "";
}

function updateInjectedStates() {
    const active = !!paneEl && paneEl.style.display !== "none";
    document.querySelectorAll<HTMLElement>("[data-cc-toggle]").forEach(b => {
        b.style.color = active ? C.accent : C.dim;
        b.style.background = active ? "rgba(127,127,127,0.12)" : "transparent";
    });
}

// A FRESH fixed-size button (NOT a clone of Discord's button — cloning inherited
// Discord's `flex:1`, which made the row divide width across one more item and
// shrank every icon to nothing). Fixed `flex:0 0 auto` + a size matching the
// sibling leaves the other buttons untouched.
function makeCCButton(size: number): HTMLElement {
    const b = document.createElement("div");
    b.setAttribute("role", "button");
    b.setAttribute("data-cc-toggle", "");
    b.setAttribute("aria-label", "Toggle captions");
    b.title = "Toggle captions";
    const px = `${Math.max(24, Math.round(size)) || 32}px`;
    Object.assign(b.style, {
        flex: "0 0 auto", width: px, height: px, margin: "0 2px",
        display: "flex", alignItems: "center", justifyContent: "center",
        borderRadius: "8px", cursor: "pointer",
        fontWeight: "700", fontSize: "12px", letterSpacing: "0.5px",
        color: C.dim, userSelect: "none",
    } as Partial<CSSStyleDeclaration>);
    b.textContent = "CC";
    b.onmouseenter = () => { if (!(paneEl && paneEl.style.display !== "none")) b.style.background = "rgba(127,127,127,0.15)"; };
    b.onmouseleave = () => updateInjectedStates();
    b.onclick = e => { e.preventDefault(); e.stopPropagation(); togglePane(); };
    return b;
}

function injectToggles() {
    try {
        if (!settings.store.transcriptPane) return;
        const shares = [...document.querySelectorAll<HTMLElement>('button,[role="button"]')]
            .filter(b => SHARE_RE.test(accessibleName(b)));
        for (const share of shares) {
            // Climb to the slot that sits directly in the button row.
            let slot: HTMLElement = share;
            while (slot.parentElement && slot.parentElement.children.length === 1) slot = slot.parentElement;
            const row = slot.parentElement;
            if (!row || row.querySelector("[data-cc-toggle]")) continue;
            const size = share.getBoundingClientRect().height || 32;
            row.insertBefore(makeCCButton(size), slot.nextSibling);
        }
        updateInjectedStates();
    } catch (e) {
        logger.error("injectToggles failed", e);
    }
}

let ccObserver: MutationObserver | null = null;
let injectThrottle: ReturnType<typeof setTimeout> | null = null;

function startObserver() {
    injectToggles();
    ccObserver = new MutationObserver(() => {
        if (injectThrottle) return;
        injectThrottle = setTimeout(() => {
            injectThrottle = null;
            injectToggles();
            // Re-dock the pane if a Discord re-render detached it while it's shown.
            if (paneEl && paneEl.style.display !== "none" && !layoutRow()?.contains(paneEl)) dockPane();
        }, 300);
    });
    ccObserver.observe(document.body, { childList: true, subtree: true });
}

function stopObserver() {
    ccObserver?.disconnect();
    ccObserver = null;
    if (injectThrottle) { clearTimeout(injectThrottle); injectThrottle = null; }
    document.querySelectorAll("[data-cc-toggle]").forEach(n => n.remove());
}

let reapTimer: ReturnType<typeof setInterval> | null = null;
let expireTimer: ReturnType<typeof setInterval> | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
let lastStatusPhase = "";
let lastInVoice = false;

export default definePlugin({
    name: "ClosedCaptions",
    description:
        "Live per-speaker closed captions for voice calls — taps each participant's own audio " +
        "stream and transcribes it locally with whisper.cpp (Vesktop/web audio path only).",
    authors: [{ name: "flashgnash", id: 0n }],
    settings,

    // Same proven web-only hook as PerUserAudioSinks / VolumeBooster: patch the
    // StreamData method that assigns `.volume = this._volume/100` and, on the
    // same `this`, start capturing that user's stream. Guarded to the Chromium
    // audio path — the native client mixes in C++ where JS can't reach it.
    patches: [
        {
            find: "streamSourceNode",
            predicate: () => !IS_DISCORD_DESKTOP,
            replacement: {
                match: /\.volume=this\._volume\/100;/,
                replace: "$&$self.handleStream(this);",
            },
        },
    ],

    handleStream,

    async start() {
        logger.info(`ClosedCaptions ${VERSION} started`);
        C = resolvePalette();   // theme stylesheet is present by now
        mountOverlay();
        mountPane();
        startObserver();        // inject "CC" toggle into Discord's control bars
        pushConfig();   // provisions + warms the engine so the first speaker isn't waiting

        reapTimer = setInterval(reap, 15000);
        // Re-render on a cadence so captions fade/expire and the backlog counter
        // ticks up even when nothing new is arriving.
        expireTimer = setInterval(() => { renderOverlay(); renderBacklog(); }, 500);

        statusTimer = setInterval(async () => {
            try {
                const st = await Native.getStatus();
                if (!st) return;
                const changed = st.phase !== engineStatus.phase || st.pct !== engineStatus.pct || st.message !== engineStatus.message;
                engineStatus = st;
                if (st.phase !== lastStatusPhase) {
                    lastStatusPhase = st.phase;
                    // Only surface hard errors as a toast; download/warm-up
                    // progress lives quietly in the pane header instead.
                    if (st.phase === "error") toast("Captions: " + (st.message || "engine error"), Toasts.Type.FAILURE);
                }
                if (changed) render();
            } catch { /* ignore */ }
            // Poll the GPU governor so the sidebar's level pill reflects live
            // throttling (steps down when a game needs the GPU).
            try {
                const g = await Native.getGpu();
                if (g && (g.tier !== engineGpu.tier || g.mode !== engineGpu.mode)) {
                    engineGpu = g;
                    renderModeControl();
                } else if (g) {
                    engineGpu = g;
                }
            } catch { /* ignore */ }
            // Start/stop our own-mic capture as we join/leave voice, and toggle
            // the transcript pane's visibility on that same transition.
            try {
                syncOwnCapture();
                const iv = inVoice();
                if (iv !== lastInVoice) { lastInVoice = iv; renderPane(); }
            } catch (e) { logger.error("voice sync", e); }
        }, 1000);

        // Debug handle — inspect capture + engine state from the console.
        (window as any).__closedCaptions = {
            version: VERSION,
            captures: () => [...captures.values()].map(c => ({ id: c.userId, name: resolveName(c.userId), self: c.isSelf, speaking: c.speaking })),
            status: () => Native.getStatus(),
            gpu: () => Native.getGpu(),
            inVoice, ownTransmitting: () => ownTransmitting(),
            toggle: togglePane,
            inject: injectToggles,
            dom: () => {
                const base = document.querySelector<HTMLElement>('[class*="base_"]');
                const row = layoutRow();
                const desc = (el: Element | null) => el ? { tag: el.tagName, class: el.className, display: getComputedStyle(el as HTMLElement).display, dir: getComputedStyle(el as HTMLElement).flexDirection, kids: el.childElementCount } : null;
                return {
                    base: desc(base), baseParent: desc(base?.parentElement || null),
                    row: desc(row), paneParent: desc(paneEl?.parentElement || null),
                    paneOrder: paneEl?.style.order,
                };
            },
            say: (name: string, text: string, confidence = 1) => { captions.push({ id: ++uttCounter, userId: "test", name, text, ts: Date.now(), final: true, confidence, words: [] }); render(); },
            clear: () => { captions = []; render(); },
            reap,
        };
    },

    async stop() {
        if (reapTimer) { clearInterval(reapTimer); reapTimer = null; }
        if (expireTimer) { clearInterval(expireTimer); expireTimer = null; }
        if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
        stopObserver();
        if (popoutOpen) { popoutOpen = false; try { void Native.popout("close"); } catch { /* ignore */ } }
        stopOwnCapture();
        for (const id of [...captures.keys()]) teardownCapture(id);
        try { void capCtx?.close(); } catch { /* ignore */ }
        capCtx = null;
        captions = [];
        unmountOverlay();
        unmountPane();
        delete (window as any).__closedCaptions;
        try { await Native.stop(); } catch (e) { logger.error("native stop failed", e); }
    },
});
