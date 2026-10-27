# Validation scope

This document is a chronological validation record. Counts, limitations and “planned” statements in earlier delivery sections describe those checkpoints, not necessarily the current implementation. Later sections supersede earlier implementation descriptions. Live Gmail, sending and follow-ups remain absent. The October 25 EDA helper adds Windows automation code and a durable queue; real ECUS compatibility remains unverified. See [Windows export handoff](windows-companion.md).

## Week 3 model comparison and GLM semantic validation — October 26, 2026

GLM 5.3 Flash remains the configured document model. The extraction prompt now describes source-field roles in English and Vietnamese, distinguishes waybill identifiers from year fields, preserves transport codes as source evidence, and separates goods from shipment summaries and service charges. New semantic guards reject explicit role contradictions without inventing replacement values. Current page classifications are passed into both provider grounding and the workspace action. Raw proposals and reason-coded rejections remain available for audit. The phone reconciliation preserves accepted transport-party evidence as phone ownership only and requires independent commercial-party corroboration; it never restores a rejected commercial role.

- The final integrated suite passed **668 tests**, with no failures or skips. Type checking, lint and the production build passed. A new prompt/schema regression verifies that the requested flight field is allowed and reaches grounding. Focused checks also cover uncertain or mislabeled item evidence, adjacent date labels, unchanged employee-reviewed values and independent phone provenance.
- The original comparison used four approved original pages and three completed models; Terra had no eligible route and was not scored. Original costs totaled $0.84281422. Three fresh GLM rounds cost $0.03707512; the combined $0.87988934 exactly matched OpenRouter key usage. All attempts, including regressions and a corrected prompt field-name mismatch, are retained rather than selecting only the best run.
- The unchanged 97-fact reference plus a semantic supplement were frozen before fresh results. Raw model proposals and accepted application candidates are scored separately; omissions, extra goods rows, unsupported roles and wording-only differences remain separate. See `outputs/week3-glm-improvement-20261026` for the frozen rubric, outcome hashes, full inventories, round-by-round reviews and billing reconciliation. These reused development pages do not establish representative or whole-form accuracy.
- Final fresh verification: the frozen scoped raw score was 94 correct known facts plus one definite VAT-to-country error (94/95, 98.95%), with three known facts omitted. Grounding retained all 94 correct scored facts and rejected the VAT value; the accepted scoped score is 94/94. Three additional raw assignments were also rejected outside that scalar denominator: an unindexed RUNNER description, a shipment-level equipment reference in goodsModel without an item row, and an unsupported pickupDate key. These percentages are not full-output or whole-form accuracy. All 11 invoice item rows remained and no extra accepted goods row appeared. Full results: `outputs/week3-glm-improvement-20261026/final-before-after-comparison.json`.
- The final offline replay used the same 22 saved page outcomes and made zero provider calls. It had no apply failures, preserved prior phone/location/package fixes and removed two visually confirmed transport-and-packaging charge rows. All 21 surviving row identities and their HS/origin values remain unchanged. A reference-only invoice row remains unresolved. This is mapping regression evidence, not new model inference or a legal/customs assessment. Exact audit: `outputs/week3-glm-improvement-20261026/mapping-replay-final-v2/identity-audit.json`.

The Week 3 PDF and editable Word report are in `outputs/week3-report-20261026`. No deployment, customer-record update, real Windows ECUS operation or customs submission occurred in this work.

## EDA saved drafts and recovery — October 26, 2026

Unfinished EDA forms now save on the server independently of the aggregate workspace revision. Each accepted save has a version, employee, time, source fingerprint and immutable audit snapshot. Submit requires the latest saved values. Failed or interrupted transfers expose approved/readback differences and an immutable employee recovery decision; retries require acknowledgement and renewed confirmation and create a single linked child job.

- The 595-test application regression suite and 10 additional editor-state tests passed. Actual-migration SQLite tests cover concurrent saves, stale source/version writes, membership/device revocation races, atomic history, active-lease recovery blocking, acknowledgement scope, one-child retries and delayed readback before/after resolution.
- All 46 portable Python helper tests passed. Recovery retains original leases, reports interruptions, durably records decisions before acknowledging, retries lost acknowledgements and prevents old-job replay. No real native UI was used.
- Isolated HTTP checks passed for unfinished dates/text, reopening, stale form/workspace versions, source-change confirmation, exact saved-form submission, mismatch evidence, immutable callbacks, audited resolution, acknowledgement gating and an exactly-once linked retry.
- Two independent browser tabs verified server persistence, an unfinished date, side-by-side conflicting values, explicit conflict resolution and saving version 3. A separate synthetic browser case verified mismatch display, employee reason/confirmation, acknowledgement blocking, renewed Submit and preserved original history after a simulated successful retry. Both tabs reported no browser errors. Evidence: `outputs/ecus-draft-conflict-verification.png` and `outputs/ecus-recovery-verification.png`.
- Type checking, lint and the isolated production build passed. The build retains its large-chunk and route-classification advisories. Verification used `/private/tmp/aicd-eda-recovery-verification` with a disposable database and no provider credentials. Test pairings were revoked, temporary credentials removed and the isolated server stopped. Customer shipment records were not modified.

