"""Portable validation, write-ahead journal, and single-job execution.

The Windows driver is deliberately outside this module so failure behavior is
executable on macOS/Linux without an ECUS installation or network connection.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol
from .fields import HEADERS, GOODS, complete_form

EXPORT_MENU = ("Tờ khai hải quan", "Đăng ký mới tờ khai xuất khẩu (EDA)")
MAX_PAYLOAD_BYTES = 2 * 1024 * 1024


class CompanionError(Exception):
    """A bounded, operator-facing error, without credentials or source payloads."""


def _unique_object(pairs: list[tuple[str, Any]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise CompanionError("Duplicate JSON keys are not accepted.")
        result[key] = value
    return result


def parse_json(text: str) -> Any:
    try:
        return json.loads(text, object_pairs_hook=_unique_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(CompanionError("Invalid JSON number.")))
    except (ValueError, TypeError) as error:
        raise CompanionError("Invalid JSON document.") from error


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def fingerprint(profile: dict) -> str:
    return hashlib.sha256(canonical(profile).encode("utf-8")).hexdigest()


def _text(value: Any, name: str, *, maximum: int = 12000, empty: bool = False) -> str:
    if not isinstance(value, str) or (not empty and not value.strip()) or len(value) > maximum or "\x00" in value:
        raise CompanionError(f"Invalid {name}.")
    return value


def _record(value: Any, name: str) -> dict[str, str]:
    if not isinstance(value, dict) or not value or len(value) > 500:
        raise CompanionError(f"Invalid {name}.")
    for key, text in value.items():
        _text(key, name + " key", maximum=160)
        _text(text, name + " value", empty=True)
    return value


def validate_job(job: Any) -> dict:
    if not isinstance(job, dict):
        raise CompanionError("Invalid job.")
    for key in ("id", "leaseToken"):
        _text(job.get(key), key, maximum=512)
    raw = _text(job.get("payloadJson"), "payload JSON", maximum=MAX_PAYLOAD_BYTES)
    if len(raw.encode("utf-8")) > MAX_PAYLOAD_BYTES:
        raise CompanionError("Payload is too large.")
    digest = job.get("payloadHash")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise CompanionError("Invalid payload hash.")
    if hashlib.sha256(raw.encode("utf-8")).hexdigest() != digest:
        raise CompanionError("Approved payload hash does not match; no ECUS action was taken.")
    payload = parse_json(raw)
    if not isinstance(payload, dict) or type(payload.get("schemaVersion")) is not int or payload["schemaVersion"] != 1:
        raise CompanionError("Unsupported payload schema.")
    if payload.get("direction") != "export" or payload.get("operation") != "create_draft":
        raise CompanionError("This companion only creates export EDA drafts.")
    for key in ("caseId", "reference", "approvedBy", "approvedAt"):
        _text(payload.get(key), key, maximum=1000)
    try:
        approved = datetime.fromisoformat(payload["approvedAt"].replace("Z", "+00:00"))
        if approved.tzinfo is None:
            raise ValueError("timezone missing")
    except ValueError as error:
        raise CompanionError("Invalid approval timestamp.") from error
    revision = payload.get("workspaceRevision")
    if type(revision) is not int or revision < 0:
        raise CompanionError("Invalid approved workspace revision.")
    form = payload.get("form")
    if not isinstance(form, dict) or set(form) != {"headers", "goods"}:
        raise CompanionError("Invalid approved form.")
    _record(form["headers"], "headers")
    goods = form["goods"]
    if not isinstance(goods, list) or not 1 <= len(goods) <= 1000:
        raise CompanionError("The approved form must contain 1–1000 goods rows.")
    for row in goods:
        _record(row, "goods row")
    if set(form["headers"]) - set(HEADERS) or any(set(row) - set(GOODS) for row in goods):
        raise CompanionError("The approved payload contains unsupported EDA fields.")
    for key in ("expiresAt", "leaseExpiresAt"):
        try:
            deadline = datetime.fromisoformat(job[key].replace("Z", "+00:00"))
            if deadline.tzinfo is None or deadline <= datetime.now(timezone.utc):
                raise ValueError("expired")
        except (KeyError, ValueError, TypeError, AttributeError) as error:
            raise CompanionError("The transfer approval or lease is missing or expired.") from error
    return payload


def validate_selector(selector: Any, name: str) -> None:
    # Each path segment must resolve uniquely. No coordinates, ordinal guesses,
    # regular expressions, executable scripts, or generic keyboard commands.
    if not isinstance(selector, list) or not 1 <= len(selector) <= 12:
        raise CompanionError(f"Missing exact selector for {name}.")
    for step in selector:
        if not isinstance(step, dict) or set(step) - {"autoId", "title", "controlType", "className"}:
            raise CompanionError(f"Invalid selector for {name}.")
        if not step.get("autoId") and not (step.get("title") and step.get("controlType")):
            raise CompanionError(f"Selector for {name} needs an automation ID or exact title and control type.")
        for value in step.values():
            _text(value, name + " selector", maximum=512)
            if "CALIBRATE" in value:
                raise CompanionError(f"Selector for {name} still needs calibration.")


def validate_navigation(value: Any, name: str) -> None:
    if not isinstance(value, list) or len(value) > 12:
        raise CompanionError(f"Invalid navigation for {name}.")
    for step in value:
        if not isinstance(step, dict) or set(step) != {"selector", "action"} or step["action"] not in ("select", "invoke"):
            raise CompanionError(f"Invalid native navigation for {name}.")
        validate_selector(step["selector"], name)


def validate_fields(fields: Any, name: str) -> None:
    if not isinstance(fields, dict) or not fields:
        raise CompanionError(f"Missing {name} mappings.")
    for key, binding in fields.items():
        _text(key, name + " key", maximum=160)
        if not isinstance(binding, dict) or set(binding) - {"selector", "navigation", "kind", "choices"}:
            raise CompanionError(f"Invalid mapping for {key}.")
        validate_selector(binding.get("selector"), key)
        validate_navigation(binding.get("navigation", []), key)
        if binding.get("kind") not in ("value", "choice", "readOnlyValue", "readOnlyText"):
            raise CompanionError(f"Only explicit native value/choice/read-only bindings are supported for {key}.")
        if binding["kind"] == "choice":
            choices = binding.get("choices")
            if not isinstance(choices, dict) or not choices or len(set(choices.values())) != len(choices):
                raise CompanionError(f"Choice map for {key} must be explicit and reversible.")
            for source, label in choices.items():
                _text(source, "choice key", empty=True)
                _text(label, "choice label", empty=True)


def validate_profile(profile: Any, payload: dict | None = None) -> str:
    if not isinstance(profile, dict) or profile.get("schemaVersion") != 1 or profile.get("direction") != "export":
        raise CompanionError("Only version-1 export profiles are accepted.")
    if profile.get("calibrated") is not True:
        raise CompanionError("The installed ECUS profile is not calibrated; no jobs will be claimed.")
    _text(profile.get("id"), "profile ID", maximum=90)
    _text(profile.get("calibratedBy"), "calibration operator", maximum=300)
    process = profile.get("process", {})
    if not isinstance(process, dict):
        raise CompanionError("Missing process identity.")
    for key in ("executable", "fileVersion", "sha256"):
        value = _text(process.get(key), "process " + key, maximum=1000)
        if "CALIBRATE" in value:
            raise CompanionError("The process identity still needs calibration.")
    if not re.fullmatch(r"[0-9a-f]{64}", process["sha256"]):
        raise CompanionError("An exact installed ECUS executable hash is required.")
    _text(profile.get("mainWindowTitle"), "main window title", maximum=512)
    validate_selector(profile.get("exportForm"), "EDA form")
    title = _text(profile["exportForm"][-1].get("title"), "installed export form title", maximum=512)
    validate_selector(profile.get("exportMarker"), "export direction marker")
    marker = _text(profile.get("exportMarkerText"), "export direction marker", maximum=512)
    if ("nhập khẩu" in (title + marker).casefold() or re.search(r"\bIDA\b", title + marker, re.I)
            or not ("tờ khai xuất khẩu" in marker.casefold() or re.search(r"\bEDA\b", marker))):
        raise CompanionError("The calibrated form needs an explicit export EDA marker, never an import IDA marker.")
    validate_fields(profile.get("headers"), "header")
    if set(profile["headers"]) != set(HEADERS):
        raise CompanionError("The profile must map all supported EDA headers, including optional blanks.")
    goods = profile.get("goods", {})
    if not isinstance(goods, dict):
        raise CompanionError("Missing goods workflow.")
    validate_navigation(goods.get("navigation", []), "goods")
    for key in ("table", "addButton", "editButton"):
        validate_selector(goods.get(key), "goods " + key)
    _text(goods.get("rowControlType"), "goods row control type", maximum=100)
    _text(goods.get("dialogTitle"), "goods dialog title", maximum=512)
    if goods["dialogTitle"] == profile["mainWindowTitle"]:
        raise CompanionError("The goods dialog must be distinct from the main window.")
    validate_fields(goods.get("fields"), "goods")
    if set(goods["fields"]) != set(GOODS):
        raise CompanionError("The profile must map all supported EDA goods columns.")
    for key in ("saveButton", "closeButton"):
        validate_selector(goods.get(key), "goods dialog " + key)
    validate_navigation(profile.get("saveNavigation", []), "draft save")
    validate_selector(profile.get("saveDraftButton"), "save draft")
    validate_selector(profile.get("draftReference"), "draft reference")
    if profile.get("draftReferenceKind") not in ("value", "text"):
        raise CompanionError("Draft reference readback needs a native value/text control.")
    if not isinstance(profile.get("saveDraftButtonLabel"), str) or not profile["saveDraftButtonLabel"].strip():
        raise CompanionError("The exact locally verified draft-save button label is required.")
    prohibited = ("IDA", "IDC", "EDC", "Truyền", "Ký", "Đăng ký")
    if any(part.casefold() in profile["saveDraftButtonLabel"].casefold() for part in prohibited):
        raise CompanionError("The configured save action resembles registration/signing/transmission.")
    if profile["saveDraftButton"][-1].get("title") != profile["saveDraftButtonLabel"]:
        raise CompanionError("The draft-save selector must include its exact verified label.")
    verification = profile.get("verification", {})
    if not isinstance(verification, dict):
        raise CompanionError("Missing saved-draft reopen/readback workflow.")
    for key in ("closeFormButton", "draftsView", "table", "referenceCell", "openButton"):
        validate_selector(verification.get(key), "saved draft " + key)
    _text(verification.get("rowControlType"), "saved draft row control type", maximum=100)
    if verification.get("referenceKind") not in ("value", "text"):
        raise CompanionError("Invalid saved-draft list reference readback.")
    if payload:
        form = payload["form"]
        for scope, records, bindings in (("header", [form["headers"]], profile["headers"]),
                                         ("goods", form["goods"], goods["fields"])):
            for record in records:
                for key, value in record.items():
                    if key not in bindings:
                        raise CompanionError(f"Profile is missing {scope} mapping: {key}. No ECUS action was taken.")
                    binding = bindings[key]
                    if binding["kind"] == "choice" and value not in binding["choices"]:
                        raise CompanionError(f"No verified {scope} choice mapping for {key}.")
    return profile["id"] + ":" + fingerprint(profile)


class Journal:
    """SQLite FULL-sync record written before every possible ECUS mutation."""
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path)
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, profile_hash TEXT NOT NULL, phase TEXT NOT NULL, result_json TEXT, reported INTEGER NOT NULL DEFAULT 0)")
        # Additive migration: old uncertain writes remain visible and are never
        # discarded just because their original delivery lease was not stored.
        columns = {row[1] for row in self.connection.execute("PRAGMA table_info(jobs)")}
        if "lease_token" not in columns:
            self.connection.execute("ALTER TABLE jobs ADD COLUMN lease_token TEXT")
        self.connection.execute("CREATE TABLE IF NOT EXISTS recovery_resolutions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), payload_hash TEXT NOT NULL, record_json TEXT NOT NULL, applied_at TEXT NOT NULL, server_acknowledged INTEGER NOT NULL DEFAULT 0)")
        self.connection.commit()

    def get(self, job_id: str) -> dict | None:
        row = self.connection.execute("SELECT payload_hash, profile_hash, phase, result_json, reported, lease_token FROM jobs WHERE id=?", (job_id,)).fetchone()
        return None if row is None else dict(zip(("payloadHash", "profileHash", "phase", "resultJson", "reported", "leaseToken"), row))

    def begin(self, job: dict, profile_hash: str) -> None:
        with self.connection:
            self.connection.execute("INSERT INTO jobs (id,payload_hash,profile_hash,phase,lease_token) VALUES (?,?,?,'in_progress',?)", (job["id"], str(job.get("payloadHash", "invalid")), profile_hash, job.get("leaseToken")))

    def finish(self, job: dict, result: dict) -> None:
        with self.connection:
            self.connection.execute("UPDATE jobs SET phase=?,result_json=?,reported=0 WHERE id=?", (result["status"], canonical(result), job["id"]))

    def reported(self, job_id: str) -> None:
        with self.connection:
            self.connection.execute("UPDATE jobs SET reported=1 WHERE id=?", (job_id,))

    def pending(self) -> list[dict]:
        return [parse_json(row[0]) for row in self.connection.execute("SELECT result_json FROM jobs WHERE reported=0 AND result_json IS NOT NULL AND NOT EXISTS (SELECT 1 FROM recovery_resolutions WHERE job_id=jobs.id) ORDER BY rowid")]

    def unresolved(self) -> list[tuple[str, str]]:
        return list(self.connection.execute("SELECT id,phase FROM jobs WHERE phase IN ('in_progress','needs_reconciliation') AND NOT EXISTS (SELECT 1 FROM recovery_resolutions WHERE job_id=jobs.id) ORDER BY rowid"))

    def recover_interrupted(self) -> None:
        """Report a process interruption without ever reopening the native job."""
        for job_id, phase in self.unresolved():
            entry = self.get(job_id)
            if phase == "in_progress" and entry["leaseToken"]:
                self.finish({"id": job_id}, {"action": "result", "jobId": job_id,
                    "leaseToken": entry["leaseToken"], "status": "needs_reconciliation",
                    "message": "The companion stopped before recording completion. Inspect ECUS before resolving this transfer; the original job will never be replayed."})

    def resolution(self, job_id: str) -> dict | None:
        row = self.connection.execute("SELECT record_json FROM recovery_resolutions WHERE job_id=?", (job_id,)).fetchone()
        return parse_json(row[0]) if row else None

    def acknowledgements(self) -> list[dict]:
        return [{"jobId": row[0], "resolutionId": row[1], "payloadHash": row[2]} for row in self.connection.execute(
            "SELECT job_id,id,payload_hash FROM recovery_resolutions WHERE server_acknowledged=0 ORDER BY rowid")]

    def apply_resolutions(self, resolutions: list[dict]) -> None:
        # The entire response is validated inside one transaction. A missing
        # local journal or conflicting decision never receives a blind ACK.
        with self.connection:
            for resolution in resolutions:
                validate_resolution(resolution)
                job_id = resolution["jobId"]
                entry, previous = self.get(job_id), self.resolution(job_id)
                if not entry or entry["payloadHash"] != resolution["payloadHash"]:
                    raise CompanionError("Recovery does not match this computer's retained job and approved payload. No acknowledgement was sent.")
                if previous:
                    if canonical(previous) != canonical(resolution):
                        raise CompanionError("The recorded recovery decision changed. Existing evidence was preserved; no acknowledgement was sent.")
                    continue
                if entry["phase"] not in ("in_progress", "needs_reconciliation"):
                    raise CompanionError("Recovery requires a matching uncertain local job. No acknowledgement was sent.")
                if self.connection.execute("SELECT 1 FROM recovery_resolutions WHERE id=?", (resolution["id"],)).fetchone():
                    raise CompanionError("A recovery decision ID was reused for a different job.")
                self.connection.execute("INSERT INTO recovery_resolutions (id,job_id,payload_hash,record_json,applied_at) VALUES (?,?,?,?,?)",
                    (resolution["id"], job_id, resolution["payloadHash"], canonical(resolution), datetime.now(timezone.utc).isoformat()))

    def acknowledge_resolutions(self, ids: list[str], sent: list[dict]) -> None:
        if not isinstance(ids, list) or len(ids) > 100 or any(not isinstance(value, str) for value in ids) or len(set(ids)) != len(ids):
            raise CompanionError("Invalid recovery acknowledgement response.")
        if set(ids) - {value["resolutionId"] for value in sent}:
            raise CompanionError("The website acknowledged a recovery decision this computer did not send.")
        with self.connection:
            for resolution_id in ids:
                self.connection.execute("UPDATE recovery_resolutions SET server_acknowledged=1 WHERE id=?", (resolution_id,))


def validate_resolution(value: Any) -> None:
    if not isinstance(value, dict):
        raise CompanionError("Invalid recovery decision.")
    for key in ("id", "jobId"):
        _text(value.get(key), "recovery " + key, maximum=160)
    if not isinstance(value.get("payloadHash"), str) or not re.fullmatch(r"[0-9a-f]{64}", value["payloadHash"]):
        raise CompanionError("Invalid recovery payload hash.")
    if value.get("disposition") not in ("no_draft", "draft_kept"):
        raise CompanionError("Invalid recovery disposition.")
    _text(value.get("actorName"), "recovery operator", maximum=300)
    _text(value.get("reason"), "recovery reason", maximum=4000)
    timestamp = _text(value.get("createdAt"), "recovery timestamp", maximum=100)
    try:
        if datetime.fromisoformat(timestamp.replace("Z", "+00:00")).tzinfo is None:
            raise ValueError("timezone missing")
    except ValueError as error:
        raise CompanionError("Invalid recovery timestamp.") from error


def sync_recovery(journal: Journal, transport: "Transport") -> None:
    """Apply server-reviewed dispositions before ACK; neither step touches ECUS."""
    acknowledgements = journal.acknowledgements()[:100]
    job_ids = list(dict.fromkeys([value["jobId"] for value in acknowledgements] + [value[0] for value in journal.unresolved()]))[:100]
    response = transport.post({"action": "recovery_sync", "jobIds": job_ids, "acknowledgements": acknowledgements})
    if not isinstance(response, dict) or not isinstance(response.get("resolutions"), list) or len(response["resolutions"]) > 100:
        raise CompanionError("Invalid recovery synchronization response.")
    journal.apply_resolutions(response["resolutions"])
    # Decisions applied above are acknowledged on the NEXT sync, so an HTTP
    # failure cannot erase the durable local evidence required for retry.
    journal.acknowledge_resolutions(response.get("acknowledgedResolutionIds", []), acknowledgements)


class Automation(Protocol):
    def preflight(self) -> None: ...
    def create_draft(self, form: dict) -> tuple[str, dict]: ...


class Transport(Protocol):
    def post(self, body: dict) -> dict: ...


def deliver_result(result: dict, journal: Journal, transport: Transport) -> dict:
    if journal.resolution(result["jobId"]):
        # A delayed callback cannot overwrite or reopen an audited recovery.
        return result
    response = transport.post(result)
    accepted = response.get("job", {}).get("status") if isinstance(response, dict) else None
    if accepted != result["status"]:
        result = {**result, "status": "needs_reconciliation",
                  "message": "The website did not accept the recorded completion status. Inspect ECUS and the website transfer record before continuing."}
        journal.finish({"id": result["jobId"]}, result)
    journal.reported(result["jobId"])
    return result


def run_job(job: dict, profile: dict, automation: Automation, journal: Journal,
            transport: Transport, confirm) -> dict:
    """Never re-execute a journaled job, including after response delivery fails."""
    _text(job.get("id"), "job ID", maximum=160)
    _text(job.get("leaseToken"), "lease token", maximum=512)
    existing = journal.get(job["id"])
    if existing:
        if existing["payloadHash"] != job.get("payloadHash"):
            raise CompanionError("Job ID was reused with different approved content; operator reconciliation is required.")
        if journal.resolution(job["id"]):
            raise CompanionError("This job already has a retained recovery decision. The original job ID will never execute again; use an explicitly approved new transfer.")
        if existing["resultJson"]:
            result = parse_json(existing["resultJson"])
            # A server may issue a fresh delivery lease, but the frozen result is
            # reused, never a second UI operation.
            result["leaseToken"] = job["leaseToken"]
            return deliver_result(result, journal, transport)
        result = {"action": "result", "jobId": job["id"], "leaseToken": job["leaseToken"],
                  "status": "needs_reconciliation", "message": "A previous run may have changed ECUS. Inspect the existing draft before any new transfer."}
        journal.finish(job, result)
        return deliver_result(result, journal, transport)
    touched = False
    begun = False
    result = {"action": "result", "jobId": job.get("id"), "leaseToken": job.get("leaseToken")}
    try:
        payload = validate_job(job)
        profile_id = validate_profile(profile, payload)
        automation.preflight()  # Process/version/title/focus guards, no UI changes.
        if not confirm(payload, profile_id):
            raise CompanionError("The Windows operator declined this draft. No ECUS action was taken.")
        validate_job(job)  # Approval/lease can expire while waiting for the operator.
        # Opening a new declaration can itself create a record. Journal first.
        journal.begin(job, fingerprint(profile))
        begun = True
        touched = True
        draft_reference, readback = automation.create_draft(complete_form(payload["form"]))
        _text(draft_reference, "verified ECUS draft reference", maximum=160)
        result.update(draftReference=draft_reference, readback=readback)
        if readback != complete_form(payload["form"]):
            raise CompanionError("ECUS readback differs from the approved snapshot; inspect the draft before retrying.")
        result.update(status="succeeded", draftReference=draft_reference, readback=readback,
                      message="Saved export EDA draft and verified every approved header and goods value. No official transmission was requested.")
    except Exception as error:
        # Native errors may embed document text. Report the controlled error text
        # only; unexpected driver exceptions receive a bounded generic message.
        message = str(error) if isinstance(error, CompanionError) else "The native ECUS operation failed; inspect the Windows session and companion journal."
        result.update(status="needs_reconciliation" if touched else "failed", message=message[:1000])
        # Save may have returned a real reference before reopen/readback failed.
        # Retain that reference as recovery evidence without claiming success.
        known_reference = getattr(automation, "last_draft_reference", None)
        if touched and isinstance(known_reference, str) and known_reference.strip() and len(known_reference) <= 160 and "\x00" not in known_reference:
            result.setdefault("draftReference", known_reference)
    if not begun:
        # Validation failures also persist before reporting, so retries are not
        # mistaken for permission to execute a job whose content changed.
        journal.begin(job, fingerprint(profile))
    journal.finish(job, result)
    return deliver_result(result, journal, transport)  # Network failure leaves the result unreported.
