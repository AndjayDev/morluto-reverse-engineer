# UI/UX specification template

Use with [UI/UX deconstruction](ui-ux-deconstruction.md). Copy the sections needed
for the task into its report; add rows with stable IDs. Empty cells are not
verification. Write unknown, blocked, untested, or not applicable with a reason.
Keep raw captures separately and link exact locators. Do not copy private data or
restricted assets into a public report.

## Scope and evidence index

- Target and version/digest:
- User tasks, selected screens/journeys, exclusions:
- Environment: browser/OS, viewport/window, scale/zoom, locale, theme, input,
  reduced motion, role and data fixture:
- Capture tools, action scope, time window, omissions and cleanup:

| Evidence ID | File/source/REA ID and exact locator | Conditions/time | Observed, declared, derived, inferred, or unknown | Limits |
| --- | --- | --- | --- | --- |

## Screen and navigation map

| Screen/overlay ID | Entry and parent | Content objects/terminology | Choices and destinations | Back/cancel/restore behavior | Evidence |
| --- | --- | --- | --- | --- | --- |

Attach an annotated hierarchy or route diagram when it makes relationships clearer.
Separate visible grouping, DOM/native hierarchy, and inferred component boundaries.

## Layout, tokens, themes, and assets

| Component/context | Grid/flex/constraints | Spacing and sizing | Containment/scroll/layers | Responsive/content rule | Evidence/class |
| --- | --- | --- | --- | --- | --- |

| Token/role | Original name or proposed name | Source value/unit and alias chain | Resolved light/dark values | State/context | Evidence/class |
| --- | --- | --- | --- | --- | --- |

Include typography, colors, spacing, radii, borders, shadows, elevation, and motion
tokens where established. Preserve raw values alongside any normalization.

| Asset ID | Source/digest | Component/variant usage | Dimensions/format/crop | Retrieval and reuse status |
| --- | --- | --- | --- | --- |

## Component blueprint

Repeat for each selected family:

- Component ID, responsibility, anatomy/slots and parent/children:
- Recovered versus proposed API: inputs, outputs/events, variants and data needs:
- State owner, initial state, guards and concurrency/cancellation behavior:
- Layout, tokens, theme/responsive rules and asset IDs:
- Accessible role/name/description, relationships, keys and focus contract:
- Linked flow/state/motion IDs, evidence, uncertainties and proposed improvements:

| State | Entry action/condition | Visual and semantic changes | Allowed actions | Exit/recovery | Evidence and coverage |
| --- | --- | --- | --- | --- | --- |

Assess default, hover, focus, active, disabled, loading, error, and empty. Add
selected, expanded, invalid, success, stale/offline and read-only where relevant.
Explain inapplicable states rather than inventing behavior.

## Flow and network timeline

| Flow/step | Initial state and guard | Action/decision | Immediate/pending feedback | Request/event evidence | Confirmation/failure/recovery | Focus/announcement |
| --- | --- | --- | --- | --- | --- | --- |

Record action and UI checkpoint times, request identifiers, capture clock/basis,
and whether links are source-supported or time-only correlations. Include
optimistic update/rollback, background refresh/polling, retry/cancel, and
persistence checks when applicable. Label simulated responses explicitly.

## Motion and gesture record

| Motion ID | Trigger/elements/properties | Start/end values | Duration/delay/curve or spring settings | Sequence/stagger | Interruption/reduced motion | Evidence/method/uncertainty |
| --- | --- | --- | --- | --- | --- | --- |

For gestures/scroll, add modality, hit area, scroll root, axes, thresholds,
constraints, release velocity/units, snapping and cancellation. Distinguish
declared parameters from measured estimates and proposed equivalents.

## Accessibility observations

| Component/flow | Semantics/name/landmark | Keyboard/focus check | Actual announcement and AT environment | Contrast/reflow/motion check | Result/evidence/gap |
| --- | --- | --- | --- | --- | --- |

Keep observed defects separate from proposed accessible corrections. An untested
screen reader path stays unverified even when the accessibility tree looks correct.

## Acceptance and completion

| Check ID | Scope and initial conditions | Action | Expected visible/semantic outcome | Evidence basis | Method/tolerance | Actual result and gap |
| --- | --- | --- | --- | --- | --- | --- |

Use passed, failed, untested, blocked, or not applicable with reasons. A completed
specification and a verified reconstruction are separate results. List:

- Answered scope items and supporting evidence:
- Partial/unresolved items, reasons and next useful checks:
- Source/runtime contradictions and their disposition:
- Proposed implementation decisions or UX improvements:
- Runtime/reconstruction checks actually performed and remaining acceptance work:
- Capture cleanup/restoration and retained artifact locations:
