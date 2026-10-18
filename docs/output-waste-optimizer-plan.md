# Output-Waste Optimizer: Build Instructions and Plan

> **Status:** Draft for the two-person team. Anything marked **[VERIFY]** is not yet sourced or tested and must be checked before it appears on screen or in the pitch. Anything marked **[DECIDE]** needs a team decision.
>
> **How to use this file:** Humans read sections 1–4 and 10–12 first. An AI assistant should read the whole file and follow section 18 before writing code.

---

## 1. Summary

Most AI footprint tools show a single number. This project shows **what resources a person's AI use is wasting**, and helps them stop wasting them.

It does four things:

1. **Resource feedback.** Converts wasted tokens into estimated energy (Wh), water (mL), CO₂ (g), and cost, with ranges and sources.
2. **Optimizers.** Suggests a maximum input length and a fixed template for recurring tasks, and detects wasted output with a fix for each waste type.
3. **Model rerouting.** Recommends a smaller model for a task when it gives the same answers on the same examples.
4. **Ranking.** An opt-in efficiency leaderboard and shareable weekly card (seeded demo data for the hackathon).

Every suggestion that changes behavior (a new input limit, a model switch) is **approved by the user** and is **checked by a quality gate** first.

**Track:** Track 2, Build a Sustainable Future (optimize resource consumption).
**Prompt link:** Virginia has more data centers than anywhere, and AI inference is a growing share of their load. Waste in AI use costs energy, water, and carbon at data centers that serve Virginia.

**Pitch line:** "Every token has a footprint. We show you what you're wasting, and help you stop."

---

## 2. Context and rules

- **Event:** 804 Hacks, one day, 8 hours of build time.
- **Team:** two people. Both must speak in the pitch and both must answer questions. Both must understand the whole project.
- **Constraints:** software only, no hardware. Claude Pro and GPT Pro are available, so code generation is not the bottleneck. Integration, data quality, demo reliability, and the pitch are.
- **Pitch:** 5 minutes max, then 2 minutes of judge questions. No slideshow.
- **Rubric (100 pts):** Functionality 35 · Problem/Solution 20 · Team and Presentation 20 · Target Market and UVP 10 · Questions 10 · Marketing 5.

**Rules for this build**
1. Demo core first. Nothing outside the demo core gets built until the demo core works end to end.
2. Never invent a number. Every energy, water, CO₂, or price figure comes from `config/sources.json` with a source and a range.
3. Estimates are ranges, labeled as estimates, with assumptions visible on screen.
4. All text analysis runs locally. Nothing is uploaded except opt-in aggregate scores.
5. Seeded or demo data is labeled "demo data" everywhere it appears.

---

## 3. Scope tiers

### Demo core (must work live)
| # | Feature | Owner |
|---|---|---|
| D1 | Output-waste detection (5 detectors, section 5.2) | A |
| D2 | Efficiency % and fix block | A |
| D3 | Resource feedback: energy, water, CO₂, cost with ranges (section 5.1) | A |
| D4 | Input limit suggestion for one task (section 5.3) | A |
| D5 | Model rerouting suggestion for one task (section 5.4) | A |
| D6 | Quality gate for D4 and D5 (section 5.5) | A |
| D7 | Paste-in analyzer UI that shows D1–D6 | A (UI) |
| D8 | Grid intensity feed: cached PJM data with labeled fallback (section 6.2) | B |
| D9 | Leaderboard and weekly card, seeded and labeled as demo data (section 5.6) | B |

### Stretch (only after D1–D9 pass their acceptance tests, and only if time remains)
- S1: Browser extension on one chat site. Owner B. Must be cut first.
- S2: CLI log reader for one coding tool, for exact token counts. Owner B.
- S3: Live quality gate on the user's own examples (the demo uses a seeded run).

### Roadmap (say it, don't build it)
- Carbon-timed scheduler for batch jobs. Demonstrates the next step in the same engine.
- Team dashboard, enterprise reporting export, VS Code and JetBrains plugins, Chrome Web Store listing, SDK or proxy.

