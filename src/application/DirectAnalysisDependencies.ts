import type { AppConfig } from "../config/types.js";
import type { parseConfig } from "../config/parseConfig.js";
import type { Logger } from "pino";
import type { BinarySessionPort } from "./binary/BinarySessionPort.js";

/** Configuration and one-shot session factories supplied by the production boundary. */
export interface DirectAnalysisDependencies {
  /** Read the caller-selected configuration without consulting ambient state. */
  readonly readConfiguration: () => ReturnType<typeof parseConfig>;
  readonly createBinarySession: (
    config: AppConfig,
    logger: Logger,
  ) => BinarySessionPort | Promise<BinarySessionPort>;
  /** Prefer byte-backed dispatch inspection while preserving explicit selection. */
  readonly createNativeDispatchBinarySession: (
    config: AppConfig,
    logger: Logger,
  ) => BinarySessionPort | Promise<BinarySessionPort>;
  /** Create an artifact-only session without selecting native analysis engines. */
  readonly createArtifactBinarySession: () =>
    | BinarySessionPort
    | Promise<BinarySessionPort>;
  /** Create a native utility session without selecting deep analysis engines. */
  readonly createNativeBinarySession: () =>
    | BinarySessionPort
    | Promise<BinarySessionPort>;
  readonly createManagedBinarySession: () =>
    | BinarySessionPort
    | Promise<BinarySessionPort>;
}
