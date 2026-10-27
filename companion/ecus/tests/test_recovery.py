import copy
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from test_companion import FakeAutomation, FakeTransport, job, profile
from ecus_companion.core import CompanionError, Journal, canonical, deliver_result, run_job, sync_recovery
from ecus_companion.__main__ import poll


def resolution(item=None, **changes):
    item = item or job()
    return {"id": "recovery_fixture", "jobId": item["id"], "payloadHash": item["payloadHash"],
            "disposition": "no_draft", "actorName": "Recovery reviewer", "reason": "Inspected ECUS and found no saved draft.",
            "createdAt": "2026-10-26T12:00:00Z", **changes}


class RecoveryTransport:
    def __init__(self, resolutions=None):
        self.resolutions = resolutions or []
        self.calls = []
        self.fail_ack = False
        self.fail_result = False
        self.confirm_ack = True

    def post(self, body):
        self.calls.append(copy.deepcopy(body))
        if body["action"] == "result":
            if self.fail_result:
                raise CompanionError("Result temporarily unavailable")
            return {"job": {"status": body["status"]}}
        if body["action"] == "poll":
            return {"job": None}
        if body["action"] != "recovery_sync":
            raise AssertionError("Unexpected request")
        if body["acknowledgements"] and self.fail_ack:
            raise CompanionError("Acknowledgement response lost")
        return {"resolutions": self.resolutions, "acknowledgedResolutionIds":
                [value["resolutionId"] for value in body["acknowledgements"]] if self.confirm_ack else []}


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "journal.sqlite3"
        self.journal = Journal(self.path)
        self.item = job()

    def tearDown(self):
        self.journal.connection.close()
        self.temp.cleanup()

    def uncertain(self):
        self.journal.begin(self.item, "profile-fingerprint")
        self.journal.recover_interrupted()

    def test_restart_records_crash_result_using_retained_original_lease(self):
        ui = FakeAutomation(self.journal)
        ui.error = KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            run_job(self.item, profile(), ui, self.journal, FakeTransport(), lambda *_: True)
        self.journal.connection.close()
        self.journal = Journal(self.path)
        self.journal.recover_interrupted()
        self.assertEqual(self.journal.get(self.item["id"])["phase"], "needs_reconciliation")
        self.assertEqual(self.journal.pending()[0]["leaseToken"], self.item["leaseToken"])
        self.assertEqual(ui.events.count("create"), 1)

    def test_legacy_journal_migrates_without_deleting_or_inventing_a_lease(self):
        legacy_path = Path(self.temp.name) / "legacy.sqlite3"
        connection = sqlite3.connect(legacy_path)
        connection.execute("CREATE TABLE jobs (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, profile_hash TEXT NOT NULL, phase TEXT NOT NULL, result_json TEXT, reported INTEGER NOT NULL DEFAULT 0)")
        connection.execute("INSERT INTO jobs (id,payload_hash,profile_hash,phase) VALUES (?,?,?,'in_progress')", (self.item["id"], self.item["payloadHash"], "old-profile"))
        connection.commit(); connection.close()
        legacy = Journal(legacy_path)
        try:
            legacy.recover_interrupted()
            self.assertEqual(legacy.unresolved(), [(self.item["id"], "in_progress")])
            self.assertEqual(legacy.pending(), [])
            self.assertIsNone(legacy.get(self.item["id"])["leaseToken"])
            legacy.apply_resolutions([resolution()])
            self.assertEqual(legacy.unresolved(), [])
            self.assertEqual(legacy.get(self.item["id"])["phase"], "in_progress")
        finally:
            legacy.connection.close()

    def test_resolution_is_durable_before_ack_and_ack_is_retried_after_restart(self):
        self.uncertain()
        transport = RecoveryTransport([resolution()])
        before = self.journal.get(self.item["id"])
        sync_recovery(self.journal, transport)
        self.assertEqual(transport.calls[0]["acknowledgements"], [])
        self.assertEqual(self.journal.unresolved(), [])
        self.assertEqual(self.journal.get(self.item["id"]), before)
        self.assertEqual(self.journal.pending(), [])
        transport.fail_ack = True
        with self.assertRaisesRegex(CompanionError, "lost"):
            sync_recovery(self.journal, transport)
        self.journal.connection.close()
        self.journal = Journal(self.path)
        self.assertEqual(len(self.journal.acknowledgements()), 1)
        transport.fail_ack = False
        sync_recovery(self.journal, transport)
        self.assertEqual(self.journal.acknowledgements(), [])
        self.assertEqual(self.journal.resolution(self.item["id"]), resolution())

    def test_successful_http_without_explicit_ack_keeps_retry_pending(self):
        self.uncertain()
        transport = RecoveryTransport([resolution()]); transport.confirm_ack = False
        sync_recovery(self.journal, transport)
        sync_recovery(self.journal, transport)
        self.assertEqual(len(self.journal.acknowledgements()), 1)

    def test_resolution_cannot_ack_unknown_job_wrong_hash_or_changed_decision(self):
        self.uncertain()
        for decision in (resolution(jobId="unknown_job"), resolution(payloadHash="f" * 64)):
            with self.assertRaisesRegex(CompanionError, "does not match"):
                self.journal.apply_resolutions([decision])
        self.assertEqual(self.journal.acknowledgements(), [])
        self.journal.apply_resolutions([resolution()])
        with self.assertRaisesRegex(CompanionError, "changed"):
            self.journal.apply_resolutions([resolution(reason="New unsupported explanation")])
        self.assertEqual(self.journal.resolution(self.item["id"]), resolution())

    def test_batch_with_unknown_job_rolls_back_all_new_resolutions(self):
        self.uncertain()
        with self.assertRaises(CompanionError):
            self.journal.apply_resolutions([resolution(), resolution(id="another_resolution", jobId="missing_job")])
        self.assertIsNone(self.journal.resolution(self.item["id"]))
        self.assertEqual(self.journal.acknowledgements(), [])

    def test_resolution_for_prewrite_failed_job_is_not_blindly_acked(self):
        run_job(self.item, profile(), FakeAutomation(self.journal), self.journal, FakeTransport(), lambda *_: False)
        with self.assertRaisesRegex(CompanionError, "uncertain local job"):
            self.journal.apply_resolutions([resolution()])

    def test_unknown_or_invalid_ack_response_does_not_clear_pending_ack(self):
        self.uncertain(); self.journal.apply_resolutions([resolution()])
        sent = self.journal.acknowledgements()
        for ids in (["other_resolution"], [{}], "recovery_fixture", ["recovery_fixture", "recovery_fixture"]):
            with self.assertRaises(CompanionError):
                self.journal.acknowledge_resolutions(ids, sent)
        self.assertEqual(self.journal.acknowledgements(), sent)

    def test_recovered_original_job_never_executes_or_reports_again(self):
        self.uncertain(); self.journal.apply_resolutions([resolution()])
        before = self.journal.get(self.item["id"])
        ui, transport = FakeAutomation(self.journal), FakeTransport()
        with self.assertRaisesRegex(CompanionError, "never execute again"):
            run_job(self.item, profile(), ui, self.journal, transport, lambda *_: True)
        deliver_result({"jobId": self.item["id"], "status": "needs_reconciliation"}, self.journal, transport)
        self.assertEqual(ui.events, [])
        self.assertEqual(transport.calls, [])
        self.assertEqual(self.journal.get(self.item["id"]), before)

    def test_explicit_new_retry_job_id_can_execute_without_erasing_previous_job(self):
        self.uncertain(); self.journal.apply_resolutions([resolution()])
        self.journal.acknowledge_resolutions(["recovery_fixture"], self.journal.acknowledgements())
        retry = {**self.item, "id": "job_new", "retryOf": self.item["id"]}
        ui = SimpleNamespace(preflight=lambda: None, create_draft=lambda form: ("NEW-DRAFT", form))
        result = run_job(retry, profile(), ui, self.journal, FakeTransport(), lambda *_: True)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(self.journal.get(self.item["id"])["phase"], "needs_reconciliation")
        self.assertEqual(self.journal.resolution(self.item["id"]), resolution())

    def test_reopen_failure_retains_actual_saved_reference_without_success(self):
        ui = FakeAutomation(self.journal)
        ui.last_draft_reference = "SAVED-BUT-READBACK-FAILED"
        ui.error = CompanionError("Could not reopen saved draft")
        result = run_job(self.item, profile(), ui, self.journal, FakeTransport(), lambda *_: True)
        self.assertEqual(result["status"], "needs_reconciliation")
        self.assertEqual(result["draftReference"], "SAVED-BUT-READBACK-FAILED")
        self.assertNotIn("readback", result)

    def test_readback_difference_retains_exact_values_for_server_comparison(self):
        ui = FakeAutomation(self.journal)
        ui.change = lambda form: form["goods"][0].update(quantity="2.5")
        result = run_job(self.item, profile(), ui, self.journal, FakeTransport(), lambda *_: True)
        self.assertEqual(result["status"], "needs_reconciliation")
        self.assertEqual(result["readback"]["goods"][0]["quantity"], "2.5")
        self.assertEqual(self.journal.get(self.item["id"])["resultJson"], canonical(result))

    def test_sync_batches_requests_to_contract_limit(self):
        for index in range(105):
            self.journal.begin({**self.item, "id": f"job_{index}"}, "profile")
        transport = RecoveryTransport()
        sync_recovery(self.journal, transport)
        self.assertEqual(len(transport.calls[0]["jobIds"]), 100)
        self.assertEqual(len(self.journal.unresolved()), 105)

    def test_poll_syncs_after_delivery_failure_and_blocks_until_ack(self):
        self.uncertain()
        transport = RecoveryTransport([resolution()]); transport.fail_result = True
        args = SimpleNamespace(profile="fixture.json", once=True, confirm_each_job=False, interval=5)
        patches = (
            patch("ecus_companion.__main__.data_directory", return_value=Path(self.temp.name)),
            patch("ecus_companion.__main__.load_configuration", return_value={"baseUrl": "https://fixture.example", "token": "device.secret"}),
            patch("ecus_companion.__main__.journal_path", return_value=self.path),
            patch("ecus_companion.__main__.HttpTransport", return_value=transport),
            patch("ecus_companion.__main__.read_profile", return_value=profile()),
        )
        from contextlib import ExitStack
        with ExitStack() as stack:
            for context in patches: stack.enter_context(context)
            native = stack.enter_context(patch("ecus_companion.__main__.NativeEcus"))
            stack.enter_context(patch("builtins.print"))
            self.assertEqual(poll(args), 0)
            self.assertEqual([call["action"] for call in transport.calls], ["result", "recovery_sync", "poll"])
            self.assertFalse(transport.calls[-1]["ready"])
            native.assert_not_called()
            transport.calls.clear()
            self.assertEqual(poll(args), 0)
            self.assertEqual([call["action"] for call in transport.calls], ["recovery_sync", "poll"])
            self.assertTrue(transport.calls[-1]["ready"])
            native.return_value.preflight.assert_called_once()


if __name__ == "__main__":
    unittest.main()
