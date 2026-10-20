import { InvestigationRecords } from "../investigation/InvestigationRecords.js";
import type { AnalysisProvider } from "../AnalysisProvider.js";
import { AnalysisProviderRegistry } from "./AnalysisProviderRegistry.js";
import {
  BinaryTargetRegistry,
  type BinaryTargetLimits,
} from "./BinaryTargetRegistry.js";
import { SessionProviderRouter } from "./SessionProviderRouter.js";

/**
 * Compose one provider-neutral target registry from deep-provider selection and
 * disjoint auxiliary operation families.
 */
export const composeBinarySession = (
  registry: AnalysisProviderRegistry,
  auxiliaryProviders: readonly AnalysisProvider[] = [],
  limits: Partial<BinaryTargetLimits> = {},
): BinaryTargetRegistry =>
  new BinaryTargetRegistry(
    SessionProviderRouter.selectable(registry, auxiliaryProviders),
    new InvestigationRecords(),
    limits,
  );
