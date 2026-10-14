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

1. **Done on this audit branch:** `client-form.html` no longer claims the form is only demonstrative; the subtitle now accurately says client information is saved/updated through the server. The shared validation helpers and isolated form-scenario tests now pass on the latest tested head; see the current PR verification section for exact SHA/run.
2. Client and case lists request `limit=100`; no pagination/load-more flow was observed in these pages. Define the expected behavior before claiming support for larger offices.
3. The client profile has placeholder counts for hearings, actions, and documents. Replace only when the corresponding data sources are integrated; until then label them as unavailable or omit them.
4. Client create and patch schemas now validate the Iranian national-code checksum server-side as well as requiring normalized 10-digit format. Corporate national/company identifiers remain governed by their separate format rules.
5. Navigation entries for calendar, actions, and documents are `#` placeholders on `main`; they should be linked only when their feature has been reviewed and safely integrated.
6. Case create/edit now uses tested local `datetime-local` to UTC ISO and back conversions. The conversion follows the browser's local timezone; deployment/user timezone policy should still be confirmed.
7. Remaining acceptance work includes browser-driven keyboard/RTL usability and real staging/API/database checks for duplicate identifiers/case numbers, stale sessions, and office-boundary denials.

## Automated tests added on this branch

- Shared browser/Node helpers normalize Persian/Arabic-Indic digits, validate Iranian national-code check digits, validate Jalali dates by round-trip conversion, and convert local `datetime-local` values to/from UTC ISO timestamps without silently accepting invalid calendar dates.
- Node's built-in test runner covers digit normalization, national-code checksum cases, Nowruz conversion, invalid Esfand dates, local-time round trips, and isolated form-controller scenarios using a lightweight fake DOM and queued API responses. It imports the actual Zod client create/patch schemas to test valid Persian-digit normalization, invalid/repeated check digits, optional patch updates, CSRF middleware placement, and schema-level HTTP 400 response logic.
- Added `backend/tests/client-routes-http.integration.test.cjs`: it launches the actual Express backend and sends real HTTP requests against a disposable PostgreSQL service provided by GitHub Actions. It checks HTTP 400 for invalid-checksum POST and PATCH, HTTP 403 for an invalid CSRF token, HTTP 201 plus persisted client data/audit entry for a valid POST, and HTTP 200 plus persisted edits/audit entry for a valid PATCH.
- Extended the HTTP suite with cross-office authorization cases: client detail and national-code lookup for a client in another office both return HTTP 404; PATCH against that foreign-office client returns HTTP 404 and verifies its stored name remains unchanged. The fixture uses a synthetic second office in the disposable CI database.
- Added a transaction-integrity regression case that installs a temporary trigger to simulate an audit-log insert failure, attempts a valid client creation, expects HTTP 500, and verifies the client row was rolled back and no extra create-audit row persisted. The trigger/function are removed in a `finally` block.
- These tests exercise the existing SQL office predicates and create transaction boundary; they do not prove every endpoint or role-specific permission is exhaustively covered. The fixture is created and torn down in the ephemeral CI database; it does not use Render, production credentials, or any operational database.
- GitHub Actions workflow `.github/workflows/forms-validation.yml` installs backend dependencies, starts PostgreSQL 16 as an isolated service, runs the existing form-validation suite, and then runs the real-HTTP integration suite.
- Earlier successful runs cover the pre-integration suite only. The new real-HTTP test is not considered verified until GitHub Actions completes successfully on the exact latest PR head SHA; report that run and SHA below after CI completes.
- The fake-DOM tests remain useful for browser-controller behavior but do not replace full browser automation or staging checks. The new HTTP suite exercises the real server and disposable database but does not prove production deployment health or every authorization boundary.

## Open PR overlap that must be reconciled

- PR #4 `feature/case-documents-metadata` adds a metadata UI/API using `/api/case-documents` and migration `backend/migrations/004_case_documents_metadata.sql`.
- PR #5 `feature/case-documents` also adds `documents.html` and `documents.js`, but uses a different `/api/documents` API and a different migration path/schema. The two PRs overlap on navigation and shared pages including `actions.html`, `backend/src/server.js`, `calendar.html`, `cases.html`, `clients.html`, `documents.html`, and `index.html`.
- Do not merge both as-is. Compare API contracts, migration/table definitions, role permissions, audit behavior, soft-delete semantics, and tests; choose one canonical contract or deliberately reconcile them into one follow-up branch. The metadata-only boundary is correct for the current hosting setup; real file upload/download remains out of scope until private durable storage is separately selected and reviewed.

## Recommended implementation sequence

1. Keep this audit branch isolated; do not merge it into `main` as part of this snapshot.
2. Keep server-side national-code checksum validation covered by schema tests and real-HTTP integration tests; next add browser-driven acceptance tests and run staging-only API checks.
3. Improve list scalability (pagination or explicit capped-result messaging) and remove/label placeholder profile metrics.
4. Review PR #2 and PR #3 for integration order and verify current-head CI and office-isolation tests.
5. Reconcile PR #4/#5 into one canonical document-metadata implementation before any merge.
6. Wire navigation only to reviewed features; then run end-to-end acceptance and security tests in a disposable/staging environment.
7. Do not deploy or migrate production as part of this form-completion phase.

## Verification note

This remains a repository audit with isolated controller tests, not a full browser-run acceptance test. The test harness uses fake DOM elements and mocked API responses and does not connect to production or any database. Recheck the current head and Actions run before merge.


## Real-HTTP integration verification (PR #6 follow-up)

- Test file: `backend/tests/client-routes-http.integration.test.cjs`.
- CI setup: disposable PostgreSQL 16 service with synthetic office, user, and session rows; the test starts the actual backend on a local runner port and calls it over HTTP.
- Required assertions: invalid national-code checksum returns HTTP 400 on client POST and PATCH; invalid CSRF returns HTTP 403; valid client creation returns HTTP 201 and persists the client plus audit row; valid client edit returns HTTP 200 and persists normalized national code, changed name, and audit row.
- Safety boundary: only the temporary CI service database is initialized/dropped. No production URL, Render service, or main-branch file is used by this test.
- Verification status for the previous real-HTTP suite: successful on prior head `ddacb47e1dee8e04c52270f0360d01d228906343` (GitHub Actions runs #66 and #67). The newly added office-isolation and audit-failure rollback cases are pending CI on the current branch head; confirm the exact PR head SHA and both push/PR workflow runs before treating this extension as verified.


### CI follow-up: backend launch path correction

- The real-HTTP harness initially resolved its child-process working directory to the repository root while launching `src/server.js`, which is under `backend/`. That would prevent the backend from starting in CI.
- Corrected the harness working directory to `backend/` (commit `d8a21e4a1a78c6d2861601d0e870c1f1a1dbf23f`).
- Verification for this correction is pending the newest GitHub Actions run on the exact updated PR head SHA. The older in-progress runs on SHA `0729ae1793772c23cc8671d0b43b70b39e763e82` do not verify this fix.
