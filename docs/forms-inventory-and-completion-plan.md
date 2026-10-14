# Dadban form inventory and completion plan

Status: **audit snapshot — not an approval to merge or deploy**
Date: 2026-10-15
Repository: `fzhtftp-commits/Dadban`
Baseline branch: `main`
Baseline commit: `c36b108f03d530375657a798151c330290d5a950`

## Scope and safety

This report inventories the form-related UI and the open feature branches before further implementation. It does not modify `main`, Render settings, or any operational database. The feature PRs referenced below remain Draft/unmerged. CI status must be checked against each current PR head before any integration; a historical green run is not sufficient.

## Forms and pages already present on `main`

| Area | Existing files / behavior observed | Current assessment |
|---|---|---|
| Dashboard | `index.html`, `app.js`; live dashboard request to `/api/dashboard`; links to recent cases and a new-case form | Present; not a data-entry form |
| Client list | `clients.html`, `clients.js`; search by name/identifier/phone/email and status filter; requests `/api/clients?limit=100` | Present; currently loads at most 100 records with no visible pagination |
| Client create/edit | `client-form.html`, `client-form.js`; individual/company switch, identity fields, contact details, address, notes; create and PATCH requests with session credentials and CSRF token | Present and API-connected; validate all fields and error paths with automated tests |
| Client profile | `client-profile.html`, `client-profile.js`; client details and linked cases; edit/delete controls | Present; displayed session/action/document counts include placeholders and should not be represented as live metrics |
| Case list | `cases.html`, `cases.js`; search, status filter, client filter via query parameter; requests `/api/cases?limit=100` | Present; currently loads at most 100 records with no visible pagination |
| Case create/edit | `case-form.html`, `case-form.js`; national-code lookup at `/api/clients/lookup`, client-name confirmation, case number/title/type/court/branch/opposing party/status/priority/dates/description/notes; POST/PATCH with CSRF | Present and API-connected; verify date/time behavior and validation end-to-end |
| Case profile | `case-profile.html`, `case-profile.js`; case details and edit/delete controls | Present |
| Hearings calendar | Not present on `main`; added by Draft PR #2 | Feature branch only |
| Case actions/follow-ups | Not present on `main`; added by Draft PR #3 | Feature branch only |
| Case-document metadata | Not present on `main`; attempted in Draft PRs #4 and #5 | Feature branches only; architecture overlap must be resolved first |

## Form-quality gaps and work status

1. **Done on this audit branch:** `client-form.html` no longer claims the form is only demonstrative; the subtitle now accurately says client information is saved/updated through the server. The shared form-validation and form-contract test workflow now passes on the current PR head (run 38635356372, SHA `33c99f8f1c8bff32a25e9274ed032359138c4917`).
2. Client and case lists request `limit=100`; no pagination/load-more flow was observed in these pages. Define the expected behavior before claiming support for larger offices.
3. The client profile has placeholder counts for hearings, actions, and documents. Replace only when the corresponding data sources are integrated; until then label them as unavailable or omit them.
4. The UI validates national-ID length, but a full Iranian national-code checksum validation was not observed in the inspected client form/server schemas. Decide whether to add checksum validation with shared front/back-end tests; do not rely on browser-only validation.
5. Navigation entries for calendar, actions, and documents are `#` placeholders on `main`; they should be linked only when their feature has been reviewed and safely integrated.
6. Case create/edit uses a browser `datetime-local` value and converts it to ISO before submission. Add tests that document the intended timezone behavior so hearings are not shifted unexpectedly.
7. Acceptance tests should cover invalid/missing fields, duplicate identifiers/case numbers, stale session/CSRF, server failures, keyboard/RTL usability, and office-boundary denials.

## Automated tests added on this branch

- Shared browser/Node helpers normalize Persian/Arabic-Indic digits, validate Iranian national-code check digits, validate Jalali dates by round-trip conversion, and convert local `datetime-local` values to/from UTC ISO timestamps without silently accepting invalid calendar dates.
- Node's built-in test runner covers digit normalization, national-code checksum cases, Nowruz conversion, invalid Esfand dates, local-time round trips, and static contracts for client/case create-edit routes, CSRF headers, client lookup, and script loading order.
- GitHub Actions workflow `.github/workflows/forms-validation.yml` executes `node --test backend/tests/forms-validation.test.cjs` on matching PR changes.
- Recorded validation checkpoint (historical): [Run #19](https://github.com/fzhtftp-commits/Dadban/actions/runs/38635505281) succeeded for SHA `5ac10975c1c26df66137f90915fbf129040b520c`. For the current PR head and latest matching CI run, see the verification section in [PR #6](https://github.com/fzhtftp-commits/Dadban/pull/6). The tests are unit and source-contract tests; they are not browser automation or a live API/database end-to-end test.

## Open PR overlap that must be reconciled

- PR #4 `feature/case-documents-metadata` adds a metadata UI/API using `/api/case-documents` and migration `backend/migrations/004_case_documents_metadata.sql`.
- PR #5 `feature/case-documents` also adds `documents.html` and `documents.js`, but uses a different `/api/documents` API and a different migration path/schema. The two PRs overlap on navigation and shared pages including `actions.html`, `backend/src/server.js`, `calendar.html`, `cases.html`, `clients.html`, `documents.html`, and `index.html`.
- Do not merge both as-is. Compare API contracts, migration/table definitions, role permissions, audit behavior, soft-delete semantics, and tests; choose one canonical contract or deliberately reconcile them into one follow-up branch. The metadata-only boundary is correct for the current hosting setup; real file upload/download remains out of scope until private durable storage is separately selected and reviewed.

## Recommended implementation sequence

1. Keep this audit branch isolated; do not merge it into `main` as part of this snapshot.
2. Correct stale client-form copy and add/confirm focused tests for client create/edit and case create/edit, including national-code lookup and date handling.
3. Improve list scalability (pagination or explicit capped-result messaging) and remove/label placeholder profile metrics.
4. Review PR #2 and PR #3 for integration order and verify current-head CI and office-isolation tests.
5. Reconcile PR #4/#5 into one canonical document-metadata implementation before any merge.
6. Wire navigation only to reviewed features; then run end-to-end acceptance and security tests in a disposable/staging environment.
7. Do not deploy or migrate production as part of this form-completion phase.

## Verification note

This remains a repository-source audit, not a browser-run acceptance test. The dedicated form-validation workflow passed on the recorded head SHA above; a successful unit/contract-test run does not establish that live API/database integration or browser behavior is fully accepted. Recheck the current head and Actions run before merge.
