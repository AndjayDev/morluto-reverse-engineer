import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";

import { jvmDebugMetadataModule } from "../composition/jvm.js";
import { logCliCommand } from "../cliLogging.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { JVM_PROVIDER_IDENTITY } from "../jvm/JvmClassFileRelease.js";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Resolve the caller-selected class-file path through the shared workflow. */
export const registerJvmCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  cli.command(jvmDebugMetadataModule.cliCommand, {
    description:
      "Inspect compiler-emitted debug metadata in a selected local JVM .class file or JAR entry",
    args: z.object({
      path: z
        .string()
        .describe("Local .class artifact, or a .jar when --entry is given"),
    }),
    options: z.object({
      entry: z
        .string()
        .optional()
        .describe(
          "Class member path to select inside the JAR, e.g. com/example/Foo.class",
        ),
      release: z.coerce
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Multi-release JAR version whose override of --entry to select",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) => {
        const service = jvmDebugMetadataModule.create(environment);
        return logCliCommand(logger, jvmDebugMetadataModule.cliCommand, () =>
          finishAnalysisCommand(
            () =>
              service.inspect(
                {
                  path: resolve(args.path),
                  ...(options.entry === undefined
                    ? {}
                    : { entry: options.entry }),
                  ...(options.release === undefined
                    ? {}
                    : { release: options.release }),
                },
                { signal },
              ),
            service,
            JVM_PROVIDER_IDENTITY.id,
            jvmDebugMetadataModule.contract.name,
            signal,
          ),
        );
      }),
  });
};