**Cut order if behind schedule:** S1, S2, S3, then D9 live features (keep the seeded version), then D4/D5 live runs (keep the seeded results).

---

## 4. Main functions in detail

### 4.1 Resource feedback (the headline)
Users see what they are wasting in the resources they care about:
- **Energy (Wh)** from wasted output and input tokens.
- **Water (mL)** from the energy, using a water-intensity range.
- **CO₂ (g)** from the energy and the grid's carbon intensity.
- **Cost** from the user's price per token, entered once in settings.

Each figure appears as a **range** (low to high), with a tooltip linking to its source in `config/sources.json`.

### 4.2 Output-waste detection
Five detectors. Each returns the flagged spans and tokens. Only the first three count toward the efficiency score by default.

| Detector | Counts toward score | Method (first version) |
|---|---|---|
| Prompt echo | Yes | Overlap between the first 2–3 sentences of the response and the prompt (n-gram overlap above a threshold) |
| Filler | Yes | Match list of openers and closers ("Great question", "I hope this helps", "Let me know if…") |
| Repetition | Yes | Repeated sentences, or repeated 6-word spans within the response |
| Redundant recap | No (advisory) | "In summary", "To recap" followed by content already present |
| Boilerplate caveat | No (advisory) | Standard disclaimers that repeat across responses |

**Efficiency % = 1 − (flagged output tokens ÷ total output tokens)**

Count only high-confidence flags. Fuzzy flags are shown as advisory.

**Each waste type has one fix:**
- Prompt echo → "Answer directly. Don't restate the question."
- Filler → "Skip pleasantries and offers of more help."
- Repetition → "Don't repeat points you've already made."
- Recap → "Don't end with a summary."
- Boilerplate → "Skip standard disclaimers unless they're needed for this answer."

The **fix block** combines the fixes for the user's most common waste types into one short block they paste into their AI settings.

**Caveat shown on screen:** brevity instructions can reduce quality on complex tasks. Recommend them mainly for simple, repeated tasks.

### 4.3 Input limits (suggestion)
For a recurring task, the tool suggests:
- A **maximum input length** (in tokens), set from the user's past examples.
- A **fixed template** that keeps only the parts the task needs. Example: for a ticket summary, keep the latest message and drop quoted replies and signatures.

**Trimming rules are deterministic** (no model rewrites the prompt):
- Remove quoted replies (lines starting with `>`, and "On … wrote:" blocks).
- Remove email signatures (text after a standard `--` line or a known signature pattern).
- Keep only the last N tokens or the last message, depending on the task.

The user approves the suggestion. The quality gate (4.5) must pass first.

### 4.4 Model rerouting (suggestion)
For a recurring task, the tool:
1. Runs the same examples on a smaller model from `config/models.json`.
2. Compares answers with the same matching rule the gate uses.
3. If the smaller model passes the threshold, shows: "Task X passed on [smaller model] in N of M examples. Estimated saving: [range]. Approve the switch?"
4. Stores the approval. Savings count only for approved switches.

The user always decides. The tool never switches models automatically.

### 4.5 Quality gate
Runs **once per task**, not per request. Its verdict is saved and reused.

**Inputs:** a task definition, 10–20 examples with known correct answers, and a candidate change (an input limit, an output limit, or a smaller model).

**Matching rules by task type:**
- **Classification or extraction:** the label or extracted value must match exactly.
- **Summarization:** the output must contain each required key fact in a list the team writes for each example.
- **Length limit:** the answer must not be cut off, i.e., the required final field must still appear.

**Default threshold:** pass rate ≥ 95% of examples. Configurable per team. **[DECIDE]** the default.

**Output:** pass or fail, pass rate, and the list of failed examples with the reason for each.

**Verdict record:** `{task_id, change_type, change_value, model, example_set_hash, pass_rate, checked_at, expires_at}`.

**Expiry:** 30 days, or when the task definition or the example set changes.

