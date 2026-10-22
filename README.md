# AICD — shipment review workspace

AICD prepares Vietnamese import declaration drafts from shipment documents. Upload a batch of files or saved emails; the application reads the attachments, groups related documents, combines their evidence, and then fills one web draft per confirmed shipment. Reviewers address missing, unclear or conflicting information and approve the saved draft.

The application structure was simplified on October 11, 2026. Shipments and Settings are the main destinations. Archive is a shipment filter. A shipment contains Review & draft, Documents, and Messages; reports and history are secondary actions. All screens support Vietnamese and English.

## Run locally

Requires Node.js 22.13 or newer and npm.

```sh
npm ci          # first installation only
npm run local   # npm run dev does the same thing
```

Open **http://127.0.0.1:5173**. Stop with Control+C. Restarting reopens saved work. Use `npm run local -- --port 5174` to select another local port.

Local mode is a single-user development workspace, not a shared team login. It runs only on loopback. Any process that can reach that local listener shares the local actor. Do not expose it through a tunnel or public listener. The local access mechanism is excluded from production builds.

Saved records and original files live in **`.aicd-local/state/`**. Keep this directory when updating source. The navigation and runtime cleanup does not change its database identity, object-storage name, or state location. [Local setup and backups](docs/local-setup.md).

## Current capabilities and next work

| Area | Implemented now | Next product step |
| --- | --- | --- |
| Documents | One batch intake for PDF/image/text/CSV and saved `.eml`; shared browser file preparation, original files, duplicate detection and evidence-based grouping | Live Gmail synchronization |
| Extraction | GLM-5.3-Flash extraction from page images or structured file text; source-linked header and commercial goods candidates | Broader layout evaluation against broker-reviewed answers |
| Draft | ECUS IDA three-form editor from supplied screenshots; source-backed autofill, required-field questions, all 25 goods columns and manual edits | Broader source-layout evaluation against broker-reviewed examples |
| Review | Guide-based source reconciliation, extraction traces, and targeted questions only for unresolved information | Wider field coverage and broker-calibrated uncertainty thresholds |
| Client memory | Explicit human corrections to stable importer details; matching-client suggestions with apply, dismiss and stop-suggesting controls | Evaluate additional reusable fields separately from transaction-specific facts |
| Messages | Imported `.eml` messages, GLM shipment matching, automatic consolidated question drafts, preserved edits and explicit draft approval | Outgoing delivery, live Gmail retrieval and timed follow-ups |
| Access | Local single-user mode; retained standalone Supabase password adapter with server authorization | Google sign-in, owner-approved access requests and persistent team sessions |
| ECUS | Immutable reviewed snapshots and a deterministic **test-only** adapter | Actual connection and credentials collected at connection time |
| Regulations | Explicitly not assessed | Versioned, verified regulations and code tables when provided |

Google sign-in, live Gmail OAuth/synchronization, outgoing email delivery, scheduled follow-ups and real ECUS integration are not implemented. Passing software tests does not establish extraction accuracy on every supplier layout.

## The shipment workflow

1. **Read the complete batch.** The browser prepares all selected files, including supported attachments inside saved emails, before submitting one intake request.
2. **Group before filling.** The backend compares document references and corroborating facts across the batch and existing open shipments. Shared senders, vessels, contracts or master bills alone do not justify a merge. Ambiguous groups stay separate for confirmation.
3. **Combine evidence.** Repeated totals are compared, never added. Commercial buyers/sellers stay separate from transport agents. A packing page listing one container can support a larger container set.
4. **Fill the web draft.** Clear AI values populate supported declaration components with document/version/page/quote references. The supplied VNACCS guide selects the appropriate source for supported conflicts and maps explicit facts to specified codes. Unresolved conflicts and unreadable values remain questions. Unknown customs, location and tax codes are not invented.
5. **Prepare remaining questions automatically.** Once all active sources have been read, missing or unresolved form information is collected into one editable local email draft. A known sender is prefilled when unambiguous. The person reviews the recipient and message and approves the draft. This records approval inside AICD; outgoing email delivery is not implemented.
6. **Preserve decisions when evidence arrives later.** Matching attachments join the existing shipment. Manual decisions remain, changed supporting evidence is flagged, and an approved shipment returns to review when its document set changes. Previous approval snapshots remain intact.

The shipment list and its Documents section show the resulting groups. Review & draft contains Thông tin chung, Thông tin chung 2, and Danh sách hàng, with questions for missing or unclear information; Messages contains imported emails and local drafts. Settings contains only Gmail and ECUS connections.

