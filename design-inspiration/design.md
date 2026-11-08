# Credential Reaper — Design Direction

Cyberpunk redesign brief for `apps/web`, derived from `references.md` and the two recordings in `recordings/`.

> **Scope rule: this document is a spec only.** Producing it involved no changes to application source (`apps/web`, `workers/api`, `spacetime/module`, `packages/shared`). Implementing it is a separate task. Everything below is written so it can be implemented as presentation-layer changes without altering routes, data contracts, API shapes, or the invariants in `CLAUDE.md` §6 (no real credential is ever touched; risk is computed by the backend, not the AI).

---

## 1. Current frontend (what exists today)

Read from `apps/web/src`, ~1,100 lines total.

**Stack.** React 19, Vite, `react-router-dom`. Styling is a single hand-written file, `src/index.css` (277 lines): CSS custom properties on `:root`, plain class names, no CSS framework, no component library, no icon set, no webfonts.

**Shell.** `components/Layout.tsx`: 220px left sidebar (brand `☠ Credential Reaper` + 4 `NavLink`s) and a `<main>` capped at 1200px, wrapped in an `ErrorBoundary` keyed by pathname.

**Routes** (`App.tsx`):

| Route | Page | In-app name | What it shows |
|---|---|---|---|
| `/` | `TheGrid` | The Grid | Table of all machine identities (name, type, owner, team, last used, status, risk). Row click goes to detail. |
| `/identities/:id` | `IdentityDetails` | — | Overview card, credentials metadata, permissions table, dependencies table, usage history table. |
| `/investigations` | `Investigations` | — | "Start investigation" form (select + button), then one card per investigation: summary, collapsible backend risk score, recommended action, findings table (severity / category / basis / description / evidence), collapsible agent tool trace. |
| `/afterlife` | `TheAfterlife` | The Afterlife | Vertical timeline of audit events. |
| `/remediation` | `Remediation` | — | One card per plan: justification, ordered steps (automatable/manual), "Simulate (dry run)" button. |

**Current tokens** (`index.css`):

- Surfaces: `--bg #0b0e14`, `--bg-elevated #12161f`, `--border #232838`
- Text: `--text #e4e7ee`, `--text-dim #8a90a3`
- Accent: `--accent #6ee7b7` (mint), `--accent-dim #2d5c48`
- Severity: critical `#ff5c7a`, high `#ffa94d`, medium `#ffd43b`, low `#6ee7b7`, each with a dark tinted `-bg`
- Type: system sans stack (`-apple-system, Segoe UI, Roboto…`), one mono stack used only by `.mono`
- Shape: 6px radius on buttons/inputs/nav, 10px on cards, fully-rounded pill badges

**Reusable pieces.** `Badges.tsx` (`RiskBadge`, `StatusBadge` mapping every status to one of `critical | high | medium | low | neutral`), `.card`, `.btn` / `.btn-secondary`, `.timeline`, `.empty-state` / `.error-state`, `.grid-2`.

**Observations that shape the redesign:**

1. There is **no landing page**. `/` is the inventory table. The brief asks for a landing page, so this is the main structural addition.
2. Page chrome is already thin and token-driven, so a theme swap is mostly a change to `:root` values plus font loading. Components don't hard-code colors; the exceptions are a few inline `style={{…}}` props for spacing.
3. Dark-only already (`color-scheme: dark`). No light theme to maintain.
4. Everything is a table or a card. There is no data visualisation anywhere, and the identity relationship data (`IdentityDependency`) is only shown as a flat table on the detail page.
5. Every page has the same three states (loading / empty / error) rendered as centred dim text. These should be themed too, not left as plain text.

---

## 2. References

### Reference 1 — typography + landing layout (`screenrecording-2026-11-07_22-14-01.mp4`)

A dark infrastructure-product landing page ("Stratum", from the Impeccable gallery). Extracted from the recording:

