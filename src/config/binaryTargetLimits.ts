import { z } from "zod";

/** Default maximum number of provider targets one server may hold open. */
export const DEFAULT_MAX_OPEN_TARGETS = 4;

/** Default maximum number of target starts allowed to overlap. */
export const DEFAULT_MAX_CONCURRENT_ANALYSES = 2;

/** Positive bounded integer used by the target-admission limits. */
export const binaryTargetLimitSchema = z
  .string()
  .regex(/^[1-9]\d*$/u, "must be a positive decimal integer")
  .transform(Number)
  .pipe(z.number().int().min(1).max(64));