**Email matching** connects saved email subjects and body text to current shipment references, including replies with no attachments. When GLM-5.3-Flash is configured, the local queue matches imported messages after document jobs finish, and rechecks them when their email content or shipment evidence changes. Each unchanged input is checked once, including a no-match result. Hosted intake attempts matching after originals are saved; the shipment list's **Match emails with AI** action processes existing messages in bounded batches of up to eight. Exact source quotations and reference checks determine which links can be saved automatically. Uncertain links get individual confirm/reject questions, and later AI runs preserve human decisions. Matching correspondence does not move all attachments together or approve a declaration. [Email matching architecture and limits](docs/email-shipment-grouping.md).

[ECUS IDA form mapping and validation](docs/ecus-ida-forms.md).

## How PDF extraction works today

GLM-5.3-Flash is the live document extractor. For PDFs, the server counts physical pages and the local background reader (or browser for explicit manual extraction) uses PDFium only to render images; it does not extract PDF text or run OCR. The server sends those page images to GLM, which returns page readings and source-linked shipment facts. TXT, CSV and XML content also goes through GLM to become form values. Other office formats need a PDF export for extraction. PDF.js, Tesseract, OCR workers and language assets are removed from the active pipeline.

Saved-email intake uses PostalMime in the browser to identify attachments and sends each supported attachment through the same preparation routine. The server parses the original email again, checks attachment metadata, and preserves the original message and files. Uploading a saved email is different from connecting a live Gmail account.

The live provider is fixed to Z.ai at `https://api.z.ai/api/paas/v4`, with server-only `ZAI_API_KEY` and `ZAI_MODEL=glm-5.3-flash`. Requests use low reasoning effort. Live extraction and email matching have no Moonshot fallback; a missing or invalid GLM configuration leaves work pending. End users cannot configure the provider or enter an API key. Each visual result retains its document version, page, quotation and image region. The application compares the combined shipment evidence before filling the draft. Clear, supported values without conflicts do not create a routine confirmation question; missing, unclear, contradictory or stale evidence still needs attention. No AI result approves or submits the declaration. [Current provider setup](docs/local-setup.md). The historical module names `kimi.ts` and `kimi-review.tsx` remain for compatibility with saved evidence; they do not select the live provider.

Without the server key, originals are saved and wait for GLM; there is no local OCR or heuristic-extraction fallback. In local mode, `npm run local` automatically reads pending originals from open import shipments, including attachments in imported `.eml` files, using two concurrent readers. Keep the local server running; the browser can close. Samples/source collections and reference-only documents are excluded from the automatic queue. Each page saves independently, jobs and timings persist in SQLite, and rate limits pause jobs for a minute. Failed provider/preparation requests require deliberate retry from the document action; completed reads with unresolved evidence are not repeatedly charged. Expired leases recover interrupted work after ten minutes; a process crash after a provider response but before saving can cause that page to be read again. Manual decisions are preserved when parallel results commit against the latest workspace revision. There is no live Gmail synchronization yet. Hosted standalone mode retains browser processing. Synthetic regression tests cover the supported ECUS goods columns, but do not establish live-provider accuracy. Saved ToKhai sample comparisons are limited to their measured populations; they do not establish accuracy on every supplier layout.

Current intake limits are 20 top-level files, 20 MiB per file, 50 pages per file and 50 attachments per saved email. The whole multipart request is capped at 22 MiB including metadata. The extraction request limit is 5 pages / 24,000 text characters, while visual jobs send one page per call; each page image is limited to 2,600 pixels per side and 1.5 MiB. The workspace permits 6 provider calls per minute. Long documents can require several processing attempts. These limits are in code, not customer settings.

## Code structure

