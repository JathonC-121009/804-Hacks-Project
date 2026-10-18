import type { Config, ModelClass, Range, SourceEntry, SourcesConfig } from "./types.ts";

/**
 * Config access with provenance tracking.
 *
 * Plan rule 2 is "never invent a number", and rule 3 is "estimates are ranges
 * with assumptions visible". Those are easy to write down and easy to lose in
 * code, so every read of a number goes through here and records:
 *   - which source keys were used,
 *   - which of those are still unverified,
 *   - what assumptions the reader should see next to the figure.
 *
 * The UI reads the collector and shows an amber badge per unverified key, which
 * is what stops a placeholder reaching a judge unlabelled.
 */

export interface ProvenanceCollector {
  used: Set<string>;
  unverified: Set<string>;
  assumptions: string[];
}

export function newCollector(): ProvenanceCollector {
  return { used: new Set(), unverified: new Set(), assumptions: [] };
}

export function note(c: ProvenanceCollector, text: string): void {
  if (!c.assumptions.includes(text)) c.assumptions.push(text);
}

/** A source entry whose value is still null: present in the file, not yet filled in. */
export class UnsourcedValueError extends Error {}

/**
 * Read a numeric range from a source entry, recording provenance.
 * Throws when the entry has null values, because a missing number must surface
 * as a visible failure rather than silently become a zero.
 */
export function useEntry(entry: SourceEntry, key: string, c: ProvenanceCollector): Range {
  c.used.add(key);
  if (!entry.verified) c.unverified.add(key);
  if (entry.low === null || entry.high === null) {
    throw new UnsourcedValueError(
      `config/sources.json: "${key}" has no value yet (source: ${entry.source}). Fill it in before using it.`,
    );
  }
  return { low: entry.low, high: entry.high, unit: entry.unit };
}

export function energyKeyFor(cls: ModelClass): "e_out_small" | "e_out_medium" | "e_out_large" {
  if (cls === "small") return "e_out_small";
  if (cls === "medium") return "e_out_medium";
  return "e_out_large";
}

export function outputEnergyPerToken(
  sources: SourcesConfig,
  cls: ModelClass,
  c: ProvenanceCollector,
): Range {
  const key = energyKeyFor(cls);
  return useEntry(sources[key], key, c);
}

/** Emission factors, skipping the `_note` / `_basis` string keys in the file. */
export function emissionFactors(sources: SourcesConfig): Record<string, SourceEntry> {
  const out: Record<string, SourceEntry> = {};
  for (const [k, v] of Object.entries(sources.EF)) {
    if (k.startsWith("_")) continue;
    if (typeof v === "string") continue;
    out[k] = v;
  }
  return out;
}

export function emissionFactorBasis(sources: SourcesConfig): string {
  const basis = sources.EF["_basis"];
  return typeof basis === "string" ? basis : "UNDECIDED";
}

// --- range arithmetic -------------------------------------------------------
// Kept separate and dull on purpose. Range maths is where an "estimate" quietly
// turns into a claim, so there is exactly one way to do each operation.

export function scaleRange(r: Range, factor: number, unit: string): Range {
  const a = r.low * factor;
  const b = r.high * factor;
  return { low: Math.min(a, b), high: Math.max(a, b), unit };
}

export function multiplyRanges(a: Range, b: Range, unit: string): Range {
  const candidates = [a.low * b.low, a.low * b.high, a.high * b.low, a.high * b.high];
  return { low: Math.min(...candidates), high: Math.max(...candidates), unit };
}

export function addRanges(a: Range, b: Range): Range {
  if (a.unit !== b.unit) throw new Error(`Cannot add ${a.unit} to ${b.unit}`);
  return { low: a.low + b.low, high: a.high + b.high, unit: a.unit };
}

export function zeroRange(unit: string): Range {
  return { low: 0, high: 0, unit };
}

export function weightedMeanRange(
  pairs: { value: Range; weight: number }[],
  unit: string,
): Range {
  const total = pairs.reduce((s, p) => s + p.weight, 0);
  if (total <= 0) return zeroRange(unit);
  let low = 0;
  let high = 0;
  for (const p of pairs) {
    low += p.value.low * p.weight;
    high += p.value.high * p.weight;
  }
  return { low: low / total, high: high / total, unit };
}

// --- validation -------------------------------------------------------------

export interface ConfigWarning {
  key: string;
  message: string;
}

/**
 * Lists everything that must be fixed before the pitch. The portal renders this
 * at the top of the page, so the gap between "runs" and "ready to show judges"
 * is never invisible.
 */
export function auditConfig(config: Config): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  const s = config.sources;

  const scalarKeys: (keyof SourcesConfig)[] = [
    "e_out_small",
    "e_out_medium",
    "e_out_large",
    "e_in",
    "e_cache_read",
    "e_cache_write",
    "WI",
    "grid_fallback",
    "va_dc",
    "ACL2025",
  ];
  for (const key of scalarKeys) {
    const entry = s[key] as SourceEntry;
    if (!entry.verified) {
      warnings.push({
        key: String(key),
        message: `Unverified: ${entry.source}`,
      });
    }
  }

  for (const [fuel, entry] of Object.entries(emissionFactors(s))) {
    if (!entry.verified) {
      warnings.push({ key: `EF.${fuel}`, message: `Unverified: ${entry.source}` });
    }
  }
  if (emissionFactorBasis(s) === "UNDECIDED") {
    warnings.push({
      key: "EF._basis",
      message: "Say whether the emission factors are lifecycle or direct combustion. Judges ask this.",
    });
  }

  for (const tier of config.models.tiers) {
    if (!tier.verified) {
      warnings.push({
        key: `models.${tier.id}`,
        message: "Model names for this tier are not checked against a current lineup.",
      });
    }
  }
  return warnings;
}
