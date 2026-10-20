import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  analysisViewCaptureEvidence,
  analysisViewNativeEvidence,
} from "../../../tests/fixtures/analysisView.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { JsonInputPhysicalReadFailure } from "../JsonInputFile.js";
import { failFileReadAfterAbort } from "../../../tests/support/failFileReadAfterAbort.js";
import { holdFirstFileRead } from "../../../tests/support/holdFirstFileRead.js";
import { createEvidenceBundle } from "../../domain/evidenceBundle.js";
import {
  estimateJsonValueBytes,
  readEvidenceFileSource,
  requireAuthenticationHeadroom,
} from "./evidenceFileSource.js";

describe("evidence-file source", () => {
  it("estimates parsed JSON at no less than its UTF-16 text", () => {
    const text = "x".repeat(1000);
    expect(estimateJsonValueBytes(text)).toBeGreaterThanOrEqual(2000);
    expect(
      estimateJsonValueBytes({ outer: [text, { inner: text }] }),
    ).toBeGreaterThan(2 * estimateJsonValueBytes(text));
  });

  it("refuses authentication when live heap headroom cannot hold its copies", () => {
    const value = { normalized_result: "y".repeat(10_000) };
    expect(
      requireAuthenticationHeadroom(value, "/tmp/capture.json", 1024),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        resource: "memory",
        reportedLimits: {
          input_path: "/tmp/capture.json",
          available_heap_bytes: 1024,
        },
      },
    });
    expect(
      requireAuthenticationHeadroom(value, "/tmp/capture.json", 1 << 30),
    ).toEqual({ ok: true, value: undefined });
  });

  it("refuses a cancelled request before reading and reads within the caller's resource scope", async () => {
    const controller = new AbortController();
    const reason = new JsonInputPhysicalReadFailure(
      new Error("opaque caller reason with physical-failure shape"),
    );
    controller.abort(reason);
    const cancelled = await readEvidenceFileSource(
      "/nonexistent/capture.json",
      {
        signal: controller.signal,
      },
    );
    expect(cancelled).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    if (cancelled.ok || !(cancelled.error instanceof AnalysisCancelledError))
      throw new Error("Expected cancelled analysis-view read");
    expect(cancelled.error.cause).toBe(reason);
    const path = join(
      await createTestTempDirectory("rea-evidence-file-source-"),
      "capture.json",
    );
    const parent = analysisViewCaptureEvidence();
    await writeFile(path, JSON.stringify(parent));
    const resources = new ArtifactResourceScope();
    const read = await readEvidenceFileSource(path, { resources });
    await resources.close();
    if (!read.ok) throw read.error;
    expect(read.value).toEqual(JSON.parse(JSON.stringify(parent)));
  });

  it("projects the selected or only record of an Evidence bundle file", async () => {
    const root = await createTestTempDirectory("rea-evidence-bundle-source-");
    const native = analysisViewNativeEvidence();
    const capture = analysisViewCaptureEvidence();
    const single = join(root, "single.json");
    await writeFile(single, JSON.stringify(createEvidenceBundle([native])));
    const only = await readEvidenceFileSource(single);
    if (!only.ok) throw only.error;
    expect(only.value.evidence_id).toBe(native.evidence_id);

    const several = join(root, "several.json");
    await writeFile(
      several,
      JSON.stringify(createEvidenceBundle([native, capture])),
    );
    const selected = await readEvidenceFileSource(
      several,
      {},
      capture.evidence_id,
    );
    if (!selected.ok) throw selected.error;
    expect(selected.value.evidence_id).toBe(capture.evidence_id);

    // Ambiguity and a missing selection are input errors that name the records held.
    const ambiguous = await readEvidenceFileSource(several);
    expect(ambiguous).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        issues: [{ path: ["source", "evidence_id"], reason: "invalid_value" }],
      },
    });
    if (ambiguous.ok) throw new Error("Expected an ambiguous bundle");
    expect(ambiguous.error.userMessage).toContain(native.evidence_id);
    expect(ambiguous.error.userMessage).toContain("analyze_function");
    const absent = "ev_" + "f".repeat(64);
    const missing = await readEvidenceFileSource(several, {}, absent);
    expect(missing).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        userMessage: expect.stringContaining(absent),
      },
    });

    // A bundle-shaped file that is not a valid bundle is a wrong-kind file, not Evidence.
    const invalid = join(root, "invalid.json");
    await writeFile(invalid, JSON.stringify({ records: [{ hello: 1 }] }));
    expect(await readEvidenceFileSource(invalid)).toMatchObject({
      ok: false,
      error: {
        _tag: "EvidenceFileError",
        reason: "wrong-kind",
        userMessage: expect.stringContaining("Evidence bundle"),
      },
    });
  });
});

