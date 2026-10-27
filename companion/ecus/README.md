# AICD Windows ECUS export companion

This is an attended native Windows bridge for **Tờ khai hải quan → Đăng ký mới tờ khai xuất khẩu (EDA)**. It creates and saves an editable export draft, closes it, reopens the saved draft by its real reference, and reads its fields back. It has no signing, official transmission, database-writing, global typing or coordinate-clicking implementation.

**The included profile is deliberately uncalibrated.** Screenshots establish the requested menu, not native automation IDs, actual editor titles or an import interface. No real ECUS installation has been exercised by the portable tests. The bridge will not claim a job until a complete installed-version profile is supplied and the expected ECUS process is present. A supported vendor import would be preferable if the installed version provides one; this implementation uses native UI Automation for a verified installation.

## Install on the ECUS Windows PC

Use Python 3.11 or newer under the same Windows account and desktop session as ECUS. From this directory:

```powershell
py -3 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

The pinned native dependency is [pywinauto 0.6.9](https://pypi.org/project/pywinauto/0.6.9/). Core validation, transport, journaling and fake-UI tests use Python's standard library. The native driver uses Windows UI Automation Value, Invoke and Selection patterns; see the [upstream control documentation](https://pywinauto.readthedocs.io/en/latest/code/pywinauto.controls.uia_controls.html).

Keep the Windows session unlocked. ECUS must run at an accessible integrity level; do not disable Windows security or expose the app's loopback server through a tunnel to work around access failures.

## Inspect and calibrate the installed version

Obtain the ECUS process ID from Windows Task Manager. The read-only inspector does not focus or operate any controls:

```powershell
.venv\Scripts\python.exe -m ecus_companion inspect --pid 1234 --output inspection-main.json
```

An operator should open the export editor, goods-detail dialog, and saved-declaration list manually, then run inspection into separate files. These local inventories can contain business data in control names. Do not publish them.

Copy `profiles/example-eda.json` to `profiles/installed-eda.json`. Replace every `CALIBRATE` placeholder using that exact installation. The menu caption is fixed to export EDA; the actual editor title is calibrated separately. A visible in-form marker must explicitly identify **Tờ khai xuất khẩu** or **EDA**. An import/IDA title or marker is rejected.

The profile pins the executable path, its SHA-256, file version and exact main/editor window titles. Each selector is a path of uniquely matched native controls. Each segment uses `autoId`, `title`, `controlType` and/or `className`; IDs or exact title plus control type are mandatory. No index guesses, regular expressions, scripts, coordinates or arbitrary keystroke strings are accepted. Recalibrate after any ECUS upgrade.

Calibrate every one of the contract's **35 header fields and 9 goods columns**, including optional blanks. These are a bounded application subset, not the complete EDA specification or the website's historical 191 import controls. Supported binding kinds:

- `value`: literal UIA Value write and exact readback.
- `choice`: a fully enumerated, reversible `choices` object mapping approved code strings to exact native option labels. Unknown labels/codes stop the job.
- `readOnlyValue` / `readOnlyText`: an ECUS-computed/system field is never written; its saved readback must still equal the approved value.

Bindings can specify native `navigation` steps (`select` or `invoke`) for tabs. Native date/code controls must actually support the configured access method; no locale conversion or guessed code expansion occurs. If a custom grid or control is inaccessible, stop calibration and obtain a supported vendor interface or add a tested native implementation. Do not mark it calibrated to bypass that limitation.

Goods use a calibrated add/edit detail dialog and native selectable grid rows. The profile also needs the draft-only Save button, a durable draft reference control, the editor Close action, saved-draft list/reference cells and Open action. The saved list must expose the newly created draft and every goods row; filtered/paginated/virtualized controls that hide required rows are not supported until explicitly implemented and tested. There is no Excel-import fallback.

After supervised verification on a disposable, nonproduction export draft, record `calibratedBy`, set `calibrated: true`, then validate:

```powershell
.venv\Scripts\python.exe -m ecus_companion validate-profile --profile profiles/installed-eda.json
```

Validation checks schema and coverage. A live, supervised save/reopen/readback test is still needed to establish compatibility. Creating a local ECUS draft is the only permitted action; declaration registration or transmission buttons must never be mapped as Save.

## Pair and operate

Create a computer key in the website's ECUS Settings, then paste it into the masked prompt:

```powershell
.venv\Scripts\python.exe -m ecus_companion configure --base-url https://your-aicd-host.example
.venv\Scripts\python.exe -m ecus_companion poll --profile profiles/installed-eda.json --once
```

Omit `--once` to keep polling every five seconds. Once the operator starts the configured helper, the employee's **Submit on the website** authorizes execution of the confirmed values on the selected computer. There is no second native confirmation in normal operation. The companion displays the shipment, approver, timestamp and goods count, activates only the verified ECUS window, and fills the draft automatically. `--confirm-each-job` adds a `CREATE` prompt for initial supervised calibration tests. Declining that test prompt reports a terminal failure for that job; it does not silently queue a retry.

Close existing declaration editors before claiming a new job. Later focus changes, unexpected dialogs, ambiguous controls, changed binaries or nearing lease expiry stop execution. Do not use the keyboard/mouse during the operation.

Use HTTPS for a hosted application. `http://127.0.0.1:5173` or `http://localhost:5173` is accepted only when AICD runs on the **same Windows PC**. A loopback URL on the Mac cannot be reached from Windows. The helper does not bypass the application's local request gate. Redirects are rejected before the key is forwarded.

