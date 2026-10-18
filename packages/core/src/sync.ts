import type { Estimate, Flag, ModelClass, Range, TokenCounts } from "./types.ts";

export const SYNC_EVENT_VERSION = 1;

export interface SyncUsageEvent {
  version: typeof SYNC_EVENT_VERSION;
  id: string;
  timestamp: string;
  surface: "paste" | "web" | "cli";
  tool: string;
  modelClass: ModelClass;
  tokens: TokenCounts;
  totalOutputTokens: number;
  wastedOutputTokens: number;
  efficiency: number;
  flagTypes: Flag["type"][];
  resources: {
    total: { energyWh: Range; waterMl: Range; co2g: Range; cost: Range };
    wasted: { energyWh: Range; waterMl: Range; co2g: Range; cost: Range };
  };
}

export interface SyncEventInput {
  id?: string;
  timestamp?: string;
  surface: SyncUsageEvent["surface"];
  tool: string;
  modelClass: ModelClass;
  tokens: TokenCounts;
  totalOutputTokens: number;
  wastedOutputTokens: number;
  efficiency: number;
  flags: Flag[];
  estimate: Estimate;
}

/** Build the privacy-safe record shared by the portal, extension and CLI. */
export function syncUsageEvent(input: SyncEventInput): SyncUsageEvent {
  const timestamp = input.timestamp ?? new Date().toISOString();
  return {
    version: SYNC_EVENT_VERSION,
    id: input.id ?? `evt_${crypto.randomUUID()}`,
    timestamp,
    surface: input.surface,
    tool: input.tool.slice(0, 80),
    modelClass: input.modelClass,
    tokens: { ...input.tokens },
    totalOutputTokens: input.totalOutputTokens,
    wastedOutputTokens: input.wastedOutputTokens,
    efficiency: Math.max(0, Math.min(1, input.efficiency)),
    flagTypes: [...new Set(input.flags.map((flag) => flag.type))],
    resources: {
      total: {
        energyWh: { ...input.estimate.energyWh },
        waterMl: { ...input.estimate.waterMl },
        co2g: { ...input.estimate.co2g },
        cost: { ...input.estimate.cost },
      },
      wasted: {
        energyWh: { ...input.estimate.wasted.energyWh },
        waterMl: { ...input.estimate.wasted.waterMl },
        co2g: { ...input.estimate.wasted.co2g },
        cost: { ...input.estimate.wasted.cost },
      },
    },
  };
}

export async function sendSyncUsageEvent(
  endpoint: string,
  key: string,
  event: SyncUsageEvent,
): Promise<void> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ event }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Sync failed (${response.status})${detail ? `: ${detail.slice(0, 180)}` : ""}`);
  }
}
