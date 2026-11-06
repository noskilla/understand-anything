import type { AnyBlock } from "../types.js";
import { triggers } from "./triggers.js";
import { conditions } from "./conditions.js";
import { actions } from "./actions.js";

export const BLOCKS: AnyBlock[] = [...triggers, ...conditions, ...actions];
export const BLOCK_MAP = new Map<string, AnyBlock>(BLOCKS.map((b) => [b.id, b]));
export function getBlock(id: string, kind?: AnyBlock["kind"]): AnyBlock {
  const b = BLOCK_MAP.get(id);
  if (!b) throw new Error(`Unknown block '${id}'. Known: ${BLOCKS.map((x) => x.id).join(", ")}`);
  if (kind && b.kind !== kind) throw new Error(`Block '${id}' is a ${b.kind}, expected ${kind}`);
  return b;
}