The website needs migration `0005_ecus_drafts_and_recovery.sql`, and the Windows helper must be updated alongside it. Control calibration and a supervised real Windows/ECUS test remain outstanding; synthetic results do not establish native compatibility. Export AI extraction and unsupported EDA fields are unchanged.

## EDA export handoff — October 25, 2026

The employee-confirmed export form now queues immutable values for a paired Windows helper. Imports remain a separate workflow. The helper implements the export menu, mapped field/goods entry, local draft save/reopen and complete supported-field readback. Its included profile is uncalibrated; no real Windows/ECUS operation has been performed.

- All 567 application tests passed, including 27 new export-contract and SQLite queue tests. Authorization revocation races, exclusive claims, idempotency, expired leases and saved-value mismatches are covered.
- TypeScript checking, ESLint and a production build in a separate source copy passed. The new database migration applied successfully to that copy's empty local database.
- The isolated HTTP smoke test passed device pairing, token/origin rejection, explicit confirmation, stale revisions, repeat Submit, payload hashing, single claim, result verification and replay. Its completion was a synthetic callback, not a native ECUS result.
- Browser verification in the disposable workspace covered creating an export case, general/goods editing, restoring edits after navigation, settings and disabled Submit when no Windows computer is ready. No browser errors were recorded.
- All 32 portable Python tests passed, including the fake native save/reopen/readback sequence and rejecting an existing EDA editor before menu invocation. A real supervised test, calibration of the installed controls, and an operator reconciliation/retry feature remain outstanding. Containers and EDA fields outside the supported subset remain manual.

No customer shipment records, live AI provider, Gmail, ECUS installation or customs service was used. The user's normal local server was not stopped; only the separate verification server was started and stopped.

## Evidence available

No existing repository was supplied. Six real shipment PDFs (55 pages) were supplied later and inspected locally. They are now stored together in the local application as described in the latest section. Their contents and derived results remain in ignored local storage; source fixtures contain synthetic examples only. No broad extraction accuracy or real ECUS success metric is reported.

## Required software checks

The domain regression suite covers source/page provenance, classification and grouping, contradictory facts, safe normalization and ambiguity, duplicate inputs, manual review, unsupported/scan paths, replacement invalidation, immutable snapshots, archive/reopen, test connector failure/retry/idempotency and an empty regulatory engine.

The API validation suite exercises request limits, file signatures, action allowlists, same-origin checks and revision conflicts. Browser/API smoke tests cover persistent intake and the review path. Type checking and a production build verify the integrated application.

Run `npm test` for the actual executable test list. See the delivery notes for checks completed in the development environment. A passing synthetic test proves the checked behavior only; it does not establish general extraction or customs correctness.

## Not yet tested with real evidence

- Supplier layouts, scans, languages and missing-page patterns across real shipments.
- Extracted-field accuracy and wrong values that software failed to flag.
- Shipment grouping mistake rates and broker review time.
- An authorized live Gmail synchronization and its retention policy.
- Multi-person use under the selected Google sign-in and owner-approval flow.
- Real ECUS installation, real draft creation/read-back, transmission or registration.
- Executable current customs rules, code tables, valuation, duty/VAT, origin/FTA or HS classification. The source-based VNACCS field audit is separate from legal validation.
- Live Supabase sign-in, SMTP invitations/recovery, session renewal and standalone deployment in the owner's cloud accounts.

## Acceptance boundary

Internal approval freezes an AICD review snapshot; it does not grant customs approval. `Create test ECUS draft` executes the **test** connector only. Legal/customs validation remains unassessed, including after a successful test run or archive.

## Verified in this delivery (October 10, 2026)

- `npm test`: domain, API/persistence, PDF layout, OCR layout, report and localization regression tests pass; run the command for the current count.
- `npm run typecheck`: passed on the integrated code.
- Production build: passed; PDF font and parser are loaded on demand.
- `node scripts/smoke-api.mjs`: 8 integration groups passed against the running loopback app. This included an authenticated review-to-snapshot workflow, failed/successful/idempotent test handoffs, responsible completion and reopen, exact EML/PDF original-byte preservation, duplicate messages, concurrent HTTP 200/409 saves, and HTTP 400/403/404/401 guards.
- Browser inspection: sign-in, synthetic demo queue, source evidence, conflicts displayed side by side and a reviewer decision persisted; no client console errors in the inspected flow.
- PDF: Vietnamese and English reports generated from synthetic state, reopened and rendered with Poppler. Both eight-page reports passed visual checks for Unicode, page breaks, source references, changes and footer numbering.

