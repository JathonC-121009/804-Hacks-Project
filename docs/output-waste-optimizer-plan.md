# Output-Waste Optimizer: Build Instructions and Plan (merged, v3)

> **Status:** Merged from the team brief (v2) and the build plan (v1). Anything marked **[VERIFY]** is not yet sourced or tested and must be checked before it appears on screen or in the pitch. Anything marked **[DECIDE]** needs a team decision. Section 3 lists every place the two sources disagreed and how this version resolved it.
>
> **How to use this file:** Humans read sections 1–4 and 13–15 first. An AI assistant should read the whole file and follow section 21 before writing code.

---

## 1. Summary

Most AI footprint tools show one number. This project shows **what resources a person's AI use is wasting** (energy, water, CO₂, cost), and gives three concrete fixes:

1. **Standing instruction block.** One short block the user pastes once into their AI settings. It prevents the most common waste in every future chat.
2. **Shorter prompt.** For a specific prompt, a rewrite that trims redundant input and adds output-limiting directions. The user reviews and approves it.
3. **Model suggestion.** A lighter model when the task likely doesn't need a bigger one. Suggestion only; the tool never switches models.

It also tracks each user's **output efficiency %** over time, with an opt-in leaderboard and a shareable weekly card (seeded demo data for the hackathon).

**Track:** Track 2, Build a Sustainable Future (optimize resource consumption).
**Prompt link:** Virginia has more data centers than anywhere, and AI inference is a growing share of their load. Waste in AI use costs energy, water, and carbon at the data centers that serve Virginia.

**Pitch lines:**
- "Every token has a footprint. We cut the ones that don't earn it."
- "Don't just measure your AI's footprint. Shrink it."

---

## 2. Context and rules

- **Event:** 804 Hacks, one day, 8 hours of build time.
- **Team:** two people. Both speak in the pitch and both answer questions. Both understand the whole project.
- **Constraints:** software only. Claude Pro and GPT Pro are available, so code generation is not the bottleneck. Integration, data quality, demo reliability, and the pitch are.
- **Pitch:** 5 minutes max, then 2 minutes of judge questions. No slideshow.
- **Rubric (100 pts):** Functionality 35 · Problem/Solution 20 · Team and Presentation 20 · Target Market and UVP 10 · Questions 10 · Marketing 5. There is no separate creativity line; uniqueness is judged under UVP.

**Rules for this build**
1. Demo core first. Nothing outside the demo core is built until the demo core passes its acceptance tests.
2. Never invent a number. Every energy, water, CO₂, or price figure comes from `config/sources.json` with a source and a range.
3. Estimates are ranges, labeled as estimates, with assumptions visible on screen.
4. All text analysis runs locally. Only opt-in aggregate scores ever leave the device.
5. Seeded or demo data is labeled "demo data" everywhere it appears.
6. The user is always in control. Nothing changes the user's prompt, settings, or model without their approval.

---

## 3. Decision log and conflict resolutions

### 3.1 Decisions carried over

| # | Decision | Status | Source |
|---|---|---|---|
| 1 | Software only, 8 hours, two people | USER DECIDED | v2 |
| 2 | Track 2 (Build a Sustainable Future) | USER DECIDED | v2 |
| 3 | One engine, multiple surfaces | USER DECIDED | v2 |
| 4 | Focus on optimizing model **output** | USER DECIDED | v2 |
| 5 | Paste-in analyzer is the fallback and the demo surface | USER DECIDED | v2 |
| 6 | "Get it" page with a "How do you use AI?" picker | USER DECIDED | v2 |
| 7 | Leaderboard ranks by **efficiency %**, not absolute savings | USER DECIDED | v2 |
| 8 | Target market: AI-heavy companies and heavy individual users on paid plans | USER DECIDED | v2 |
| 9 | Marketing: product-led cards and leaderboard, plus marketplaces, GitHub, Product Hunt | USER DECIDED | v2 |
| 10 | Region chooser dropped | USER DECIDED | v2 |
| 11 | Scheduler is roadmap; built only if time remains | USER DECIDED | v2 and later instruction |
| 12 | Per-prompt rewrite is a real feature | USER DECIDED | v2 |
| 13 | Model recommendation is suggestion-only; no automatic rerouting | USER DECIDED | v2 |
| 14 | Waste score counts only flagged tokens, not raw length | SUGGESTION | v2 |
| 15 | All text analysis runs locally | SUGGESTION | v2 |
| 16 | Input limits and model switches go through a quality gate before they're shown as safe | USER DECIDED | v1, confirmed in the review of the earlier plan |
| 17 | Efficiency % does not depend on energy weights | SUGGESTION | v2 |

