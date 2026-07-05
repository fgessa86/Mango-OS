# Mango OS

A single-page BD/pipeline command center: deals, contacts, enablers (partners/VCs/govt bodies), organizations (competitors/market players), tasks, and the network of relationships between all of them. Built as a personal tool, not a multi-tenant product — no auth, no row-level access control.

## Stack

- React 19 + Vite, plain CSS (`src/styles.css`) with CSS custom properties for theming — no component library, no CSS-in-JS.
- Supabase (Postgres + PostgREST) as the only backend. `src/supabase.js` exports a single `api(table, method, body, query)` helper that hits the REST API directly with the anon key; there is no server code in this repo.
- Anthropic API called directly from the browser (`src/anthropic.js`) for AI summaries, photo-note transcription, and transcript summarization. Requires `VITE_ANTHROPIC_API_KEY` at build time (see `.env.example`) — there is no backend proxy, so the key is present in the built JS bundle. Acceptable for this project's threat model; revisit if that changes.
- `src/gmail-sync-updated.js` is a **reference Google Apps Script**, not part of the Vite app — it's a separate script pasted into Google Apps Script directly, used to auto-log Gmail activity into the `activities` table on a timer.

Almost all UI logic lives in one file, `src/App.jsx` — the top-level `App` component holds all state and CRUD functions, and every view/sheet/modal is a function component defined below it in the same file. `src/constants.js` holds the enum-like arrays (stages, types, priorities, etc.) that drive dropdowns and color-coded badges throughout.

## Database schema (Supabase)

Core entities:
- **deals** — id, company, stage, contact_id, contact_name, contact_role, value, notes, next_action, created_at, last_activity_at, ai_summary, ai_summary_updated_at
- **contacts** — id, name, role, company, email, phone, linkedin, source, notes, tags[], last_contacted_at, created_at, ai_summary, ai_summary_updated_at, warmth, is_internal
- **enablers** — id, name, type, contact_id, contact_name, notes, created_at, last_activity_at, ai_summary, ai_summary_updated_at
- **organizations** — id, name, type, sector, description, website, notes, created_at — competitors, market players, regulators, payers, associations, research bodies
- **activities** — id, deal_id, contact_id, enabler_id, type, description, created_at — the shared activity-timeline log; any subset of the three FKs can be set
- **todos** — id, title, description, priority, status, due_date, deal_id, enabler_id, contact_id, created_at, completed_at

Junction / relationship tables:
- **deal_contacts** — deal_id, contact_id, role_in_deal (unique on deal_id+contact_id) — multi-contact support per deal
- **enabler_contacts** — enabler_id, contact_id, role_in_org (unique on enabler_id+contact_id) — multi-contact support per enabler
- **deal_enablers** — deal_id, enabler_id, relationship (can_introduce/active/institutional), strength (strong/medium/weak), notes — which enablers can help with which deals
- **network_edges** — source_type, source_id, target_type, target_id, relationship, strength, direction, notes — generic polymorphic graph edges (any entity to any entity). Written only via the Network tab's generic "+ Connection" picker, as the fallback for pairs that don't map to a dedicated junction table (see Network tab below); no dedicated edit/delete UI for existing rows yet. Feeds a future visual network map.

`deals`/`enablers`/`contacts` all carry `ai_summary`/`ai_summary_updated_at` and auto-regenerate their summary (via `SummaryCard`) whenever a sheet is opened and the existing summary is missing or older than the most recent activity. Summaries are also click-to-edit and independently saveable.

## Legacy vs. junction contact fields

