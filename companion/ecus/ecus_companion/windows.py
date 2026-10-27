"""Native UI Automation driver; intentionally no coordinates or keyboard typing.

Only calibrated, accessible installations are supported. An inaccessible custom
grid/date control is a calibration blocker, never a reason to type blindly.
"""
from __future__ import annotations

import ctypes
import hashlib
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from .core import CompanionError, EXPORT_MENU


class ControlNotReady(CompanionError):
    pass


def require_windows():
    if os.name != "nt":
        raise CompanionError("Native ECUS control and token storage require Windows.")


def process_path(pid: int) -> str:
    require_windows()
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        raise CompanionError("Cannot inspect the installed ECUS process.")
    try:
        size = wintypes.DWORD(32768)
        value = ctypes.create_unicode_buffer(size.value)
        if not kernel.QueryFullProcessImageNameW(handle, 0, value, ctypes.byref(size)):
            raise CompanionError("Cannot verify ECUS executable path.")
        return value.value
    finally:
        kernel.CloseHandle(handle)


def file_version(path: str) -> str:
    require_windows()
    from ctypes import wintypes
    version = ctypes.WinDLL("version", use_last_error=True)
    version.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
    version.GetFileVersionInfoSizeW.restype = wintypes.DWORD
    version.GetFileVersionInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    version.VerQueryValueW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT)]
    unused = wintypes.DWORD()
    size = version.GetFileVersionInfoSizeW(path, ctypes.byref(unused))
    if not size:
        raise CompanionError("ECUS executable has no readable file version.")
    buffer = ctypes.create_string_buffer(size)
    if not version.GetFileVersionInfoW(path, 0, size, buffer):
        raise CompanionError("Cannot read ECUS file version.")
    pointer, length = ctypes.c_void_p(), wintypes.UINT()
    if not version.VerQueryValueW(buffer, "\\", ctypes.byref(pointer), ctypes.byref(length)) or length.value < 52:
        raise CompanionError("Invalid ECUS version resource.")
    numbers = ctypes.cast(pointer, ctypes.POINTER(wintypes.DWORD))
    if numbers[0] != 0xFEEF04BD:
        raise CompanionError("Invalid ECUS version signature.")
    return ".".join(map(str, (numbers[2] >> 16, numbers[2] & 65535, numbers[3] >> 16, numbers[3] & 65535)))


