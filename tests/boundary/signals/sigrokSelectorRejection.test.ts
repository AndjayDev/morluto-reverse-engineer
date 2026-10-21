import { describe, expect, it } from "vitest";
import {
  parseSigrokDecoderHelpRejection,
  parseSigrokSelectorRejection,
} from "../../../src/signals/sigrokSelectorRejection.js";

const selection = (decoders: string) => ({ decoders, annotations: null });

const refusalFor = (id: string): string =>
  `srd: ModuleNotFoundError: Failed to load decoder ${id}: import by name failed: No module named '${id}'\nFailed to load protocol decoder ${id}.`;

describe("decode selector rejection", () => {
  it("attributes a missing decoder module named after a caller selector", () => {
    expect(
      parseSigrokSelectorRejection(
        refusalFor("nosuchdecoder"),
        selection("nosuchdecoder"),
      ),
    ).toMatchObject({ path: ["decoders"], reason: "invalid_value" });
  });

  it("leaves a refusal for another decoder unclassified", () => {
    expect(
      parseSigrokSelectorRejection(
        refusalFor("nosuchdecoder"),
        selection("uart"),
      ),
    ).toBeUndefined();
  });

  it("keeps an installed decoder whose own import fails unclassified", () => {
    expect(
      parseSigrokSelectorRejection(
        "srd: ModuleNotFoundError: Failed to load decoder uart: import by name failed: No module named 'serial'\nFailed to load protocol decoder uart.",
        selection("uart"),
      ),
    ).toBeUndefined();
  });

  it("ignores a selector that names no decoder", () => {
    expect(
      parseSigrokSelectorRejection(refusalFor("nosuchdecoder"), selection("")),
    ).toBeUndefined();
  });
});

describe("decoder help rejection", () => {
  it("attributes the refusal to the decoder the caller asked help for", () => {
    const rejection = parseSigrokDecoderHelpRejection(
      refusalFor("nosuchdecoder"),
      "nosuchdecoder",
    );
    expect(rejection).toMatchObject({
      path: ["decoder"],
      reason: "invalid_value",
    });
    expect(rejection?.message).toContain(
      "Failed to load protocol decoder nosuchdecoder.",
    );
    expect(rejection?.message).toContain(
      "inspect_signal_decoders without a decoder",
    );
  });

  it("leaves a catalog request unclassified", () => {
    expect(
      parseSigrokDecoderHelpRejection(refusalFor("nosuchdecoder"), null),
    ).toBeUndefined();
  });

  it("leaves a refusal for another decoder unclassified", () => {
    expect(
      parseSigrokDecoderHelpRejection(refusalFor("nosuchdecoder"), "uart"),
    ).toBeUndefined();
  });

  it("keeps an installed decoder whose own import fails unclassified", () => {
    expect(
      parseSigrokDecoderHelpRejection(
        "srd: ModuleNotFoundError: Failed to load decoder uart: import by name failed: No module named 'serial'\nFailed to load protocol decoder uart.",
        "uart",
      ),
    ).toBeUndefined();
  });
});
