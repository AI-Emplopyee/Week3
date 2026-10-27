import copy
import hashlib
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ecus_companion.core import CompanionError, EXPORT_MENU, Journal, canonical, run_job, validate_job, validate_profile
from ecus_companion.fields import HEADERS, GOODS, complete_form
from ecus_companion.storage import InstanceLock, journal_path
from ecus_companion.transport import NoRedirects, validate_base_url
from ecus_companion.windows import NativeEcus

ROOT = Path(__file__).resolve().parents[1]


def profile():
    value = json.loads((ROOT / "profiles/example-eda.json").read_text())
    def calibrated(item):
        if isinstance(item, str):
            return item.replace("CALIBRATE", "test")
        if isinstance(item, list):
            return [calibrated(child) for child in item]
        if isinstance(item, dict):
            return {key: calibrated(child) for key, child in item.items()}
        return item
    value = calibrated(value)
    value.update(calibrated=True, calibratedBy="Test operator", mainWindowTitle="ECUS fixture")
    value["process"].update(fileVersion="1.2.3.4", sha256="a" * 64)
    # The real editor title is deliberately different from the menu command.
    value["exportForm"][-1]["title"] = "Export declaration editor"
    return value


def job():
    payload = {"schemaVersion": 1, "direction": "export", "operation": "create_draft",
               "caseId": "case_test", "reference": "Xuất khẩu INV+^%{10}", "workspaceRevision": 7,
               "approvedBy": "Test operator", "approvedAt": "2026-10-25T12:00:00Z",
               "form": {"headers": {"invoiceNumber": "INV+^%{10}", "exporterName": "Công ty thử nghiệm"},
                        "goods": [{"description": "Genuine + ^ % { } text", "quantity": "2.500"}]}}
    raw = json.dumps(payload, ensure_ascii=False, indent=2)
    return {"id": "job_test", "payloadJson": raw, "payloadHash": hashlib.sha256(raw.encode()).hexdigest(),
            "leaseToken": "lease_fixture", "expiresAt": "2099-01-01T00:00:00Z", "leaseExpiresAt": "2099-01-01T00:00:00Z"}


def replace_payload(item, change):
    value = json.loads(item["payloadJson"])
    change(value)
    item["payloadJson"] = canonical(value)
    item["payloadHash"] = hashlib.sha256(item["payloadJson"].encode()).hexdigest()


class FakeTransport:
    def __init__(self):
        self.calls = []
        self.fail = False
        self.status = None
    def post(self, value):
        self.calls.append(copy.deepcopy(value))
        if self.fail:
            raise OSError("acknowledgement lost")
        return {"job": {"status": self.status or value["status"]}}


class FakeAutomation:
    def __init__(self, journal):
        self.journal = journal
        self.events = []
        self.change = None
        self.reference = "DRAFT-001"
        self.error = None
    def preflight(self):
        self.events.append("preflight")
    def create_draft(self, form):
        self.events.append("create")
        assert self.journal.get("job_test")["phase"] == "in_progress"
        if self.error:
            raise self.error
        readback = copy.deepcopy(form)
        if self.change:
            self.change(readback)
        return self.reference, readback


class CompanionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.journal = Journal(Path(self.temp.name) / "journal.sqlite3")
        self.ui = FakeAutomation(self.journal)
        self.transport = FakeTransport()
    def tearDown(self):
        self.journal.connection.close()
        self.temp.cleanup()
    def run_transfer(self, item=None, selected=None, confirm=lambda *_: True):
        return run_job(item or job(), selected or profile(), self.ui, self.journal, self.transport, confirm)

    def test_raw_utf8_hash_verified_before_parsing_without_reserialization(self):
        item = job()
        self.assertEqual(validate_job(item)["direction"], "export")
        item["payloadJson"] += " "
        with self.assertRaisesRegex(CompanionError, "hash"):
            validate_job(item)

    def test_duplicate_json_keys_rejected(self):
        item = job()
        item["payloadJson"] = item["payloadJson"].replace('"direction": "export"', '"direction": "export", "direction": "import"')
        item["payloadHash"] = hashlib.sha256(item["payloadJson"].encode()).hexdigest()
        with self.assertRaisesRegex(CompanionError, "Duplicate"):
            validate_job(item)

    def test_only_export_create_draft(self):
        for key, value in (("direction", "import"), ("operation", "transmit"), ("schemaVersion", 2)):
            item = job()
            replace_payload(item, lambda payload: payload.update({key: value}))
            with self.assertRaises(CompanionError):
                validate_job(item)
        self.assertEqual(EXPORT_MENU, ("Tờ khai hải quan", "Đăng ký mới tờ khai xuất khẩu (EDA)"))

    def test_expired_approval_and_lease_rejected_before_native_actions(self):
        for key in ("expiresAt", "leaseExpiresAt"):
            item = job(); item[key] = "2000-01-01T00:00:00Z"
            with self.assertRaisesRegex(CompanionError, "expired"):
                validate_job(item)

    def test_unknown_payload_field_rejected(self):
        item = job()
        replace_payload(item, lambda payload: payload["form"]["headers"].update({"importOnlyGuess": "x"}))
        with self.assertRaisesRegex(CompanionError, "unsupported"):
            validate_job(item)

    def test_example_profile_never_claims_ready(self):
        example = json.loads((ROOT / "profiles/example-eda.json").read_text())
        with self.assertRaisesRegex(CompanionError, "not calibrated"):
            validate_profile(example)

    def test_every_optional_field_requires_mapping_before_any_action(self):
        selected = profile(); del selected["headers"]["remarks"]
        result = self.run_transfer(selected=selected)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.ui.events, [])

    def test_distinct_actual_title_with_export_marker_is_allowed(self):
        selected = profile()
        self.assertNotEqual(selected["exportForm"][-1]["title"], EXPORT_MENU[1])
        self.assertTrue(validate_profile(selected).startswith(selected["id"] + ":"))

    def test_import_title_or_marker_is_rejected(self):
        for where in ("title", "marker"):
            selected = profile()
            if where == "title": selected["exportForm"][-1]["title"] = "Tờ khai nhập khẩu (IDA)"
            else: selected["exportMarkerText"] = "Tờ khai nhập khẩu (IDA)"
            with self.assertRaisesRegex(CompanionError, "export EDA marker"):
                validate_profile(selected)

    def test_reference_and_complete_independent_readback_required(self):
        self.ui.reference = ""
        result = self.run_transfer()
        self.assertEqual(result["status"], "needs_reconciliation")

    def test_omitted_readback_key_is_not_filled_from_expected_values(self):
        self.ui.change = lambda form: form["headers"].pop("remarks")
        result = self.run_transfer()
        self.assertEqual(result["status"], "needs_reconciliation")

    def test_unexpected_default_in_optional_blank_is_mismatch(self):
        self.ui.change = lambda form: form["headers"].update(remarks="ECUS automatic default")
        result = self.run_transfer()
        self.assertEqual(result["status"], "needs_reconciliation")

    def test_extra_or_reordered_goods_rows_fail(self):
        self.ui.change = lambda form: form["goods"].append(copy.deepcopy(form["goods"][0]))
        self.assertEqual(self.run_transfer()["status"], "needs_reconciliation")

    def test_exact_decimal_and_literal_characters_survive(self):
        result = self.run_transfer()
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["readback"]["goods"][0]["quantity"], "2.500")
        self.assertEqual(result["readback"]["headers"]["invoiceNumber"], "INV+^%{10}")
        self.assertEqual(self.ui.events, ["preflight", "create"])

    def test_declining_never_opens_or_writes_ecus(self):
        self.assertEqual(self.run_transfer(confirm=lambda *_: False)["status"], "failed")
        self.assertEqual(self.ui.events, ["preflight"])

    def test_crash_after_write_ahead_requires_reconciliation_not_replay(self):
        self.ui.error = KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self.run_transfer()
        self.assertEqual(self.journal.get("job_test")["phase"], "in_progress")
        self.ui.error = None
        result = self.run_transfer()
        self.assertEqual(result["status"], "needs_reconciliation")
        self.assertEqual(self.ui.events.count("create"), 1)

    def test_native_exception_after_possible_write_is_never_simple_failed(self):
        self.ui.error = RuntimeError("sensitive native error")
        result = self.run_transfer()
        self.assertEqual(result["status"], "needs_reconciliation")
        self.assertNotIn("sensitive", result["message"])

    def test_network_failure_persists_result_and_retry_never_reexecutes(self):
        self.transport.fail = True
        with self.assertRaises(OSError):
            self.run_transfer()
        self.assertEqual(len(self.journal.pending()), 1)
        self.transport.fail = False
        self.assertEqual(self.run_transfer()["status"], "succeeded")
        self.assertEqual(self.ui.events.count("create"), 1)
        self.assertEqual(self.journal.pending(), [])

    def test_server_rejected_success_becomes_local_reconciliation(self):
        self.transport.status = "needs_reconciliation"
        result = self.run_transfer()
        self.assertEqual(result["status"], "needs_reconciliation")
        self.assertEqual(self.journal.unresolved(), [("job_test", "needs_reconciliation")])

    def test_existing_job_with_changed_hash_never_reexecutes(self):
        self.run_transfer()
        item = job(); replace_payload(item, lambda payload: payload.update(reference="other"))
        with self.assertRaisesRegex(CompanionError, "reused"):
            self.run_transfer(item)
        self.assertEqual(self.ui.events.count("create"), 1)

    def test_profile_fingerprint_changes_when_any_selector_changes(self):
        left = profile(); right = copy.deepcopy(left)
        right["headers"]["remarks"]["selector"][0]["autoId"] = "different"
        self.assertNotEqual(validate_profile(left), validate_profile(right))
        self.assertLessEqual(len(validate_profile(left)), 160)

    def test_server_field_contract_has_not_drifted(self):
        source = (ROOT.parents[1] / "lib/ecus-export.ts").read_text()
        self.assertEqual(tuple(re.findall(r"^  header\('([^']+)'", source, re.M)), HEADERS)
        self.assertEqual(tuple(re.findall(r"^  goods\('([^']+)'", source, re.M)), GOODS)

    def test_https_origin_and_redirect_rules(self):
        self.assertEqual(validate_base_url("https://aicd.example/"), "https://aicd.example")
        self.assertEqual(validate_base_url("http://127.0.0.1:5173"), "http://127.0.0.1:5173")
        for url in ("http://192.168.1.1", "https://user:key@aicd.example", "https://aicd.example/path", "file:///tmp/data"):
            with self.assertRaises(CompanionError): validate_base_url(url)
        with self.assertRaisesRegex(CompanionError, "redirect"):
            NoRedirects().redirect_request(None, None, 302, "", {}, "https://other.example")

    def test_journal_identity_is_bound_to_origin_and_device(self):
        base = Path(self.temp.name)
        one = journal_path(base, {"baseUrl": "https://one.example", "token": "device1.secret"})
        self.assertNotEqual(one, journal_path(base, {"baseUrl": "https://two.example", "token": "device1.secret"}))
        self.assertNotEqual(one, journal_path(base, {"baseUrl": "https://one.example", "token": "device2.secret"}))

    def test_two_helpers_cannot_take_the_local_session_lock(self):
        path = Path(self.temp.name) / "session.lock"
        with InstanceLock(path):
            with self.assertRaises(CompanionError):
                with InstanceLock(path): pass
        with InstanceLock(path): pass

    def test_native_value_setter_uses_literal_value_not_keystrokes(self):
        driver = object.__new__(NativeEcus)
        events = []
        native = SimpleNamespace(CurrentValue="", CurrentIsReadOnly=False)
        def setter(value):
            events.append(value); native.CurrentValue = value
        native.SetValue = setter
        control = SimpleNamespace(iface_value=native)
        driver._guard = lambda **_: None
        driver._control = lambda *_args, **_kwargs: control
        driver._write_fields(None, {"description": "+^%{TAB} original text"}, {"description": {"kind": "value"}})
        self.assertEqual(events, ["+^%{TAB} original text"])

    def test_native_readonly_computed_fields_are_never_overwritten(self):
        driver = object.__new__(NativeEcus)
        native = SimpleNamespace(CurrentValue="12.50", CurrentIsReadOnly=True,
                                 SetValue=lambda _: self.fail("read-only write"))
        driver._guard = lambda **_: None
        driver._control = lambda *_args, **_kwargs: SimpleNamespace(iface_value=native)
        driver._write_fields(None, {"amount": "12.50"}, {"amount": {"kind": "readOnlyValue"}})

    def test_native_focus_change_and_unexpected_modal_stop_before_action(self):
        driver = object.__new__(NativeEcus)
        driver.profile, driver.pid, driver.deadline, driver.binary_stat = profile(), 7, None, ()
        driver.main = SimpleNamespace(is_visible=lambda: True, process_id=lambda: 7,
                                      window_text=lambda: "ECUS fixture")
        driver._stat = lambda: ()
        driver._foreground_pid = lambda: 8
        with self.assertRaisesRegex(CompanionError, "Focus moved"):
            driver._guard()
        driver._foreground_pid = lambda: 7
        dialog = SimpleNamespace(is_visible=lambda: True, element_info=SimpleNamespace(control_type="Window"),
                                 window_text=lambda: "Unexpected confirmation")
        driver.desktop = SimpleNamespace(windows=lambda **_: [dialog])
        with self.assertRaisesRegex(CompanionError, "unexpected"):
            driver._guard()

    def test_native_transmission_action_is_blocked(self):
        driver = object.__new__(NativeEcus)
        driver._guard = lambda **_: None
        control = SimpleNamespace(is_visible=lambda: True, is_enabled=lambda: True,
                                  window_text=lambda: "Truyền EDA",
                                  iface_invoke=SimpleNamespace(Invoke=lambda: self.fail("transmission invoked")))
        with self.assertRaisesRegex(CompanionError, "transmission"):
            driver._invoke(control)

    def test_native_saved_draft_is_reopened_before_full_readback(self):
        driver = object.__new__(NativeEcus)
        driver.profile = profile()
        driver.main = SimpleNamespace(handle=42)
        events, state = [], {"rows": [], "header": {}, "visible": True, "dialog": False, "selection": 0}
        form_control = SimpleNamespace(is_visible=lambda: state["visible"])
        dialog_control = SimpleNamespace(is_visible=lambda: state["dialog"])
        listing = object()
        driver._guard = lambda **_: None
        driver._form = lambda: form_control
        driver._dialog = lambda: dialog_control
        driver._navigate = lambda *_args, **_kwargs: None
        driver._open_export_menu = lambda: events.append("export-menu")
        driver._assert_no_editor = lambda: None
        def rows():
            result = []
            for index in range(len(state["rows"])):
                def select(i=index):
                    state["selection"] = i; events.append("select-goods")
                result.append(SimpleNamespace(iface_selection_item=SimpleNamespace(Select=select)))
            return result
        driver._goods_rows = rows
        driver._resolve = lambda root, selector, **_: selector[-1]["autoId"]
        def write(root, values, *_args, **_kwargs):
            if root is form_control:
                state["header"] = copy.deepcopy(values); events.append("write-header")
            else:
                state["edit"] = copy.deepcopy(values); events.append("write-goods")
        driver._write_fields = write
        def invoke(control, **_):
            if control == "test_goods_add":
                state["dialog"] = True; events.append("add-goods")
            elif control == "test_goods_save":
                state["rows"].append(copy.deepcopy(state["edit"])); state["dialog"] = False; events.append("save-goods")
            elif control == "test_save_draft":
                state["saved"] = {"headers": copy.deepcopy(state["header"]), "goods": copy.deepcopy(state["rows"])}; events.append("save-draft")
            elif control == "test_close_saved_form":
                state["visible"] = False; state["header"] = {}; events.append("close-draft")
            elif control == "test_open_selected_saved_draft":
                state["visible"] = True; state["header"] = copy.deepcopy(state["saved"]["headers"]); events.append("reopen-draft")
            elif control == "test_goods_edit":
                state["dialog"] = True; state["edit"] = copy.deepcopy(state["saved"]["goods"][state["selection"]]); events.append("open-saved-goods")
            elif control == "test_goods_cancel_close":
                state["dialog"] = False; events.append("close-saved-goods")
            else:
                self.fail("Unexpected native invocation: " + control)
        driver._invoke = invoke
        driver._read = lambda *_: "DRAFT-PERSISTED"
        driver._rows = lambda *_: [SimpleNamespace(iface_selection_item=SimpleNamespace(Select=lambda: events.append("select-draft")))]
        def read(root, *_args, **_kwargs):
            events.append("read-header" if root is form_control else "read-goods")
            return copy.deepcopy(state["header"] if root is form_control else state["edit"])
        driver._read_fields = read
        def foreground(_): return True
        native = SimpleNamespace(SetForegroundWindow=foreground)
        expected = complete_form(json.loads(job()["payloadJson"])["form"])
        with patch("ctypes.WinDLL", return_value=native, create=True):
            reference, actual = driver.create_draft(expected)
        self.assertEqual(reference, "DRAFT-PERSISTED")
        self.assertEqual(actual, expected)
        self.assertLess(events.index("save-draft"), events.index("close-draft"))
        self.assertLess(events.index("close-draft"), events.index("reopen-draft"))
        self.assertLess(events.index("reopen-draft"), events.index("read-header"))
        self.assertLess(events.index("reopen-draft"), events.index("read-goods"))

    def test_normal_operation_needs_no_second_confirmation(self):
        from ecus_companion.__main__ import confirm
        with patch("builtins.input", side_effect=AssertionError("Unexpected extra confirmation")), patch("builtins.print"):
            self.assertTrue(confirm(json.loads(job()["payloadJson"]), "fixture"))

    def test_existing_mdi_or_top_level_editor_is_rejected_before_menu_or_writes(self):
        for top_level in (False, True):
            with self.subTest(top_level=top_level):
                driver = object.__new__(NativeEcus)
                driver.profile, driver.pid = profile(), 7
                title = driver.profile["exportForm"][-1]["title"]
                def control(name, children):
                    return SimpleNamespace(handle=42, is_visible=lambda: True, descendants=lambda: children,
                        element_info=SimpleNamespace(automation_id="", name=name, control_type="Window", class_name=""))
                editor = control(title, [])
                driver.main = control("ECUS fixture", [] if top_level else [editor])
                driver.desktop = SimpleNamespace(windows=lambda **_: [driver.main, editor] if top_level else [driver.main])
                driver._guard = lambda **_: None
                driver._open_export_menu = lambda: self.fail("New menu was invoked for an existing editor")
                driver._write_fields = lambda *_args, **_kwargs: self.fail("Existing draft was overwritten")
                def foreground(_): return True
                with patch("ctypes.WinDLL", return_value=SimpleNamespace(SetForegroundWindow=foreground), create=True):
                    with self.assertRaisesRegex(CompanionError, "existing export"):
                        driver.create_draft({"headers": {}, "goods": []})


if __name__ == "__main__":
    unittest.main()