**Cost of the check:** record the tokens and estimated energy used by the check, and subtract it from the reported savings.

### 4.6 Leaderboard and weekly card
- **Efficiency % ranking**, not absolute savings, so light and heavy users are compared fairly. Compare within cohorts where possible (**[DECIDE]** the cohort definition).
- **Opt-in only.** Only aggregate efficiency scores are shared. Prompts and responses never leave the device.
- **Hackathon version:** seeded demo data, labeled "demo data" on screen.
- **Weekly card:** efficiency %, change vs last week, and the resources represented (Wh, mL, g CO₂, cost), with ranges.

---

## 5. Calculations

### 5.1 Resource conversion
Let:
- `T_out` = output tokens, `T_in` = uncached input tokens, `T_cr` = cache-read tokens, `W` = wasted output tokens
- `e_out`, `e_in`, `e_cr` = energy per token (Wh/token), each as a low and high value from `config/sources.json`
- `I` = grid carbon intensity (gCO₂/kWh) for the hour, from D8
- `WI` = water intensity (mL/kWh), as a low and high value from `config/sources.json`
- `P_out`, `P_in` = user's price per token, from settings

**Wasted energy (Wh)** = `W × e_out` (low and high)

**Wasted water (mL)** = wasted energy (kWh) × 1000 × `WI` — convert Wh to kWh first

**Wasted CO₂ (g)** = wasted energy (kWh) × `I`

**Wasted cost** = `W × P_out` (plus the input term if the input limit is applied)

**Notes:**
- Cache reads (`T_cr`) use near-zero energy in this model. Show the assumption on screen.
- Hidden reasoning tokens are billed as output. If the tool can see them (for example, from an API response), include them in `T_out`. In web chat they are not visible, so output is undercounted. Say so.
- Every figure is a range. Never display a single number without its range.

### 5.2 Efficiency %
`efficiency = 1 − W / T_out`, where `W` counts only high-confidence flags.

### 5.3 Input savings
`saved_input_tokens = T_in_original − T_in_limited`, per task, averaged over the example set.

### 5.4 Savings for the user's baseline
Savings are measured against the user's own first 7 days (or first 50 responses, **[DECIDE]**). Display the baseline and the period.

### 5.5 Net savings for a team report
`net = gross savings − energy used by quality checks`. Show both lines.

### 5.6 Impact example (for the pitch)
Use this structure, with labeled inputs. **Every input must be sourced or marked as an assumption.**

> Users × wasted output tokens per month × energy per token × grid intensity = estimated CO₂ avoided per month.

Example inputs (**all placeholders, [VERIFY] before use**):
- Users: [assumption]
- Wasted output tokens per user per month: [from fixtures or a pilot]
- Energy per output token: [range, source]
- Grid intensity for PJM: [range, source, date]

Present the result as a range. State the assumptions on screen.

---

## 6. Data

### 6.1 Storage
- **Local-only**, using a JSON file or SQLite in `data/`. No server.
- Tables or files: `events`, `tasks`, `examples`, `verdicts`, `approvals`, `settings`.

### 6.2 Grid data
- Source: EIA hourly electricity data API, PJM balancing authority, generation by fuel type. **[VERIFY]** the endpoint, parameters, field names, and rate limit with a real test call in hour 0–1.
- Convert the fuel mix to carbon intensity: sum(generation by fuel × emissions factor by fuel) ÷ total generation. **[VERIFY]** the emissions factor source and whether it's lifecycle or direct.
- Cache the last 30 days in `data/grid_pjm.json`.
- **Fallback:** if the feed is unavailable, use a constant from `config/sources.json`, labeled "fallback value, not live."

### 6.3 Seeded demo data
- `data/demo_events.json`: 200 sample events with realistic waste patterns.
- `data/demo_leaderboard.json`: 20 fake users, labeled "demo data."
- `data/demo_tasks.json`: 2 tasks with 10 examples each, for the quality gate and the rerouting demo.