The origin and device key are encrypted together with per-user Windows DPAPI in `%LOCALAPPDATA%\AICD\EcusCompanion\connection.dpapi`. No signing certificate/PIN is requested. Journals are separated by server origin and device ID; a single local session lock prevents simultaneous helpers. Journal readbacks contain business data and inherit the Windows user's local application-data permissions.

## Result and failure behavior

The helper validates the exact UTF-8 payload hash, export direction, schema, approval/lease deadlines and field coverage before acting. SQLite records `in_progress` and the original delivery lease with FULL synchronization **before opening the new EDA form**. The original approved strings are not rounded or inferred.

Success requires a durable draft reference plus all supported header values and every goods row read from the **reopened saved draft**. Missing/extra/reordered rows, unexpected defaults in approved blanks, native recalculations or any value difference require reconciliation. The website independently compares readback and may reject a reported success; that rejection is recorded locally as reconciliation.

An interruption after a possible write never automatically recreates the declaration. On restart, an `in_progress` job is recorded as `needs_reconciliation` and reported using its retained lease, without opening ECUS. The local journal blocks further claims until an operator inspects the actual ECUS draft and records a disposition in the website's recovery screen. If Save produced a real draft reference before a later readback failure, that reference is retained in the result. Complete readback values, including mismatches, are sent unchanged so the website can show the differences.

The reviewed website disposition is either `no_draft` or `draft_kept`, with the operator, reason, timestamp and approved-payload hash. The companion verifies that the decision matches an uncertain job in this computer's retained journal, saves it in a separate recovery table, and acknowledges it on the next synchronization. It waits for explicit server acknowledgement before advertising readiness. A lost response retries the acknowledgement; it never repeats the ECUS operation. The original job phase and result remain preserved, and a late result callback cannot reopen a resolved job.

Retaining a draft prevents another transfer for that shipment. If inspection establishes that there is no draft, an employee can explicitly authorize a new transfer through the website's retry workflow, which creates a new job ID. The old ID is permanently ineligible to execute again. Recovery neither deletes nor modifies an ECUS draft.

Do not delete the journal or local application-data directory to clear an uncertain write. The additive journal migration retains legacy records. A legacy `in_progress` record without a saved lease stays blocked until the server's running lease expires and an operator records its disposition; a matching recovery can then be synchronized by payload hash. If the local job is missing after reinstall or a decision has a different hash, the helper stops and does not acknowledge it. Preserve the original Windows account and journal for investigation; do not create replacement records or replay a job to bypass this check.

Completed results are saved before network reporting. If acknowledgement is lost, the same result is delivered again without operating ECUS. Recovery synchronization still runs after a result-delivery failure. Once a matching decision is saved locally, obsolete pending results stay in the journal but are no longer sent. `status` shows pending result deliveries, unresolved jobs and pending recovery acknowledgements:

```powershell
.venv\Scripts\python.exe -m ecus_companion status
```

## Portable verification

From the repository root, on macOS/Linux/Windows:

```sh
python3 -m unittest discover -s companion/ecus/tests -v
```

Tests exercise raw-hash/schema/direction validation, mapping completeness, deadline rejection, exact values/blanks, write-ahead ordering, crash/no-replay behavior, acknowledgement loss, server-rejected success, origin/device journal isolation, redirect/HTTP rules and single-instance locking. Recovery tests cover legacy migration, restart reporting, immutable dispositions, payload/hash checks, lost recovery acknowledgements, stale callbacks, readiness ordering and a separately approved new job ID. These tests do not establish that a real ECUS installation exposes the required native controls.
