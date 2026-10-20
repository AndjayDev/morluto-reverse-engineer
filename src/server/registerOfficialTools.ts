import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/officialToolContracts.js";
import {
  declaresWaitBudget,
  DEFAULT_WAIT_BUDGET_MS,
} from "../contracts/officialToolContracts.js";
import { NATIVE_INVENTORY_OPERATIONS } from "../domain/native/nativeInventory.js";
import { registerEvidenceTools } from "./registerEvidenceTools.js";
import {
  retainedSummaryDelivery,
  withoutDeliveryDetail,
  type EvidenceToolFamilyOptions,
} from "./retainedSummaryDelivery.js";

const SUMMARY_OPERATIONS: ReadonlySet<string> = new Set(
  NATIVE_INVENTORY_OPERATIONS,
);
const withoutDetail = withoutDeliveryDetail(SUMMARY_OPERATIONS);

/** Direct tools share Evidence recording/projection with the other provider-backed tools. */
export const registerOfficialTools = (
  server: EvidenceMcpServer,
  options: EvidenceToolFamilyOptions,
): void => {
  registerEvidenceTools(server, OFFICIAL_TOOL_CONTRACTS, {
    ...options,
    ...retainedSummaryDelivery(SUMMARY_OPERATIONS, options),
    parametersForExecution: withoutDetail,
    parametersForEvidence: withoutDetail,
    adapterSelections: (contract, input) => {
      const targetId =
        typeof input.target_id === "string" ? input.target_id : undefined;
      // The wait budget belongs to the tools whose schema declares it. A tool
      // that declares none is told not to wait, so a call on a starting target
      // reports its state at once instead of blocking for a budget it never
      // asked for.
      const waitMs = declaresWaitBudget(contract.inputSchema)
        ? typeof input.wait_ms === "number"
          ? input.wait_ms
          : DEFAULT_WAIT_BUDGET_MS
        : 0;
      // The handle and the budget are adapter selections. They are not facts
      // about the analysed program, so the provider and the Evidence record
      // never see them.
      const { target_id: _targetId, wait_ms: _waitMs, ...parameters } = input;
      return {
        ...(targetId === undefined ? {} : { targetId }),
        waitMs,
        parameters,
      };
    },
  });
};