### 3.2 Conflicts and how this version resolves them

| Topic | v1 (plan) said | v2 (brief) said | Resolution in this version | Needs a team decision? |
|---|---|---|---|---|
| Input optimization | Deterministic input limits per task, approved by user, gated | Rule-based rewrite that trims input and adds output directions, user approves a diff | Both. The rewrite is the user-facing feature. It applies input trimming rules and output directions. For recurring tasks it also gets the quality gate | No |
| Quality gate scope | Required for input limits, output limits, and rerouting | Not mentioned except as a risk | Required for any change that is presented as "safe" on a recurring task. Optional for one-off prompt rewrites, which are shown with a clear "not checked" label | Yes: confirm |
| Model suggestion | Approval-based rerouting, gated by a pass rate on examples | Heuristic suggestion, labeled "likely sufficient," never automatic | Heuristic suggestion as the default. If the user has saved examples for the task, the gate runs and the suggestion shows the pass rate. Never automatic | No |
| Leaderboard | Seeded demo data (Tier 1) | Tier 3 (mock or only if time remains) | Tier 3, shown as seeded, labeled demo data, if built at all. Still a main function in the pitch | Yes: confirm |
| Browser extension | Stretch (S1), cut first | Tier 1, item 3 | **Tier 2.** Paste-in is the demo core. The extension is the first thing cut. Extension conflicts with the two-person capacity noted in review | **Yes: must decide** |
| Pre-send nudge | Not in v1 | Tier 2, item 9 | Tier 2, built only after the extension works on one site | No |
| Scheduler | Roadmap | Tier 3 | Roadmap, per decision 11 | No |
| Grid data | Demo core D8 | Tier 1, item 6 | Demo core, cached with labeled fallback | No |
| Token weighting | Not specified | Full design | Adopted from v2 (section 6) | No |
| Custom-instruction block | Called "fix block" | Called "custom-instruction block" | Adopted from v2 wording | No |

---

## 4. Scope tiers

### Demo core (must work live, paste-in analyzer)

| # | Feature | Owner |
|---|---|---|
| D1 | Output-waste detection (section 5.2) | A |
| D2 | Efficiency % and the standing instruction block (section 5.3) | A |
| D3 | Resource feedback: energy, water, CO₂, cost, with ranges and sources (section 5.1) | A |
| D4 | Per-prompt rewrite with diff and token difference (section 5.4) | A |
| D5 | Model suggestion with confidence and footprint range (section 5.5) | A |
| D6 | Quality gate for recurring tasks (section 7) | A |
| D7 | Paste-in analyzer UI that shows D1–D6 | A (UI) |
| D8 | Grid intensity feed: cached PJM data with labeled fallback (section 9.2) | B |
| D9 | Weekly efficiency card, from stored events (section 5.7) | B |

### Tier 2 (after D1–D9 pass their acceptance tests)
- **T2-a:** Browser extension on one chat site, with a receipt and waste flags under each response. Owner B. First item cut if behind.
- **T2-b:** Pre-send nudge in the extension: reads the draft, shows the rewrite and model suggestion before sending. Owner B. Requires T2-a.
- **T2-c:** CLI log reader for one coding tool, for exact token counts. Owner B.
- **T2-d:** Dashboard with history and week-over-week efficiency. Owner A.
- **T2-e:** Live quality gate on the user's own examples, instead of the seeded run. Owner A.

