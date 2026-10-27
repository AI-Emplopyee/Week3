"""Per-Windows-user DPAPI credentials and an OS-released single-instance lock."""
from __future__ import annotations

import base64
import ctypes
import hashlib
import os
from pathlib import Path

from .core import CompanionError, canonical, parse_json
from .transport import validate_base_url, validate_token
from .windows import require_windows


def data_directory() -> Path:
    require_windows()
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        raise CompanionError("Windows LOCALAPPDATA is unavailable.")
    directory = Path(local) / "AICD" / "EcusCompanion"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def dpapi(data: bytes, *, decrypt=False) -> bytes:
    require_windows()
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]
    array = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source = Blob(len(data), array)
    output = Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    if decrypt:
        function = crypt.CryptUnprotectData
        function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                             ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
        arguments = (ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output))
    else:
        function = crypt.CryptProtectData
        function.argtypes = [ctypes.POINTER(Blob), wintypes.LPCWSTR, ctypes.c_void_p, ctypes.c_void_p,
                             ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
        arguments = (ctypes.byref(source), "AICD ECUS paired device", None, None, None, 1, ctypes.byref(output))
    function.restype = wintypes.BOOL
    if not function(*arguments):
        raise CompanionError("Windows could not unlock/store this user's paired-device key.")
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        kernel.LocalFree(output.pbData)


def save_configuration(directory: Path, base_url: str, token: str):
    # Origin and key are encrypted together so moving/editing a config cannot
    # redirect an existing key to a different server.
    body = canonical({"baseUrl": validate_base_url(base_url), "token": validate_token(token)}).encode("utf-8")
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "connection.dpapi"
    temporary = directory / "connection.dpapi.tmp"
    with open(temporary, "wb") as target:
        target.write(dpapi(body))
        target.flush()
        os.fsync(target.fileno())
    os.replace(temporary, path)


def load_configuration(directory: Path) -> dict:
    try:
        encrypted = (directory / "connection.dpapi").read_bytes()
        if len(encrypted) > 16384:
            raise CompanionError("The paired-device configuration is invalid.")
        config = parse_json(dpapi(encrypted, decrypt=True).decode("utf-8"))
        validate_base_url(config["baseUrl"])
        validate_token(config["token"])
        return config
    except (OSError, KeyError, TypeError, UnicodeError) as error:
        raise CompanionError("Run configure under this Windows account before polling.") from error


def journal_path(directory: Path, config: dict) -> Path:
    identity = config["baseUrl"] + "\n" + config["token"].split(".", 1)[0]
    return directory / ("journal-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24] + ".sqlite3")


class InstanceLock:
    """Lock released by the OS on crash; covers all configured devices locally."""
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.file = open(path, "a+b")

    def __enter__(self):
        self.file.seek(0)
        if not self.file.read(1):
            self.file.write(b"1")
            self.file.flush()
        self.file.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            self.file.close()
            raise CompanionError("Another ECUS companion process is already active.") from error
        return self

    def __exit__(self, *_):
        if os.name == "nt":
            import msvcrt
            self.file.seek(0)
            msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
        self.file.close()
