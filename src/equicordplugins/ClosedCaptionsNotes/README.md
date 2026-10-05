# ClosedCaptionsNotes

Session-notes **extension** for the [ClosedCaptions](../ClosedCaptions) plugin
(hard dependency — enable both). A local llama.cpp LLM (Qwen3) periodically
reads the live call transcript and maintains a per-channel **knowledge base**
of key information — world lore, names and roles, quests, decisions, plans.
Built for D&D sessions ("the baron is secretly a lich" gets written down), but
the extraction criteria are **fully customizable** via the *Notes prompt*
setting.

It plugs into ClosedCaptions through its extension API: the 📝 button in the
captions sidebar header, the notes split at the bottom of the pane, the 1 s
status tick (notes cadence), and the utterance PCM hook (DM voice
fingerprinting). The native side shares ClosedCaptions' downloader, log file
and GPU governor (one main-process bundle, shared module instances) — notes
passes only run when the caption engine is idle and the GPU has room.

## What it does

The plugin can also **take notes**: a local llama.cpp LLM (Qwen3) periodically
reads the transcript and maintains a per-channel **knowledge base** of key
information — world lore, names and roles, quests, decisions, plans. Built for
D&D sessions ("the baron is secretly a lich" gets written down), but the
extraction criteria are **fully customizable** via the *Notes prompt* setting.

- **Everything is local** and scales to the machine like the caption models:
  weak machines auto-pick Qwen3-1.7B (~1.1 GB), normal ones Qwen3-4B (~2.4 GB),
  and Qwen3-8B is an explicit opt-in for big GPUs. Provisioning mirrors the
  whisper engine: `CC_LLM_BIN`/`CC_LLM_MODEL` env → cached → download a pinned
  llama.cpp release (Windows tries Vulkan, falls back to CPU) → `PATH`.
- **Lowest priority by design** — the LLM runs at OS priority 19 and only when
  the caption engine is idle, external GPU demand is low, and a cooldown has
  passed; under load, passes are simply delayed. **Opening the notes panel
  lifts the gating** (you're actively waiting), and also flushes the current
  transcript buffer so the notes are fresh.
- **The markdown IS the source of truth** — no hidden database. Every pass
  parses the vault's bullets into facts (their file/location is their
  metadata), hands them to the model with ephemeral ids, applies the JSON
  ops (`new` / `updated` / `removed`), and writes the files back. Manual
  edits are first-class: edit, add or delete any bullet in Obsidian and
  that's simply what the model sees next pass. Deleting a file deletes its
  facts (recoverable from git). Default dir: `Documents/discord-notes`.
  (Old installs: the legacy `.store/` JSON migrates into the vault
  automatically on first pass, then is removed.)
- **Wiki-style tree, one folder per server** — general notes land in
  `<Guild>/<Channel>.md`; any entity that accumulates 3+ facts gets its own
  page (`<Guild>/Places/…`, `Items/…`, `Factions/…`, `Quests/…`, `Events/…`,
  `Lore/…`) — except **characters, who ALWAYS get their own
  `People/<Name>.md` page from the very first fact**, so every name mention
  anywhere linkifies to their page. Pages merge across the guild's channels
  and are linked from a *Pages* section in the channel file; pages whose
  facts disappear are deleted (git keeps the history). DM calls share a
  `DMs/` tree.
- **`Cast.md` — the DM and who plays whom** — seeded once per guild from the
  call's speakers, then user-owned (never rewritten). `- DM: alice` makes
  alice's narration the authoritative source of truth over player claims;
  `- bob: Hank, Greg` tells the model bob voices both Hank and Greg, to be
  disambiguated from context. Hard attribution rules ride along in every RPG
  pass: transcript speakers are PLAYERS not characters, and when it isn't
  clear which character a fact belongs to, the model must use no subject at
  all — a missing attribution is fine, a wrong one is not. Discord server
  nicknames feed in as an extra hint (players often nickname themselves
  after their character): "the label 'Hank' is a nickname of account dave"
  — a hint only, and Cast.md always outranks it. For pathological naming
  (players sharing names with other players' characters, characters named
  after real people), any **plain sentence written in Cast.md** below the
  mappings is injected verbatim as authoritative cast notes — e.g. "there
  are two ethans: the player ethan plays Greg, whose surname is also
  Ethan". The prompt also forbids resolving names by string match alone.
- **Unnamed characters get placeholders** — a character whose name isn't
  known yet is filed under a descriptive subject ending in `(unnamed)`
  ("Hooded stranger (unnamed)"); a player's not-yet-named character uses
  the player's Discord name ("bob (unnamed)"). The page carries a ⚠
  rename-me notice. Resolution paths: the model renames automatically when
  the real name comes up, the cleanup pass does too, the notes chat takes
  "the hooded stranger is Veyle", or just rename the file by hand —
  markdown is the source of truth, so a manual rename IS the fix.
