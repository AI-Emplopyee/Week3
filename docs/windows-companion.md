# ECUS export handoff

The website now includes a separate EDA export review form, a persistent transfer queue, device pairing, and a Python Windows UI Automation helper in [companion/ecus](../companion/ecus/README.md). This is implemented code with synthetic verification; native draft creation has **not** been verified on the broker's ECUS installation. The existing import test adapter remains separate.

## Employee workflow

1. Create a shipment with direction **Export (EDA)**, or explicitly change its direction in shipment details. Import records are never silently converted.
2. Review the export form's supported general fields and goods rows. Suggestions use reviewed, nonstale export shipment facts. **Save draft** stores unfinished work on the server, with the employee, time and version. Another employee can reopen it. Conflicting edits require an explicit reload or review before saving; they cannot silently overwrite a newer version. Changed shipment evidence also requires review.
3. Save the latest values, confirm them and select the paired Windows computer. Press **Submit to ECUS (EDA)**. The server checks membership, current workspace and saved-form versions, export direction, field structure and fresh device readiness. It saves an immutable payload with the approving employee, timestamp, source fingerprint and SHA-256 hash.
4. The Windows helper polls for one job, journals it before native changes, activates the calibrated ECUS process, and selects **Tờ khai hải quan → Đăng ký mới tờ khai xuất khẩu (EDA)**.
5. The helper writes mapped fields and goods, saves the local draft, closes and reopens it by its actual reference, and reads the supported values back. The website reports success only when the saved reference and values match the approved payload. Unexpected native dialogs, changed controls, lost focus or interrupted operations stop the attempt.

Only editable drafts are created. Digital signing, EDA transmission, EDC registration and customs decisions are outside this workflow.

## Installation

Restart the website after updating to apply migrations `0004_ecus_export_jobs.sql` and `0005_ecus_drafts_and_recovery.sql`. Update the Windows helper at the same time so it supports recovery acknowledgements. In **Settings → ECUS connection — export**, the workspace owner creates a computer key, shown once. The database stores only its hash. Follow the [Windows helper README](../companion/ecus/README.md) to install dependencies, inspect accessible controls, calibrate the profile, pair the key and start the helper. It uses per-user Windows DPAPI for local credential storage.

The current local website accepts loopback traffic only: local mode must run on the **same Windows computer** as the helper. A helper on Windows cannot use a Mac's `127.0.0.1` website. For separate computers, use an authenticated HTTPS deployment with the migrations applied. The helper does not expose a local HTTP command server.

The supplied profile is deliberately uncalibrated. The menu text comes from the supplied menu screenshot and the vendor's [export registration help](https://help.ecus.net.vn/7.0.1.DANGKYMOI_TXK_Title.html). The other supplied form photos show IDA import screens and do not establish EDA control identities. Native process identity, actual form title/marker, every supported field, goods-row operations, save and reopen controls must be measured on the target installation. Inaccessible custom controls require adapting the driver or a verified vendor import interface; no coordinate or keyboard fallback is included. Do not set `calibrated` merely to bypass this check.

## Queue and failure behavior

- Device keys are scoped to one workspace. Pairing requires an owner; current owner authority, device revocation and reviewer membership are checked again at guarded database writes.
- Repeated Submit with identical approval content reuses the same job, including after a lost HTTP acknowledgement. One job may run per computer. Approval expires after 24 hours; a claim lasts at most 30 minutes and the helper checks deadlines during native operations.
- Changes to the approved shipment or its active documents cancel queued work. Edits after a transfer has started do not change its frozen payload; the approved values are visible in the transfer history.
- A pre-write failure is `failed`. A partial/uncertain write, expired running lease or saved-value mismatch is `needs_reconciliation`. Disconnecting a computer cancels queued jobs and flags running jobs for inspection; it cannot instantly undo a native action already in flight.
- The local SQLite journal prevents replaying native actions after a crash. Pending result delivery can be retried independently. Do not delete the journal to retry an uncertain operation.
- Failed, cancelled and uncertain jobs require an employee recovery decision. History shows the approved values, available saved readback and exact differences. Missing readback is unknown, not a verified match. A delayed first callback can add evidence before recovery, but cannot change an already resolved attempt.

## Recovery and controlled retry

Inspect the actual ECUS application before recording a decision in the transfer history. Enter a reason and confirm either **keep the existing draft** (including its reference), or **no ECUS draft remains**. Keeping a draft blocks recreation; it records an employee decision, not automatic verification. If no draft remains, the web form becomes editable. The employee must review and confirm it again before another Submit.

For uncertain work, retry waits until the original helper has saved the recovery decision in its journal and acknowledged it. A terminal helper result allows inspection even before the lease timestamp expires. An interrupted operation without a terminal result remains blocked until its lease expires. If the original computer is unavailable, its key must be disconnected and its lease expired before the server can waive its acknowledgement. This never replaces the employee's inspection.

Every recovery decision is immutable. A retry creates a new job linked to the old one, retaining the original approval, result and decision. Concurrent Submit requests create at most one child per resolved attempt. Neither a recovery decision nor reconnecting the helper automatically creates a new draft. Never delete queue records or the local journal to work around a blocked transfer.

## Coverage and validation

The web form covers 35 general fields and 9 fields per goods row, not the complete EDA specification. Containers, additional tax/valuation fields and attachments must be completed separately in ECUS. Input checks establish structure and a minimum transferable subset, not legal correctness or current code-table validity. Native defaults for supported fields are included in readback; nonblank unexpected values cause reconciliation. Formatting differences are not silently accepted.

`tests/ecus-export.test.ts` checks export-only payloads, parsing, immutable approval and readback. The draft-store, job-store and recovery tests run against SQLite with the actual migrations to check version conflicts, audit history, authorization races, leases, acknowledgement scope and concurrent retries. `companion/ecus/tests` tests the journal and execution flow with fake native controls. `scripts/smoke-ecus.mjs` exercises real local HTTP routes with synthetic callbacks, saved drafts and failure/recovery/retry in a separate disposable workspace:

```sh
AICD_SMOKE_ISOLATED=1 node --experimental-strip-types scripts/smoke-ecus.mjs http://127.0.0.1:5184
```

These checks do not prove ECUS compatibility. Acceptance still requires one supervised test export on the actual Windows installation, including saved readback and an interruption scenario.
