import type { GhidraProjectCacheIdentity } from "./GhidraProjectCacheTypes.js";
import type { GhidraProjectManifestTarget } from "./GhidraProjectManifest.js";

/**
 * The identity a store test publishes under.
 *
 * The fields are the ones a Ghidra session reports for a Linux target, so a
 * test can derive the cache key the store derives.
 */
export const ghidraProjectCacheIdentity = (): GhidraProjectCacheIdentity => ({
  providerId: "ghidra",
  providerVersion: "12.1.4",
  jvmVmName: "OpenJDK 64-Bit Server VM",
  platform: "linux",
  targetSha256: "a".repeat(64),
  importProfileDigest: "b".repeat(64),
});

/** The target a store test publishes the identity for. */
export const ghidraProjectCacheTarget = (): GhidraProjectManifestTarget => ({
  sha256: "a".repeat(64),
  kind: "executable",
  format: "pe",
  architecture: "x86_64",
  executable_role: "shared-library",
});