## Email/password and Kimi update

- At that earlier checkpoint, 96 automated tests passed, including provider identity validation, invite allowlists, atomic throttling, one-use recovery proofs, cookie protections, bounded and redacted provider responses, callback parsing and localization, session refresh, Kimi page selection, exact source grounding, version retirement and review invalidation. See the local delivery section for the later integrated count.
- The standalone build and Wrangler dry run passed without deployment, using clearly synthetic infrastructure identifiers. Generated configuration selects Supabase mode, disables simulated Sites identity and resolves both D1 migration files.
- Local HTTP checks rejected forged platform identity headers in standalone mode, rejected HTTP password submission before any provider call and blocked cross-origin authentication requests.
- Browser inspection verified English/Vietnamese login and password-reset screens using a fake local provider configuration without submitting credentials. The unconfigured state blocks login. Kimi settings display the international endpoint and unavailable state until server configuration exists.
- Eight existing API integration groups passed again after the auth changes. These checks cover the Sites-mode local workspace with synthetic data; they do not substitute for live Supabase testing.

At that checkpoint, Kimi only proposed factual header fields from explicitly selected stored text pages (up to five pages / 24,000 characters). The shipment-first update below adds automatic bounded intake and commercial goods proposals. Successful proposal saves are audited. Failed or timed-out provider attempts consume the rate limit but do not yet create a separate durable transmission ledger. Requests are not automatically retried after provider errors.

The API smoke script supplies known text fixture pages for its PDF upload. That check validates storage and page/provenance constraints, not the browser PDF text parser's accuracy. These API and workflow tests use synthetic data only. The separate real-sample regression is described below.

## Earlier real-sample checkpoint: exact coverage

- Inventoried all six PDFs and all 55 physical pages. 54 pages have absent/minimal native text; one master B/L page has a usable text layer.
- Local regression processed nine scanned pages with the same Tesseract.js engine and bundled language models used by browser intake, plus one native-text page. The sampled scans cover the combined invoice/packing file, C/O, HBL, labelled contract, and three detailed packing pages.
- 23 selected header/goods values matched local visual checks: invoice/packing facts and one invoice goods row, plus HBL/MBL references. These are selected engineering checks, not a broker-approved declaration or a full-field accuracy denominator.
- 56 candidate values and two document-level goods proposals were retained; the case prefers the invoice goods proposal for review. The initial partial state was approximately 52 KB and had 24 actionable issues. No value was automatically approved.
- 45 further detailed packing pages were inventoried but not OCR-validated in this delivery. Dense rotated component tables, Chinese text, C/O OCR ambiguities and the document labelled contract require human verification. The application exposes source/manual review paths.
- This historical OCR checkpoint is not the current extraction pipeline. Its local evaluator was removed when production extraction became Kimi-only; the private historical result remains ignored at `outputs/private-sample/regression-results.json`.
- Browser QA verified the language switch, preference across reload, queue and review screens. Browser file-picker automation stalled, so end-to-end browser upload/OCR was not verified. Direct API original-file intake, parser/OCR module checks and local OCR evaluation were tested separately.

Do not report 23/23 selected matches as overall shipment accuracy. Unchecked fields, grouping mistakes, reviewer time and actual ECUS transfer still have no representative measurement.

## Local delivery and reference audit

- At the previous local-delivery checkpoint, the integrated suite had **120 passing tests**. Added coverage included the loopback launcher, duplicate-instance protection, draft-save races, local actor selection, reference coverage and audit payload copying. Later review invalidation cannot mutate earlier audit before/after details.
- Integrated TypeScript checking and a production build pass. Local access is development-only and cannot be selected by a production build.
- Eight API integration groups passed in local mode using synthetic data. Nine read-only local boundary checks passed, including spoofed Host, cross-site Origin, forwarded headers and private file paths.
- Restart checks preserved the exact workspace and original PDF hashes. A second launch on the same or a different port was rejected without rotating the running instance's private configuration.
- Browser inspection verified direct local access, Vietnamese/English presentation, persistent language preference, case and global reference views, combined filters and case values. No console errors were observed in the inspected flow. The previously noted browser file-picker/OCR end-to-end gap remains.
- The source-fact registry covers all 96 numbered indicators with 13 source amendments: 15 partial source relationships, 4 manual relationships, 72 gaps in the original source-fact mapping and 5 customs-authority/system-owned indicators. These mapping categories are separate from the structured editor added below. Exact ECUS mappings and current code tables remain unverified; executable legal rules remain empty.
- This update used synthetic data and source-reference research. It did not call live Kimi, Gmail or Supabase, contact ECUS, send email, publish or deploy the application, or retest private client documents.

The architecture and module explanation is in [the learning walkthrough](code-walkthrough.md). The source download excludes `.aicd-local`, other runtime state, credentials, client documents and old build archives; it is not a backup of shipment records.