`deals.contact_id`/`contact_name` and `enablers.contact_id`/`contact_name` are the original single-contact fields from before multi-contact support existed. They're kept for backward compatibility (used for e.g. the deal card's contact line, and as the default Quick-Add activity attribution) but the People sections on Deal/Enabler Sheets are backed by the `deal_contacts`/`enabler_contacts` junction tables instead. When resolving "who's linked to this deal," union both sources (see `ContactSheet`'s Linked Deals logic) rather than assuming one or the other is authoritative.

## Feature map

- **Pipeline** — Kanban board of deals by stage, drag-and-drop between columns.
- **Deal Sheet / Enabler Sheet / Contact Sheet** — full-page detail views (not modals) sharing the same structural pattern: header info + Edit/Delete/Back, AI Summary card, People/Linked-entity sections, Enabler-connection sections, To-Dos, Quick Add, and an Activity Timeline. The timeline component (filters: All/Calls/Emails/Meetings/Notes) is intentionally identical across all three sheets.
- **Network tab** — single integrated workspace for the relationship graph (replaced an earlier 3-sub-tab design):
  - *Quick Add bar* — "+ Contact", "+ Organization", "+ Connection" each expand an inline form below the buttons (not a modal); "Bulk Add" opens a rapid-entry table (Name/Type/Company/Role/Email/Warmth per row, "Save All" at the end) for dumping many contacts/orgs at once.
  - *Directory* — every contact, deal, enabler, and organization in one searchable, filterable (All/Contacts/Internal Team/Targets/Enablers/Competitors/Market Players), sorted-by-type list. Each row shows a compact "connected to: ..." line resolving `deal_contacts`/`enabler_contacts`/`deal_enablers`/`network_edges` (plus one indirect hop for contacts, e.g. "KFSHRC (Deal via BECO Capital)") into clickable names. Clicking a contact/deal/enabler row opens its full sheet; clicking an organization expands an inline edit card in place (no sheet exists for organizations).
  - The generic "+ Connection" picker searches across all four entity types and routes to the right table based on the pair: enabler+deal → `deal_enablers`, contact+deal → `deal_contacts`, contact+enabler → `enabler_contacts`, anything else (contact-contact, org-anything, etc.) → `network_edges`. This is also the only UI that writes to `network_edges` — still no dedicated edit/delete for it beyond what this generic form provides.
  - Deal Sheets show a read-only "Enabler Paths" section (from `deal_enablers`); Enabler Sheets show an editable "Connected Targets" section (add/remove via the existing `AddConnectionModal`) — the same underlying rows, viewed from each side.
  - Auto-population: creating a contact with a `company` that case-insensitively matches an existing deal's `company` or enabler's `name` auto-creates the corresponding `deal_contacts`/`enabler_contacts` row; marking a contact internal auto-adds an "Internal Team" tag. Both rules live in `persistContact` (the side-effect-free core that `saveContact` wraps), so every contact-creation path — the regular Contacts-tab form, the Network quick-add, and Bulk Add — gets them for free.
- **Tasks tab** — every open todo across deals/enablers, sorted priority-then-due-date, filterable (All/High Priority/Due Today/Overdue), inline-editable (title/priority/due date/linked deal-enabler).
- **Reports** — plaintext EOD/EOW report generation + copy-to-clipboard.
- **Boss View** — pipeline overview, Key Summaries (AI summaries for active deals/enablers), Action Items (top 10 priority todos).
- **Quick Add** (on every sheet) — logs an activity; supports a camera button (photo of handwritten notes → Claude vision → transcribed `note` activity) and a "Paste Transcript" activity type (textarea + "Summarize with AI" that replaces the pasted text in place before saving).
- **Theme** — dark (default) / light toggle via the header gear icon, persisted to `localStorage`. Implemented with CSS variables on `:root`, overridden by `.dark-mode`/`.light-mode` classes applied to **both** `.app` and `document.body` (body needs its own class since it's an ancestor of `.app`, not a descendant, so it can't inherit `.app`'s variable overrides). There's also an `@media (prefers-color-scheme: light)` fallback on bare `:root` for contexts where no explicit class has been applied yet; the explicit body/app classes always take precedence over it via specificity.
- **Warmth** — per-contact relationship-temperature indicator (unknown/cold/warm/hot/active), shown as a colored dot on contact cards and set via a colored-button selector in the contact form.

## Conventions worth knowing before editing

- Every "delete" CRUD function manually cascades related rows first (activities, junction tables, todos) before deleting the parent row, since there's no guarantee of `ON DELETE CASCADE` at the DB level. Follow the existing pattern in `deleteDeal`/`deleteEnabler`/`deleteContact` when adding new relationships.
- Shared UI pieces (`QuickAdd`, `TodoSection`/`TodoRow`, `PeopleSection`, `SummaryCard`, `AddConnectionModal`) are deliberately factored out and reused across sheets rather than duplicated — extend those instead of writing sheet-specific copies.
- Colors for enum-like fields (stage, enabler type, org type, priority, strength, warmth) are defined once in `constants.js` as `{ id, label, color }` arrays and rendered as `<span className="badge" style={{background: color+"22", color, border: `1px solid ${color}44`}}>` — reuse this pattern for any new categorical field rather than inventing new badge styles.
- No test suite exists. Verify changes by running the dev server and exercising the feature directly (this app talks to a live, shared Supabase project — be careful not to leave test data behind when doing so).
