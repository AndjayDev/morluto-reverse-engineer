# Route a reverse-engineering request

The user chooses the target and outcome. The agent chooses the necessary routes.
These are instructions for the agent, not an installed workflow runner or a new
REA tool. The core routes work without optional helper skills.

## Select the smallest complete workflow

| Requested outcome | Work to perform | Completion artifact |
| --- | --- | --- |
| Understand an app or compare products | Product/feature research; inspect selected workflows and relevant architecture/UI evidence | Feature/evidence matrix, distinctions, unknowns and source-linked brief |
| Explain how code or an artifact works | Trace selected entry points, ownership, data/state changes and dependencies using source or the appropriate REA route | Architecture/behavior explanation with evidence and coverage limits |
| Recover an interface or design system | Follow [UI/UX deconstruction](ui-ux-deconstruction.md) and its [template](ui-ux-spec-template.md) | Tokens, components, states, flows, motion and acceptance specification |
| Rebuild or clone a selected experience | Establish the specification, implement the requested slice, then verify it | Working implementation plus observed fidelity/behavior results and gaps |
| Test a target or compare a reconstruction | Replay selected tasks and compare relevant visual, semantic and behavioral outcomes | Reproduction evidence, mismatches and an acceptance report |

Use active conversation context before asking for a target or scope again. A bare
"reverse engineer this app" calls for a bounded overview and follow-up questions
driven by gaps; it does not authorize a clone, full archive crawl or production
changes. A request for a build plan ends at the plan. A request to build continues
into implementation without a redundant permission question when the target and
scope are already authorized.

Keep a short checklist of requested outcomes. For mixed tasks, reuse findings
from earlier routes instead of rerunning discovery. A missing optional helper
does not block the core workflow; a missing capability needed for a specific
claim does. Finish supported work and identify the remaining evidence gap.

## Product and architecture research

For a product brief, identify the selected users/tasks, content objects, entry
points and feature families. Record what was observed, what official material
claims, what source declares, and what remains inferred. Inspect only surfaces
needed for the user's question; do not equate visible controls with working
features or a marketing claim with verified behavior.

For comparisons, keep feature presence, user-journey behavior and implementation
fidelity in separate columns. If alternatives, dependencies, licensing or pricing
matter to a build decision, consult current authoritative sources and label
unverified terms. Do not run a market survey for a narrow interface task.

For source analysis, trace the selected feature from entry point through state
owner, data transformation, persistence boundary and visible/output result. Use
source locations for concrete claims; report unresolved indirect calls and
external services. Map relevant module boundaries and invariants before widening
the search. A source-only explanation does not need REA provider setup or target
execution. For binaries and packages, use the entrypoint's target-routing rules
and preserve REA's evidence and provider lifecycle.

A construction brief should connect features to evidence, recovered constraints,
implementation choices, dependencies and acceptance checks. Add alternatives,
domain models or phased backlogs only when they serve the requested outcome.
Reuse any project-owned catalog/schema through its documented contract. A brief
does not itself authorize database ingestion, wiki writes or external publication.

## Select optional specialists

Check the active skill catalog or the project's supplied route map. Load only the
selected helper's instructions and needed references when its phase begins. Pass
the existing target, authorized actions, evidence index, open question and expected
artifact; do not restart intake. Describe a helper as executed only after following
its applicable workflow. A tool name or installed skill is not proof of usable
provider access. Do not install helpers merely to satisfy this table.

| Helper, when available | Use it for | Boundary and fallback |
| --- | --- | --- |
| Project product-research or adapter guide, sometimes named `reverse-engineer` | Existing feature/catalog contracts and local analysis adapters | If that name is an alias to this skill, follow its linked module reference directly or use the product route above; do not recurse through aliases |
| `clone-website` | Website extraction and an explicitly requested reconstruction | Use extraction as part of the UI/UX route. Do not invoke a build-first workflow for an analysis-only request; the UI/UX guide supplies extraction without this helper |
| `audit-context-building` | Deep ownership/data-flow/invariant analysis for a selected code question | Keep its scope bounded to the relevant source; use ordinary repository tools when unnecessary or unavailable |
| `qa-only` | Report-only verification, screenshots and reproduction steps | Follow authorized test journeys and disposable-data boundaries; report defects without editing the target. Use host-supported checks if unavailable |
| `animate` | Implement or adjust specified motion in a requested build | Measure target motion through the UI/UX guide first. New motion is a design choice, not recovered evidence |
| Figma source/specification/implementation skills | A selected Figma source or requested Figma deliverable | Preserve their access and asset rules. Ordinary browser/native analysis has no Figma dependency |
| Browser or OS automation skill | Operate the selected interface for an authorized capture or test | Choose available tools and their real schemas; preserve the passive-versus-action distinction in [runtime observation](runtime-observation.md) |

Follow the user's design workflow when implementing or improving an interface.
Skills such as `quiet-ui`, `design-libraries`, or `design-review` belong to those
phases when applicable. A design review that edits code is not an observation-only
pass. Preserve the reference's design in a fidelity task, and label deliberate
changes in the implementation decisions.

Helpers do not grant new permissions or require unrelated setup. A helper's
broader defaults cannot enlarge the user's request. If those defaults cannot be
scoped to the selected phase, use this guide's core procedure and say the helper
was not invoked. Do not start parallel agents merely because an optional helper
exists; follow the active delegation instructions.

## Continue into reconstruction only when requested

Translate recovered requirements into the target stack, reusing compatible
project components and real callbacks. Keep source-derived facts distinct from
proposed APIs, replacement assets and architectural choices. Preserve original
target files. Use authorized source material and disclose missing resources.

For a working slice, cover its meaningful states in component fixtures and its
end-to-end journey in the application. Keep mocked services and synthetic data
identified. A screenshot match, component demo or successful HTTP response does
not prove integrated persistence. Use the [UI/UX verification criteria](ui-ux-deconstruction.md#8-verify-and-close)
for context matching, tolerances, temporal checks and accessibility limits.

## Keep one handoff and close the request

Use one evidence index and stable feature/component/flow IDs across routes. A
route handoff contains the target identity, selected scope, evidence locators,
findings, unknowns and next acceptance check. Record proposed changes separately.

Before finishing, compare the output to the original checklist. State the routes
and helpers actually used, deliverable locations, observed verification results,
and partial/unresolved claims. Do not describe an instruction-only review as a
live run. Release owned captures and restore temporary settings within scope.
The user should receive one coherent result without needing to orchestrate the
supporting skills.
