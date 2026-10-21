import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../../fixtures/artifactInventory.js";
import { readJavaScriptArtifactFiles } from "../../../support/javascriptApplicationScope.js";
import { createJavaScriptArtifactReader } from "../../../../src/artifacts/javascript/JavaScriptArtifactReader.js";
import { analyzeJavaScriptArtifactFiles } from "../../../../src/application/javascript/JavaScriptArtifactAnalysis.js";
import { buildJavaScriptArtifactGraph } from "../../../../src/application/javascript/JavaScriptArtifactGraphBuilder.js";

const sources = [
  {
    file: "async-then.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/async-then")})();await pending.then(()=>{});const Socket=globalThis.WebSocket;',
  },
  {
    file: "async-catch.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/async-catch")})();await pending.catch(()=>{});const Socket=globalThis.WebSocket;',
  },
  {
    file: "executor-then.mjs",
    source:
      'export {};const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/executor-then");resolve()});await pending.then(()=>{});const Socket=globalThis.WebSocket;',
  },
  {
    file: "executor-catch.mjs",
    source:
      'export {};const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/executor-catch");resolve()});await pending.catch(()=>{});const Socket=globalThis.WebSocket;',
  },
  {
    file: "chained-alias.mjs",
    source:
      'export {};const pending=(async()=>{await 0;new Socket("wss://example.test/chained-alias")})();const tail=pending.then(()=>{});await tail.catch(()=>{});const Socket=globalThis.WebSocket;',
  },
  {
    file: "initialized-chain.mjs",
    endpoint: "wss://example.test/initialized-chain",
    source:
      'export {};const Socket=globalThis.WebSocket;const pending=(async()=>{await 0;new Socket("wss://example.test/initialized-chain")})();await pending.catch(()=>{});',
  },
  {
    file: "capability-name-0.mjs",
    source:
      'export {};const pending=new Promise(async function(resolve){({resolve:0});await 0;new Socket("wss://example.test/property-name-0");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "capability-name-1.mjs",
    source:
      'export {};const pending=new Promise(async function(resolve){({}).resolve;await 0;new Socket("wss://example.test/property-name-1");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "capability-name-2.mjs",
    source:
      'export {};const pending=new Promise(async function(resolve){({resolve(){}});await 0;new Socket("wss://example.test/property-name-2");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "capability-name-3.mjs",
    source:
      'export {};const pending=new Promise(async function(resolve){class K{resolve(){}}await 0;new Socket("wss://example.test/property-name-3");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "capability-name-4.mjs",
    source:
      'export {};const pending=new Promise(async function(resolve){resolve:for(;;){break resolve;}await 0;new Socket("wss://example.test/property-name-4");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "capability-name-5.mjs",
    source:
      'export {};const pending=new Promise(async function(resolve){{const {resolve}= {resolve:0};}await 0;new Socket("wss://example.test/property-name-5");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "capability-name-6.mjs",
    source:
      'export {};const pending=new Promise(async function(resolve){({eval:0});await 0;new Socket("wss://example.test/property-name-6");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "capability-name-7.mjs",
    source:
      'export {};const pending=new Promise(async function(resolve){({arguments:0});await 0;new Socket("wss://example.test/property-name-7");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "callback.js",
    endpoint: "wss://example.test/pair",
    source:
      'const invoke=run=>run();invoke(()=>{});const Socket=globalThis.WebSocket;invoke(()=>new Socket("wss://example.test/pair"));',
  },
  {
    file: "apply.js",
    endpoint: "wss://example.test/apply",
    source:
      'const connect=()=>new Socket("wss://example.test/apply");try{connect.apply(null,1)}catch{}const Socket=globalThis.WebSocket;',
  },
  {
    file: "options.mjs",
    endpoint: "wss://example.test/options",
    source:
      'export {};const{WebSocket:Socket}=await import("ws",{with(){}});new Socket("wss://example.test/options");',
  },
  {
    file: "disposer.js",
    endpoint: "wss://example.test/disposer",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/disposer")})()){await using r={set[Symbol.asyncDispose](value){},[Symbol.dispose](){}}}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "helper-read.js",
    source:
      'const connect=()=>new Socket("wss://example.test/helper-read");connect.call(null,connect.call=()=>{});const Socket=globalThis.WebSocket;',
  },
  {
    file: "base-field.js",
    source:
      'class Base{field=new Socket("wss://example.test/base-field")}class Derived extends Base{}new Derived();const Socket=globalThis.WebSocket;',
  },
  {
    file: "promise-executor.js",
    source:
      'new Promise(()=>new Socket("wss://example.test/promise-executor"));const Socket=globalThis.WebSocket;',
  },
  {
    file: "destructured-getter.js",
    source:
      'const{run}={get run(){return new Socket("wss://example.test/destructured-getter")}};const Socket=globalThis.WebSocket;',
  },
  {
    file: "getter-key-wait.js",
    endpoint: "wss://example.test/getter-key-wait",
    source:
      '(async()=>{const{[void await 0]:value}={get undefined(){return new Socket("wss://example.test/getter-key-wait")}}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "async-executor.mjs",
    endpoint: "wss://example.test/async-executor",
    source:
      'let release;const ready=new Promise(resolve=>{release=resolve});const pending=new Promise(async resolve=>{resolve();await ready;new Socket("wss://example.test/async-executor")});await pending;const Socket=globalThis.WebSocket;release();',
  },
  {
    file: "changed-base.js",
    endpoint: "wss://example.test/changed-base",
    source:
      'class Base{field=new Socket("wss://example.test/changed-base")}class Other{}class Derived extends Base{}Object.setPrototypeOf(Derived,Other);new Derived();const Socket=globalThis.WebSocket;',
  },
  {
    file: "nested-getter.js",
    source:
      '(async()=>{const{run:{[await 0]:x}}={get run(){new Socket("wss://example.test/nested-getter");return {}}}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "default-getter.js",
    source:
      '(async()=>{const{run:x=await 0}={get run(){new Socket("wss://example.test/default-getter")}}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "key-before-getter.js",
    endpoint: "wss://example.test/key-before-getter",
    source:
      '(async()=>{const{[void await 0]:{x}}={get undefined(){new Socket("wss://example.test/key-before-getter");return {}}}})();const Socket=globalThis.WebSocket;',
  },
  {
    file: "late-resolve.mjs",
    source:
      'const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/late-resolve");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "late-reject.mjs",
    source:
      'const pending=new Promise(async(resolve,reject)=>{await 0;new Socket("wss://example.test/late-reject");reject()});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "no-settlement.mjs",
    source:
      'const pending=new Promise(async()=>{await 0;new Socket("wss://example.test/no-settlement")});await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "escaped-resolve.mjs",
    endpoint: "wss://example.test/escaped-resolve",
    source:
      'let release;const pending=new Promise(async resolve=>{release=resolve;await 0;new Socket("wss://example.test/escaped-resolve")});release();await pending;const Socket=globalThis.WebSocket;',
  },
  {
    file: "shadowed-resolve.mjs",
    source:
      'const pending=new Promise(async resolve=>{(()=>{const resolve=()=>{};resolve()})();await 0;new Socket("wss://example.test/shadowed-resolve");resolve()});await pending;const Socket=globalThis.WebSocket;',
  },
] as const;

it("retains reviewed callback and descriptor endpoints with source provenance", async () => {
  const root = await createTestTempDirectory("rea-reviewed-calls-");
  for (const fixture of sources)
    await writeFile(join(root, fixture.file), fixture.source);
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const graph = buildJavaScriptArtifactGraph(
      snapshot,
      files,
      analyzeJavaScriptArtifactFiles(files),
    );
    const observations = graph.nodes
      .filter(({ kind }) => kind === "endpoint")
      .flatMap(({ observations }) => observations);
    const expected = sources.filter((fixture) => "endpoint" in fixture);
    expect(observations).toHaveLength(expected.length);
    for (const fixture of expected)
      expect(observations).toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({ value: fixture.endpoint }),
          evidence: expect.objectContaining({
            location: {
              available: true,
              value: expect.objectContaining({ source: fixture.file }),
            },
          }),
        }),
      );
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});
