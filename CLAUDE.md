# Mango OS

A single-page BD/pipeline command center: deals, contacts, enablers (partners/VCs/govt bodies), organizations (competitors/market players/regulators/payers/associations/research bodies), tasks, and the network of relationships between all of them. Built as a personal tool, not a multi-tenant product: no auth, no row-level access control.

## Stack

- React 19 + Vite, plain CSS (`src/styles.css`) with CSS custom properties for theming. No component library, no CSS-in-JS.
- Supabase (Postgres + PostgREST) as the only backend. `src/supabase.js` exports a single `api(table, method, body, query)` helper that hits the REST API directly with the anon key; there is no server code in this repo.
- Anthropic API called directly from the browser (`src/anthropic.js`) for AI summaries, photo-note transcription, and transcript summarization. Requires `VITE_ANTHROPIC_API_KEY` at build time (see `.env.example`). There is no backend proxy, so the key is present in the built JS bundle. Acceptable for this project's threat model; revisit if that changes.
- `src/gmail-sync-updated.js` is a **reference Google Apps Script**, not part of the Vite app: it's a separate script pasted into Google Apps Script directly, used to auto-log Gmail activity into the `activities` table on a timer.

Almost all UI logic lives in one file, `src/App.jsx`: the top-level `App` component holds all state and CRUD functions, and every view/sheet/modal is a function component defined below it in the same file. `src/constants.js` holds the enum-like arrays (stages, types, priorities, cities, etc.) that drive dropdowns and color-coded badges throughout.

## Database schema (Supabase)

Core entities:
- **deals**: id, company, stage, contact_id, contact_name, contact_role, value, notes, next_action, city, region, created_at, last_activity_at, ai_summary, ai_summary_updated_at
- **contacts**: id, name, role, company, email, phone, linkedin, source, notes, tags[], warmth, is_internal, last_contacted_at, created_at, ai_summary, ai_summary_updated_at
- **enablers**: id, name, type, contact_id, contact_name, notes, city, region, created_at, last_activity_at, ai_summary, ai_summary_updated_at
- **organizations**: id, name, type, sector, description, website, notes, city, region, country (default "Saudi Arabia"), address, created_at, ai_summary, ai_summary_updated_at. Types: competitor, market_player, regulator, payer, association, research.
- **activities**: id, deal_id, contact_id, enabler_id, organization_id, type, description, created_at. The shared activity-timeline log; any subset of the four FKs can be set.
- **todos**: id, title, description, priority, status, due_date, deal_id, enabler_id, contact_id, created_at, completed_at. No `organization_id` column; the Organization Sheet intentionally has no To-Dos section for this reason.

Junction / relationship tables:
- **deal_contacts**: deal_id, contact_id, role_in_deal (unique on deal_id+contact_id). Multi-contact support per deal.
- **enabler_contacts**: enabler_id, contact_id, role_in_org (unique on enabler_id+contact_id). Multi-contact support per enabler.
- **deal_enablers**: deal_id, enabler_id, relationship (can_introduce/active/institutional), strength (strong/medium/weak/unknown), notes. Which enablers can help with which deals.
- **network_edges**: source_type, source_id, target_type, target_id, relationship, strength, direction, notes. Generic polymorphic graph edges (any entity to any entity: contact/deal/enabler/organization). This is where all organization relationships live (person-to-org, org-to-org, org-to-deal, org-to-enabler), plus any other pair that doesn't map to a dedicated junction table above. Written via the Network tab's generic "+ Connection" picker and via the Organization Sheet's "+ Add Person" / "+ Connect Organization" / "+ Connect Deal" / "+ Connect Enabler" buttons (all of these route through the shared `addConnection` function). Relationship vocabulary: works_at, board_member, advisor, knows, can_introduce, reports_to, subsidiary, parent, board_overlap, partnership, competitor_to, regulates, funds, invested_in, custom. When connecting a person to an organization, the role/title (e.g. "CEO", "Board Member") is stored as plain text in `notes`.