### 6.4 Event schema
```json
{
  "id": "evt_001",
  "timestamp": "2026-10-18T14:03:00Z",
  "surface": "paste",
  "tool": "chatgpt | claude | other",
  "model": "string",
  "tokens": { "input": 0, "cache_read": 0, "output": 0, "reasoning": 0 },
  "flags": [{ "type": "echo | filler | repetition | recap | boilerplate", "tokens": 0, "confidence": "high | advisory" }],
  "region": "PJM"
}
```
Text fields (`prompt`, `response`) are kept **only locally** and never included in shared data.

---

## 7. Architecture and file layout

Monorepo, TypeScript. **[DECIDE]** if the team prefers Python for the core; the plan works either way.

```
804-Hacks-Project/
  docs/
    output-waste-optimizer-plan.md   (this file)
  packages/
    core/                 engine: estimates, detectors, fixes, input rules, gate, rerouting
      src/
        estimate.ts       section 5.1
        detect.ts         section 4.2
        fixes.ts          fix block
        inputRules.ts     section 4.3
        gate.ts           section 4.5
        reroute.ts        section 4.4
        grid.ts           section 6.2
      test/               unit tests with fixtures
  apps/
    portal/               paste-in analyzer, leaderboard page, weekly card
  config/
    sources.json          every number with its source
    models.json           model list and per-model energy ranges
  data/
    demo_*.json           seeded data (labeled)
    grid_pjm.json         cached grid data
  scripts/
    fetch_grid.ts         EIA fetch and cache
```

---

## 8. Interfaces (function signatures)

```ts
estimate(event: UsageEvent, config: Config): { energyWh: Range; waterMl: Range; co2g: Range; cost: Range }
detect(response: string, prompt?: string): { flags: Flag[]; wastedOutputTokens: number; efficiency: number }
suggestFixes(flags: Flag[], history: Flag[]): { fixes: Fix[]; fixBlock: string }
suggestInputLimit(examples: Example[], task: Task): { maxInputTokens: number; template: string }
applyInputRules(prompt: string, task: Task): string
runGate(task: Task, change: Change, examples: Example[], threshold: number): Verdict
suggestReroute(task: Task, examples: Example[], candidates: Model[]): RerouteSuggestion | null
weeklyCard(events: UsageEvent[]): CardData
fetchGridPJM(): Promise<GridHour[]>   // with cache and fallback
```

`Range` is `{ low: number; high: number; unit: string }`.

---

## 9. Acceptance criteria (each must pass before moving on)

| Feature | Test |
|---|---|
| D1 detection | On 20 fixture responses with known waste, precision ≥ 0.9 for high-confidence flags, and every flag has a span |
| D2 efficiency | Efficiency is between 0 and 1, and matches section 5.2 on the fixtures |
| D3 resource feedback | Every figure shows a range, a unit, and a source key. No single numbers on screen |
| D4 input limit | Applying the rules to fixtures removes quoted replies and signatures, and leaves the latest message intact |
| D5 rerouting | On the seeded task, the suggestion appears only when the pass rate meets the threshold |
| D6 gate | On a seeded failing change, the gate returns fail and lists the failed examples |
| D7 paste-in | Paste a 500-word prompt and response, get all results in under 3 seconds, locally |
| D8 grid | The app works with the cache alone, and shows the fallback label when the feed is down |
| D9 leaderboard | Seeded data is labeled, and opt-in is off by default |

---

## 10. Work plan (two people, 8 hours)

**Owners:** A = core engine and paste-in UI. B = grid data, leaderboard and card, and stretch items.

