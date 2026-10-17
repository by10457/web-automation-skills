/** Official phase-two request contracts, shared by JS/CLI validation and MCP schemas. */
import { z } from 'zod';

const ids = z
  .array(
    z
      .string()
      .regex(/^[a-zA-Z0-9-]+$/)
      .min(1)
      .max(128),
  )
  .min(1)
  .max(100);
const integer = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

/** Explicit fields match /windowbounds; omitting ids is never allowed by this wrapper. */
export const layoutSchema = z.strictObject({
  type: z.enum(['box', 'diagonal']),
  startX: integer,
  startY: integer,
  width: integer.min(500),
  height: integer.min(200),
  col: integer.min(1),
  spaceX: integer.min(0),
  spaceY: integer.min(0),
  offsetX: integer,
  offsetY: integer,
  orderBy: z.enum(['asc', 'desc']),
  screenId: integer.optional(),
});

export const phaseTwoSchemas = [
  z.strictObject({ action: z.literal('fingerprint-random'), ids }),
  z.strictObject({ action: z.literal('arrange'), ids, layout: layoutSchema }),
  z.strictObject({ action: z.literal('arrange-flexible'), ids }),
];
export const phaseTwoRequest = z.discriminatedUnion('action', phaseTwoSchemas);
export const phaseTwoActions = ['fingerprint-random', 'arrange', 'arrange-flexible'];