## Structured declaration and ECUS-style interface update

- Final integrated checks: **152 tests passed**, TypeScript passed, production build passed. The bundler still reports a large-chunk advisory; no build error occurred. New PDF declaration content is covered by automated report checks; the earlier eight-page visual PDF checks predate this expanded section.
- The editor models 90 editable indicators, including 1.48 with a deferred fourth component. Five customs-owned indicators are read-only; 1.46 remains deferred. Of the 72 original source-fact gaps, 71 now have a capture model (70 without an explicitly blocked component, 1.48 partial); this does not add automated extraction, verified legal rules or ECUS import mappings.
- New tests cover strict typed payloads, malformed decimal/date handling, explicit applicability and evidence, preserved manual context, scope, stable repeating IDs, parent-row references, goods identity collisions, stale review, audited orphan removal, immutable snapshots and old-record initialization. Exact decimal reconciliation catches small differences without a universal rounding tolerance; malformed unit price and packing-list date checks are active.
- Five `smoke-declaration.mjs` HTTP groups pass: incomplete saved drafts versus reviewed values, forged/blocked inputs, stable row links and invalidation, HTTP 409 conflicts and reopened drafts, and explicit audited orphan removal. Existing eight workflow API groups and nine loopback boundary checks also pass.
- A full stop/start preserved the exact JSON workspace hash, saved declaration drafts, earlier snapshots and original PDF bytes at revision 94. Existing cases received empty drafts; no historical snapshot was rewritten.
- Browser checks cover General 1 / General 2 / Goods navigation, compound invoice components, persistent Vietnamese/English preference, review with a manual basis, unsaved input retained across sections/cases, disabled exports while edits are pending, accurate save-status labels and deliberate discard. Changes were tested with labelled synthetic data.
- The user supplied the software label ECUS5-VNACCS 2018. The layout follows published vendor help sections; no installed-build import template or accepted external declaration was verified. No real model, inbox, auth provider or customs service was called, and no deployment occurred.

Browser upload/OCR and live-provider limitations listed earlier remain; these tests do not establish representative extraction accuracy or legal correctness.


## Application structure and navigation cleanup (October 11, 2026)

- 148 regression tests, TypeScript checking and production build passed. Four tests exclusively for the removed coverage presentation helper were deleted; the declaration/reference/export checks remain.
- A fresh exported-source installation completed with `npm ci --offline --no-audit --no-fund`, including postinstall asset preparation. The fresh copy also passed all 148 tests, type checking and build.
- Eight workflow API groups and five declaration API groups passed with isolated synthetic data. Nine read-only loopback boundary checks passed against the existing local workspace.
- The existing workspace reopened at revision 94 with five cases and eight documents. Its serialized state hash exactly matched the pre-cleanup snapshot; browser testing saved no edits.
- Browser checks covered Vietnamese/English, desktop and narrow navigation, shipment section changes, unsaved declaration retention, disabled report/approval while edits were pending, and list search/filter retention on returning from a shipment. The final fresh browser tab reported no errors.
- The source export excludes runtime state, credentials, client originals, dependency directories and build caches. Unused hosting/login/template code was removed; no real Gmail, Kimi, Supabase or ECUS request, outgoing email or deployment occurred.

See [the cleanup notes](cleanup-2026-10-11.md) for module changes. At this cleanup checkpoint, Google sign-in, owner approval, automatic Gmail/Kimi processing and evidence-backed sender questions were planned work. The later shipment-first section records which parts were subsequently implemented and tested.


## Settings simplification (October 11, 2026)

- Settings now contains only Gmail and ECUS connection cards. Removed account/team/default-reviewer/regulations/practice-data controls and their unused UI code.
- Gmail address saves omit the default-reviewer field, preserving the existing assignment setting. Neither card claims an active connection.
- Type checking, production build and 21 existing localization/frontend-access tests passed. Browser inspection verified both languages and exactly two Settings sections with no browser errors. No settings or shipment data was saved during verification.

## Shipment-first intake and combined drafts (October 11, 2026)

### Current implementation and software checks