- **Palette.** Near-black with a faint green cast: page `#0a0f0c`, panels `#0e130f`. Single saturated phosphor green for headlines, the primary CTA (`#48ff24` fill, black text) and "healthy" state. Amber (`#d69e00`-ish) is the only other accent, used for caution badges and "armed" states. White/light grey for body copy.
- **Display type.** All-caps, dot-matrix / LED-style pixel face in phosphor green, very large, tight leading, ending each line with a small `+` glyph (e.g. `ONE SERVICE+ / EVERY REGION+ / NOTHING TO GLUE+`). Section titles reuse it at a smaller size (`THREE VERBS, ONE NOUN+`, `DEPLOY`, `OBSERVE`, `SCALE`).
- **Body type.** A clean monospace for paragraphs, nav, labels and code. Key phrases in body copy are **bold** for emphasis, not coloured.
- **Nav / labels.** Tiny uppercase monospace with wide tracking (`DOCS  CHANGELOG  GITHUB  SIGN IN`, `TIMEBASE`, `TRIGGER`, `REPLICAS`). Brand is a small green wordmark with a dim product descriptor beside it, separated by a hairline.
- **Buttons.** Primary: solid green, black uppercase mono text, an arrow (`→`), square corners. Secondary: transparent with a 1px light outline, uppercase mono.
- **Containers.** Square-cornered panels separated by 1px hairlines in a slightly lighter green-black. No shadows, no gradients, no rounding. The page reads as a single framed instrument.
- **Terminal snippets.** Dark inset boxes with a `$` prompt, a command, then dim output with a green `locked`/`ok` status word.
- **Section pattern.** Rows split by hairlines into columns: large pixel-font label (left) · terminal snippet · prose · a single big metric (right).
- **Metric tiles.** A strip of 5 tiles with a tiny uppercase label, a seven-segment/LCD-style numeral whose unlit segments are faintly visible, and a dim unit underneath.
- **Status chip.** Small bordered amber chip with a dot (`SYNTHETIC SIGNAL · NOT A BENCHMARK`), which is a useful model for honest "demo data" labelling.

**Explicitly excluded** (per `references.md`): the oscilloscope / frequency panel on the right of the hero (waveform canvas, channel list, mode toggle, timebase/trigger). That slot is taken by the network map from Reference 2. Don't reproduce waveforms.

### Reference 2 — network map (`networkingmap.mp4`, revised full-frame version)

> The recording in `design-inspiration/recordings/` is still the earlier cropped version. The corrected, full-frame recording is at `~/Videos/networkingmap.mp4` (9.6 s, 1858×1052). This section is based on that file. Copy it into `recordings/` to keep the reference with the repo.

A cyberpunk SOC/threat-dashboard concept (Behance, "Data Dashboard Presentation Interface Design"). The recording shows three states of one screen:

**State A: overview HUD (three columns plus a bottom bar).**

- **Left column.** `KEY INDICATORS`: a radar/spider chart with ~10 labelled axes, each axis label followed by a tiny `n / total` value in teal. `SUGGESTED IMPROVEMENTS`: a stack of bordered rows, each with an uppercase label and a row of 1–5 small square "strength" pips on the right, then one full-width outlined `SIMULATE` button. Bottom-left: a large `4,9` score block labelled `COMPLIANCE SCORE`, an `ISSUES` tab, and three small stat chips (`5 ACTUAL`, `12 PREVENTED`, `43/21 PREDICTED`) where the inactive chips are dimmed.
- **Centre.** `NETWORK MAP`: ~25 small square node chips with tiny uppercase labels (`WEB SERVER`, `CO DESKTOP`). A tight cluster sits near the centre and a handful of larger peripheral nodes sit at the edges. Many thin Bézier links sweep from the periphery into the cluster and cross each other at low opacity so density reads as texture. Small bright pulses run along some links. Faint dashed concentric circles sit behind everything.
- **Threat animation.** One peripheral node (top left) is marked with a red-orange chip. A red link from it animates toward the cluster, brighter than the teal links, then settles. This is the only place red appears on the map.
- **Right column.** `TRAFFIC MAP` (world map with arcs) and `EVENTS LOG`: stacked cards with chamfered/bracketed corners, a bold uppercase event title (`UNUSUAL TRAFIC`, `DDOS ATTACK`, `SQL INJECTION ATTACK`) and a dim mono line of metadata (`IP … | PAYLOAD … | SUR1 SUR2`). Cards fade out towards the bottom.
- **Bottom bar.** Three chamfered pill selectors under the map: `ACTUAL` (period of time), `ALL` (node category), `ALL` (connection status). Bottom right: a dashed, dim hint box (`PRESS TO TURN ON VOICE CONTROL`).