| Time | Person A | Person B |
|---|---|---|
| 0:00–0:45 | Together: agree the schema and signatures in section 8; scaffold the repo; write 20 fixtures with expected flags | Test one real EIA call; record the exact endpoint, fields, and limits; write `config/sources.json` with first sources |
| 0:45–3:00 | Build `estimate`, `detect`, `suggestFixes` (D1–D3) | Build `fetchGridPJM` with cache and fallback (D8); build demo data (6.3) |
| 3:00–5:00 | Build `applyInputRules`, `runGate`, `suggestReroute` (D4–D6); paste-in UI (D7) | Build leaderboard and weekly card with seeded data (D9); start S1 extension only if D8–D9 pass |
| 5:00–6:00 | Integrate: paste-in shows D1–D6; fix bugs | Integrate grid data into estimates; check all figures show ranges and sources |
| 6:00–7:00 | Write the impact calculation (5.6) with sources | Write the competitor table, verify each tool's current features, and the marketing plan |
| 7:00–8:00 | Rehearse three times. Record a backup demo. No new features | Rehearse three times. Test on a second machine |

**Stop rule:** at 5:00, if D1–D9 do not all pass their acceptance tests, drop the stretch items and fix the core.

---

## 11. Demo script (about 3 minutes live, 2 minutes Q&A)

**Speaker A (problem and demo):**
1. Show the Virginia problem in one sentence with a sourced figure.
2. Paste a wasteful response into the analyzer. Show the flags, the efficiency %, and the fix block.
3. Show the resource feedback: energy, water, CO₂, and cost, with ranges and the source tooltip.
4. Show the input-limit suggestion and the quality gate result for it.

**Speaker B (rerouting, ranking, and close):**
5. Show the rerouting suggestion with the pass rate and the approve button. Approve it, and show the saving counted.
6. Show the leaderboard and weekly card, labeled as demo data.
7. Close with the impact range and assumptions.

**Fallbacks:**
- Grid feed down → cached data with the fallback label.
- Analyzer slow → the recorded run.
- Anything fails live → switch to the backup video, and say so.

---

## 12. Pitch, market, and rubric mapping

| Rubric | What we show | Where |
|---|---|---|
| Functionality (35) | Paste-in analyzer, resource feedback, input and rerouting suggestions, gate, leaderboard | Demo sections 2–6 |
| Problem/Solution (20) | Virginia data centers, sourced figure, invisible waste, approach | Speaker A opening, impact range |
| Team and Presentation (20) | Both speak, clean handoffs | Demo script |
| Target Market and UVP (10) | Companies that use AI heavily; heavy individual users on paid plans. UVP below | Speaker A |
| Questions (10) | Both know every section | Rehearsal |
| Marketing (5) | Plan below | Speaker B |

**UVP:** "Other tools show a number. We show what you're wasting, in energy, water, CO₂, and money, and we help you stop it, with a quality check so answers don't get worse."

**Target market:**
- Companies with heavy AI use: token waste is cost and carbon waste.
- Heavy individual users on paid plans: "waste less, get more from your limit."

**Marketing plan (beyond social media):**
- Shareable weekly cards with efficiency % and resources saved, opt-in.
- Opt-in leaderboard, ranked by efficiency %.
- Product Hunt launch and GitHub release (after the event).
- Developer communities that discuss AI cost and green software.
- B2B pilots: one engineering or FinOps team, one sustainability or ESG team.
- Roadmap: browser extension and VS Code plugin for distribution.

**Business model (roadmap):** free analyzer and extension as the funnel; paid team dashboard and reporting export.

---

## 13. Competition and novelty

