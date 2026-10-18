import type { Config, FlagType } from "../src/types.ts";

/**
 * Twenty prompt/response fixtures with the waste labelled by hand.
 *
 * These exist to hold the detectors to the plan's D1 criterion: precision >= 0.9
 * on high-confidence flags. Roughly a third are deliberately clean, because a
 * precision test with no clean cases cannot fail in the way that matters - a
 * detector that flags good writing as waste is worse than one that misses waste.
 *
 * Keep `expectHigh` honest. If a detector fires something not listed here it
 * counts as a false positive, so widening a label to make the test pass is
 * cheating the only safety net these detectors have.
 */

export interface Fixture {
  id: string;
  prompt: string;
  response: string;
  /** High-confidence (scored) flag types this response should produce. */
  expectHigh: FlagType[];
  /** Advisory types we expect. Not asserted, recorded for the report. */
  expectAdvisory?: FlagType[];
  note: string;
}

export const FIXTURES: Fixture[] = [
  // --- clean: must produce no scored flags ---------------------------------
  {
    id: "clean-direct",
    prompt: "How do evaporative cooling towers use water in a data center?",
    response:
      "Warm water from the server loop is sprayed over a fill material while outside air passes through it. Part of that water evaporates and carries the heat away. The rest returns to the loop, and because evaporation leaves minerals behind, operators periodically flush some of it out as blowdown.",
    expectHigh: [],
    note: "Direct, no pleasantries, no restating. The baseline for precision.",
  },
  {
    id: "clean-list",
    prompt: "What are the main cooling options for a data center?",
    response:
      "Open evaporative systems are the most water-hungry but very energy efficient. Closed-loop systems recirculate the same fluid and consume almost no fresh water. Air cooling avoids water entirely at the cost of much higher electricity use. Direct liquid and immersion cooling put the coolant against the chips themselves.",
    expectHigh: [],
    note: "Parallel list items share a stem; must not read as repetition.",
  },
  {
    id: "clean-code",
    prompt: "Write a function that converts watt-hours to kilowatt-hours.",
    response:
      "```js\nfunction whToKwh(wh) {\n  return wh / 1000;\n}\n```\nIt divides by 1000, so 2500 Wh becomes 2.5 kWh.",
    expectHigh: [],
    note: "Code plus one line. Nothing to trim.",
  },
  {
    id: "clean-short",
    prompt: "What does PUE stand for?",
    response: "Power Usage Effectiveness.",
    expectHigh: [],
    note: "Four words. No detector should find anything.",
  },
  {
    id: "clean-long-complex",
    prompt:
      "Compare average and marginal emissions factors, explain which one a carbon-aware scheduler should use, and say what data each one needs.",
    response:
      "An average factor divides total emissions by total generation across a region and a period. A marginal factor describes the emissions of whichever generator responds to the next unit of demand. A scheduler that shifts load is changing demand, so marginal is the theoretically correct signal. In practice marginal data is harder to obtain: it needs dispatch modelling or a commercial provider, while hourly fuel mix is published freely. Teams therefore ship average first and treat the gap as a known limitation rather than pretending it does not exist.",
    expectHigh: [],
    note: "Long because the question is hard. Length alone is not waste.",
  },
  {
    id: "clean-real-caveat",
    prompt: "Can I cite a 28% energy reduction from prompt compression?",
    response:
      "Not from that number. It appears in a secondary summary rather than in the paper itself, so quoting it would attribute a figure the authors may not have published. Read the paper and use the range it reports.",
    expectHigh: [],
    note: "A caveat that carries information is not boilerplate.",
  },
  {
    id: "clean-question-back",
    prompt: "Should we use closed-loop cooling?",
    response:
      "That depends on your climate and your power source. Closed-loop almost eliminates water use but raises electricity draw, so in a region with a dirty grid it can increase emissions while saving water. Which of the two are you optimising for?",
    expectHigh: [],
    note: "A clarifying question inside the answer is content, not a closing offer.",
  },

  // --- filler ---------------------------------------------------------------
  {
    id: "filler-opener",
    prompt: "How much water does a large data center use per day?",
    response:
      "Great question! Published figures for large facilities range from a few hundred thousand to several million gallons a day, depending on the cooling design and the local climate.",
    expectHigh: ["filler"],
    note: "Classic praise opener.",
  },
  {
    id: "filler-closer",
    prompt: "Does shortening a prompt reduce emissions?",
    response:
      "Only slightly. Output generation dominates inference energy, so trimming the input mostly saves money rather than power. I hope this helps! Let me know if you have any other questions.",
    expectHigh: ["filler", "filler"],
    note: "Two closing pleasantries in the final sentences.",
  },
  {
    id: "filler-certainly",
    prompt: "List three ways to cut inference energy.",
    response:
      "Certainly! Route easy work to a smaller model, cap output length for well-defined tasks, and cache identical requests so repeats never reach a GPU.",
    expectHigh: ["filler"],
    note: "'Certainly!' plus content.",
  },

  // --- echo -----------------------------------------------------------------
  {
    id: "echo-verbatim",
    prompt: "What is the difference between average and marginal carbon intensity?",
    response:
      "The difference between average and marginal carbon intensity is worth being precise about. Average divides total emissions by total generation. Marginal describes the generator that responds to the next unit of demand.",
    expectHigh: ["echo"],
    note: "Opening sentence reuses the prompt's wording almost intact.",
  },
  {
    id: "echo-paraphrase",
    prompt: "Why did Virginia become a hub for data centers?",
    response:
      "You asked why Virginia became a hub. Dense fiber routes from the early internet, cheap and reliable power, and county tax incentives all compounded over two decades.",
    expectHigh: ["echo"],
    note: "Restating phrase with different wording, so overlap alone would miss it.",
  },
  {
    id: "echo-plus-filler",
    prompt: "How do I measure the energy used by one API call?",
    response:
      "Great question! To answer your question about measuring the energy used by one API call, you cannot measure it directly for a hosted model. You can only estimate it from token counts and a published energy-per-token figure.",
    expectHigh: ["filler", "echo"],
    note: "Both at once, on different sentences.",
  },

  // --- repetition -----------------------------------------------------------
  {
    id: "repetition-exact",
    prompt: "Why is caching useful for LLM apps?",
    response:
      "Caching stops identical requests from reaching the GPU a second time. It works best when many users ask the same thing. Caching stops identical requests from reaching the GPU a second time.",
    expectHigh: ["repetition"],
    note: "Word-for-word repeat of the opening sentence.",
  },
  {
    id: "repetition-reordered",
    prompt: "Explain why shorter answers save energy.",
    response:
      "Shorter answers use fewer output tokens, which means less energy. Generation happens one token at a time, so each token carries its own cost. Fewer output tokens means shorter answers use less energy.",
    expectHigh: ["repetition"],
    note: "Same words reordered. Word-set overlap catches it where exact match does not.",
  },
  {
    id: "repetition-plus-filler",
    prompt: "What is blowdown?",
    response:
      "Sure, blowdown is the concentrated water a cooling tower flushes out. Minerals build up as water evaporates, so some must be discharged. Blowdown is the concentrated water a cooling tower flushes out.",
    expectHigh: ["filler", "repetition"],
    note: "Opener plus a repeated definition.",
  },

  // --- advisory only: no scored flags expected -----------------------------
  {
    id: "advisory-boilerplate",
    prompt: "What is PJM's carbon intensity right now?",
    response:
      "As an AI language model, I don't have access to real-time grid data. You would need an hourly feed such as the EIA grid monitor to answer that for the current hour.",
    expectHigh: [],
    expectAdvisory: ["boilerplate"],
    note: "Boilerplate is advisory, so the score must not move.",
  },
  {
    id: "advisory-recap",
    prompt: "How can a software team cut its AI energy use?",
    response:
      "Start by routing simple work to a smaller model, since most requests do not need a frontier model. Cap output length on tasks with a well-defined answer shape. Cache repeated requests so identical questions never reach a GPU twice. Check quality once per task rather than per request, otherwise the checking costs more than the saving. In summary, route smaller, cap output, cache repeats, and check once.",
    expectHigh: [],
    expectAdvisory: ["recap"],
    note: "Closing recap in the final third. Advisory, never scored.",
  },
  {
    id: "advisory-overlength",
    prompt: "What is PUE?",
    response:
      "Power Usage Effectiveness is a ratio used throughout the data center industry to describe how much of a facility's electricity reaches computing equipment. It is defined as total facility energy divided by the energy delivered to IT equipment. A value of 1.0 would mean every watt entering the building reached a server, with nothing spent on cooling, lighting, or power conversion losses. Real facilities sit above that. Hyperscale operators report figures close to 1.1, while older enterprise rooms often sit near 2.0, meaning they spend as much energy on overhead as on computing. The metric has well-known limits. It says nothing about how useful the computation was, so a facility running idle servers can post an excellent ratio. It also ignores water entirely, which is why separate water metrics exist alongside it. Despite those gaps it remains the figure most operators publish.",
    expectHigh: [],
    expectAdvisory: ["overlength"],
    note: "Three-word question, long answer. Advisory, because we cannot tell what was needed.",
  },
  {
    id: "advisory-prompt-side",
    prompt:
      "Please could you summarize this article for me. I would like a summary of the article please. Thanks in advance!",
    response: "Here are the five main points of the article.",
    expectHigh: [],
    expectAdvisory: ["prompt_side"],
    note: "The waste is in the prompt. The politeness is caught; the paraphrased repeat is knowingly not, because word overlap cannot see that 'summarize' and 'a summary of' are the same ask.",
  },
];

