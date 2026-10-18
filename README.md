# Output-Waste Optimizer

**804 Hacks — Track 2, Build a Sustainable Future.**

Most AI footprint tools show you one number. This one shows **what your AI use is wasting** — energy, water, CO₂ and money — then gives you three fixes for it.

1. **A standing instruction block.** Paste once into your AI's custom-instructions setting. Applies to every future chat.
2. **A shorter prompt.** Rule-based and local, shown as a diff you approve.
3. **A model suggestion.** A lighter model when the task likely doesn't need a bigger one. Suggestion only — it never switches your model.

Any change that gets called *safe* first passes a **quality gate**: it runs against saved examples with known answers, once per task. Checking every request would burn more energy than the change saves, which is the trap this design exists to avoid.

Full scope, sources and open decisions: [`docs/output-waste-optimizer-plan.md`](docs/output-waste-optimizer-plan.md).

---

## Run it

The portal needs **Node 22.13+** and nothing else. No install or build step is required for the portal.

```bash
npm run dev
```

Then open <http://127.0.0.1:5173/>.

| Command | What it does |
|---|---|
| `npm run dev` | Serves the portal at :5173 |
| `npm run cli -- --help` | Runs the provider-neutral terminal optimizer |
| `npm test` | 103 tests, including the acceptance criteria from the plan |
| `npm run seed` | Regenerates the demo data in `data/` (run it the morning of the event so dates look current) |
| `npm run grid` | Fetches real PJM grid data — needs `EIA_API_KEY` |
| `npm run typecheck` | Full type check — needs `npm install` |
| `npm run build:ext` | Builds the browser extension into `extension/dist/` — needs `npm install` |

### Why there's no build step

The demo gets one chance to run, on conference wifi, possibly on a different machine. A build is a thing that can fail at 7:55am. Node 22 strips TypeScript types itself, so the tests run `.ts` directly and [`scripts/serve.ts`](scripts/serve.ts) strips types on the fly for the browser. The browser runs the same source the tests do, with no artefact in between.

---

## What's built

Demo core (D1–D9 in the plan) — all working, all tested:

| | Feature |
|---|---|
| D1 | Output-waste detection: 5 detectors, **100% precision and recall** on 20 labelled fixtures |
| D2 | Efficiency % and the standing instruction block (capped at 60 words) |
| D3 | Resource feedback: energy, water, CO₂, cost — every figure a range with a source badge |
| D4 | Per-prompt rewrite with a diff and token delta |
| D5 | Model suggestion with confidence and every signal shown |
| D6 | Quality gate, with its own cost measured and subtracted |
| D7 | Paste-in analyzer |
| D8 | Grid feed with cache and labelled fallback |
| D9 | Weekly efficiency card |

The browser extension is also built. It has dedicated support for ChatGPT, Claude, Gemini, Perplexity, Microsoft Copilot, Grok, Poe, DeepSeek, Mistral Le Chat, Meta AI, and You.com. For another browser-based AI tool, open its chat page and choose **Enable on this AI site** in the extension popup; access is requested only for that site.

The CLI's `run` command fixes the prompt **before** it reaches a terminal AI, automatically adds a concise output instruction, recommends a model tier, runs the AI, and analyzes the answer. It works with any tool that accepts its prompt as the final argument:

```bash
# Gemini CLI: the optimized prompt is appended after -p
npm run cli -- run --prompt "Please explain DNS please" -- gemini -p

# Claude, Codex, and Ollama use the same wrapper
npm run cli -- run --prompt "Summarize this repository" -- claude -p
npm run cli -- run --prompt "Find the failing test" -- codex exec
npm run cli -- run --prompt "Explain DNS" -- ollama run llama3

# For a CLI that needs the prompt in a specific position, use the placeholder
npm run cli -- run --prompt "Explain DNS" -- my-ai --message "{prompt}" --quiet

# Preview the automatic change without calling the AI
npm run cli -- run --prompt "Please explain DNS please" --dry-run -- gemini -p

# The original post-response analyzer remains available for saved output
npm run cli -- analyze --prompt-file prompt.txt --response-file response.txt

# Pass exact provider usage and return clean machine-readable output
node apps/cli/index.ts analyze -p "Summarize this" -r "Great question..." \
  --input-tokens 25 --output-tokens 80 --model-class medium --json
```