```text
app/                         Routes, layout and workspace orchestration
  api/                       Thin HTTP endpoints
components/
  workspace/                 Navigation, shipment list and shipment sections
  declaration-draft.tsx      ECUS IDA three-form editor
  account-access.tsx         Current login/session screens
  kimi-review.tsx            Current document-level AI action (legacy filename)
hooks/                       Workspace request/session state
lib/
  engine.ts                  Shipment changes, reconciliation and review checks
  shipment-grouping.ts        Batch-wide document matching and ambiguity handling
  email-shipment-ai.ts        Bounded GLM email-to-shipment proposals and evidence checks
  email-grouping.ts           Current correspondence links and individual review decisions
  server-email-grouping.ts    Authorized matching requests and guarded persistence
  shipment-autofill.ts        Combined evidence → typed declaration components
  client-memory.ts            Local human corrections and guarded matching-client suggestions
  review-questions.ts         Targeted review questions from current issues
  shipment-correspondence.ts  Local editable email drafts; no send operation
  extraction.ts              Shared normalization and source-type metadata helpers
  vnaccs-guide-rules.ts       Supplied-guide source selection and explicit code mappings
  client-case-automation.ts   Browser fallback for selected-shipment reading
  ai-processing-queue.ts      Durable page jobs, leases, concurrency and timings
  ai-result-persistence.ts    Rebase validated AI results without losing human edits
  declaration*.ts            Typed declaration schema, validation and drafts
  ecus-form.ts               Screenshot field mapping and required controls
  client-*.ts                Browser intake, image preparation and edit helpers
  server*.ts                 Request authorization, persistence and file handling
  auth-*.ts                  Identity/session and membership controls
  kimi.ts                    Multimodal requests and evidence checks (legacy filename)
  vision.ts                  Image validation and source binding
  client-vision.ts            Browser page rendering and resumable AI batches
  client-pdf-raster.ts        Worker lifecycle for PDFium page rendering
  pdf-raster*.ts              PDFium pixel rendering without text extraction
  server-vision.ts            Authenticated private page image storage
  intake-ai.ts                Bounded text enrichment for nonvisual intake
  intake-metadata.ts          Batch and email-attachment metadata validation
  i18n*.ts*                  Vietnamese/English presentation
  report*.ts                 Review report data and PDF generation
  vnaccs*.ts                 Internal field references and developer exports
build/                       Application Worker and local request gate
scripts/                     Startup, packaging and verification tools
db/ + drizzle/               Database schema and migrations
fixtures/ + tests/           Synthetic verification inputs and regression tests
docs/                        Setup, architecture and learning material
```

The application no longer depends on `.openai`, Sites hosting, ChatGPT login, connector-preview scaffolding, or the unused template component library. The field-reference registry is retained internally because the declaration editor depends on it; the coverage screen has been removed.

Database updates use revision checks so concurrent edits cannot silently overwrite each other. Original files remain private and their downloads require workspace access. Pending browser edits, saved drafts, internal review approval and customs submission are distinct states.

The current database stores a bounded workspace JSON aggregate. A whole batch changes this record in one revision-checked commit, so the form is not filled from a partly saved batch. Original file storage is separate; failed intake attempts clean up staged objects where possible. This is not a distributed transaction across database and file storage. The local automatic reader uses a separate durable page-job table. Hosted background workers and normalized shipment/event storage remain future work.

## Verify and download

Stop the local server before `npm run build` or a standalone build/check/deploy. Production generation shares framework files with the local server; the build refuses to run while its launcher is active or cannot be verified.

```sh
npm test
npm run typecheck
npm run build
npm run export:source
```

`outputs/AICD-source.zip` contains application source, tests, migrations, PDFium rendering/font assets, synthetic fixtures, and documentation. It excludes dependencies, generated builds, credentials, local records and uploaded customer files. It is a source download, not a shipment-data backup.

The integration scripts write synthetic records. Run them only in a separate, disposable checkout with its own local storage and a server on port 5174. Never target the workspace containing your shipment. The explicit environment flag is required before these scripts make requests:

```sh
AICD_SMOKE_ISOLATED=1 node scripts/smoke-api.mjs http://127.0.0.1:5174
AICD_SMOKE_ISOLATED=1 node scripts/smoke-declaration.mjs http://127.0.0.1:5174
AICD_SMOKE_ISOLATED=1 node scripts/smoke-shipment-intake.mjs http://127.0.0.1:5174
AICD_SMOKE_ISOLATED=1 node scripts/smoke-review.mjs http://127.0.0.1:5174
```

The read-only boundary check can run against the regular local server: `node scripts/smoke-local-boundary.mjs http://127.0.0.1:5173`. Synthetic files in `fixtures/` are regression-test inputs; they are not loaded into your workspace automatically.

A generic production build denies data access until an authentication deployment is explicitly configured. The retained [standalone setup](docs/standalone-setup.md) documents the current adapter, while the intended team product will use Google sign-in and owner approval. No deployment occurs during local development or source export.

For the beginner explanation, start with [the code walkthrough](docs/code-walkthrough.md). See [product scope](docs/product-scope.md), [validation history](docs/validation.md), and [cleanup details](docs/cleanup-2026-10-11.md).
