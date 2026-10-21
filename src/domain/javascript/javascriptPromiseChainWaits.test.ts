import { expect, it } from "vitest";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const sources = [
  'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();await pending.then(()=>{});',
  'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();await pending.catch(()=>{});',
  'const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/chain");resolve()});await pending.then(()=>{});',
  'const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/chain");resolve()});await pending.catch(()=>{});',
  'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();const tail=pending.then(()=>{});await tail.catch(()=>{});',
];

it.each(sources)("preserves chained native promise blocking: %s", (source) => {
  const result = analyzeJavaScriptStaticSource(
    `export {};${source}const Socket=globalThis.WebSocket;`,
  );
  expect(result.parse_status).not.toBe("failed");
  expect(result.endpoints).toEqual([]);
});

it.each(sources)("retains initialized chained producer: %s", (source) => {
  const result = analyzeJavaScriptStaticSource(
    `export {};const Socket=globalThis.WebSocket;${source}`,
  );
  expect(result.endpoints.map(({ value }) => value)).toEqual([
    "wss://example.test/chain",
  ]);
});

it.each([
  ["pending.then=()=>undefined;", "pending.then()"],
  ["const alias=pending;alias.then=()=>undefined;", "pending.then()"],
  ["pending.catch=()=>undefined;", "pending.catch()"],
  ["Promise.prototype.then=()=>undefined;", "pending.then()"],
  ["Promise.prototype.catch=()=>undefined;", "pending.catch()"],
  ["Object.setPrototypeOf(pending,{then:()=>undefined});", "pending.then()"],
  [
    "function mutate(value){value.then=()=>undefined}mutate(pending);",
    "pending.then()",
  ],
  [
    "const tail=pending.then();tail.constructor=null;tail.then=resolve=>resolve();",
    "tail",
  ],
  [
    "class Fast extends Promise{constructor(executor){super(resolve=>{resolve();executor(()=>{},()=>{})})}}pending.constructor={[Symbol.species]:Fast};",
    "pending.then()",
  ],
  [
    "class Fast extends Promise{constructor(executor){super(resolve=>{resolve();executor(()=>{},()=>{})})}}Object.defineProperty(Promise,Symbol.species,{value:Fast});",
    "pending.then()",
  ],
  [
    "class Fast extends Promise{constructor(executor){super(resolve=>{resolve();executor(()=>{},()=>{})})}}Object.defineProperty(pending.constructor,Symbol.species,{value:Fast});",
    "pending.then()",
  ],
  ["Promise[Symbol.species].prototype.then=()=>undefined;", "pending.then()"],
] as const)("keeps changed chain identity unknown: %s", (change, wait) => {
  const source = `export {};let release;const ready=new Promise(resolve=>{release=resolve});const pending=(async()=>{await ready;new Socket("wss://example.test/changed-chain")})();${change}await ${wait};const Socket=globalThis.WebSocket;release();`;
  const result = analyzeJavaScriptStaticSource(source);
  expect(result.parse_status).not.toBe("failed");
  expect(result.endpoints.map(({ value }) => value)).toEqual([
    "wss://example.test/changed-chain",
  ]);
});