- Intake prepares the selected batch and saved-email attachments before one revision-checked workspace commit. Grouping runs before supported declaration autofill. Missing-information checks wait until grouping is confirmed and the available documents have readable extraction results; unreadable source pages remain visible review problems.
- Regression coverage includes attachment-order independence, evidence bridges, container subsets, contradictory House and unqualified B/L references, unsafe shared-container joins, duplicates, later attachments, preserved manual decisions, selective stale-source flags, exact totals, partial declaration components, source quotations, and immutable snapshots. Routine generated draft entries do not each become a confirmation question; real structural or evidence problems remain actionable.
- Final integrated checks: **190 tests passed**, TypeScript passed, and production build passed. Lint completed with no errors and three existing framework advisories (two full-page auth navigations and the private source-image preview). Vendored PDF/OCR workers are excluded from application linting. The build still reports a large-chunk advisory.
- The six intake HTTP groups, eight existing workflow HTTP groups and five declaration HTTP groups all passed on an isolated local server with synthetic data. Browser checks verified the six real documents in one shipment, both languages, evidence-backed confirmation questions, an editable local sender draft, preservation of unsaved email edits across navigation, and HTTP 409 recovery without losing typed text. Development hot reload briefly recreated the locale context while files were being edited; after reload the inspected flow had no new errors.
- `node scripts/smoke-shipment-intake.mjs` passed six synthetic HTTP groups: a complete multipart batch groups before autofill; duplicate batches are idempotent across file order; invalid later files or mismatched metadata leave no partial workspace changes; a valid PDF above 1 MiB reaches upload handling without false extraction success; saved-email attachments retain OCR metadata and sender relationships; and local question drafts remain editable while cross-shipment issue IDs are rejected.
- The greater-than-1-MiB smoke case exposed the framework's earlier multipart limit. `next.config.ts` now sets the framework body limit to 22 MiB, matching the bounded upload endpoint. Per-file/page limits and the 22-MiB whole-request limit still apply; the framework setting does not disable validation.
- Automatic Kimi intake is owner-configured, bounded and covered with mocked transport/fallback tests. Missing configuration continues local extraction; provider failures and limits preserve evidence with unavailable/failed/partial status. These software checks establish neither live model availability nor extraction accuracy.

### Real files now saved as one local shipment

- All **six supplied PDFs, containing 55 physical pages**, were imported and retained under the single local shipment **AICD-0006**. At the initial post-grouping checkpoint, the workspace revision was 101; later normal saves may increase that revision.
- **The final grouping was explicitly confirmed using the already visually checked cross-document references.** The automatic grouping run initially left five groups because its OCR-derived evidence was insufficient. This sample is evidence of a completed reviewed grouping workflow, not evidence that automatic grouping correctly joined all six files unaided.
- Local OCR has now been attempted for all 48 pages of the detailed packing list. Many dense, rotated or Chinese-language sections remain unreadable or uncertain with the current local language assets. OCR execution is not validation: these pages have not all been transcribed accurately or reconciled line by line.
- At that checkpoint, combined evidence produced **14 generated declaration entries and one commercial goods row**. These are unapproved source-backed draft values, not 14 broker-validated fields or a complete declaration. No individual field was approved and no final shipment approval or customs submission was performed.
- Each of the six originals was downloaded through the application's authorized document route and its SHA-256 compared with the supplied source file. All six hashes matched. This verifies original-byte preservation, not extraction correctness.
- The five pre-existing cases were compared with their baseline and remained unchanged. Private originals, OCR output, runtime records and verification artifacts remain local and excluded from source downloads.
- No live Gmail or Kimi call was made while processing this sample. No email was sent and no ECUS system was contacted. Ask sender currently creates an editable draft inside AICD only; it does not create a Gmail draft, deliver mail, monitor replies or schedule follow-ups.