**State B: sub-network drill-down overlay.** Selecting a node dims the whole dashboard and opens a dark overlay panel:

- Top left: title `R&D SUB-NETWORK` with four dim key/value lines (`ORIG. IP`, `EXT. IP`, `PAYLOAD`, `TYPE`).
- Below it: a large octagonal ring badge with a `THREAT LEVEL` caption, a centre chip with a short label, and a small row of lit/unlit pips. Ring is teal when healthy and red-orange when threatened.
- Two small lists under it: `INTERNET` and `INTERNAL NETWORK`, and below those `DEVICES POTENTIALLY UNDER RISK`, each entry a name plus a dim address line, fading out at the bottom.
- Centre/right: an **ego graph**. The selected node and its neighbours are drawn as round "bubbles" (a circle around a chip icon with a distinct glyph per kind: desktop, document, link, etc.), joined by straight bright lines and sitting on dashed concentric rings. A compromised node is red with a red halo and an alert glyph.
- Bottom: a list of issue rows, each with an orange/red bullet, an alert icon, an uppercase title, a few dim metadata columns (department, type, payload, time) and a right-aligned outlined capsule action (`RAISE A TICKET`, `UPDATE REQUEST`). Rows fade out downward.

**State C: node focus in the overview.** Without opening the overlay, the hovered/selected node gets a thin circular halo, and the links of everything else dim, so one node's connections stand out. (The recording shows this transition between A and B.)

**Palette and detail common to all states.** Near-black (`#020706`) with a single teal/cyan (approx. `#2fd0c0`) for nodes, links and text, plus red-orange as the only alert colour. Thin outer frame with small corner ticks. Tiny uppercase mono for every label. Panels titled in dim uppercase with corner brackets.

### Your direction (`references.md`)

- Cyberpunk theme overall.
- Landing page: Reference 1's typography and layout, minus the frequency panel.
- Landing page: an interactive network map of **all existing machine identities, with their history** (Reference 2).

---

## 3. Design principles

1. **One instrument, not a dashboard of cards.** Square corners, hairline borders, no shadows, framed panels. Replace the current 10px-rounded cards.
2. **Phosphor green is the brand; amber and red are state.** Don't spend colour on decoration. Colour means status.
3. **Colour is never the only signal.** Every severity/status already renders its text label in a badge; keep that. Don't make the map rely on hue alone (use ring style, icon glyph, and label as well).
4. **Display font for headings only, mono for everything else.** The pixel face is legible at large sizes only; never use it for paragraphs, table cells or small labels.
5. **Glow is an accent, not a default.** Neon glow only on the primary CTA, the selected node, and critical-risk elements, so the critical state still stands out.
6. **Honest data labelling.** The seed dataset is demo data (4 identities). Show a small amber "DEMO DATASET" chip like Reference 1's `SYNTHETIC SIGNAL` chip whenever the app is showing seeded data.
7. **Motion respects `prefers-reduced-motion`.** Pulses, scanlines, flicker and typing effects all switch off; the map stays fully usable and static.

---

## 4. Design tokens

Drop-in replacement values for the existing variable names in `index.css`, so existing rules keep working. New variables are added alongside. Hex values for green/amber/background are sampled from the recording; the teal and red are estimated from the artwork and should be tuned on a real screen.

```css
:root {
  /* surfaces (existing names) */
  --bg:            #0a0f0c;   /* page; sampled from Ref 1 */
  --bg-elevated:   #0e130f;   /* panels; sampled from Ref 1 */
  --border:        #1b2a21;   /* hairlines, slightly lifted from bg */
  --text:          #e6efe8;   /* body, faint green cast */
  --text-dim:      #7f9486;   /* labels, metadata. Check >= 4.5:1 on --bg */

  /* brand */
  --accent:        #48ff24;   /* phosphor green; primary CTA fill (sampled) */
  --accent-dim:    #123d12;   /* active nav background, selected row */

  /* new: second accent for the network map (Ref 2) */
  --signal:        #2fd0c0;   /* node/link glow */
  --signal-dim:    #0f3b37;
  --map-bg:        #020706;   /* map canvas, darker than the page */

  /* severity (existing names; keep the 4-level scale) */
  --critical:      #ff3b5c;   --critical-bg: #2e0d16;
  --high:          #ff8a1f;   --high-bg:     #2e1a08;
  --medium:        #e6b800;   --medium-bg:   #2a2406;
  --low:           #2fd0c0;   --low-bg:      #0b2623;
}
```

