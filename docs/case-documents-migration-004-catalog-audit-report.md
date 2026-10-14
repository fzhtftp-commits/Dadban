# Migration 004 catalog audit report

Date: 2026-10-14
Scope: `backend/migrations/004_case_documents_metadata.sql` on `feature/case-documents-metadata`

## Current PR and CI evidence

- PR #4 is open, Draft, and unmerged; base branch is `feature/case-actions`.
- Latest confirmed passing catalog-test commit at the time of this report update: `9b6620480c47fa12ed35749a7dc333f9c74ff812`.
- GitHub Actions run [38624760976](https://github.com/fzhtftp-commits/Dadban/actions/runs/38624760976) completed successfully on that exact SHA; the `backend-tests` job and all steps passed. Its SHA matched PR #4's current head when checked.
- Report-update commit [ca5004019f3128498d35d344488675e0c9c90ef8](https://github.com/fzhtftp-commits/Dadban/commit/ca5004019f3128498d35d344488675e0c9c90ef8) also passed CI in run [38624734607](https://github.com/fzhtftp-commits/Dadban/actions/runs/38624734607), on that commit's exact SHA. Subsequent catalog-test additions were separately checked by run 38624760976.
- The catalog test now also asserts all indexes are live, valid, and ready; requires B-tree access methods; checks primary-index identity and exact key attributes; and checks unique-index NULL semantics.
- Operator-class audit follow-up: runs [38624986676](https://github.com/fzhtftp-commits/Dadban/actions/runs/38624986676) (SHA `2067693c49148d315bc8291bbb6f07627bd0f3ff`), [38625107257](https://github.com/fzhtftp-commits/Dadban/actions/runs/38625107257) (SHA `0d3a573ffedb4bb60e138cced484cbd6b207ea33`), and [38625217746](https://github.com/fzhtftp-commits/Dadban/actions/runs/38625217746) (SHA `6c5060b797b0d2df8738bf79ce39d3caf67994d6`) failed with `index key operator class differs from expected catalog contract`. The actual mismatch was the expected operator class for the `idempotency_key` (`varchar`) index key: PostgreSQL uses `text_ops`, not `varchar_ops`. The test-only fix is commit `e45e4584792765e1eb93bc7ed6299499fc89f45b`; run [38625342030](https://github.com/fzhtftp-commits/Dadban/actions/runs/38625342030) completed with conclusion `success` on that exact SHA (job `backend-tests`: success).
- Report-head CI: before this report update, report commit `20fd5eceaddd55904e63a400ad203fe10e723299` matched PR head and run [38625362024](https://github.com/fzhtftp-commits/Dadban/actions/runs/38625362024) completed with conclusion `success` on that exact SHA (job `backend-tests`: success). A new CI run for the next report commit is required before that new head is considered validated.
- Report/CI alignment: this update records the verified failure and current fix commit; the current report-head CI must also finish successfully before the report is considered fully validated.
- Confirmed report-head CI: run [38625479254](https://github.com/fzhtftp-commits/Dadban/actions/runs/38625479254) completed with conclusion `success` on exact SHA `16e724ff204d087b6844f5a4dd973d93319d8ad1`; the `backend-tests` job passed with no failed steps. That SHA matched PR #4 head at verification time; PR remained open, Draft, and unmerged (base `feature/case-actions`).
- Next catalog-audit extension: test commit `beed2ed1c9aed81c463501d3e1872e24d0394c09` adds explicit checks that `case_documents` is a regular permanent table (`relkind='r'`, `relpersistence='p')) and that every FK/CHECK constraint is validated and not marked `NO INHERIT`. This extends the audit to table-level persistence and constraint catalog flags; CI for this new commit and the following report update must be checked against their exact SHAs before claiming green.
- Failure analysis and correction: runs [38625702934](https://github.com/fzhtftp-commits/Dadban/actions/runs/38625702934) on `beed2ed1c9aed81c463501d3e1872e24d0394c09` and [38625720810](https://github.com/fzhtftp-commits/Dadban/actions/runs/38625720810) on `ad3143c37307ef3891c60d2af161ce8db52a91c3` both failed at the new catalog assertion with `ERROR: FK/CHECK validation or inheritance flags differ from migration contract` (PL/pgSQL `RAISE`, generated block line 482). The predicate incorrectly applied `connoinherit` to both FK and CHECK constraints. Corrected in test commit `009f9620c1e632dc440eefa61809ae9932d50e83`: all FK/CHECK constraints must be validated, while the `NO INHERIT` flag is tested only for CHECK constraints. This is a test-only correction; migration SQL is unchanged. CI for the correction and this report update is pending and must be checked on exact SHAs.
- The report commit `98482d4672d9054ba2cff36d7bca035ebf1c4b6e` passed in run [38624956955](https://github.com/fzhtftp-commits/Dadban/actions/runs/38624956955); that passing result does not cover the later operator-class assertion or its current fix.
- Earlier run [38624551651](https://github.com/fzhtftp-commits/Dadban/actions/runs/38624551651) passed on exact SHA `cfed5a18268a2c30ef0e65069ed4e5ab03097ff9`. The preceding run [38624403599](https://github.com/fzhtftp-commits/Dadban/actions/runs/38624403599) failed due to an incorrect expected DESC `indoption` bitmask; the test was corrected on the feature branch and the follow-up passed.
- No migration SQL, `main`, production database, or Render service was changed.

## Catalog coverage

The test applies the actual migration into a schema isolated inside the GitHub Actions disposable PostgreSQL database; parent tables come from that disposable baseline. It does not point at a shared or production database.

- **Columns (20):** exact inventory, ordinal position, name, formatted type, nullability, and absence of unexpected identity/generated/inherited attributes.
- **Defaults (5):** exact normalized default expressions for `id`, `document_type`, `storage_status`, `created_at`, and `updated_at`; rejects any extra default.
- **Primary key:** must be validated and key only `id`.
- **Foreign keys (4):** exact constraint-name inventory, composite source and target column order for office-scoped case/creator/updater relations, target tables/columns, validation, and rejection of non-default action/match/deferrability settings. The direct office FK is included in the exact inventory and target checks.
- **CHECK constraints (5):** exact constraint-name inventory and validation; two cross-field invariants are compared using normalized full catalog expressions. The actual catalog expressions for document type, storage status, and size limit are evaluated against allowed-value and boundary matrices: all expected enum members must pass, unexpected values must fail, and size limits test NULL, -1, 0, 25 MiB, and 25 MiB + 1. Cross-field probes check metadata-only/storage-key combinations and all idempotency/fingerprint pairing cases.
- **Indexes (4 including PK):** exact index-name inventory; key order/count, uniqueness, partial predicates, validity/readiness, and expected index definitions are checked for all three migration indexes and the PK index.
- **Negative fixture:** same-named but incompatible table, CHECK, FK, and index definitions are deliberately created and inspected so object names alone cannot make the fixture appear compatible.

## Interpretation and remaining limitation

The checks combine catalog metadata comparisons with executable behavior probes. The behavior probes detect meaningful changes in the three inline CHECK rules, but they are not a formal proof of logical equivalence for every possible SQL expression. If a future review requires strict normalized-text equality for those three inline expressions as well, add it only after verifying PostgreSQL's actual deparsed form in the disposable CI environment. Do not describe this automated audit as a production migration test or legal/security certification.

## Safety boundaries

- Migration execution is limited to the disposable PostgreSQL service in GitHub Actions.
- No production database, `main`, Render service, or deployed migration was changed.
- PR #4 must remain Draft and unmerged.
- For every subsequent change, report CI as green only when the successful workflow's `head_sha` exactly matches the current PR head.