`deals`/`enablers`/`contacts`/`organizations` all carry `ai_summary`/`ai_summary_updated_at` and auto-regenerate their summary (via `SummaryCard`) whenever a sheet is opened and the existing summary is missing or older than the most recent activity. Summaries are also click-to-edit and independently saveable. All AI-generated prompts explicitly instruct the model not to use em dashes (see the no-em-dash rule below).

## Legacy vs. junction contact fields

`deals.contact_id`/`contact_name` and `enablers.contact_id`/`contact_name` are the original single-contact fields from before multi-contact support existed. They're kept for backward compatibility (used for e.g. the deal card's contact line, and as the default Quick-Add activity attribution) but the People sections on Deal/Enabler/Organization Sheets are backed by `deal_contacts`/`enabler_contacts` plus `network_edges` (source_type='contact'). When resolving "who's linked to this entity," union all applicable sources rather than assuming one is authoritative; see `DealSheet`/`EnablerSheet`'s `peopleNorm` (junction + edge merge, deduped by contact) and `OrganizationSheet`'s `keyPeople` (edges + matching deal_contacts/enabler_contacts if the org's name matches an existing deal company or enabler name).

## Feature map

- **Pipeline**: Kanban board of deals by stage, drag-and-drop between columns. Deal cards show a city pin when `city` is set.
- **Deal Sheet / Enabler Sheet / Contact Sheet / Organization Sheet**: full-page detail views (not modals) sharing the same structural pattern: header info + Edit/Delete/Back, AI Summary card, People/Linked-entity sections, To-Dos (except Organization Sheet), Quick Add, and an Activity Timeline. The timeline component (filters: All/Calls/Emails/Meetings/Notes) is intentionally identical across all sheets.
  - Deal Sheet additionally shows "Paths In" (indirect 1-2 hop `network_edges` traversal rooted at the deal itself and, if one exists, the organization whose name matches the deal's company; rendered as a compact "A > B > Deal" chain, see `findNetworkPaths`) and "Enabler Paths" (read-only, from `deal_enablers`).
  - Enabler Sheet additionally shows "Connected Targets" (editable, from `deal_enablers`, add/remove via `AddConnectionModal`).
  - Organization Sheet additionally shows "Key People" (cross-pollination badge if a person is linked to more than one tracked organization), "Connected Organizations", "Connected Deals", and "Connected Enablers" (all backed by `network_edges`, add/remove via `AddOrgLinkModal`).
- **Network tab**: single integrated workspace for the relationship graph:
  - *Quick Add bar*: "+ Contact", "+ Organization", "+ Connection" each expand an inline form below the buttons (not a modal); "Bulk Add" opens a rapid-entry table (Name/Type/Company/Role/City/Email/Warmth per row, "Save All" at the end) for dumping many contacts/orgs at once.
  - *Directory*: every contact, deal, enabler, and organization in one searchable, filterable (All/Contacts/Internal Team/Targets/Enablers/Competitors/Market Players) list, with a city filter dropdown. Each row shows a city pin (when set) and a compact "connected to: ..." line resolving `deal_contacts`/`enabler_contacts`/`deal_enablers`/`network_edges` (plus one indirect hop for contacts, e.g. "KFSHRC (Deal via BECO Capital)") into clickable names. Clicking any row opens its full sheet, including organizations (Organization Sheet).
  - The generic "+ Connection" picker searches across all four entity types and routes to the right table based on the pair, via the shared `addConnection` function: deal+enabler → `deal_enablers`, contact+deal → `deal_contacts`, contact+enabler → `enabler_contacts`, anything else (org-anything, contact-contact, etc.) → `network_edges`. When the pair is a contact and an organization and the relationship is one of `works_at`/`board_member`/`advisor`/`reports_to` (see `PERSON_ORG_RELATIONSHIPS`), a "Role / Title" field appears and is folded into the edge's `notes`.
- **Tasks tab**: every open todo across deals/enablers, sorted priority-then-due-date, filterable (All/High Priority/Due Today/Overdue), inline-editable (title/priority/due date/linked deal-enabler).
- **Reports**: plaintext EOD/EOW report generation + copy-to-clipboard.
- **Boss View**: pipeline overview, Key Summaries (AI summaries for active deals/enablers), Action Items (top 10 priority todos).
- **Quick Add** (on every sheet): logs an activity; supports a camera button (photo of handwritten notes → Claude vision → transcribed `note` activity) and a "Paste Transcript" activity type (textarea + "Summarize with AI" that replaces the pasted text in place before saving).
- **Theme**: dark (default) / light toggle via the header gear icon, persisted to `localStorage`. Implemented with CSS variables on `:root`, overridden by `.dark-mode`/`.light-mode` classes applied to **both** `.app` and `document.body` (body needs its own class since it's an ancestor of `.app`, not a descendant, so it can't inherit `.app`'s variable overrides). There's also an `@media (prefers-color-scheme: light)` fallback on bare `:root` for contexts where no explicit class has been applied yet; the explicit body/app classes always take precedence over it via specificity.
- **Warmth**: per-contact relationship-temperature indicator (unknown/cold/warm/hot/active), shown as a colored dot on contact cards, person cards, and directory rows, and set via a colored-button selector in the contact form.
- **Last synced indicator**: header text reading the most recent activity of type `email` or `meeting` and showing its timestamp, as a signal that the Gmail/Calendar sync is working.

## Conventions worth knowing before editing

- Every "delete" CRUD function manually cascades related rows first (activities, junction tables, todos, network_edges) before deleting the parent row, since there's no guarantee of `ON DELETE CASCADE` at the DB level. Follow the existing pattern in `deleteDeal`/`deleteEnabler`/`deleteContact`/`deleteOrganization` when adding new relationships.
- Shared UI pieces (`QuickAdd`, `TodoSection`/`TodoRow`, `PeopleSection`, `SummaryCard`, `AddConnectionModal`, `AddOrgLinkModal`) are deliberately factored out and reused across sheets rather than duplicated. Extend those instead of writing sheet-specific copies.
- Colors for enum-like fields (stage, enabler type, org type, priority, strength, warmth) are defined once in `constants.js` as `{ id, label, color }` arrays and rendered as `<span className="badge" style={{background: color+"22", color, border: \`1px solid ${color}44\`}}>`. Reuse this pattern for any new categorical field rather than inventing new badge styles.
- Every dropdown backed by one of these enum-like arrays should use `SelectWithCustom` (a drop-in `<select>` replacement that appends a "+ Add custom..." option; picking it swaps the select for a text input committed on blur/Enter) instead of a plain `<select>`, so users can always type a value outside the predefined list. For multi-select tag pickers use `TagPickerWithCustom`, and for colored button-group pickers (like warmth) use `ButtonGroupWithCustom`. All three live near the top of `src/App.jsx`, above `export default function App()`.
- Location fields (`city`, `region` on deals/enablers/organizations) use `SelectWithCustom` against `CITY_OPTIONS`/`REGION_OPTIONS` (derived from `SAUDI_CITIES`/`REGIONS` in `constants.js`). Render a city as a small pin, `📍 {city}`, with the `.city-pin` CSS class, on any card or row where it's set.
- Never use the em dash character anywhere: not in UI text, labels, descriptions, generated content, AI prompts, or code comments. Use commas, periods, colons, or parentheses instead. This applies to text written by hand and to instructions embedded in Anthropic API prompts (the summary/transcript/photo-note prompts explicitly tell the model not to use them).
- No test suite exists. Verify changes by running the dev server and exercising the feature directly. This app talks to a live, shared Supabase project with real data, so be careful not to leave test data behind when doing so, and don't assume a row is test data just because it appeared recently; verify before deleting.
