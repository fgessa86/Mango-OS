# Mango OS Audit

Date: July 11, 2026. Scope: full codebase read (App.jsx 6,159 lines, MapTab.jsx, anthropic.js, supabase.js, utils.js, constants.js, gmail-sync-updated.js, styles.css), live database integrity checks against the shared Supabase project, and a 375px browser sweep with request tracing. No fixes applied; findings only.

Legend: each finding has an ID (C/H/M/L + number) for referencing during fix work.

---

## CRITICAL: broken functionality, data integrity risks

### C1. Deletes do not cascade to the newer link tables (future orphans guaranteed)
The manual-cascade convention was never extended to the tables added after it was written. Verified by reading every delete path:

- `deleteContact` cleans junctions, edges, and todos, but leaves: `activities.contact_id` (dangling), `notes.contact_id`, `material_links.contact_id`, `meeting_briefs.contact_id`, and the denormalized `deals.contact_id`/`contact_name`.
- `purgeDeal` / `purgeEnabler` (also run when un-checking Target/Enabler) null activities/todos, but leave: `notes.deal_id/enabler_id`, `material_links.*`, `meeting_briefs.*`, `boss_comments.*`, and `network_edges` rows whose source/target is the deal/enabler.
- `deleteInstitution` (org branch) handles activities/todos/edges/roles, but leaves: `notes.organization_id`, `material_links.organization_id`, `meeting_briefs.organization_id`, `boss_comments.organization_id`.

Live DB is clean today only because notes/materials/briefs are new and lightly used. The first contact or institution delete that has a linked note/material/brief will orphan rows silently (they disappear from the UI because lookups join against the parent).

### C2. `persistContact` auto-link bypasses `contact_roles`
When a new contact's company name matches a deal/enabler, `persistContact` writes only the legacy `deal_contacts`/`enabler_contacts` row, not `contact_roles` (the documented source of truth). One divergent row already exists in production (an `enabler_contacts` row with no `contact_roles` mirror). Consequences: the role is non-removable from the UI (`removable: false` fallback path), invisible to `contact_roles`-only consumers (brief context, Tier 1 outreach detection via roles), and the divergence grows with every event-badge-scan import.

### C3. Edit Contact / Edit Institution / Edit Deal modals are unreachable dead code
`setModal({type:"contact"})` and `setModal({type:"institution"})` are never called anywhere; `setModal({type:"deal"})` is only called for creation. Practical impact: **tags, source, and the internal-team flag can no longer be set or edited from any UI**. `is_internal` matters: it drives the Network Map's "Internal Team" nodes and is the root set for Path Finder. A contact created today can never be marked internal. (`ContactForm`, `InstitutionEditModal`, and DealForm's edit branch are ~200 lines of dead code.)

---

## HIGH: dead ends and missing interconnections that block workflows

### H1. Activities do not cross-link between people and institutions
- Institution Quick Add logs with deal/enabler/org FKs but `contact_id: null`; the meeting never appears on any attendee's Person Sheet, and `last_contacted_at` is not bumped.
- Person Quick Add logs with `contact_id` only; the activity never appears on the institution sheet even when the person's primary role is there (outreach emails, calls, voice notes all invisible at the account level).
- Only the Fathom/Gmail sync writes both sides. Journey A and D both hit this: log a meeting with Dr. X from KFSHRC's sheet and Dr. X's timeline stays empty.

### H2. No global search (Journey E fails)
"Find that thing about NUPCO" requires manually checking the Ecosystem search (institutions/people only), Notes search (notes only), the Tasks list (no search box at all), and scrolling activity timelines (no search). Activities and tasks are not searchable anywhere; there is no cross-entity search surface.

### H3. Back navigation loses context (no history)
`PersonSheet` hardcodes "← Back to Ecosystem". Reaching a person from an institution's People section, a task pill, the Follow-ups dashboard, or Home and pressing Back always dumps you on the Ecosystem tab; the institution sheet you came from is gone. Institution sheets remember only pipeline-vs-network. Any two-hop navigation (Home → deal → person → back) strands the user.

### H4. Outreach is unreachable on mobile
`MobileTabBar` has no Outreach entry, Home has no "View Outreach" button (unlike Materials/Reports), and the nudge banner only renders when `needsNudgeCount > 0`. With zero contacts needing a nudge, the entire Outreach Engine (follow-ups, templates, compose) cannot be opened on a phone.

### H5. Boss comment attachments can be displayed but never created
`CommentPanel` and `BossNotes` render `file_data` images/attachments, and `postBossComment` accepts them, but neither compose UI has a file input (the old `boss-clip-btn` CSS is orphaned). Andy's screenshot-on-a-deal workflow from the spec is impossible.