- **Notes chat (💬)** — a small chat strip in the notes section: type
  "Maretta runs the Drowned Rat, not the Gilded Eel" and a correction pass
  applies it to the vault (the instruction outranks the stored facts),
  replying with what it changed. Session-logged as `(chat)`.
- **Guild ledgers (RPG style)** — `<Guild>/Schedule.md` collects out-of-game
  scheduling (when the next session is, who's free when) and
  `<Guild>/Timeline.md` the campaign chronology (story events as they
  happen, dated by when they were noted, names wikilinked).
- **Git-versioned vault** — the notes dir is a git repo: a snapshot commit
  runs before every pass (so manual Obsidian edits are captured) and a commit
  after every change, meaning a cleanup pass or the next session can never
  clobber anything irrecoverably — `git log` / `git diff` in the notes dir is
  the full history. No git installed → versioning is quietly skipped.
- **Per-call session logs** — every call also gets its own timestamped file,
  `<Guild>/Sessions/<YYYY-MM-DD HH-MM> <channel>.md`, appended per pass with
  what the note-taker learned (new / updated / removed facts, with times).
  Append-only history — the entity/channel pages are the living state.
- **Newest first, everywhere** — every generated file (character pages,
  channel pages, Schedule, Timeline) is organized into `## YYYY-MM-DD`
  sections, newest at the top: this call's changes lead, older information
  sits below, pre-dating bullets group under `## Earlier`. The headers
  themselves persist each fact's noted-date in the markdown; an updated
  fact bumps to today's group. The in-app panel shows ONLY the current
  call's changes (from git), on every tab — the files are the full record.
- **Timer + on-demand pass** — the panel footer counts down to the next
  scheduled summarization; opening the panel triggers one immediately for
  whatever transcript has accumulated.
- **Note styles (per channel)** — "Conversation" (the default) records ONLY
  things worth remembering: appointments, dates, plans, commitments,
  decisions, explicit "remember this" items. It never records personal
  details and is structurally profile-proof: subjects are stripped after
  every pass so person pages can't form no matter what the model returns.
  "RPG" is the full world-building knowledge base (characters, places,
  items, quests → entity pages). Switch per channel from the pill in the
  notes header; the global default is a setting.
- **STRICTLY OPT-IN per channel** — nothing is ever noted in a channel until
  someone explicitly flips the toggle in the 📝 panel for that channel (the
  plugin-settings switch is only a master kill switch). Private DM
  side-channel lines (🔒) are never fed to the notes either way.
- **Purge control (🗑 in the notes header, two-stage)** — deletes everything
  the current session recorded for that guild, including the git history
  when the session's commits sit on top (branch rewound, reflog expired,
  objects pruned); interleaved histories fall back to a file revert and say
  so. Also drops the not-yet-summarized transcript buffer.
- Cadence: a pass every ~15 min of call (configurable), plus on leaving voice
  and when the panel opens. Env overrides: `CC_LLM_BIN`, `CC_LLM_LIBDIR`,
  `CC_LLM_MODEL` (standard/auto tier), `CC_LLM_MODEL_SMALL`, `CC_LLM_MODEL_LARGE`.
- **External provider (optional)** — instead of the self-provisioned local
  engine, point *Notes API URL* (or `CC_LLM_URL`) at any OpenAI-compatible
  `/v1/chat/completions` server: a home llama-server router on the tailnet,
  Ollama, or a cloud provider (with *Notes API model* / *Notes API key* as
  needed, key also via `CC_LLM_API_KEY`). The plugin first sends the full
  llama.cpp request (JSON mode + thinking off) and steps down automatically
  for stricter providers that 400 on unknown params. Blank URL = local engine,
  so people with no setup of their own still get the zero-install default.
  Note the transcript text leaves the machine when an external URL is set —
  only use servers you trust. External passes skip the GPU-idle gating (they
  cost nothing locally). If the endpoint is network-unreachable the plugin
  falls back to the local engine for 5 minutes and keeps retrying — this
  repo points `CC_LLM_URL` at the host's tailnet LLM mesh router
  (`modules/llm-router.nix`, port 8630), so notes ride the best machine on
  the tailnet when one is up and the local engine otherwise.


## Settings migration

These settings used to live inside ClosedCaptions; on first start this plugin
copies the old values over once (including `notesChannels` — the strict
per-channel opt-ins are privacy state and survive the split).

## Distributing

Like ClosedCaptions this is a standard Vencord userplugin (`index.tsx` +
`native.ts`). Recipients drop BOTH `ClosedCaptions/` and `ClosedCaptionsNotes/`
into `src/userplugins/` and build Vencord — this plugin imports from
`../ClosedCaptions`, so the folder names must be kept.