describe("evidence-file read failure provenance", () => {
  it("keeps a physical null read cause after the analysis-view request aborts", async () => {
    const root = await createTestTempDirectory("rea-view-late-io-");
    const path = join(root, "capture.json");
    await writeFile(path, JSON.stringify(analysisViewCaptureEvidence()));
    const controller = new AbortController();
    await failFileReadAfterAbort(
      path,
      controller,
      new Error("later abort"),
      null,
    );
    try {
      const result = await readEvidenceFileSource(path, {
        signal: controller.signal,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "EvidenceFileError", reason: "io", path },
      });
      if (result.ok) throw new Error("Expected physical JSON read failure");
      expect(result.error.cause).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("preserves identical physical and abort causes for analysis-view reads", async () => {
    const root = await createTestTempDirectory("rea-view-identical-abort-");
    const path = join(root, "capture.json");
    await writeFile(path, JSON.stringify(analysisViewCaptureEvidence()));
    const controller = new AbortController();
    const physical = Object.assign(new Error("descriptor EIO"), {
      code: "EIO",
    });
    await failFileReadAfterAbort(path, controller, physical, physical);
    try {
      const result = await readEvidenceFileSource(path, {
        signal: controller.signal,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "EvidenceFileError", reason: "io" },
      });
      if (result.ok) throw new Error("Expected physical JSON read failure");
      expect(result.error.cause).toBe(physical);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("preserves the caller cancellation reason during an analysis-view read", async () => {
    const root = await createTestTempDirectory("rea-view-read-cancel-");
    const path = join(root, "capture.json");
    await writeFile(path, JSON.stringify(analysisViewCaptureEvidence()));
    const reader = await holdFirstFileRead(path);
    const controller = new AbortController();
    const reason = new Error("stop analysis-view read");
    try {
      const pending = readEvidenceFileSource(path, {
        signal: controller.signal,
      });
      await reader.firstRead;
      controller.abort(reason);
      reader.release();
      const result = await pending;
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisCancelledError",
          operation: "inspect_analysis_view",
        },
      });
      if (result.ok || !(result.error instanceof AnalysisCancelledError))
        throw new Error("Expected cancelled analysis-view read");
      expect(result.error.cause).toBe(reason);
    } finally {
      controller.abort(reason);
      reader.release();
      vi.restoreAllMocks();
    }
  });

  it("does not treat a caller reason with physical-read shape as a physical read", async () => {
    const root = await createTestTempDirectory("rea-view-opaque-cancel-");
    const path = join(root, "capture.json");
    await writeFile(path, JSON.stringify(analysisViewCaptureEvidence()));
    const reader = await holdFirstFileRead(path);
    const controller = new AbortController();
    const reason = new JsonInputPhysicalReadFailure(
      new Error("opaque caller reason with physical-failure shape"),
    );
    try {
      const pending = readEvidenceFileSource(path, {
        signal: controller.signal,
      });
      await reader.firstRead;
      controller.abort(reason);
      reader.release();
      const result = await pending;
      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisCancelledError", cause: reason },
      });
      if (result.ok || !(result.error instanceof AnalysisCancelledError))
        throw new Error(
          "Expected caller cancellation, not physical I/O failure",
        );
      expect(result.error.cause).toBe(reason);
    } finally {
      controller.abort(reason);
      reader.release();
      vi.restoreAllMocks();
    }
  });
});