### H6. Tier 1 outreach detection misses `deals.contact_id`-only and org-role people
`OutreachTab`'s NOT YET CONTACTED derives Tier 1 people from `deal_contacts` + `contact_roles(deal)` + `deals.contact_id`, which is right, but because of C2/C3 some role data only exists in legacy tables or on contacts.company text, and people whose only tie is an organization role at a Tier 1 target's org row are excluded. Also RECENTLY REPLIED lists every `replied` contact forever (no recency window), so the group only grows.

### H7. Institution rename leaves stale references
`renameInstitution` renames the org/deal/enabler rows, but: `contacts.company` strings still hold the old name (breaking `persistContact` future auto-matching and the People table's company fallback), and `deals.contact_name`/`contact_role` denormalized copies never update when the contact record changes. Same class of issue: editing a contact's name does not update `deals.contact_name`, which the deal card displays.

---

## MEDIUM: inconsistencies and friction

### M1. Every write triggers a full reload: 20 HTTP requests per checkbox
Measured live: toggling one task checkbox fires 1 PATCH + 19 full-table GETs (~200KB today). `markCommentRead`, tier changes, city edits, every inline save does the same. Fine at 60 contacts; linear degradation as data grows, and the app is unusable offline/slow-network mid-edit. Notes/materials/templates already demonstrate the better pattern (patch local state); nothing else uses it.

### M2. Duplicate entries in entity pickers
`TaskForm`'s Institution picker and the note "Link to..." picker list enablers and organizations as separate rows, so an institution that is both (or is also a deal in the note picker) appears 2-3 times with identical labels. Picking different duplicates writes different FKs, which then render as different pill colors for the same real-world institution.

### M3. Deal-only creation produces typeless half-institutions
"+ New deal" from the Pipeline creates only a `deals` row: no organizations row, no type, no auto-research (unlike "+ Institution" which does all three). The resulting Ecosystem card lands in an unlabeled type group with no badge until someone edits it. Deal cards also show `contact_name` as dead text (H7) while institution cards show clickable people.

### M4. Boss View copy and gating rough edges
- Home's empty state reads "No new comments from Andy." even for Andy (should say "from Fahed").
- Andy's browser auto-fetches the Daily Briefing (3 web-search API calls/day on Fahed's key) with no way to opt out; harmless but unintended spend.
- `view === "outreach" && !bossMode` renders a blank main area if boss mode ever lands on that view id.
- Materials tab is visible to Andy (by design) but Notes/Outreach hiding relies only on nav-item removal.

### M5. Hooks called after conditional returns
`InlineText` and `InlineSelectField` early-return for readOnly before `useEffect`. It never crashes only because `bossMode` is constant for a session, but it violates the rules of hooks and will break under any future dynamic readOnly (or React compiler).

### M6. Dates and toasts are mostly consistent, with pockets
Dates: sheets use `formatDate` (Jul 8) and Home uses `formatDateTime` consistently, but FollowupRow mixes "6 days waiting" with "Last outreach Jul 5", the People table shows "Never", and briefs show both meeting date and "Prepared" date in the same row. Toasts are consistent (single top-right, 2.5s) except `savedToast` (1s) vs full messages, and Reports uses its own inline "Copied!" button state instead of a toast.

### M7. People table role edit writes a different field than it displays
The Role cell displays `contact.role || contact_roles.role_title` but saves edits to `contacts.role` only, silently shadowing the role-row title. The Outreach column and Warmth column sort by raw id strings (so "Awaiting Reply" sorts under "a", not by urgency).

### M8. `renderDealCard` contact and Home task rows are dead ends
Deal-card contact names are plain text (no navigation to the person). Home Urgent Task cards render with pointer cursor but do nothing when the task has no linked entity, and there is no way to complete a task from Home. FollowupRow institution names are plain text (person is clickable, institution is not).

### M9. Sidebar "Saved Views" are decorative
Three static labels ("Tier 1 targets", "Riyadh accounts", "Closing this quarter") look clickable, do nothing, and have no way to be created or removed.

### M10. `Sidebar` receives a `lastSynced` prop it never renders
Dead prop; the "last Gmail sync" signal exists in App but is shown nowhere. Users cannot tell whether the Apps Script sync is alive (relevant to Journey D trust).

### M11. Fathom badge only where `ActivityDescription` is used
Sheet timelines and Home show the badge; the EOD/EOW plaintext reports and AI summary prompts strip the marker correctly, but the Network Map side panel's recent-activity list renders raw descriptions, so `[[FATHOM]]` leaks there verbatim.

---

## LOW: polish