def file_hash(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def matches(control, selector: dict) -> bool:
    info = control.element_info
    values = {"autoId": info.automation_id, "title": info.name,
              "controlType": info.control_type, "className": info.class_name}
    return all(values.get(key) == value for key, value in selector.items())


class NativeEcus:
    def __init__(self, profile: dict, job: dict | None = None):
        require_windows()
        from pywinauto import Desktop
        self.desktop = Desktop(backend="uia")
        self.profile, self.job = profile, job
        self.main = None
        self.pid = None
        self.binary_stat = None
        self.deadline = None
    def _set_deadline(self):
        if self.job:
            # A small margin leaves time to report completion before the lease.
            deadlines = [datetime.fromisoformat(self.job[key].replace("Z", "+00:00")).timestamp() for key in ("expiresAt", "leaseExpiresAt")]
            self.deadline = min(deadlines) - 20

    def preflight(self):
        self._set_deadline()
        candidates = [window for window in self.desktop.windows()
                      if window.window_text() == self.profile["mainWindowTitle"] and window.is_visible()]
        if len(candidates) != 1:
            raise CompanionError("Exactly one calibrated ECUS main window must be open.")
        self.main = candidates[0]
        self.pid = self.main.process_id()
        expected = self.profile["process"]
        actual = process_path(self.pid)
        if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(expected["executable"])):
            raise CompanionError("ECUS process path does not match the calibrated installation.")
        if file_version(actual) != expected["fileVersion"] or file_hash(actual) != expected["sha256"]:
            raise CompanionError("The installed ECUS binary/version changed. Recalibrate before transferring.")
        self.binary_stat = self._stat()
        self._guard(focus=False)
        self._assert_no_editor()

    def _assert_no_editor(self):
        selector = self.profile["exportForm"][-1]
        roots = self.desktop.windows(process=self.pid)
        if any(control.is_visible() and matches(control, selector)
               for root in roots for control in [root, *root.descendants()]):
            raise CompanionError("Close the existing export declaration editor before claiming a new transfer.")

    def _stat(self):
        info = Path(self.profile["process"]["executable"]).stat()
        return (info.st_size, info.st_mtime_ns, info.st_ino)

    def _foreground_pid(self):
        from ctypes import wintypes
        user = ctypes.WinDLL("user32", use_last_error=True)
        user.GetForegroundWindow.restype = wintypes.HWND
        user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        pid = wintypes.DWORD()
        user.GetWindowThreadProcessId(user.GetForegroundWindow(), ctypes.byref(pid))
        return pid.value

    def _guard(self, *, dialog=False, focus=True):
        if self.deadline is not None and time.time() >= self.deadline:
            raise CompanionError("The transfer lease is ending. Inspect the partial ECUS draft; automatic continuation is disabled.")
        if not self.main or not self.main.is_visible() or self.main.process_id() != self.pid or self.main.window_text() != self.profile["mainWindowTitle"]:
            raise CompanionError("The calibrated ECUS window/process changed.")
        if self._stat() != self.binary_stat:
            raise CompanionError("The ECUS executable changed during transfer.")
        if focus and self._foreground_pid() != self.pid:
            raise CompanionError("Focus moved away from ECUS. Inspect the draft before continuing.")
        allowed = {self.profile["mainWindowTitle"], self.profile["exportForm"][-1]["title"]}
        last = self.profile["verification"]["draftsView"][-1]
        if last.get("controlType") == "Window":
            allowed.add(last.get("title"))
        if dialog:
            allowed.add(self.profile["goods"]["dialogTitle"])
        for window in self.desktop.windows(process=self.pid):
            if window.is_visible() and window.element_info.control_type == "Window" and window.window_text() not in allowed:
                raise CompanionError("An unexpected ECUS window/dialog appeared. No further controls were changed.")

    def _resolve(self, root, path: list, *, dialog=False):
        self._guard(dialog=dialog)
        current = root
        for segment in path:
            found = [item for item in [current, *current.descendants()] if matches(item, segment) and item.is_visible()]
            if not found:
                raise ControlNotReady("A calibrated native control is not ready.")
            if len(found) != 1:
                raise CompanionError("A calibrated native control is missing or ambiguous. No fallback typing is allowed.")
            current = found[0]
            if current.process_id() != self.pid:
                raise CompanionError("A control belongs to a different process.")
        return current

    def _form(self):
        # ECUS may expose the EDA form as an MDI child or a top-level window.
        self._guard()
        title = self.profile["exportForm"][-1]["title"]
        roots = [self.main] + [w for w in self.desktop.windows(process=self.pid)
                              if w.handle != self.main.handle and w.window_text() == title]
        found = []
        for root in roots:
            try:
                found.append(self._resolve(root, self.profile["exportForm"]))
            except ControlNotReady:
                continue
        unique = {item.element_info.runtime_id.__str__(): item for item in found}
        if not unique:
            raise ControlNotReady("The calibrated export form is not ready.")
        if len(unique) != 1:
            raise CompanionError("The exact export EDA form is not uniquely visible. Import IDA forms are never filled.")
        form = next(iter(unique.values()))
        if form.window_text() != title or not form.is_enabled():
            raise CompanionError("The export form title/state does not match the calibrated EDA screen.")
        marker = self._resolve(form, self.profile["exportMarker"])
        if marker.window_text() != self.profile["exportMarkerText"]:
            raise CompanionError("The visible form does not show the calibrated export EDA direction marker.")
        return form

    def _invoke(self, control, *, dialog=False, menu=False):
        self._guard(dialog=dialog)
        if not control.is_enabled() or not control.is_visible():
            raise CompanionError("The calibrated native action is not currently available.")
        title = control.window_text()
        prohibited = ("truyền", "ký số", "gửi", "khai trước", "khai báo", "đăng ký", " edc", " idc", " eda", " ida")
        if not menu and any(word in (" " + title.casefold()) for word in prohibited):
            raise CompanionError("A native action resembles signing or official transmission; it was blocked.")
        try:
            control.iface_invoke.Invoke()
        except Exception as error:
            raise CompanionError("This action has no usable native Invoke pattern. Calibrate a supported control; no click/keyboard fallback was used.") from error

    def _navigate(self, root, steps: list, *, dialog=False):
        for step in steps:
            control = self._resolve(root, step["selector"], dialog=dialog)
            if step["action"] == "invoke":
                self._invoke(control, dialog=dialog)
            else:
                self._guard(dialog=dialog)
                control.iface_selection_item.Select()

    def _control(self, root, binding, *, dialog=False):
        self._navigate(root, binding.get("navigation", []), dialog=dialog)
        return self._wait_for(lambda: self._resolve(root, binding["selector"], dialog=dialog), dialog=dialog)

    def _read(self, control, kind="value", choices=None):
        if kind in ("text", "readOnlyText"):
            return control.window_text()
        if kind == "choice":
            selected = control.iface_selection.GetCurrentSelection()
            if selected.Length != 1:
                raise CompanionError("A choice control has no unique selected value.")
            label = selected.GetElement(0).CurrentName
            reverse = {label: value for value, label in choices.items()}
            if label not in reverse:
                raise CompanionError("ECUS contains an uncalibrated choice label.")
            return reverse[label]
        return str(control.iface_value.CurrentValue)

    def _write_fields(self, root, values: dict, bindings: dict, *, dialog=False):
        # Verify access to every control before the first field value is changed.
        for key in values:
            binding = bindings[key]
            control = self._control(root, binding, dialog=dialog)
            self._read(control, binding["kind"], binding.get("choices"))
            if binding["kind"] == "value" and control.iface_value.CurrentIsReadOnly:
                raise CompanionError("A mapped export input is read-only on this installation.")
        for key, value in values.items():
            binding = bindings[key]
            control = self._control(root, binding, dialog=dialog)
            self._guard(dialog=dialog)
            if binding["kind"].startswith("readOnly"):
                # ECUS may compute this from other approved inputs. Never force
                # its value; independent persisted readback must still match.
                continue
            if binding["kind"] == "choice":
                # pywinauto's UIA selection targets the named item, not a global keystroke.
                control.select(binding["choices"][value])
            else:
                control.iface_value.SetValue(value)
            self._guard(dialog=dialog)
            if self._read(control, binding["kind"], binding.get("choices")) != value:
                raise CompanionError("A native control did not retain the exact approved value.")

    def _read_fields(self, root, bindings: dict, *, dialog=False):
        result = {}
        for key, binding in bindings.items():
            control = self._control(root, binding, dialog=dialog)
            self._guard(dialog=dialog)
            result[key] = self._read(control, binding["kind"], binding.get("choices"))
        return result

    def _dialog(self):
        self._guard(dialog=True)
        found = [w for w in self.desktop.windows(process=self.pid)
                 if w.is_visible() and w.window_text() == self.profile["goods"]["dialogTitle"]]
        if not found:
            raise ControlNotReady("The calibrated goods dialog is not ready.")
        if len(found) != 1:
            raise CompanionError("The calibrated goods-detail dialog is not uniquely visible.")
        return found[0]

    def _wait(self, check, *, dialog=False):
        self._wait_for(check, dialog=dialog)

    def _wait_for(self, check, *, dialog=False):
        end = time.monotonic() + 8
        while time.monotonic() < end:
            self._guard(dialog=dialog)
            try:
                result = check()
                if result:
                    return result
            except ControlNotReady:
                pass
            time.sleep(0.1)
        raise CompanionError("ECUS did not reach the expected native screen state in time.")

    def _rows(self, root, config):
        table = self._resolve(root, config["table"])
        return [row for row in table.children() if row.element_info.control_type == config["rowControlType"] and row.is_visible()]

    def _goods_rows(self):
        form = self._form()
        self._navigate(form, self.profile["goods"].get("navigation", []))
        return self._rows(form, self.profile["goods"])

    def _open_export_menu(self):
        self._guard()
        # Opening the menu is already covered by the write-ahead journal.
        for index, title in enumerate(EXPORT_MENU):
            def menu_item():
                found = []
                for root in self.desktop.windows(process=self.pid):
                    if root.is_visible():
                        found.extend(control for control in [root, *root.descendants(control_type="MenuItem")]
                                     if control.element_info.control_type == "MenuItem" and control.window_text() == title and control.is_visible())
                if len(found) > 1:
                    raise CompanionError("The exact export menu item is ambiguous.")
                return found[0] if found else None
            control = self._wait_for(menu_item)
            if index == 0:
                self._guard()
                try:
                    control.iface_expand_collapse.Expand()
                except Exception:
                    self._invoke(control, menu=True)
            else:
                self._invoke(control, menu=True)

    def create_draft(self, form: dict):
        self.last_draft_reference = None
        from ctypes import wintypes
        user = ctypes.WinDLL("user32", use_last_error=True)
        user.SetForegroundWindow.argtypes = [wintypes.HWND]
        # One explicit targeted activation after operator confirmation; no later
        # refocusing if another application takes over the user's foreground.
        if not user.SetForegroundWindow(self.main.handle):
            raise CompanionError("Windows did not allow ECUS activation. Focus ECUS and inspect the transfer record.")
        self._guard()
        # Recheck after any optional operator prompt and immediately before New:
        # ECUS may otherwise reuse a zero-goods editor instead of creating one.
        self._assert_no_editor()
        self._open_export_menu()
        current = self._wait_for(self._form)
        if self._goods_rows():
            raise CompanionError("The newly opened EDA form already contains goods; creation stopped to avoid overwriting an existing draft.")
        self._write_fields(current, form["headers"], self.profile["headers"])
        goods = self.profile["goods"]
        for index, values in enumerate(form["goods"]):
            current = self._form()
            self._navigate(current, goods.get("navigation", []))
            if len(self._goods_rows()) != index:
                raise CompanionError("Goods row count changed unexpectedly.")
            self._invoke(self._resolve(current, goods["addButton"]))
            dialog = self._wait_for(self._dialog, dialog=True)
            self._write_fields(dialog, values, goods["fields"], dialog=True)
            self._invoke(self._resolve(dialog, goods["saveButton"], dialog=True), dialog=True)
            self._wait(lambda: not dialog.is_visible(), dialog=True)
            if len(self._goods_rows()) != index + 1:
                raise CompanionError("ECUS did not save exactly one new goods row.")
        current = self._form()
        self._navigate(current, self.profile.get("saveNavigation", []))
        self._invoke(self._resolve(current, self.profile["saveDraftButton"]))
        reference = self._wait_for(lambda: self._read(self._resolve(current, self.profile["draftReference"]), self.profile["draftReferenceKind"]))
        if not reference.strip() or len(reference) > 160:
            raise CompanionError("ECUS did not provide a durable draft reference after Save.")
        self.last_draft_reference = reference
        # Closing and reopening from the saved list independently establishes
        # persistence. Reading the still-open editor is insufficient.
        verify = self.profile["verification"]
        self._invoke(self._resolve(current, verify["closeFormButton"]))
        self._wait(lambda: not current.is_visible())
        listing = self._wait_for(lambda: self._resolve(self.main, verify["draftsView"]))
        matching = [row for row in self._rows(listing, verify)
                    if self._read(self._resolve(row, verify["referenceCell"]), verify["referenceKind"]) == reference]
        if len(matching) != 1:
            raise CompanionError("The saved draft cannot be uniquely found by its actual reference.")
        self._guard()
        matching[0].iface_selection_item.Select()
        self._invoke(self._resolve(listing, verify["openButton"]))
        reopened = self._wait_for(self._form)
        if self._read(self._resolve(reopened, self.profile["draftReference"]), self.profile["draftReferenceKind"]) != reference:
            raise CompanionError("A different draft reopened; no success was reported.")
        readback = {"headers": self._read_fields(reopened, self.profile["headers"]), "goods": []}
        if len(self._goods_rows()) != len(form["goods"]):
            raise CompanionError("Saved goods row count differs from the approved snapshot.")
        for index in range(len(form["goods"])):
            rows = self._goods_rows()
            self._guard()
            rows[index].iface_selection_item.Select()
            self._invoke(self._resolve(self._form(), goods["editButton"]))
            dialog = self._wait_for(self._dialog, dialog=True)
            readback["goods"].append(self._read_fields(dialog, goods["fields"], dialog=True))
            self._invoke(self._resolve(dialog, goods["closeButton"], dialog=True), dialog=True)
            self._wait(lambda: not dialog.is_visible(), dialog=True)
        self._guard()
        return reference, readback


def inspect_process(pid: int):
    """Read UIA identities only; does not focus, click, edit or invoke controls."""
    require_windows()
    from pywinauto import Desktop
    path = process_path(pid)
    count = 0
    def describe(control, depth=0):
        nonlocal count
        count += 1
        if count > 10000 or depth > 30:
            raise CompanionError("Inspection exceeded the bounded UI tree limit.")
        info = control.element_info
        return {"autoId": info.automation_id, "title": info.name, "controlType": info.control_type,
                "className": info.class_name, "visible": control.is_visible(), "enabled": control.is_enabled(),
                "children": [describe(child, depth + 1) for child in control.children()]}
    return {"process": {"executable": path, "fileVersion": file_version(path), "sha256": file_hash(path)},
            "windows": [describe(window) for window in Desktop(backend="uia").windows(process=pid)]}