**Known tools (verify each one's current features before the pitch):**
- Footprint AI (Chrome): energy, water, and CO₂ totals for chat responses.
- AI Impact Tracker (Chrome): carbon and water estimates for ChatGPT.
- My AI Impact (Firefox): per-prompt estimates for ChatGPT.
- claude-carbon: session footprint and tips for Claude Code.
- Carbon Trace: energy and carbon for ML and LLM calls, as an SDK.
- tokentap and token-tracker: token and cost tracking for coding tools.
- EcoLogits: open-source per-request energy and emissions library.
- ebb-ai: defers LLM calls to cleaner windows, for developers.
- Token Efficiency Agent: scores and rewrites prompts to cut tokens.
- Carbon Aware SDK and cloud region pickers: infrastructure, not AI usage.

**Gap we claim:** none of these combines waste detection in the output, the resource feedback with ranges, the input and rerouting suggestions behind a quality gate, and the team-facing report. **Say "in our research we found none that combine…" and mean it.** Re-check before the pitch.

**Honest framing:** each technique is established. The contribution is the combined workflow and the approval-based design.

---

## 14. Sources table (fill before the pitch)

| Key | Value | Range | Source | Date | Used for |
|---|---|---|---|---|---|
| `e_out` | Energy per output token | [VERIFY] | [VERIFY] | | Section 5.1 |
| `e_in` | Energy per input token | [VERIFY] | [VERIFY] | | Section 5.1 |
| `WI` | Water intensity | [VERIFY] | [VERIFY] | | Section 5.1 |
| `EF` | Emissions factor by fuel | [VERIFY] | [VERIFY] | | Section 6.2 |
| `grid_PJM` | Live PJM intensity | Feed | EIA API [VERIFY] | | Section 6.2 |
| `va_dc` | Virginia data center electricity or water | [VERIFY] | [VERIFY] | | Speaker A opening |
| `ACL2025` | Brevity and energy result | 25–60% energy reduction, per the paper's findings [VERIFY] | Poddar et al., ACL Findings 2025 [VERIFY] | | Pitch evidence |

---

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Two-person capacity | Hold to the demo core. Stretch items only after D1–D9 pass |
| Invented numbers | Every value in `config/sources.json`. No number without a source |
| Brevity hurts quality | Quality gate on every suggestion; recommend mainly for simple tasks |
| False positive waste flags | High-confidence flags only in the score; fixtures test precision |
| Extension breaks or breaks terms of service | Extension is stretch, and it's a roadmap item if it doesn't work |
| Grid feed unavailable | Cached data and labeled fallback |
| Judges ask about average vs marginal emissions | State it as a limitation and name marginal emissions as next step |
| Leaderboard gaming | Opt-in; efficiency % rather than absolute savings; cohorts |
| Demo failure | Recorded run and backup video |

---

## 16. Open decisions

1. Default quality threshold (section 4.5).
2. Baseline definition: first 7 days or first 50 responses (section 5.4).
3. Leaderboard cohort definition (section 4.6).
4. TypeScript or Python for the core (section 7).
5. Product name.
6. Which chat site, if the extension (S1) is built.
7. Confirm that the scheduler is roadmap only.

---

## 17. Verification checklist (before the pitch)

- [ ] Real EIA API call made, endpoint and fields recorded
- [ ] Emissions factor source chosen, lifecycle or direct stated
- [ ] Energy-per-token range sourced for each model shown
- [ ] Water intensity range sourced
- [ ] Virginia figure sourced and dated
- [ ] Each competitor's current features checked
- [ ] Impact calculation written with labeled inputs
- [ ] Every figure on screen shows a range and a source
- [ ] Demo data labeled everywhere it appears
- [ ] Backup video recorded
- [ ] Both team members have rehearsed every section

---

## 18. Instructions for AI assistants

If you are helping build this project:

1. **Read this entire file first.** Then ask which feature the user owns (A or B), and build only that owner's items.
2. **Do not invent numbers.** Every energy, water, CO₂, or price value must come from `config/sources.json`. If a value is missing, leave a placeholder and say so.
3. **Do not invent API details.** Verify the EIA endpoint and field names with a real call, or mark them unverified.
4. **Respect the scope tiers** in section 3. Don't build roadmap items or stretch items before the demo core passes its acceptance tests (section 9).
5. **Keep text local.** Never send prompt or response text to any server, logs, or shared data.
6. **Gate every suggestion.** Input limits and model switches must pass the quality gate before they are shown as safe.
7. **Keep the user in control.** Input limits and model switches are suggestions that require approval. Never switch models automatically.
8. **Label demo data** everywhere it appears.
9. **Write unit tests with fixtures** for every detector and for the gate.
10. **Flag uncertainty.** If you aren't sure about a number, API detail, or competitor feature, say so instead of guessing.