- **L1.** Mobile tap targets under 44px: `home-section-action` buttons (17px tall), Ecosystem filter checkboxes (13px), todo checkboxes (20px), edit pencil (19px), badge selects (21px), task pills (23px), city pill ✕ (12x11).
- **L2.** Reports view has no page title/header (two boxes float with no context), and Reports has no mobile entry in Boss View at all.
- **L3.** `activities_fully_orphaned = 1` in production: one activity whose four FKs are all null (residue of an entity archive). Invisible in every UI except Home Recent Activity, where it shows as "General".
- **L4.** `NoteEditor` linked-entity pill and `EntityPicker` chips are styled slightly differently from `TaskPills` (three pill styles for the same concept).
- **L5.** The compose Gmail URL relies on `contact.email` being valid; there is no email format validation anywhere (a typo'd email silently produces a broken Gmail compose).
- **L6.** `DailyBriefing` icons mix a text glyph (⚕) with emoji (🧬, 🇸🇦); the flag emoji renders as "SA" text on Windows.
- **L7.** `MapTab` labels truncate at 15 chars with no tooltip on the label itself (tooltip only on node hover), and the map's `activities` prop means every keystroke elsewhere rebuilds the graph memo input identity.
- **L8.** `SummaryCard` auto-generates a summary on first sheet-open (API spend) with no way to disable; combined with auto-research-on-open, opening one new institution sheet can cost 2 API calls before any user action.
- **L9.** `voice_note` glyph is an emoji (🎤) while every other timeline glyph is a monochrome character.
- **L10.** `parseDueHint` and the Apps Script's `parseFathomDueDate_` are near-duplicate logic maintained in two files (drift risk; already differ on ISO/month-name parsing).

---

## Interconnectivity matrix (requested traces)

| Relationship | Forward | Reverse | Notes |
| --- | --- | --- | --- |
| Contact role ↔ institution | ✓ person on institution sheet, clickable | ✓ institution on person Roles, clickable | Both directions work (H3 back-nav aside) |
| Activity on deal ↔ linked contact | ✗ | ✗ | H1: no cross-visibility unless the sync wrote both FKs |
| Task on deal + contact | ✓ both sheets | ✓ pills navigate both ways | Works |
| Note linked to entity | ✓ Linked Notes section, opens note | ✓ note shows entity tag | Works (single-link only) |
| Material on deal → prep brief | ✓ | n/a | `gatherBriefContext` + Related Materials both include them |
| Target checkbox ↔ deal row | ✓ create/archive both directions | ✓ name/city sync | Type/sector don't live on deals (by design); rename leaves contacts.company stale (H7) |
| Boss comment tagged to entity | ✓ Boss Notes on sheet + Home unread | ✓ re: chip navigates | Attachments can't be created (H5) |
| Ecosystem card stage ↔ Pipeline | ✓ card shows stage; changes reflect after reload | ✓ | Works via loadData |
| Network Map edge sources | ✓ all five tables folded in | n/a | Verified in buildGraph |

## Journey walkthroughs (summary)

- **A (met someone new):** Ecosystem → + Person → roles/warmth/connection in one form → open person → Quick Add meeting → + Task. About 12-14 clicks, no dead end, but the logged meeting never reaches the institution timeline (H1) and adding them mid-institution-sheet then pressing Back loses your place (H3).
- **B (pre-meeting prep):** Home → Prep Brief → brief modal with materials + download. 2 clicks when the meeting is synced; excellent. If the meeting isn't in Today's Agenda, + New Brief adds ~5 fields. Solid.
- **C (Andy comments):** Works end to end (comment → Home unread → Mark read → entity tag navigates → BossNotes reply), except Fahed cannot attach files back (H5) and replying from Home requires opening the floating panel (no inline reply).
- **D (email came in):** Sync logs it, person timeline shows it, outreach flips to replied automatically. Works, but the institution sheet never shows the email (H1) and nothing surfaces sync health (M10).
- **E (find "that thing about NUPCO"):** Fails. No global search (H2).

## Performance summary

- Initial load: 19 parallel GETs, ~200KB. Acceptable.
- Any write: PATCH + the same 19 GETs (measured 20 requests per task-checkbox toggle). M1.
- Notes/materials/templates writes correctly patch local state (no reload); the pattern exists and works.
- No component memoization anywhere; `buildInstitutions` and `resolveContactRoles` recompute per render, `NetworkTab` runs `resolveContactRoles` for all 58 contacts on every keystroke in the search box. Not yet user-visible at this data size.

## Data integrity check results (live, July 11)

All orphan checks returned 0 except: `activities_fully_orphaned = 1` (L3) and `enabler_contacts_missing_in_roles = 1` (C2 evidence). Legacy/new people tables otherwise in sync; no duplicate institution names; no dangling FKs. The risks in C1 are prospective, not yet realized.
