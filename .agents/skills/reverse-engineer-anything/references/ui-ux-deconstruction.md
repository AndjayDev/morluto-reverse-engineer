# UI and UX deconstruction

Use this guide to turn a selected interface into an implementable specification.
It applies to browser, Electron, native, and supplied-capture investigations;
choose methods the host actually supports. Analysis does not require building a
clone. Use the [specification template](ui-ux-spec-template.md) for outputs.

Contents: [scope](#1-scope-and-evidence), [inventory](#2-discover-the-interface),
[visual extraction](#3-extract-visual-and-system-design),
[states](#4-inspect-states-and-data-feedback), [motion](#5-measure-interaction-and-motion),
[UX and accessibility](#6-map-ux-and-accessibility),
[handoff](#7-produce-reusable-specifications), [verification](#8-verify-and-close).

## 1. Scope and evidence

Record target URL/package/version or artifact digest, selected journeys, role,
data fixture, browser/OS, viewport in CSS pixels, device scale, zoom, locale,
theme, input modality, and reduced-motion setting. Mark unknowns. For native
targets record window size and display scaling. Select representative contexts
rather than testing every possible combination; state the omitted combinations.

Use stable IDs for screens, components, states, transitions, and captures. Each
finding carries an evidence locator (REA Evidence ID when supplied; otherwise
file/path, source range, screenshot region, or recording timestamp), capture
conditions, and one of these evidence classes:

- **Observed:** a rendered state, action outcome, or accessibility announcement
  actually captured in the specified environment.
- **Declared:** a CSS rule, token, handler, route, asset, or timing parameter found
  in source/package data; execution and current applicability are unproven.
- **Derived:** a calculation from identified measurements, with method and units.
- **Inferred:** a proposed component boundary, semantic token, mental model, or
  behavior not directly established. Include rationale and a way to check it.
- **Unknown:** inaccessible, untested, truncated, or conflicting evidence. Give
  the reason and next useful check. Do not convert missing evidence to absence.

Evidence class is separate from confidence and coverage. A precise CSS value can
be confidently declared while its live use remains unknown. Give external
captures their own provenance; do not invent REA Evidence IDs for them.

### Choose the inspection route

| Input | Start with | What it cannot establish alone |
| --- | --- | --- |
| Source or extracted package | Targeted component/style/asset searches; existing JavaScript analysis when useful | Active rendering, executed branches, timing, or successful persistence |
| Existing browser/Electron target | Advertised discovery and passive DOM/accessibility/network/screenshot capture | Actions before attachment or actions performed by the agent |
| Agent-operated browser journey | Declared scenario actions and captures; read [runtime observation](runtime-observation.md) | Full computed-style or motion inspection unless the tool actually exposes it |
| Native interface | Available OS accessibility inspector, screenshots, declared user/agent actions, and selected packaged resources | DOM/CSS; accessibility trees also omit custom-drawn content |
| Screenshots/video only | Annotated geometry, visible states, timestamped changes, asset references | Hidden hierarchy, original tokens, exact spring physics, complete navigation, or assistive-technology behavior |

Check tool schemas before using them. Computed styles, animation inspection,
throttling, and arbitrary evaluation below are DevTools/host procedures, not
promised REA parameters. Use them only through a tool that supports them and
within the authorized target/action scope; otherwise retain the gap. Preserve
originals and unsaved state. Use disposable data for writes, failures, retries,
or offline experiments; do not broaden an observation into a production mutation.
Keep private captures and credentials out of a public handoff. Inspection of an
asset does not establish permission to redistribute it.

## 2. Discover the interface

1. Inventory the app shell, navigation, routes/screens, dialogs, menus, drawers,
   panels, and repeated content patterns. Record entry points and nested
   navigation, deep links, back/forward behavior, and restoration after reload.
2. Walk the selected user tasks from entry to completion or recovery. Record
   actions, choices, prerequisites, visible feedback, and exit/cancel paths.
   Distinguish observed terminology from inferred user goals or mental models;
   behavior alone does not prove designer intent or usability.
3. Select representative component families and contexts: repeated rows/cards,
   forms, selection controls, navigation, overlays, and data views. Include short
   and long content, empty and populated data, and narrow/wide layouts when
   supported. Record theme and role variants, including inaccessible ones.
4. Build a capture matrix of component × state × relevant context. Default,
   hover, focus, active, disabled, loading, error, and empty each receive observed,
   declared-only, untested, blocked, or not-applicable status with a reason.
   Add selected, expanded, invalid, success, stale, offline, or read-only states
   when the component needs them. Container empty states need not be invented
   for leaf controls. Distinguish pointer-down `:active` from persistent selection.

## 3. Extract visual and system design

### DOM, hierarchy, and layout

1. Capture a baseline screenshot and a bounded DOM/accessibility subtree for
   the same state and time window. Identify elements by stable role/name and a
   source or DOM locator; record ambiguity in selectors. Trace the selected node
   through ancestors to its layout container, scroll root, and overlay root.
2. Record semantic hierarchy separately from rendered nesting and proposed
   reusable components. DOM wrappers do not prove framework component boundaries.
   Note portals, shadow roots, iframes, virtualization, and canvas/custom drawing;
   report inaccessible subtrees instead of claiming a complete inventory.
3. In supported DevTools, inspect the box model and grid/flex overlays. Record
   display, row/column tracks, gap, alignment, padding, margin, min/max sizes,
   aspect ratio, flex growth/shrink, and fixed/fluid dimensions. Capture bounding
   rectangles with their coordinate space, scroll position, and transforms.
4. Trace containment: overflow/clipping, scroll ownership, sticky/fixed anchors,
   containing blocks, stacking contexts, z-index, and overlay collision behavior.
   Test long text and content resizing where authorized; do not derive responsive
   rules from a single viewport. Check both sides of source-declared or observed
   breakpoints/container thresholds, distinguishing interpolation from evidence.

### CSS, tokens, and themes

1. Read matched CSS declarations, stylesheet/source ranges, cascade layers,
   specificity, inherited values, custom properties, media/container queries,
   and theme selectors for representative elements. Save original values and
   their resolved values separately; inline `style` is not the full cascade.
2. Where supported, take bounded snapshots of selected properties through the
   computed-style panel or `getComputedStyle(element)` and relevant pseudo-elements.
   Save values at capture time: the API result is live, and resolved pixel values
   do not recover original token names or units. See the
   [CSSOM API reference](https://developer.mozilla.org/en-US/docs/Web/API/Window/getComputedStyle).
3. Extract primitives and semantic aliases: colors (including alpha and color
   space), text/surface/border/status roles, spacing, radii, border widths,
   shadows, elevation, opacity, and layering. Preserve alias relationships and
   exceptions. Cluster repeated values into **candidate** scales only; equal
   pixels do not prove a shared token. Screenshot color samples are estimates
   affected by compositing and rendering.
4. Record typography family/fallback, actual rendered font when inspectable,
   size, weight, line height, letter spacing, variable axes, wrapping, truncation,
   and text roles. Separate loaded assets from declared font stacks. Missing
   fonts and substituted glyphs are fidelity gaps, not original design choices.
5. Capture the same components/states in supported light and dark themes.
   Map semantic role → source alias → value per theme, including elevation and
   interaction variants. Record system preference versus explicit override and
   persistence only when checked. Never infer dark mode by inverting colors.

### Assets

Inventory referenced images, SVGs/sprites, icons, fonts, cursors, and motion
assets from selected DOM/CSS/package resources. Match each to its component,
variant, dimensions/viewBox, crop/fit, scale, and theme usage. Record its source,
digest when bytes are available, format, and known license/reuse limits.

Copy selected permitted package files or save authorized resources to a new
output directory with a manifest. Keep originals unchanged. An observed URL is
not authorization to fetch an entire asset library; do not replay signed URLs,
send credentials to other origins, or bypass inaccessible resources. If retrieval
or redistribution is unavailable, document the reference and required replacement
without presenting a substitute as extracted source material.

## 4. Inspect states and data feedback

For each selected component, record before state → trigger/guard → immediate
feedback → pending state → confirmed/error state → recovery. Include labels,
enabled actions, focus movement, layout changes, and accessibility updates.
Exercise real pointer/keyboard interaction where possible. A forced CSS
pseudo-state verifies styling only, not event behavior or application state.

Observe loading indicators, skeletons, progress, empty versus no-results states,
validation, disabled versus read-only behavior, and recoverable versus blocking
errors. Determine which inputs/data survive retry, cancel, navigation, and
reload. A toast saying “Saved” is visible feedback, not proof of persistence.

### Correlate requests with state

1. Start the selected network capture before the action; record baseline,
   action time, request IDs/methods/safe endpoint labels, response status/timing,
   UI checkpoints, and cache/service-worker indicators when available. Collect
   only payload details needed for the question and permitted by the tool.
2. Link candidate requests to UI transitions using request IDs, initiators when
   available, and source handlers. Label time-only matches as correlation. Use
   the [runtime guide](runtime-observation.md) for passive/scenario differences;
   scenario records do not supply request initiator stacks.
3. For optimistic UI, capture the visible update before confirmation and the
   success reconciliation or failure rollback. In a disposable authorized
   environment, test latency, rejection, retry, cancellation, and repeated input.
   Record any test-induced throttling or response substitution; a simulated
   failure documents client behavior under that condition, not a real outage.
4. For background polling, revalidation, subscriptions, or long jobs, record
   observed intervals and window length, pending/stale indicators, completion,
   error feedback, and navigation/reconnection behavior. Repeated requests alone
   do not prove polling; an interval estimate does not prove a scheduling rule.
5. Verify persistence with an authorized reread/reload when in scope. Distinguish
   frontend feedback, HTTP acknowledgment, and confirmed durable state. If cache,
   server semantics, or capture gaps prevent attribution, leave that unknown.

## 5. Measure interaction and motion

Create a motion record per selected transition, linked to the state/flow IDs.

- Record trigger, elements, properties, start/end values, transform origin,
  delay, duration, easing/keyframes, iterations, and interruption/reversal rules.
  Separate time until feedback begins, animation duration, and network wait.
- Inspect CSS transitions/keyframes and available animation tooling. With an
  authorized evaluation tool, `element.getAnimations({subtree: true})` can expose
  active CSS/Web Animations; inspect supported effect keyframes and timing.
  This does not cover every JavaScript/physics or canvas animation. See
  [animation inspection scope](https://developer.mozilla.org/en-US/docs/Web/API/Element/getAnimations).
- Read source-declared cubic-bezier/steps/linear curves or library settings when
  available. For springs record library/version, stiffness, damping, mass,
  initial velocity, and rest thresholds only if exposed, with units/conventions.
  A fitted spring/easing curve is an approximation, not recovered configuration.
- For visual-only evidence, use timestamped frames to measure displacement,
  opacity, onset, settling, and overshoot. Report frame cadence, measurement
  resolution, run variation, and a range rather than fabricated exact timing.
  Repeat representative transitions where feasible. Compare controlled runs
  rather than mixing throttled, background-tab, and normal playback.
- Map orchestration: sequence/parallel groups, stagger order and offset, delays
  relative to events, layout reordering, entering/exiting items, shared-element
  continuity, and page/route transitions. Observe interruption, rapid reversal,
  and navigation cancellation when safe. Visual continuity alone does not prove
  a shared-element API or FLIP implementation.
- For gestures, record pointer/touch/trackpad modality, hit region, axes,
  thresholds, capture/cancel behavior, drag constraints, snapping, and keyboard
  alternatives. Sample slow/fast releases where supported; relate displacement
  and timestamps to estimated velocity with units. Preserve source-declared
  velocity thresholds separately from observed release outcomes.
- For scroll interactions, record scroll root, offset/progress range, direction,
  sticky boundaries, snapping, momentum, parallax, and any velocity-dependent
  response. Distinguish position-driven motion from time-driven animation.
  Mouse emulation does not prove touch/trackpad behavior.
- Recheck reduced motion: what is removed, shortened, or replaced, and whether
  feedback and task completion remain understandable. If a mode or device is
  unavailable, report the missing coverage.

## 6. Map UX and accessibility

Produce a route/navigation map and a decision/state table for the selected
journeys. Include entry conditions, objects and terminology, branch guards,
primary/secondary actions, disclosure order, confirmation, cancellation, error,
retry/undo, and completion. Note preserved selections, drafts, scroll position,
and focus across navigation. Label hypothesized mental models and friction as
interpretation; claims about user success need user research evidence.

Inspect accessibility separately from visual fidelity:

1. Capture semantic roles, accessible names/descriptions, headings, ARIA/native
   landmarks, relationships, selected/expanded/disabled/invalid/busy states, and
   live-region declarations. Compare the accessibility tree with visible labels
   and states. ARIA declarations alone do not establish assistive behavior.
2. Walk Tab/Shift+Tab order and visible focus; test activation keys, Escape,
   arrow keys and composite-widget navigation as applicable. Record initial
   focus, modal containment, background inertness, dismissal, and focus return.
   Include navigation after errors and controls exposed only on hover.
3. With available assistive technology, record screen reader/browser/OS versions,
   the action, actual announcements and ordering for loading, errors, validation,
   and async completion. Without that test, label announcements declared or
   unverified, even if `aria-live` exists.
4. Check selected foreground/background contrast, target dimensions, zoom/reflow,
   text resizing, reduced motion, and high-contrast/forced-colors behavior where
   applicable. Record measured values and the standard/version used for any
   compliance claim. A scoped inspection or automated scan is not a complete
   accessibility certification. Use the
   [WAI-ARIA patterns](https://www.w3.org/WAI/ARIA/apg/patterns/) as a comparison
   reference, not evidence of what the target does.

Document observed defects faithfully. In a proposed reconstruction, put accessible
corrections and other UX improvements in a separate decisions section; do not
silently describe proposed behavior as recovered behavior.

## 7. Produce reusable specifications

Use the [template](ui-ux-spec-template.md) to deliver:

- A scope/capture index and coverage matrix with evidence links and gaps.
- An annotated screen/navigation map and layout rules across sampled contexts.
- A token/asset inventory preserving original names, aliases, values and units;
  mark proposed semantic names and redistribution limits.
- Component blueprints with responsibility, anatomy/slots, variants, inputs,
  outputs/events, controlled state, layout rules, state transitions, motion,
  data feedback, and accessibility contracts. Proposed APIs are implementation
  choices unless recovered directly from source.
- Flow and motion tables detailed enough to implement and verify independently.
- An acceptance matrix: initial conditions, actions, expected visible/semantic
  outcomes, evidence, method, tolerance, actual result, and remaining uncertainty.

For a requested build, map the blueprint to the chosen stack and existing
compatible components. Use stories or equivalent fixtures for meaningful states
and transitions, plus journey checks for integration. Keep fixtures separate from
live services. A component story does not prove routing, persistence, or native
behavior. No library, provider installation, publication, or build is required
merely to deliver a UI/UX analysis.

## 8. Verify and close

Review the original scope against these exit criteria:

| Area | Required evidence for the claimed result |
| --- | --- |
| Coverage | Every selected screen/journey and applicable state has evidence or an explicit gap; not-applicable decisions include reasons |
| Visual system | Layout/token/theme claims trace to declarations or measurements; responsive claims include multiple relevant contexts |
| Interaction/data | Selected actions have before/pending/after evidence and recovery coverage; simulated and real outcomes are distinguished |
| Motion | Timing/curve sources and units are recorded; measured estimates, unsupported physics, and untested input modalities remain explicit |
| UX/accessibility | Decision paths, keyboard/focus results, semantics, and actual versus untested announcements are documented |
| Handoff | Each blueprint links evidence and acceptance checks; inferred APIs and improvements are labeled; assets have provenance/reuse status |

Replay representative journeys from a known initial state when runtime access
exists. Reconcile source, pixels, tree, and network disagreements instead of
averaging them away. Recheck changed claims; do not repeatedly capture already
resolved evidence without a reason.

When verifying a reconstruction, compare target and implementation under matching
viewport, scale, theme, fonts, content, state, and motion settings. Use overlays
or image differences for layout plus DOM/semantic and action checks for behavior.
Choose explicit task-appropriate tolerances before comparison; mask only declared
nondeterministic regions. Compare temporal checkpoints for motion, not just final
frames. Record mismatches and fixes; pixel similarity is not interaction fidelity.

Close with answered, partial, and unresolved scope items and the next checks
needed for unresolved claims. Report specification completion separately from
runtime coverage and reconstruction acceptance. Release owned capture resources
and restore any temporary test settings or fixtures within the authorized scope.