/**
 * Config for tests. Deliberately NOT the real config/sources.json: tests must
 * not break when the team fills in a real figure, and a test that depends on an
 * unverified placeholder would quietly bless that placeholder.
 */
export function testConfig(): Config {
  const entry = (low: number, high: number, unit: string) => ({
    low,
    high,
    unit,
    source: "TEST FIXTURE - arbitrary values, never ship these",
    date: null,
    verified: true,
  });

  return {
    sources: {
      _meta: { purpose: "test fixture" },
      e_out_small: entry(0.0001, 0.001, "Wh/token"),
      e_out_medium: entry(0.0005, 0.005, "Wh/token"),
      e_out_large: entry(0.002, 0.02, "Wh/token"),
      e_in: entry(0, 0, "Wh/token"),
      e_cache_read: entry(0, 0, "Wh/token"),
      e_cache_write: entry(0, 0, "Wh/token"),
      WI: entry(100, 2000, "mL/kWh"),
      grid_fallback: entry(300, 500, "gCO2/kWh"),
      EF: {
        _basis: "test fixture",
        COL: entry(820, 1050, "gCO2/kWh"),
        NG: entry(400, 550, "gCO2/kWh"),
        NUC: entry(5, 20, "gCO2/kWh"),
        WND: entry(8, 20, "gCO2/kWh"),
        SUN: entry(30, 60, "gCO2/kWh"),
        WAT: entry(10, 30, "gCO2/kWh"),
        OIL: entry(650, 850, "gCO2/kWh"),
        OTH: entry(200, 700, "gCO2/kWh"),
      },
      va_dc: entry(1, 2, "unset"),
      ACL2025: entry(25, 60, "percent"),
    },
    models: {
      _meta: { purpose: "test fixture" },
      platforms: [
        {
          id: "claude",
          label: "Claude",
          tiers: {
            small: { model: "test-small", effort: "low", verified: true, effort_verified: false, note: "t" },
            medium: { model: "test-medium", effort: "medium", verified: true, effort_verified: false, note: "t" },
            large: { model: "test-large", effort: "high", verified: true, effort_verified: false, note: "t" },
          },
        },
      ],
      tiers: [
        {
          id: "small",
          label: "Small",
          energy_key: "e_out_small",
          description: "test",
          examples: [],
          verified: true,
        },
        {
          id: "medium",
          label: "Medium",
          energy_key: "e_out_medium",
          description: "test",
          examples: [],
          verified: true,
        },
        {
          id: "large",
          label: "Large",
          energy_key: "e_out_large",
          description: "test",
          examples: [],
          verified: true,
        },
      ],
      default_assumed_tier: "large",
      default_assumed_tier_note: "test",
    },
  };
}
