# Mango OS

A single-page BD/pipeline command center for the Saudi healthcare ecosystem. The mental model: every hospital, VC, government body, payer, etc. is an **institution**, and **people** hold roles at institutions. Some institutions are also pipeline **Targets** (sales/BD deals) and/or **Enablers** (partners who can open doors). Built as a personal tool, not a multi-tenant product: no auth, no row-level access control.

## Stack

- React 19 + Vite, plain CSS (`src/styles.css`) with CSS custom properties for theming. No component library, no CSS-in-JS.
- Supabase (Postgres + PostgREST) as the only backend. `src/supabase.js` exports a single `api(table, method, body, query)` helper that hits the REST API directly with the anon key; there is no server code in this repo.
- Anthropic API called directly from the browser (`src/anthropic.js`) for AI summaries, photo-note transcription, and transcript summarization. Requires `VITE_ANTHROPIC_API_KEY` at build time (see `.env.example`). There is no backend proxy, so the key is present in the built JS bundle. Acceptable for this project's threat model; revisit if that changes.
- `src/gmail-sync-updated.js` is a **reference Google Apps Script**, not part of the Vite app: it's pasted into Google Apps Script directly to auto-log Gmail activity into the `activities` table on a timer.

Almost all UI logic lives in one file, `src/App.jsx`: the top-level `App` component holds all state and CRUD functions, and every view/sheet/modal is a function component defined below it. `src/constants.js` holds the enum-like arrays (institution types, stages, priorities, cities, etc.) that drive dropdowns and color-coded badges.

## Navigation

Five tabs: **Pipeline | Network | Tasks | Reports | Boss View**. There is no separate Contacts or Enablers tab: all people live in the Network tab's People sub-tab, and all enablers are institutions in the Network tab flagged with the Enabler checkbox. The stats bar shows Pipeline Deals, Pipeline Value, People, Institutions, and Open Tasks. The header shows a "Synced: <time>" indicator reading the most recent `email`/`meeting` activity (or "No sync yet").

## Database schema (Supabase)

Core entities:
- **deals**: id, company, stage, contact_id, contact_name, contact_role, value, notes, next_action, city, region, created_at, last_activity_at, ai_summary, ai_summary_updated_at
- **contacts**: id, name, role, company, email, phone, linkedin, source, notes, tags[], warmth, is_internal, last_contacted_at, created_at, ai_summary, ai_summary_updated_at
- **enablers**: id, name, type, contact_id, contact_name, notes, city, region, created_at, last_activity_at, ai_summary, ai_summary_updated_at
- **organizations**: id, name, type, sector, description, website, notes, city, region, country (default "Saudi Arabia"), address, created_at, ai_summary, ai_summary_updated_at
- **activities**: id, deal_id, contact_id, enabler_id, organization_id, type, description, created_at. Shared activity-timeline log; any subset of the four FKs can be set (an institution activity is logged with all of its backing FKs so it appears everywhere at once).
- **todos**: id, title, description, priority, status, due_date, deal_id, enabler_id, contact_id, created_at, completed_at.

Junction / relationship tables:
- **contact_roles**: id, contact_id, entity_type ("deal"/"enabler"/"organization"), entity_id, role_title, is_primary, created_at. The source of truth for who belongs to which institution and in what capacity.
- **deal_contacts** / **enabler_contacts**: legacy per-institution people tables. Every contact_roles write for entity_type "deal"/"enabler" is dual-written here (and vice versa) so the Pipeline deal sheet keeps working. Removing a role cleans up both sides.
- **deal_enablers**: deal_id, enabler_id, relationship, strength, notes (legacy; read-only "Enabler Paths" on the deal sheet).
- **network_edges**: source_type, source_id, target_type, target_id, relationship, strength, direction, notes. Institution-to-institution edges (org-to-org, etc.), person-to-person connections, and (for backward compat) person-to-organization role mirrors. Relationship vocab in `NETWORK_EDGE_RELATIONSHIPS`.
- **custom_options**: id, field_name, value, created_at. Persisted "+ Add custom" dropdown values, keyed by field_name (see custom-dropdown convention below).

## The institution model (key concept)

An **institution** is a derived object, one per normalized (lowercased/trimmed) name, folding together up to three backing rows: an `organizations` row (its type/city/sector/etc.), a `deals` row (making it a **Target**), and an `enablers` row (making it an **Enabler**). `buildInstitutions(deals, enablers, organizations)` in `App.jsx` produces this list; each institution carries `orgId`/`dealId`/`enablerId`, `isTarget`/`isEnabler`, resolved `type`/`city`/`stage`, etc. Institution "type" (Hospital, VC, Government, Tech Company, Payer, Regulator, Association, Research, Pharmaceutical, plus custom) is separate from the Target/Enabler flags. `institutionTypeMeta`/`normalizeTypeKey` resolve a raw type string to a canonical `{id,label,color}` case-insensitively so legacy free-typed values group correctly.