Notes:

- `--low` moves from green to teal on purpose. Today `--low` and `--accent` are the same mint, so a "low risk" badge looks like a primary action. With a lime accent, "low" in teal and "active" in teal-or-green stays distinguishable from buttons.
- The amber `#d69e00` sampled in Ref 1 is close to `--medium`; no separate amber token is needed.
- Verify contrast for `--text-dim` and every `-bg`/foreground badge pair before shipping; dim green on near-black is the likeliest failure.

### Typography

| Role | Face | Where |
|---|---|---|
| Display | **Doto** (primary; dot-matrix, closest to the Ref 1 headline) with **VT323** as the interchangeable alternate. Uppercase, large. | Landing hero, page `<h1>`s, section titles, brand wordmark |
| Mono | **JetBrains Mono**, **IBM Plex Mono** or **Space Mono** (any clean programmer mono). | Body text, nav, labels, tables, badges, buttons, terminal snippets |
| Numerals | The display font's numerals (Doto or VT323). A separate seven-segment face is not needed. | Landing KPI strip, hygiene score, risk score only |

**Font decision (decided: Doto and VT323, interchangeable; pick the better one at implementation).** Recommendation so the implementer doesn't have to re-derive it:

- Use **Doto** as the default `--font-display`. It renders as dots like the reference, has weight axes, and holds up at hero size.
- Use **VT323** as the fallback and as the choice for small terminal-style accents (the `$` prompt snippets, LCD numerals), since it stays legible at 16–24px where dot-matrix faces get noisy.
- Wire both through a single CSS variable (`--font-display`) so swapping is a one-line change. Check that the chosen face has a `+` glyph and numerals before finalising.
- Neither face is suitable below ~16px or for table cells and paragraphs; those stay in the mono face.

- Replace the current system-sans stack entirely; the app should not mix sans and mono. Load fonts via `@fontsource` packages or self-hosted files so the app works offline and without a third-party request. (The repo pins no font dependency today; adding one is an implementation-time decision.)
- Scale: display `clamp(2.5rem, 7vw, 5.5rem)` with line-height ~1.0 on the landing hero, `1.75–2.25rem` for page titles, body `14px`, labels `11–12px` uppercase with `letter-spacing: 0.08–0.12em`.
- Body paragraphs may emphasise with `font-weight: 700`, as in Ref 1.

### Shape, borders, effects

- `border-radius: 0` everywhere, including badges (replace pills with square bordered tags) and inputs. The one allowed exception is circular halos on the map.
- 1px `--border` hairlines; `--accent` or `--signal` for the active/selected one.
- **Chamfered corners / corner brackets** (Ref 2) on the two or three panels that deserve emphasis (event feed entries, the selected-identity panel): implement with `clip-path` or four small corner pseudo-elements, not images.
- Glow: `box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 40%, transparent)` on the primary button and selected node only.
- Optional, subtle, and off under reduced motion: a faint CRT scanline overlay (`repeating-linear-gradient`, <= 4% opacity) on the landing hero and map only, never over tables (it hurts readability).

---

## 5. Layout and navigation

**Decided: add a landing page at `/`** and move the inventory table to `/grid` (it keeps its in-app name, "The Grid"). Update the nav accordingly.

**Decided: sidebar inside the app.** Every route except the landing keeps a persistent left sidebar, restyled: uppercase tracked mono labels, square corners, a hairline right border, and a green left-edge marker plus `--accent-dim` fill on the active route. Keep the existing 220px width unless the display-font brand wordmark needs more.

