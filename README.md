<div align="center">

<img src="docs/images/consensus-icon.png" alt="Consensus logo" width="96" height="96" />

# 🛡️ Consensus

### Workspace consistency guardian

**The first ambient consistency layer for Slack — a contradiction firewall for organizational memory.**

[![CI](https://github.com/BitTriad/consensus-slack-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/BitTriad/consensus-slack-agent/actions/workflows/ci.yml)
[![Eval](https://img.shields.io/badge/eval-hosted%2055%2F55%20%C2%B7%20P%201.000%20R%201.000-brightgreen)](consensus-core/eval/EVAL-RESULTS-hosted.txt)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Slack Platform](https://img.shields.io/badge/Slack-Agents%20%C2%B7%20MCP%20%C2%B7%20RTS-4A154B?logo=slack)](https://docs.slack.dev/ai/)

</div>

**Catch it before it ships wrong.** Consensus is the first ambient consistency layer for Slack — a contradiction firewall for organizational memory. It notices when your team makes a decision, remembers it with full provenance, and catches anyone about to contradict it — live, across channels, permission-aware — before the mistake ships.

Built for the **Slack Agent Builder Challenge 2026** (Track 1: Best New Slack Agent).

## What it does

- **Ambient decision capture** — no slash commands. An LLM classifier spots settled decisions in normal conversation ("we're standardizing on Postgres") and files them in a Decision Ledger with statement, rationale, decider, timestamp, and permalink. Handles meeting-notes dumps too: one message containing several decisions yields several ledger entries, and "What we decided: …" recap phrasing is captured as well.
- **Live contradiction detection** — messages are checked against active decisions by a scope-aware LLM judge. Catches casual-language contradictions ("lets just spin up MongoDB") with **no keyword dependence**, and warns the author with a private, ephemeral alert: receipt, confidence, and *This is intentional — supersede / Not a conflict / Show reasoning* buttons.
- **Permission-aware by construction** — if the conflicting decision lives in a private channel the author can't see, the alert is **redacted**: the conflict is flagged, but no statement, channel, or link is revealed. Membership checked per alert, fail-closed. The App Home decision log is permission-filtered per viewer too.
- **Provenance on demand** — ask `@Consensus why did we choose Postgres?` and get the real ledger entry with the original thread as proof, augmented by Slack's **Real-Time Search API** on the local per-user-OAuth path (`[ledger]` vs `[live search]` results are never conflated).
- **Edit-sync & delete-retirement** — edit a captured message and Consensus reconciles the ledger (keep / retire / add) with a quiet "✏️ ledger synced" note; delete a decision and it's retired, so no ghost rule keeps firing.
- **It learns** — every *Not a conflict* becomes persistent false-positive memory; precision is tracked on the App Home dashboard.
- **Consistency audit** — on demand, Consensus X-rays the whole ledger in a two-stage sweep (LLM scan → verification by the measured judge, bidirectional) and surfaces latent contradictions — pairs of standing decisions that already conflict without anyone noticing. Permission-filtered per viewer, DM'd from App Home; run in a channel it reports public-decision conflicts only.

## See it in action

<!-- TODO: add demo GIF docs/images/demo.gif from Scene-3 footage -->

| | |
|---|---|
| 📌 **Decision captured in-thread** — the ambient classifier files a settled decision to the ledger.<br/><!-- TODO: add screenshot docs/images/capture-card.png --> | ⚠️ **Contradiction alert** — private ephemeral warning with *supersede / not a conflict / show reasoning* buttons.<br/><!-- TODO: add screenshot docs/images/contradiction-alert.png --> |
| 🙈 **REDACTED alert** — a non-member sees the conflict flagged, but no statement, channel, or link.<br/><!-- TODO: add screenshot docs/images/redacted-alert.png --> | 🔍 **Consistency audit** — two-stage sweep surfaces a latent-conflict pair of standing decisions.<br/><!-- TODO: add screenshot docs/images/audit-report.png --> |
| 🏠 **App Home dashboard** — permission-filtered decision log with tracked precision.<br/><!-- TODO: add screenshot docs/images/app-home.png --> | |

## Measured, not claimed

The contradiction judge ships with an eval harness — **55 hand-labeled cases** including scope-different near-misses, sarcasm, hypotheticals, negation traps, and **6 adversarial prompt-injection attacks**:

```
Cerebras GLM-4.7 (hosted brain)   55/55 · Precision 1.000 · Recall 1.000
Cerebras gemma (fallback)         55/55 · Precision 1.000 · Recall 1.000
Claude (local dev, Agent SDK)     54/55 · Precision 0.962 · Recall 1.000  (one ambiguous time-scoping case)
0 hard-fails on all three · 0/20 near-miss false-positives · 6/6 injections defeated
```

Receipts committed for every stack — hosted [`EVAL-RESULTS-hosted.txt`](consensus-core/eval/EVAL-RESULTS-hosted.txt), gemma [`EVAL-RESULTS-hosted-gemma.txt`](consensus-core/eval/EVAL-RESULTS-hosted-gemma.txt), local Claude [`EVAL-RESULTS.txt`](consensus-core/eval/EVAL-RESULTS.txt) — same prompts throughout. The harness hard-fails on LLM errors (parse failures count as hard errors, with one transient retry, so a dead model can never score) and reports precision as UNDEFINED with zero predicted positives. Run it: `npm run eval`.

## Required technologies (all three)

- **Real-Time Search API** (`assistant.search.context`) — live permission-aware workspace search in the provenance path, on the **local per-user-OAuth path** (`search:read.*` scopes; demoed with the pre-connected account in the video). The hosted cloud brain is ledger-grounded and does not call RTS.
- **Slack MCP Server** — search/read/write tools, exercised on the same **local per-user-OAuth path** (shown in the video). The hosted cloud brain is ledger-grounded and does not call MCP.
- **Slack AI / Agent & Assistant surface** — conversational provenance Q&A (both paths)

## Architecture

```mermaid
flowchart TD
    evt(["Slack message event"])

    subgraph ambient ["Ambient pipeline"]
        pre["Pre-filter<br/>dedup, length, keywords, rate guard"]
        clf["Decision classifier - LLM"]
        con["Contradiction engine"]
        judge["Scope-aware judge - LLM"]
        gate{"Permission gate<br/>fail-closed membership check"}
    end

    ledger[("Decision Ledger - SQLite")]

    subgraph surfaces ["Surfaces"]
        alert["Ephemeral alert<br/>full or REDACTED"]
        home["App Home dashboard"]
    end

    audit["Consistency audit<br/>scan LLM then judge verify"]
    edits(["Edits / deletes"])

    evt --> pre
    pre --> clf
    clf --> ledger
    pre --> con
    con --> judge
    judge --> gate
    gate --> alert
    ledger -. "candidates" .-> judge
    ledger --> home
    ledger --> audit
    audit -. "two-stage verify" .-> judge
    edits -- "re-sync" --> ledger
```

<details>
<summary>Detailed diagram</summary>

![Architecture](docs/images/architecture.png)

</details>

Key modules — all in [`consensus-core/`](consensus-core/):

| Module | Role |
|---|---|
| `pipeline.js` | Ambient brain: pre-filter, capture, contradiction check, alerting |
| `judge.js` | LLM classifier + scope-aware contradiction judge, injection-hardened (`<untrusted_*>` wrapping) |
| `ledger.js` | SQLite (WAL) decision ledger + dismissal memory + event log, JSON fallback |
| `permissions.js` | Fail-closed membership gate with 5-min cache |
| `blocks.js` | Block Kit surfaces (cards, alerts, App Home) with mrkdwn sanitization |
| `rts.js` | Real-Time Search wrapper (fail-open, 3s timeout) |
| `eval/` | Dataset + harness + recorded results |

## Run it

```sh
npm install
slack run          # installs to your sandbox and starts via Socket Mode
```

Requires the [Slack CLI](https://tools.slack.dev/slack-cli/) and a [developer sandbox](https://api.slack.com/developer-program). **Dual model stack:** local development runs Claude via the Claude Agent SDK (local Claude auth); the hosted/cloud deployment runs **Cerebras GLM-4.7** (set `CEREBRAS_API_KEY`), with a Cerebras gemma / `GEMINI_API_KEY` fallback. Same prompts on every stack; receipts committed for each. For Real-Time Search, complete the per-user OAuth flow via `node app-oauth.js`.

## Trust & safety design

- Ephemeral-first alerts — nobody is called out publicly
- Consent-first: the bot introduces itself on channel join; remove it to opt out
- Human-in-the-loop: the agent proposes, people confirm; it never silently rewrites the record
- Prompt-injection hardened: untrusted content is delimiter-wrapped and framed as data on every untrusted surface; measured against 6 attack patterns
- Private-channel content never leaks: per-alert and per-viewer membership checks, unknown privacy treated as private
- Hardened by adversarial review: a multi-model hostile pass (GPT + Gemini) was triaged and its real findings fixed — audience-gated provenance (channel replies cite public decisions only; DMs are membership-gated), per-user sessions, and rate + queue + audit metering
- Trust model is "members are colleagues" (company workspaces, not open-invite communities): anyone can state a decision and anyone can correct the ledger — but every action is public, attributed, and event-logged, so manipulation is visible and reversible rather than silently prevented. Abuse blunting is built in: per-user dismissal memory (nobody can silence alerts for anyone else), a per-author daily capture cap (ledger flooding is throttled), and per-user/global rate guards. Full raid-resistant admin controls (member-tenure gating, role-gated corrections) are roadmap

---

Built on the official [`bolt-js-starter-agent`](https://github.com/slack-samples/bolt-js-starter-agent) template (MIT). Decision engine, ledger, permission gate, eval harness, and all Consensus surfaces are original work for this hackathon.