- **Creating an institution** (`addInstitution`) always creates an `organizations` row, and additionally creates a linked `deals` row if Target is checked and/or an `enablers` row if Enabler is checked.
- **Editing an institution** (`saveInstitution`) ensures the org row exists and reconciles the checkboxes: checking Target/Enabler creates the deal/enabler, unchecking archives it via `purgeDeal`/`purgeEnabler` (deletes the deal/enabler and its junctions, but preserves shared activities/todos by nulling their FK). The edit modal confirms before an uncheck removes a linked row.
- **Linking a person to an institution** uses `institutionPrimaryEntity(inst)`: a Target links via its deal (so the person also appears on the Pipeline deal sheet), an Enabler via its enabler, otherwise via its organization. `institutionPeople(inst, ...)` unions people across all three backing rows plus legacy junctions.
- Clicking an institution anywhere opens the **Institution Sheet** (keyed by name via `institutionSheetKey`); clicking a person opens the **Person Sheet** (keyed by contact id via `personSheetId`). The Pipeline kanban still opens the **Deal Sheet** for deals.

## Feature map

- **Pipeline**: Kanban board of deals by stage, drag-and-drop between columns, "+ New Deal". Deal cards show a city pin. The Deal Sheet's People section is backed by contact_roles (via the deal_contacts dual-write), so people/activities added to a Target institution in the Network tab show up here too, and stage changes sync back to the institution.
- **Network tab** (`NetworkTab`): the master ecosystem view. Top bar = search + "+ Institution" + "+ Person" (each expands an inline form). Two sub-tabs:
  - *Institutions*: type/city filters plus "Targets only"/"Enablers only" toggles; a card grid grouped by type. Each card shows name, type badge, Target (blue) / Enabler (gold) dots, city pin, pipeline stage (if Target), people count, and a preview of the first few people with roles.
  - *People*: warmth/city/institution filters; a card grid of every contact showing warmth dot, all their roles ("CEO at Sahab, Board Member at NUPCO"), email/phone, connection count, and last-contacted date.
- **Institution Sheet**: header with type badge, Target/Enabler flags, city/region, sector, website, Edit (opens `InstitutionEditModal` with the Target/Enabler checkboxes) and Delete. If Target, a pipeline-stage dropdown that syncs to the deal. Sections: AI Summary, "People at <name>" (Add Person has two paths, pick existing or create new inline; each person shows role, warmth, email, an "Also:" line for their other institutions, and a remove X), Connected Institutions (explicit network_edges org-to-org plus auto-detected connections through shared people), "Paths In" (Targets only, `findNetworkPaths` traversal over network_edges and contact_roles), Quick Add, and Activity Timeline.
- **Person Sheet**: header with warmth dot, email, phone; AI Summary; Roles (each links to its institution, with type/stage badge and remove X; "+ Add Role" links them to another institution); Connections (network_edges to people/institutions); Quick Add; Activity Timeline. Edit opens the contact modal.
- **Tasks tab**: every open todo, sorted priority-then-due-date, filterable, inline-editable (click the edit pencil to edit title/priority/due date/linked deal-enabler).
- **Reports**: plaintext EOD/EOW report generation + copy-to-clipboard.
- **Boss View**: pipeline overview, Key Summaries, Action Items.
- **Quick Add** (on every sheet): logs an activity; supports a camera button (photo of handwritten notes to Claude vision to transcribed note) and a "Paste Transcript" type (textarea + "Summarize with AI").
- **Theme**: dark (default) / light toggle via the header gear icon, persisted to `localStorage` (`.dark-mode`/`.light-mode` on both `.app` and `document.body`), with an `@media (prefers-color-scheme: light)` fallback (white bg, #f8f9fa surface, #1a1a2e text, #4a5568 muted, #e2e8f0 borders).
- **Warmth**: per-contact temperature (unknown/cold/warm/hot/active), a colored dot on people cards and person sheets.

## Conventions worth knowing before editing

- **Custom dropdowns**: every categorical dropdown uses `SelectWithCustom` (drop-in `<select>` that appends "+ Add custom..."; picking it swaps to a text input). To persist custom values, pass `options={optionsWithCustom(DEFAULTS, customOptions, "field_name")}` and wrap `onChange` with `trackCustom("field_name", thatSameOptionsList, onAddCustomOption)`. `customOptions` (raw rows) and `onAddCustomOption` (`App`'s `addCustomOption`) are threaded down as props. Field names in use: institution_type, city, region, deal_stage, warmth, relationship, activity_type, priority, tag, strength, enabler_type. Multi-select tags use `TagPickerWithCustom`; colored button groups (warmth) use `ButtonGroupWithCustom`. All live near the top of `App.jsx`.
- Every "delete" CRUD function manually cascades related rows first (activities, junction tables, contact_roles, network_edges, todos) before deleting the parent, since there is no guaranteed `ON DELETE CASCADE`. `purgeDeal`/`purgeEnabler` archive a Target/Enabler while preserving shared history; `deleteInstitution` removes all backing rows.
- Colors for enum-like fields are defined once in `constants.js` as `{ id, label, color }` and rendered as `<span className="badge" style={{background: color+"22", color, border: \`1px solid ${color}44\`}}>`. Reuse this rather than inventing badge styles.
- Location fields use `SelectWithCustom` against `CITY_OPTIONS`/`REGION_OPTIONS`. Render a city as a small pin, `📍 {city}`, with the `.city-pin` class.
- Only send optional string fields to Supabase when they have real content (trim and skip empties); never send an empty string for a numeric column.
- Never use the em dash character anywhere: not in UI text, labels, toasts, descriptions, generated content, AI prompts, or code comments. Use commas, periods, colons, or parentheses instead. The AI prompts explicitly instruct the model to avoid them too.
- No test suite exists. Verify changes by running the dev server and exercising the feature directly. This app talks to a live, shared Supabase project with real data, so clean up any test data afterward, and do not assume a row is test data just because it appeared recently; verify before deleting.