The AI provider still receives the optimized prompt, but PromptFootprint's rewrite, suggestion, and waste analysis all stay local. The original AI answer stays on stdout so it can still be piped or redirected; PromptFootprint's preflight and report go to stderr.

**Not built, by choice:** CLI log reader (Tier 2), leaderboard (Tier 3), and carbon-aware scheduler (roadmap). Automatic model rerouting is permanently out of scope — the user always decides.

---

## Before you show this to judges

**The numbers on screen are placeholders.** `config/sources.json` ships with unverified order-of-magnitude values so the pipeline runs end to end. The portal shows an amber banner listing every one, and badges each figure derived from them.

Fill in `config/sources.json`, set `verified: true`, and the banner clears itself. Until then, don't quote a figure from this app.

Still to verify (plan §20):

- [ ] Real EIA API call made; endpoint and field names recorded
- [ ] Emission factor source chosen; lifecycle or direct stated
- [ ] Energy-per-output-token range sourced per model class
- [ ] Water intensity range sourced
- [ ] One Virginia data center figure, sourced and dated
- [ ] Each competitor's current features checked
- [ ] Backup demo video recorded

---

## How it's laid out

```
packages/core/src/     The engine. Pure functions, no I/O, no network.
  detect.ts            5 waste detectors (plan §5.2)
  estimate.ts          tokens -> energy, water, CO2, cost (plan §8.1)
  config.ts            every number read through here, with provenance tracking
  instructions.ts      fix 1
  rewrite.ts           fix 2
  suggestModel.ts      fix 3
  gate.ts              the quality gate (plan §7)
  grid.ts              PJM carbon intensity
  card.ts              weekly card
packages/core/test/    103 tests; fixtures.ts holds the 20 labelled pairs
apps/portal/           the paste-in analyzer
config/                sources.json — every figure with its source
data/                  seeded demo data, all labelled as such
scripts/               serve, seed, fetch_grid
```

---

## Design rules this code follows

These are in the plan and enforced in the code, not just written down:

1. **Never invent a number.** Every figure comes from `config/sources.json`. A source with no value yet throws `UnsourcedValueError` rather than silently becoming zero.
2. **Estimates are ranges.** `formatRange()` is the only path to the screen and will not print a bare number.
3. **Nothing leaves the device.** No network calls from the portal except loading its own files. No network tokenizer.
4. **Automatic fixes are opt-in.** `analyze` and the browser UI only show changes. The CLI applies a rewrite only when the user explicitly invokes `run`; model changes remain suggestions because provider flags are not universal.
5. **Demo data says it's demo data.** Seeded grid rows use `source: "seeded"`, never `"eia"`. Gate runs from recorded outputs are tagged `runner_kind: "recorded"` and the UI prints it.
6. **Precision over recall.** Only high-confidence flags affect the score; fuzzy signals are advisory and never counted.

---

## Known limits

Say these before a judge asks:

- These are **estimates, not measurements**. You can't measure a hosted model's energy from outside it.
- **Average** grid intensity, not marginal. Marginal is the right signal for load shifting; average is what free hourly data supports.
- **Input energy counted as zero** — a deliberate output-centred assumption. So prompt trimming shows as a money saving, not an energy one.
- **Hidden reasoning tokens are invisible in web chat**, so output there is undercounted.
- **Brevity can cost quality.** That's what the gate is for, and it only covers tasks with a checkable answer.
- **A paraphrased repeat isn't detected.** "Summarise this" vs "I'd like a summary of this" needs sentence meaning — which means a model call, which means energy spent to save energy and your text leaving the device. Out of scope on purpose.
- **We never detect hallucinations.** Nothing here claims to.