The final sample revision is 102, with 14 generated declaration entries, one commercial goods row and 16 unresolved questions. Formatting-only differences in company-name spacing no longer create conflicts; different letters remain meaningful. The unresolved OCR and questions stay visible. Accurate completion of every declaration field and every packing-table line remains unverified. The [code walkthrough, Chapter 21](code-walkthrough.md#21-why-shipment-first-processing-changes-the-product) explains the implemented processing and review boundaries.


## Individual confirmation and real-only workspace (October 11, 2026)

- **205 automated tests passed**, including per-field history, explicit per-row confirmation, ignored incoming approval flags, safe save-only behavior, unchanged-row preservation, row-scoped fingerprints, high-confidence facts without routine questions, changed-source reopening and legacy confirmation recovery. Type checking and production build passed. Lint has zero errors and three existing advisories (two authentication navigations and the private image preview).
- **23 HTTP groups passed in a separate disposable workspace:** four new review groups, eight existing workflow groups, five declaration groups and six shipment-intake groups. They verify that one header confirmation retains every unrelated issue, saving a goods table grants no approvals, confirming one row retains other rows/questions, and saved history survives a fresh read. The smoke scripts require `AICD_SMOKE_ISOLATED=1`; their default port is 5174.
- Browser checks in the isolated workspace confirmed one exporter question and one goods row individually. Other questions remained pending; the completed count increased by one each time. Reload retained six pending questions and four completed decisions in the test case. The completed section started collapsed. No browser console errors were recorded for that inspected flow.
- Read-only browser verification of the actual workspace showed one shipment with six original PDFs, twelve pending questions and three earlier explicit field confirmations (importer, unloading port and vessel). All three historical values, timestamps and reasons were preserved. No additional real field or goods decision was made during testing.
- Removed five synthetic/demo cases and their eight documents from the actual workspace records at revision 106, after saving a local recovery copy. Four empty merged case shells remain hidden as grouping history. The retained real shipment, sources, candidates, draft and user decisions were preserved. Full stored-state comparison after QA exactly matched the post-cleanup snapshot. Recovery artifacts and old original blobs remain local and excluded from the source ZIP.
- The goods table's reviewed count now reflects goods rows, instead of counting header-field reviews. Saving edits and confirming a row are separate controls. Completed question snapshots are historical presentation; they cannot approve a current question.

The remaining questions reflect unresolved evidence, including uncertain OCR. This change does not establish extraction accuracy or customs correctness. No live Kimi/Gmail call, email send, ECUS connection or deployment occurred. The test server was stopped; the user's regular local application remains running. See [Chapter 22 of the walkthrough](code-walkthrough.md#22-confirming-one-question-must-not-confirm-its-neighbours).


## Kimi vision pipeline (October 12, 2026)

- 245 automated tests passed; typecheck and production build passed. Lint has no errors and three existing warnings. New coverage includes blank scans, bounded inline image requests, page/image/version binding, rejected proposals, progress/resume, separate PDF/OCR text, visual citations, draft autofill and preserved human decisions. Provider responses are mocked.
- A local endpoint check used page 1 of the supplied XCMG invoice/packing PDF. Its rendered JPEG was stored privately with a verified SHA-256; incorrect source versions, nonexistent pages and mismatched image dimensions were rejected. The test used PDFium to prepare its raster; production browser rendering uses PDF.js. Workspace revision stayed 269 across this check. No shipment records were mutated.
- Browser verification showed the new extraction dialog, page progress, administrator-only configuration message and disabled submission while the key is absent. The existing source documents stayed available.
- No live Moonshot call or empirical extraction accuracy evaluation was performed: the running server has no configured key. No Gmail message, ECUS transmission or deployment occurred.
- The old text-only page-selection helper was removed; text and vision now use the shared resumable batch planner. See [Kimi vision guide](kimi-vision.md) for activation and implementation boundaries.

## Email shipment matching and sample classification (October 12, 2026)

- The integrated suite passes **289 tests**. Added provider tests use mocked Kimi responses for exact references and quotations, ambiguous/shared identifiers, contradictory sources, line-bound heading parsing, truncated context, malformed output, timeout, and all-rejected or partially rejected proposals.
- Domain regressions cover individual confirmation, preserved human rejection, new conflicting evidence, omitted earlier AI links, document replacement, merged cases, archived correspondence and unchanged declaration approvals. Public API requests cannot inject internal AI-result actions.
- Isolated upload tests exercise the actual email upload function with private storage/server stubs. Plain-text and HTML-only replies preserve original EML bytes and searchable text without creating extra shipment documents/cases; duplicates and body-length limits are checked.
- Live local HTTP validation at revision 312 checked foreign-origin rejection (403), revision conflict (409), an empty mailbox (422), an unknown email (400), and forged internal actions (400). Workspace state remained unchanged; no Kimi request was made.
- All 42 previously misclassified sample collections were corrected through audited application actions: 25 reference collections, 15 export/re-export collections, and 2 with unresolved direction. Source hashes were checked first. The repair preserved all 857 documents, candidates, original grouping decisions, saved declaration values and unrelated cases. No shipment was approved.
- English browser checks verified the email intake/matching controls, specific reference collection labels, and removal of import-only approval actions from non-import records. Vietnamese/English dictionaries and scope checks also pass automated tests.
- Live Gmail retrieval is not implemented. No provider key is configured, and real Kimi grouping accuracy has not been evaluated. The private sample backup and repair evidence remain excluded from source exports.


## Kimi-only extraction (October 13, 2026)

- **304 automated tests pass**, together with TypeScript and the production build. Lint has no errors and three existing framework advisories. Mocked provider checks verify clear visual readings without OCR agreement, absence of legacy text from image requests, exact selected-page metadata, uncertain-page handling, source evidence, unsupported formats and partial results across several batches. These tests establish software behavior, not live model accuracy.
- Removed PDF.js, Tesseract, OCR language data and local OCR/PDF text readers. PDFium only renders pixels. New PDF uploads ignore caller-supplied text/OCR results and remain pending until Kimi reads the original pages. Legacy source records and human decisions remain preserved.
- Domain tests verify that clear source-backed facts and goods cells do not raise routine confirmation questions, while conflicting sources, ambiguous dates/numbers and genuinely unclear readings remain actionable. Re-reading preserves unchanged human decisions and records evidence replacement in the audit trail. Unsupported or unreadable originals do not become endlessly pending documents.
- A temporary, isolated browser rendering page generated a one-page PDF and verified the actual dedicated worker, self-hosted Wasm and 1200 × 600 RGBA output. This exposed and resolved a Vite worker URL problem. No synthetic shipment was added to the workspace.
- Real sample extraction has not been rerun: this local server still has no configured Kimi key. Existing sample questions therefore reflect historical saved readings until Kimi is configured and those originals are reprocessed. No Gmail, ECUS, outgoing email or live Moonshot operation was performed.

## Autonomous ECUS preparation and supplied-guide rules (October 15, 2026)

- **454 regression tests passed** after extraction cleanup, confidence/crop support, per-page repair/resume fixes, exact goods-identity joins, scoped rereads, client memory, explicit-unit reconciliation and guarded header-role correction. Type checking, production build and diff checks passed; the build retains large-chunk and route-classification advisories. Lint has no errors and three existing framework advisories. Coverage includes current Kimi page evidence, same-value corroboration without duplicate-copy promotion, conflicting primary sources, uncertain guide dependencies, visual provenance, the guide's ±1 line-value tolerance, automatic email drafts, edit preservation, recipient validation and approval invalidation.
- Production no longer contains the legacy heuristic document extractor or container/seal text parser. Historical parser fixtures remain test-only. Historical OCR candidates are preserved as records but excluded from autofill. Opening an import case resumes unread originals with Kimi when configured; provider failures preserve completed work and require retry.
- The supplied VNACCS guide is recorded by filename, SHA-256 and selected section excerpts. Implemented source-selection and explicit-code rules cite their guide sections; they do not establish current-law compliance or fill unknown customs/tax codes.
- Isolated browser checks used the prior live synthetic Kimi response: 37 grounded facts, all 24 editable goods cells plus generated STT, eight genuinely missing header details, one automatically prepared email, preserved recipient edits and a human approval control. Documents exposes the model, page reading, quotation and destination for each fact. No email was sent or declaration approved.
- The reported shipment's old invoice confirmations came from legacy local OCR, not Kimi. The user authorized processing its seven original pages through Moonshot. Live testing uses the supplied key through a temporary local session; credentials and private source files are excluded from the source export. Results are saved page by page. No email or declaration is automatically approved.
- Client memory records new, explicit human corrections to five stable importer details. Seventeen domain regressions cover matching, current-source validity, aliases, superseded corrections, apply/dismiss/revoke, provenance, cross-case draft refresh and approval invalidation. Seven HTTP workflow checks passed in a disposable workspace with provider credentials disabled.
- Browser checks in that disposable workspace saved a synthetic phone correction in one case, found it in the next case, verified that unsaved edits disable Apply, and applied it with human provenance. A source-conflict email stayed unapprovable until its relevant memory was reviewed; dismissal enabled approval without removing the unanswered question. Stop suggesting removed future suggestions. No test record was added to the real workspace and no mail was sent. The disposable server was stopped after QA.
- Independent live scope audits through revision 348 found all 91 non-target cases, 853 non-target documents and 723 non-target candidates exactly equal to the saved baseline. The earlier four-property collateral change in AICD-0006 was restored through one audited revision-checked action. Regression coverage now prevents unrelated reread rebuilds and directs an automatic email draft to the active destination when related cases merge.
- Live tests exposed incorrect row roles and nonliteral quotations as well as provider timeouts. Strict source checks reject these proposals; they are not accepted merely because a model assigns high confidence. A slower thinking-enabled repair was tested and removed after timeouts; K2.6 initial and repair calls retain non-thinking mode. These checks do not establish a measured production accuracy rate.
- Page-completeness checks preserve rejected readings in the audit trail. Only fully documented secondary row-scope failures superseded by clear, agreeing guide-authoritative evidence can cease blocking automatic questions and rereads. Rejections involving other fields, evidence failures, conflicting primary sources or incomplete diagnostics still block completion.
- Explicit weight-unit conversion uses exact arithmetic and keeps the original reading. Ambiguous or absent units remain unresolved. Unlabeled goods-row text cannot become an invoice/contract header through row-scope repair; focused tests cover relevant English, Vietnamese and Chinese labels and combined invoice-number/date headings.

- Final live state at revision 348 has Kimi readings for all seven pages of the four authorized shipment PDFs. The final certificate page reread accepted 18 facts, invoice page reread 22 and detailed packing-list reread 74, each with zero rejected proposals. One commercial goods row remains. The invoice number fills without a confirmation issue; its explicit heading supplies invoice form A. The reread recovered the packing-list unit `t`, allowing 520.29 t and 520290 KGS to reconcile to 520290 KG with original evidence retained.
- List comparison now aggregates continuation pages by document and page role, requires clear quantities and explicit matching unit sets, and compares lists only when an invoice participates. Unitless packing components do not create a fabricated commercial-goods conflict; comparable mismatches still do. No invoice-number, gross-weight/unit or packing-component list conflict remains in the final sample.
- Final browser verification shows the filled invoice with numeric model confidence and original-page crops, and 26 consolidated unresolved form details in an updated email proposal. Earlier email edits remain preserved; the proposal is available for review. No recipient can be chosen from the workspace because it has no imported correspondence. No email, declaration or ECUS submission was approved or sent. The remaining questions include unsupplied customs/tax details and conflicting exporter evidence.

## Corroborated exporter selection (October 16, 2026)

- **465/465 tests pass**, with type checking and production build passing. Lint has zero errors and the same three existing warnings. Eleven new policy and integration regressions cover explicit certificate exporter roles, invoice display spelling, original evidence preservation, conflicting primary values and identifiers, unread sources, duplicate originals, same-company secondary address conflicts, supporting evidence dependencies and withdrawal of corroboration.
- The user requested automatic selection of the supported highlighted exporter and address. The new source-reconciliation policy uses an invoice seller corroborated by an explicitly labeled certificate-of-origin exporter with the same address when no contract is supplied. Contract guidance remains authoritative. This policy is labeled separately from the VNACCS guide and adds no document reader or model call.
- At live revision 352 the selected invoice exporter and matching address are filled without exporter conflicts; party classification is also supported. The updated email proposal contains 23 unresolved details, down from 26. Existing human email edits are preserved, and no email or declaration was approved or sent.
- An explicit, audited field-selection action replaced the earlier stale exporter choice at the user's request. All 91 other cases, every original document and every saved candidate remain byte-for-byte equivalent in the serialized state to the pre-change snapshot. Browser verification shows the selected name with the original invoice crop, its 98/100 Kimi source-reading estimate and the source-reconciliation explanation.

## Obsolete source confirmations (October 16, 2026)

- **474/474 tests pass**, with type checking, production build and diff checks passing. Nine added regressions cover automatic retirement of stale legacy source selections, equivalent current-reader values, historical evidence lookup, preservation of manual and materially changed Kimi decisions, unresolved evidence, approved/completed immutability, idempotence, case isolation and consistent formatting in review summaries.
- Clear current facts now supersede stale selections from known legacy machine readers, or semantically equivalent source selections, without inventing a new human review. The complete former decision and current evidence IDs are retained in a dedicated audit entry. Review summaries use the same evidence-backed formatting comparison as the form while retaining original source cards.
- At live revision 354 the importer's obsolete OCR choice, unchanged contract number and resolved discharge-port choice were retired automatically. At the user's request, the explicitly labeled bill-of-lading notify-party company was selected over its separately extracted address. No non-missing confirmation or conflict remains in this shipment; all 23 open issues are required blanks. Other cases, all original documents and all saved candidates were unchanged. No email or declaration was approved or sent.
- Kimi's extraction instructions now distinguish party names from their address/contact lines. This is a prompt clarification for future reads; no new provider call was needed to apply the current supported selections. Browser verification confirms the selected importer with its original cropped evidence and numeric Kimi estimate.


## Source-backed form mapping corrections (October 26, 2026)

- **629 automated tests pass**, together with TypeScript, lint and production build. Local HTTP tests ran with loopback access; production-build route/chunk advisories remain. New regressions cover location code/name consistency, generic port allowances, package ambiguity, independently corroborated phone formatting, partial-page evidence, original-source acceptance, source conflicts and correct review-field navigation.
- A small documented UNECE location catalog maps grounded transport readings for Brussels and Ho Chi Minh City to their published code/name representations. Original quotes, candidate IDs and confidence remain intact; code verification stays unverified. Unknown, unclear or contradictory evidence remains reviewable. Explicit package wording maps to PK; a bare courier Piece label does not establish packaging type and requires review.
- The telephone rule corrects the extra zero after +84 only when independent source documents explicitly corroborate the otherwise identical international number for the same party. It preserves accepted individual evidence on partially rejected pages, never invents domestic/area-code digits and never overwrites an employee's explicit original-source choice.
- The offline regression replay uses the original **four Sarens import cases, 14 files, 22 saved GLM-5.3-Flash page outcomes**. Before/after snapshots use the same inputs and verify file hashes. Final artifacts are under `outputs/sarens-mapping-replay-20261027/after-v3/`; reproduction instructions are in the parent directory's README. The comparison has **3 changed values, 3 newly filled values and 5 unsupported values cleared for review**. Cleared values are not counted as accuracy improvements. HS/origin values are unchanged.
- These are current mapping results on saved unassisted readings, not a fresh model run or an accuracy percentage. They do not reproduce the separately reviewed/enriched historical 75.7% sample. Remaining raw-reading limitations include the 893 kg arrival-flight source role, an uncertain SGN reading, missing actual ports for the 5.86 kg case, and 23 proposed goods rows including three non-item/service/reference rows. No employee answer key was supplied to production mapping.
- No model request, live shipment edit, email, ECUS action or deployment was performed. The model remains GLM-5.3-Flash with low reasoning. EDA export extraction and native Windows ECUS filling still require real-workplace validation.