### Tier 3 (mock, labeled, or only if time remains)
- **T3-a:** Leaderboard, seeded with labeled demo data, ranked by efficiency %. Owner B.
- **T3-b:** Link and citation check for verification risk.
- **T3-c:** Scheduler for deferrable batch jobs.
- **T3-d:** Second chat site, SDK wrapper, VS Code, JetBrains, Chrome Web Store listing.

### Roadmap (say it, don't build it)
Scheduler, team dashboard, enterprise reporting export, automatic model rerouting (out of scope permanently, by decision 13), SDK or proxy, user accounts, region chooser (dropped).

**Cut order if behind schedule:** T2-b, T2-a, T2-c, T2-d, T3-a (keep the seeded version on screen if it's already built), then T2-e (use the seeded run). Never cut D1–D9.

---

## 5. Main functions

### 5.1 Resource feedback (the headline)
Shows what the user is wasting, in the resources they care about:
- **Energy (Wh)** from wasted output tokens.
- **Water (mL)** from the energy, using a water-intensity range.
- **CO₂ (g)** from the energy and the grid's carbon intensity.
- **Cost** from the user's price per token, entered once in settings.

Each figure is a **range** (low to high), with a tooltip linking to its source key in `config/sources.json`. No single number appears without its range.

### 5.2 Output-waste detection
Five detectors. Each returns the flagged spans and tokens. Only the first three count toward the efficiency score.

| Detector | Counts toward score | Method (first version) |
|---|---|---|
| Prompt echo | Yes | Overlap between the start of the response and the prompt (n-gram overlap above a threshold) |
| Filler openers and closers | Yes | Match a list ("Great question," "I hope this helps," "Let me know if…") |
| Repetition | Yes | Repeated sentences, or repeated 6-word spans within the response |
| Redundant recap | No (advisory) | "In summary," "To recap" followed by content already present |
| Boilerplate caveat | No (advisory) | Standard disclaimers, shown but not scored |

Advisory-only signals, shown but not scored: a response far longer than a simple prompt warrants, and prompt-side hints (very long prompt, repeated instructions, simple task on a large model).

**Count only high-confidence flags.** Fuzzy flags are shown as advisory, and fixtures test precision.

### 5.3 Efficiency % and the standing instruction block
**Efficiency % = 1 − (wasted output tokens ÷ total output tokens)**

This does not depend on any energy weight, so rankings stay fair even if the energy constants change.

**Standing instruction block.** Each waste type has one matching line. The tool combines the lines for the user's most common waste into a short block they paste **once** into their AI's standing-instructions setting. It applies to every future chat.

Example:
> Answer directly without restating my question. Skip greetings and closing offers. No summary at the end unless I ask. Keep answers as short as the question allows.

Keep the block short, because it adds input tokens to every message. Recommend brevity mainly for simple, repeated tasks, since brevity can reduce quality on complex ones. Check where ChatGPT and Claude currently store standing instructions [VERIFY], since the names change.

### 5.4 Per-prompt rewrite
For one specific prompt, the tool shows a shorter version the user can paste instead, with a diff and the token difference.

**Rule-based and local** for the hackathon. An LLM-assisted rewrite would spend energy and send text off-device; if added later, disclose it.

The rewrite does two things:
- **Trims redundant input:** repeated instructions, filler politeness, and pasted context flagged for the user to confirm.
- **Adds output-limiting directions** that suit the task type, such as a length cap, "answer directly," or "no recap."

**Be honest about where the saving comes from.** Under the output-centered model, trimming input saves little energy. Most of the saving is in the output directions. Input trimming also saves cost and usage-limit headroom. The user must review and approve the rewrite, because trimming can change meaning.

**Gate:** if the user has saved examples for this task, the rewrite runs through the quality gate (section 7). Otherwise it's shown with the label "not checked against examples."

### 5.5 Model suggestion (suggestion only)
A local heuristic classifies the prompt (task type, length, presence of code or math, requested depth) into a model tier. The tool shows:
- the recommended tier,
- a confidence level,
- the estimated footprint difference, as a range,
- the label **"likely sufficient"** and an override control.

Model names and tiers live in `config/models.json`, since model lineups change.

**Never automatic.** The tool never switches or reroutes the user's model.

If the user has saved examples for this task, the quality gate runs on the candidate tier and the suggestion shows the pass rate.

**Caveats to state:** the heuristic can be wrong, and wrongly downsizing can cause retries that cost more energy. Check what ChatGPT's and Claude's own model pickers do today [VERIFY], so claims about auto-selection are accurate. RouteLLM is an open-source router and a useful reference [VERIFY license before citing].

### 5.6 Savings estimate and baseline
Savings = wasted output tokens avoided × energy per output token × grid intensity, measured **against the user's own baseline**: first 7 days, or first 50 responses **[DECIDE]**. Show the baseline and the period on screen.

### 5.7 Weekly card and leaderboard
- **Weekly card (D9):** efficiency %, change vs last week, wasted tokens, top waste type, and resources represented (Wh, mL, g CO₂, cost), each as a range. Shareable image.
- **Leaderboard (T3-a):** ranked by efficiency %, opt-in only, aggregate scores only. Seeded with labeled demo data. Cohort definition **[DECIDE]**.

---

## 6. Token counting and weighting

### 6.1 Counting tokens

| Surface | Method | Accuracy |
|---|---|---|
| Paste-in, numbers mode | User enters token counts | Exact |
| Paste-in, text mode | Estimate from the text | Approximate; show as a range |
| CLI tools (T2-c) | Usage fields in local session logs | Exact |
| API / SDK (roadmap) | Provider usage fields in each response | Exact |
| Web chat (extension, T2-a) | Estimate from the page text | Approximate |

For the text estimate, start with a ratio heuristic (roughly 1.3 tokens per word, or characters ÷ 4), then calibrate against a real tokenizer library on the ~20 fixtures. Check which local tokenizers exist for each provider [VERIFY]. **Do not use a network token-counting call**, since that breaks the local-only rule.

### 6.2 Weighting (output-centered)
All weights live in `config/sources.json` or `config/models.json`, each with a cited source.

```
energy_Wh = (output_tokens + reasoning_tokens) × e_out(model_class)
          + optional small terms for input and cache writes (default 0)
cache reads ≈ 0
CO2_g     = energy_Wh / 1000 × grid_intensity_gCO2_per_kWh
water_mL  = energy_Wh / 1000 × water_per_kWh_range
```

- `e_out(model_class)`: build on the EcoLogits methodology [VERIFY], which estimates GPU energy from the model's active parameters and the number of generated tokens, plus a data center overhead factor. For closed models, use size classes (small, medium, large) with ranges, since parameter counts are estimated.
- **Input weight defaults to 0.** Add a labeled sensitivity scenario with a small nonzero input weight once a source is found.
- **Reasoning tokens count as output.** On web chat they are hidden, so output is undercounted. Say so on screen.
- **Cache reads** are most of the tokens in coding-agent sessions but use little energy, so they are weighted near zero.

---

## 7. Quality gate

**Purpose:** prevents a suggestion from presenting a worse answer as a safe saving.

**When it runs:** on any recurring task where a shorter prompt, an input limit, or a smaller model is shown as safe. It runs **once per task**, not per request, so checking doesn't waste the energy it saves. Its verdict is stored and reused.

**Inputs:** a task definition, 10–20 saved examples with known correct answers, and the candidate change.

**Matching rules by task type:**
- **Classification or extraction:** the label or value must match exactly.
- **Summarization:** each required key fact, from a list the team writes per example, must appear.
- **Length limit:** the final required field must still appear, so the answer isn't cut off.

**Default threshold:** pass rate ≥ 95% **[DECIDE]**, configurable per team.

**Output:** pass or fail, pass rate, and the failed examples with a reason for each.

**Verdict record:** `{task_id, change_type, change_value, model, example_set_hash, pass_rate, checked_at, expires_at}`.

**Expiry:** 30 days, or when the task definition or example set changes.

**Cost of the check:** record its tokens and estimated energy, and subtract them from reported savings (net-of-check).

**Unchecked changes** (one-off rewrites with no examples) are labeled "not checked against examples" everywhere they appear.

---

## 8. Calculations

### 8.1 Resource conversion
Let `W` = wasted output tokens, `e_out` = energy per output token (low and high, from sources), `I` = grid carbon intensity (gCO₂/kWh) for the hour from D8, `WI` = water intensity (mL/kWh, low and high), and `P_out` = the user's price per output token from settings.

- Wasted energy (Wh) = `W × e_out`
- Wasted water (mL) = (wasted energy in kWh) × 1000 × `WI` — convert Wh to kWh first
- Wasted CO₂ (g) = (wasted energy in kWh) × `I`
- Wasted cost = `W × P_out`

Add the input term only when an input rule is applied and its weight is nonzero.

### 8.2 Efficiency
`efficiency = 1 − W / T_out`, where `W` counts only high-confidence flags and `T_out` is total output tokens.

### 8.3 Net savings for a team report
`net = gross savings − energy used by quality checks`. Show both lines separately.

### 8.4 Impact example (for the pitch)
Use this structure, with labeled inputs. **Every input is sourced or marked as an assumption.**

> Users × wasted output tokens per user per month × energy per output token × grid intensity = estimated CO₂ avoided per month.

Inputs are placeholders until verified:
- Users: [assumption]
- Wasted output tokens per user per month: [from fixtures or a pilot]
- Energy per output token: [range, source]
- Grid intensity for PJM: [range, source, date]

Present the result as a range, with assumptions on screen.

---

## 9. Data

### 9.1 Storage
Local only: JSON files or SQLite in `data/`. No server. Collections: `events`, `tasks`, `examples`, `verdicts`, `approvals`, `settings`.

### 9.2 Grid data (D8)
- Source: EIA hourly electricity data API, PJM balancing authority, generation by fuel type. **[VERIFY]** the endpoint, parameters, field names, and rate limit with a real test call in hour 0–1.
- Convert the fuel mix to carbon intensity: sum(generation by fuel × emissions factor by fuel) ÷ total generation. **[VERIFY]** the emissions factor source and whether it's lifecycle or direct.
- Average intensity, not marginal. State marginal emissions as a limitation.
- Cache the last 30 days in `data/grid_pjm.json`.
- **Fallback:** if the feed is unavailable, use a constant from `config/sources.json`, labeled "fallback value, not live."

### 9.3 Seeded demo data
- `data/demo_events.json`: 200 sample events with realistic waste patterns.
- `data/demo_tasks.json`: 2 recurring tasks with 10 examples each, for the quality gate.
- `data/demo_leaderboard.json`: 20 fake users, labeled "demo data" (T3-a).

### 9.4 Event schema
```json
{
  "id": "evt_001",
  "timestamp": "2026-10-18T14:03:00Z",
  "surface": "paste | web | cli",
  "tool": "chatgpt | claude | claude-code | codex | other",
  "model": "string",
  "tokens": { "input": 0, "cache_write": 0, "cache_read": 0, "output": 0, "reasoning": 0 },
  "token_source": "user_entered | estimated | exact",
  "flags": [{ "type": "echo | filler | repetition | recap | boilerplate", "tokens": 0, "confidence": "high | advisory" }],
  "region": "PJM"
}
```
Text fields (`prompt`, `response`) are stored **only locally**, and never included in shared data.

---

## 10. Architecture and file layout

Monorepo, TypeScript [DECIDE: TypeScript or Python for the core; the plan works either way].

```
804-Hacks-Project/
  docs/
    output-waste-optimizer-plan.md   (this file)
  packages/
    core/                 engine
      src/
        estimate.ts       section 8.1
        detect.ts         section 5.2
        instructions.ts   section 5.3 (efficiency and the instruction block)
        rewrite.ts        section 5.4
        suggestModel.ts   section 5.5
        gate.ts           section 7
        grid.ts           section 9.2
        tokens.ts         section 6
      test/               unit tests with fixtures
  apps/
    portal/               paste-in analyzer, Get-it page, weekly card
  extension/              Manifest V3 (T2-a, only if built)
  config/
    sources.json          every number with its source
    models.json           model tiers and per-tier energy ranges
  data/
    demo_*.json           seeded data (labeled)
    grid_pjm.json         cached grid data
  scripts/
    fetch_grid.ts         EIA fetch and cache
```

---

## 11. Interfaces

```ts
estimate(event: UsageEvent, config: Config): { energyWh: Range; waterMl: Range; co2g: Range; cost: Range }
analyze(response: string, prompt?: string): { flags: Flag[]; wastedOutputTokens: number; efficiency: number }
buildInstructionBlock(flags: Flag[], history: Flag[]): { lines: string[]; block: string }
rewritePrompt(prompt: string, taskType: string): { rewritten: string; diff: string; tokenDelta: number }
suggestModel(prompt: string, config: ModelConfig): { tier: string; confidence: "low" | "medium" | "high"; footprintDelta: Range }
runGate(task: Task, change: Change, examples: Example[], threshold: number): Verdict
weeklyCard(events: UsageEvent[]): CardData
fetchGridPJM(): Promise<GridHour[]>   // with cache and labeled fallback
```

`Range` is `{ low: number; high: number; unit: string }`.

---

## 12. Acceptance criteria

Each must pass before moving on.

| Feature | Test |
|---|---|
| D1 detection | On 20 fixture responses with known waste, precision ≥ 0.9 for high-confidence flags; every flag has a span |
| D2 efficiency and block | Efficiency is between 0 and 1 and matches section 8.2 on fixtures; the block is under 60 words |
| D3 resource feedback | Every figure has a range, a unit, and a source key; no single numbers on screen |
| D4 rewrite | Removes repeated instructions and filler on fixtures, keeps the task intact, shows a diff; nothing applied without approval |
| D5 model suggestion | Shows tier, confidence, and footprint range; never changes the model; override works |
| D6 gate | On a seeded failing change, returns fail and lists the failed examples; on a passing change, returns the pass rate |
| D7 paste-in | Paste a 500-word prompt and response; all results in under 3 seconds, locally |
| D8 grid | App works from the cache alone and shows the fallback label when the feed is down |
| D9 card | Card shows efficiency, change, and resources as ranges; seeded data is labeled |

---

## 13. Work plan (two people, 8 hours)

**Owners:** A = core engine, paste-in UI, rewrite, model suggestion, gate. B = grid data, card, demo data, and Tier 2 extension work.

| Time | Person A | Person B |
|---|---|---|
| 0:00–0:45 | Together: agree the schema and signatures in section 11; scaffold the repo; write 20 fixtures with expected flags | Test one real EIA call; record the exact endpoint, fields, and limits; start `config/sources.json` |
| 0:45–3:00 | Build `estimate`, `analyze`, `buildInstructionBlock` (D1–D3); token-counting heuristic calibrated on fixtures | Build `fetchGridPJM` with cache and fallback (D8); build demo data (9.3) |
| 3:00–4:30 | Build paste-in UI (D7) and `rewritePrompt` (D4) | Build the weekly card (D9); start T2-a only if D8 and D9 pass |
| 4:30–6:00 | Build `suggestModel` (D5) and `runGate` (D6); integrate paste-in with D1–D6 | Integrate grid data into estimates; check every figure shows a range and source |
| 6:00–7:00 | Write the impact calculation (8.4) and the sources table | Write the competitor table, verify each tool's current features, draft the marketing plan |
| 7:00–8:00 | Rehearse three times; record a backup demo; no new features | Rehearse three times; test on a second machine |

**Stop rule:** at 5:00, if D1–D9 do not all pass their acceptance tests, drop Tier 2 and fix the core.

---

## 14. Demo script (about 3 minutes live, 2 minutes Q&A)

**Speaker A (problem and first half of the demo):**
1. Virginia and data centers in one sentence, with a sourced figure.
2. Paste a wasteful prompt and response into the analyzer. Show the flags and the efficiency %.
3. Show the resource feedback: energy, water, CO₂, and cost, with ranges and the source tooltip.
4. Show the three fixes: the standing instruction block, the shorter prompt with its diff and token difference, and the model suggestion with its confidence. For the prompt, show the quality gate result if the task has examples.

**Speaker B (second half and close):**
5. Approve the rewrite and show the saving counted. Show the model suggestion with an override, and show that nothing changed without approval.
6. Show the weekly card, labeled demo data if the leaderboard is shown.
7. Show the Get-it page picker, with "coming soon" labels on unbuilt options.
8. Close with the impact range and its assumptions.

**Fallbacks:**
- Grid feed down → cached data with the fallback label.
- Analyzer slow → the recorded run.
- Anything fails live → switch to the backup video, and say so.

---

## 15. Pitch, market, and rubric mapping

| Rubric | What we show | Where |
|---|---|---|
| Functionality (35) | Paste-in analyzer, resource feedback, instruction block, rewrite, model suggestion, gate, card | Demo steps 2–7 |
| Problem/Solution (20) | Virginia data centers, sourced figure, invisible waste, three fixes | Speaker A opening, impact range |
| Team and Presentation (20) | Both speak; clean handoffs | Demo script |
| Target Market and UVP (10) | Companies with heavy AI use; heavy individual users on paid plans. UVP below | Speaker A |
| Questions (10) | Both know every section | Rehearsal |
| Marketing (5) | Plan below | Speaker B |

**UVP:** "Other tools show a number. We show what you're wasting, in energy, water, CO₂, and money, and give you three fixes: a standing instruction block, a shorter prompt, and a lighter-model suggestion. Changes are approved by you, and suggestions for recurring tasks are checked before they're shown as safe."

**Target market:**
- Companies with heavy AI use: token waste is cost and carbon waste.
- Heavy individual users on paid plans: "waste less, get more from your limit."

**Marketing plan (beyond social media and flyers):**
- Shareable weekly cards with efficiency % and resources saved, opt-in.
- Opt-in leaderboard, ranked by efficiency %, after the hackathon.
- Product Hunt launch and GitHub release (after the event).
- Developer communities that discuss AI cost and green software.
- B2B pilots: one engineering or FinOps team, one sustainability or ESG team, and a campus sustainability office.
- Roadmap: browser extension and VS Code and JetBrains plugins for distribution.
- Business model (roadmap): free analyzer and extension as the funnel; paid team dashboard and reporting export.

**Enterprise reporting:** an emerging need, but regulatory claims vary. Verify the current rules before citing them. At least one vendor already sells enterprise AI-emissions reporting, so the field is not empty.

**Leaderboard cautions:** opt-in; aggregate scores only; efficiency % can differ by task type, so compare within cohorts.

**Likely judge questions to prepare:**
- How is this different from Footprint AI or EcoLogits?
- How accurate are the estimates?
- Why average and not marginal emissions?
- Does shortening output hurt quality?
- What about privacy?
- How would you make money?
- How do you stop people gaming the leaderboard?
- Why suggest a model instead of switching it for the user?
- How do you know the lighter model is good enough?

---

## 16. Competition and novelty

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
- LLM routers (RouteLLM, OpenRouter, and cloud-provider routers): route each request to a cheaper or stronger model, for developers.
- Carbon Aware SDK and cloud region pickers: infrastructure, not AI usage.

**Gap we claim:** none of these combines waste detection in the output, resource feedback with ranges, a per-prompt rewrite and a model suggestion that are both approval-based, a quality gate on recurring tasks, and a team-facing report. **Say "in our research we found none that combine…" and mean it.** Re-check before the pitch.

**Honest framing:** each technique is established. Routing is a known technique, and the angle is the pre-send, footprint-framed suggestion for chat users, combined with waste feedback. The contribution is the combined workflow and the approval-based design.

---

## 17. Sources table (fill before the pitch)

| Key | Value | Range | Source | Date | Used for |
|---|---|---|---|---|---|
| `e_out` | Energy per output token | [VERIFY] | [VERIFY] | | 8.1 |
| `e_out_class` | Energy by model size class | [VERIFY] | EcoLogits methodology [VERIFY] | | 6.2 |
| `WI` | Water intensity | [VERIFY] | [VERIFY] | | 8.1 |
| `EF` | Emissions factor by fuel | [VERIFY] | [VERIFY] | | 9.2 |
| `grid_PJM` | Live PJM intensity | Feed | EIA API [VERIFY] | | 9.2 |
| `va_dc` | Virginia data center electricity or water | [VERIFY] | [VERIFY] | | Opening |
| `ACL2025` | Brevity and energy result | Per the paper's findings [VERIFY] | Poddar et al., ACL Findings 2025 [VERIFY] | | Pitch evidence |
| `YapScore` | Verbosity benchmark | [VERIFY] | [VERIFY] | | Pitch evidence |
| `RouteLLM` | Open-source router license | [VERIFY] | [VERIFY] | | 5.5 |

---

## 18. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Two-person capacity | Hold to the demo core (D1–D9). Tier 2 only after the core passes |
| Extension breaks or conflicts with a site's terms | Extension is Tier 2 and first to be cut; paste-in is the fallback |
| Invented numbers | Every value in `config/sources.json`; no number without a source |
| Brevity hurts quality | Recommend mainly for simple tasks; the gate covers recurring tasks |
| Prompt rewrite changes meaning | Show a diff; require approval; label unchecked rewrites |
| Model suggestion is wrong | Confidence shown; "likely sufficient" label; override; never automatic |
| Downsizing causes retries that cost more | State it on screen; show the gate pass rate when examples exist |
| False-positive waste flags | Count only high-confidence flags; test precision on fixtures |
| Grid feed unavailable | Cached data and labeled fallback |
| Average vs marginal emissions questioned | State as a limitation; name marginal emissions as next step |
| Leaderboard gaming | Opt-in; efficiency % rather than absolute savings; cohorts; tier 3 |
| Demo failure | Recorded run and backup video |

---

## 19. Open decisions

1. **Extension: Tier 2 or Tier 1?** Decide now. This plan assumes Tier 2.
2. Confirm the quality gate scope: required for recurring tasks, optional for one-off rewrites.
3. Confirm the leaderboard is Tier 3 (seeded), not a live demo feature.
4. Default quality threshold (section 7).
5. Baseline: first 7 days or first 50 responses (section 8.3).
6. Leaderboard cohort definition.
7. TypeScript or Python for the core.
8. Product name.
9. Which chat site, if the extension is built.
10. Which CLI tool, if the log reader is built.

---

## 20. Verification checklist (before the pitch)

- [ ] Real EIA API call made; endpoint and fields recorded
- [ ] Emissions factor source chosen; lifecycle or direct stated
- [ ] Energy-per-token range sourced for each model class shown
- [ ] Water intensity range sourced
- [ ] Virginia figure sourced and dated
- [ ] Each competitor's current features checked
- [ ] Standing-instruction locations in ChatGPT and Claude checked
- [ ] Model-picker behavior in ChatGPT and Claude checked
- [ ] RouteLLM license checked before citing
- [ ] Impact calculation written with labeled inputs
- [ ] Every figure on screen shows a range and a source
- [ ] Demo data labeled everywhere it appears
- [ ] Backup video recorded
- [ ] Both team members have rehearsed every section

---

## 21. Instructions for AI assistants

If you are helping build this project:

1. **Read this entire file first.** Then ask which feature the user owns (A or B), and build only that owner's items.
2. **Do not invent numbers.** Every energy, water, CO₂, or price value comes from `config/sources.json`. If a value is missing, leave a placeholder and say so.
3. **Do not invent API details.** Verify the EIA endpoint and field names with a real call, or mark them unverified.
4. **Respect the tiers** in section 4. Don't build roadmap items or Tier 2 items before the demo core passes section 12.
5. **Keep text local.** Never send prompt or response text to any server, logs, or shared data. Do not use network token-counting calls.
6. **Never change the user's prompt, settings, or model without approval.** Rewrites and model suggestions are shown as diffs or recommendations.
7. **Gate recurring suggestions.** Anything presented as safe on a recurring task must pass the quality gate first.
8. **Label demo data** everywhere it appears.
9. **Write unit tests with fixtures** for every detector, the rewrite, the suggestion, and the gate.
10. **Flag uncertainty.** If you aren't sure about a number, API detail, or competitor feature, say so instead of guessing.
