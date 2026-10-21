# Borland Win32 exception-handler body recovery

Issue: https://github.com/morluto/rea/issues/2926

## Requirements

Recognize decoded PE32 x86 Borland SEH registration (`push ebp; push handler;
push fs:[0]; mov fs:[0],esp`, including a provably zero register offset).
Recover orphaned handler code within an existing function's non-contiguous
body span in the ephemeral analysis database. Preserve other function owners,
defined data, names, signatures, target bytes and Windows P0 mutation policy.
All existing function queries must consume the corrected FunctionManager body.
Record recognized registrations and remaining omissions as Evidence limitations.

## Acceptance

- A self-owned PE32 fixture exposes handler-only strings and calls through the
  public CLI/MCP and resolves handler addresses to the enclosing function.
- A handler's initial RTL jump veneer does not hide the following catch body.
  Following that non-fallthrough continuation requires a caller-supplied or
  imported Borland RTL identity; an arbitrary executable jump is omitted.
- A nonzero FS offset and an independently owned handler are not reassigned.
- Cancellation and malformed targets retain existing cleanup behavior.

## Non-goals

No target execution, Windows P0 mutation, general exception-table recovery,
guessed compiler version, or forced ownership outside the existing body span.

## Follow-up review contracts

Bound speculative handler recovery across the complete startup analysis by
instruction visits, decoded bytes and queued work. Exhaustion preserves a typed
static-coverage omission and must not publish a partially expanded body. RTL
identity uses actual FunctionManager ownership and AddressSet membership, even
inside the enclosing numeric span. Retain the validated veneer fact from its
producer, including an initially undecoded entry. Containment queries carry the
same SEH observations for recovered addresses and known omitted handler entries.