**The landing page `/` is full-bleed with no sidebar**, like Ref 1: a top bar with wordmark + product descriptor, a short nav row (`THE GRID`, `INVESTIGATIONS`, `THE AFTERLIFE`, `REMEDIATION`) and one primary CTA. This means `Layout` needs a second shell variant (landing vs. in-app), which is a structural change, not just CSS.

Nav labels and routes:

| Label | Route |
|---|---|
| Overview (landing) | `/` |
| The Grid | `/grid` |
| Investigations | `/investigations` |
| The Afterlife | `/afterlife` |
| Remediation | `/remediation` |

Content width: raise the current 1200px cap for the landing and map (they should use the full viewport); keep tables comfortable at ~1200–1400px.

---

## 6. Landing page spec (`/`)

Two-column hero on desktop (stacks on narrow screens, map second):

**Left column (Ref 1 typography, copied structurally):**

1. Dim product descriptor beside the brand: `CREDENTIAL REAPER · MACHINE IDENTITY`.
2. Display headline, phosphor green, ending each line with `+`. Draft copy to adapt:
   `EVERY KEY+ / EVERY BOT+ / NOTHING FORGOTTEN+`.
3. One paragraph of mono body copy, with the key phrase in bold. Draft: "Credential Reaper inventories every **machine identity** you own, investigates the ones that outlived their purpose, and retires them safely, as a dry run first."
4. Two buttons: primary `OPEN THE GRID →` (green fill) and secondary `START AN INVESTIGATION` (outline).
5. A terminal-style status snippet under the buttons (Ref 1's `$ stratum deploy` box), e.g. `$ reaper scan` / `4 identities · 2 orphaned · 1 critical` / `locked`. These numbers should come from the real inventory, not be hard-coded.

**Right column:** the network map (section 7) in the slot where Ref 1 has the scope panel, with the `DEMO DATASET` amber chip in its header.

**Below the hero (optional, Ref 1 section pattern):** a three-row "verbs" section reusing the row layout of `DEPLOY / OBSERVE / SCALE` → `INVESTIGATE / REMEDIATE / SIMULATE`, each row: pixel-font label · terminal snippet · prose · one metric. Map to the real product flow: Netrunner investigation → proposed plan → dry-run simulate.

**HUD row (Ref 2 State A, below the hero):** a three-column strip that borrows the reference's side columns around the map:

| Reference panel | Credential Reaper equivalent | Data |
|---|---|---|
| `KEY INDICATORS` radar | Risk-factor radar across the inventory (axes such as ownership, dormancy, permissions, rotation, expiry). Optional and decorative; skip if no honest per-axis value can be derived. | Aggregate over `riskAssessment.factors` / finding `category`, or omit |
| `SUGGESTED IMPROVEMENTS` + `SIMULATE` | Proposed remediation plans with the strength pips showing risk level. The button is a link to `/remediation`; it does **not** simulate from the landing page. | `fetchRemediationPlans()` |
| `COMPLIANCE SCORE` block | `HYGIENE SCORE`: a single derived number (for example 100 minus the mean backend `riskScore`), labelled as derived. Three small chips: `ORPHANED`, `INVESTIGATED`, `SIMULATED`. | `fetchIdentities()`, `fetchInvestigations()`, `fetchRemediationPlans()` |
| `EVENTS LOG` | Latest audit events as chamfered cards. | `fetchAuditEvents()` |
| `TRAFFIC MAP` (world map) | **Dropped.** There is no geographic data. | n/a |

Risk scores shown here are always the backend's own values; the UI never recomputes or edits an identity's risk, only aggregates it for display.

**KPI strip (optional):** 4–5 tiles with LCD numerals, as in Ref 1: `IDENTITIES`, `ORPHANED`, `CRITICAL`, `INVESTIGATIONS`, `SIMULATED`. All computable from the existing `fetchIdentities`, `fetchInvestigations`, `fetchRemediationPlans` responses.

---

## 7. Network map spec

**Purpose:** show every machine identity in the system, together with its history, as an interactive graph.

### 7.1 What the data supports today (important)

Verified against `packages/shared/src/identity.ts` and `workers/api/src/spacetime/seed-data.ts`:

| Map concept | Source | Caveat |
|---|---|---|
| Identity nodes | `MachineIdentity` from `fetchIdentities()` | Seed data has only **4** identities, so the default map will look sparse next to the reference. |
| Node type glyph | `identity.type` (7 types) | Needs one small icon per type. |
| Node colour/ring | `riskLevel`, `status` | Already returned by the list endpoint. |
| Edges / neighbours | `IdentityDependency` (`name`, `kind`, `relationship`) | Only reachable per identity via `fetchIdentityDetail(id)`; the list endpoint doesn't include dependencies. Seed data has just **1** dependency row (`checkout-api` on `id-001`). Dependencies are keyed by free-text `name`, not by identity id, so two identities only appear linked if their dependency `name` strings match. |
| History | `createdAt`, `lastUsedAt`, `UsageEvent[]` (per identity detail), `AuditEvent[]` (`fetchAuditEvents()`) | Audit events carry `identityName`, not an id. |

Consequences for the implementer:

**Decided: the map is primarily a visual, accuracy is not critical.** That settles the open data question as follows:

- **No new endpoint.** Build the map from `fetchIdentities()` plus `fetchIdentityDetail(id)` for each identity (a handful of parallel requests via `Promise.all`; fine at demo scale). If the inventory ever grows to hundreds, revisit with an aggregate endpoint; that is explicitly out of scope now.
- A request failure for one identity's detail must not blank the map: draw that node without links and keep going.
- To avoid an empty-looking map, also draw nodes for **dependencies** (smaller, dimmer "resource" nodes) and for **owners/teams** (hub nodes, since `owner` and `team` are on every identity). Orphaned identities then visibly have no owner hub, which is the product's story.
- **Ambient texture is allowed, fabricated identities are not.** Extra faint background links, dashed rings, drifting pulses and unlabelled, non-interactive "dust" nodes may be added purely for density, as the reference relies on a busy graph. They must carry no names, can't be selected, and are never counted in KPIs, filters or the hygiene score. Never render a made-up identity that looks real.
- Richer seed data in `workers/api/src/spacetime/seed-data.ts` is optional and can be a separate change if the demo needs it. The map must look good with the current 4 identities.
- Node positions come from a deterministic layout (seeded from the identity id), not a live physics simulation, so the map looks the same on every load and costs nothing at rest.

### 7.2 Visual encoding

- **Canvas** `--map-bg`, with dashed concentric rings (Ref 2) and a faint grid. Rendered with `<canvas>` or SVG; no graph library is installed, and `CLAUDE.md` asks to avoid unnecessary dependencies, so hand-rolled SVG with a simple force or radial layout is preferred for this node count. If a library is chosen later, justify it in the PR.
- **Identity node:** a square chip with a glyph for its `type`, an uppercase mono label (`name`), and a dim second line (`type · environment`).
- **Risk:** chip border colour from the severity tokens. `critical` additionally gets a pulsing halo (Ref 2's red node). Don't use hue alone: critical also gets a thicker border and a `!` glyph in the corner.
- **Status:**
  - `active`: solid chip.
  - `stale`: dimmed to ~60% opacity, dashed border.
  - `orphaned`: a broken ring (dashed, with a gap) and **no owner link**. Reads as "disconnected".
  - `retired`: a ghost chip, outline only at ~25% opacity, no glow. This is how "history" appears for identities that no longer exist in a live state.
- **Links:** thin curved Béziers at ~20–30% opacity in `--signal`; pulses travelling along links only for `active` identities and only when motion is allowed. Dependency links for a selected node brighten and straighten.
- **Layout (Ref 2 State A):** a dense cluster near the centre with a few larger peripheral nodes, Bézier links sweeping from the edge into the cluster, dashed concentric rings behind. With few real nodes, place identities on the rings and dependencies/owners between them so the structure still reads as a radar.
- **Threat animation:** for `critical` and `orphaned` identities, animate one red link from the node toward the cluster (as the reference does once), then settle to a static red link. Everything else stays teal. Reduced motion: draw it static.
- **Hover / focus (Ref 2 State C):** a thin circular halo on the node, its links brighten, all other links dim to ~15%. Tooltip with name, type, status and risk.
- **Click: drill-down overlay (Ref 2 State B).** The dashboard dims and an overlay panel opens for that identity, laid out like the reference:
  - Top left: `<IDENTITY NAME>` as the title with dim key/value lines (`TYPE`, `OWNER`, `TEAM`, `ENVIRONMENT`).
  - Octagonal ring badge captioned `RISK LEVEL`, with the backend risk score as the numeral; ring is teal for low/medium and red-orange for high/critical.
  - Two lists under it: `PERMISSIONS` and `DEPENDENCIES` (the same data as the detail page), plus `CREDENTIALS` with `maskedPreview` only.
  - Centre/right: an ego graph of that identity and its dependencies/owner/team as round bubbles with per-kind glyphs on dashed rings; the identity is red if critical, and orphaned identities show a dangling, unconnected owner bubble.
  - Bottom: a list of issue rows from the identity's latest investigation findings (severity bullet, category, `basis` tag, description, fading downward), with right-aligned outlined actions. Actions are `OPEN DETAILS`, `START INVESTIGATION` and `VIEW REMEDIATION` (all navigation or the existing investigate flow). See the safety constraint in 7.4.
  - `Esc`, a close button, or clicking the dimmed backdrop closes the overlay.

### 7.3 History

Two complementary mechanisms; do the first for the MVP of this feature.

1. **Time scrubber** along the bottom of the map. Range from the earliest `createdAt` to now. Dragging it shows each identity as it was at that moment: not yet created (hidden), alive, stale (no `lastUsedAt` within a threshold), or retired. Play/pause animates it. Date label in the display font.
2. **Per-node history panel** (right side, see 7.4): when a node is selected, list its `UsageEvent`s and its `AuditEvent`s (investigation started/completed, remediation proposed/simulated, retired) as a vertical log, newest first, fading older entries like Ref 2's events log. Include the identity's `createdAt` and `lastUsedAt` as the first and last entries.

### 7.4 Side panels and filter bar (Ref 2 State A)

Beside the map, panels titled in tiny uppercase mono with corner-bracket borders:

- `EVENTS LOG` (right column): the most recent audit events from `fetchAuditEvents()`, as chamfered cards with a bold uppercase title and a dim mono metadata line, fading with age. When an identity is hovered or selected, switch to that identity's `HISTORY` (7.3).
- Left column: the HUD row panels from section 6 (`HYGIENE SCORE`, `SUGGESTED IMPROVEMENTS`, optional radar). On narrow screens these stack under the map.
- **Bottom filter bar** under the map, three chamfered pill selectors as in the reference: `PERIOD` (the time-scrubber range, e.g. `ACTUAL` / `30D` / `ALL TIME`), `TYPE` (`ALL` or one of the 7 identity types), `STATUS` (`ALL`, `ACTIVE`, `STALE`, `ORPHANED`, `RETIRED`). Filtering dims non-matching nodes rather than removing them, so layout doesn't jump.
- The reference's dashed `PRESS TO TURN ON VOICE CONTROL` hint box is **not** used. Voice control is out of scope.

**Safety constraint:** the map and its overlay may navigate, filter, select and start an investigation, but must not expose any control that revokes, rotates or deletes a credential. Do not copy the reference's `RAISE A TICKET` / `UPDATE REQUEST` as live actions; there is no ticketing integration. A remediation entry point leads to the existing Remediation page, which stays dry-run only.

### 7.5 Accessibility and fallback

- Keyboard: arrow keys / `Tab` move between nodes; `Enter` selects; `Esc` resets. Each node has an accessible name including type, status and risk (`payments-svc-prod, service account, active, critical risk`).
- Provide a **table view toggle** (`MAP | LIST`) on the same data, which is the existing Grid table, so screen-reader and low-motion users and small screens aren't dependent on the canvas.
- Under `prefers-reduced-motion`: no pulses, no scanlines, no animated transitions on selection (instant re-layout).
- On narrow viewports the side panels collapse beneath the map; the scrubber stays below the map.

---

## 8. Component and page restyle checklist

Everything is a restyle of existing markup unless marked **new**.

**Global**
- Swap tokens (section 4), load fonts, set `body` to mono, `h1–h3` to the display face (uppercase, `+` suffix optional only on the landing).
- `.card` → square, hairline border, no radius; optional bracket corners on emphasised cards.
- `.badge` → square bordered tag, uppercase, tiny; keep the `critical | high | medium | low | neutral` tone mapping in `Badges.tsx` unchanged. Only CSS changes.
- `.btn` → solid `--accent`, black uppercase mono text, trailing `→`, glow; `.btn-secondary` → 1px outline. Add visible `:focus-visible` outlines (none exist today).
- `select`, `input` → square, mono, `--border`, green focus ring.
- `table` → keep dense rows; header row uppercase tiny dim labels (already), hover row gets a left green marker plus `--accent-dim` background. No scanline overlay on tables.
- `.empty-state` / `.error-state` / loading text → styled as terminal output (`> loading identities…`, `! ERROR: …`), not centred grey text.
- **New:** a shared `DemoChip` for the amber `DEMO DATASET` label.

**The Grid (`/grid`)**: existing table with themed badges; add the same filter chips as the map; clicking a row still routes to detail. Optional: `MAP | LIST` toggle shared with the landing.

**Identity Details**: two-column cards become framed panels with uppercase panel titles; the credentials block keeps showing only `maskedPreview` (never a value); risk score as an LCD numeral next to the risk tag; usage history rows get a green/amber/red result marker with the text label retained.

**Investigations**: the start form becomes a terminal-style command bar (`$ investigate <select identity> [RUN]`); the running state shows a blinking cursor line instead of "Analysis in progress…"; findings table keeps all five columns; `basis` tags (`confirmed`/`inferred`/`unknown`) stay distinct by label and border style, not just colour; the agent tool-call trace is styled as a terminal log (it already is a mono list). The "risk computed by the backend, not the AI" wording must remain visible.

**The Afterlife**: keep the vertical timeline but give it a spine in `--border` with square markers; entry titles in mono caps; the actor line dim. Optionally the same fading-by-age treatment as Ref 2's events log. Reuse event card styling from the map's side panel so the two feel like one system.

**Remediation**: each plan is a framed panel with a status tag; steps as a numbered terminal checklist with `AUTO` / `MANUAL` tags (replacing the dim parenthetical); the dry-run button is explicit: `SIMULATE (DRY RUN)`; the safety line "no live credential is ever touched" stays prominent.

---

## 9. Implementation notes and constraints

- Keep `apps/web/src/api/client.ts` signatures and routes in `packages/shared/src/api.ts` unchanged. The redesign is presentation-only apart from the route move in section 5 (decided) and the second layout shell for the landing page. No new API endpoint is planned (decided in 7.1).
- No new runtime dependency unless justified: fonts (via `@fontsource-*` or self-hosted) are the likely exception; a graph/animation library should not be needed at this scale.
- Keep light/dark scope as-is (dark only).
- Verify visually in a browser at desktop and narrow widths, check keyboard navigation of the map, and run `pnpm typecheck` and the web build after implementing. None of that applies to this document.
- Update `CLAUDE.md` §3 (frontend paths, new landing page and route) and `README.md` when the redesign lands.

## 10. Decisions (from your answers)

| # | Question | Decision |
|---|---|---|
| 1 | Fonts | **Doto** and **VT323** (read "v323" as VT323), usable interchangeably. The designer picks at implementation; recommendation and variable setup are in section 4. |
| 2 | Landing page at `/`, Grid at `/grid` | **Yes.** |
| 3 | Top bar or sidebar inside the app | **Sidebar.** |
| 4 | Map data | **Whatever makes most sense; visual first, accuracy not critical.** Resolved as: no new endpoint, build from existing endpoints, allow clearly non-interactive ambient texture, never fabricate identities (section 7.1). |
| 5 | Reference 2 coverage | **Re-checked** against the fixed full-frame recording at `~/Videos/networkingmap.mp4`; section 2 and section 7 now describe all three states (overview HUD, node focus, sub-network overlay). |

## 11. Remaining notes

- The fixed map recording lives in `~/Videos/`, not in `design-inspiration/recordings/` (that copy is still the old cropped one, 728,821 bytes). Copy it over when convenient so the reference travels with the repo.
- Small open point for the implementer only: whether the radar chart (section 6) has an honest data source. If not, drop it; the rest of the HUD row stands without it.
