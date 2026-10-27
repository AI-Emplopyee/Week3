from __future__ import annotations

import argparse
import getpass
import json
import sys
import time
from contextlib import closing
from pathlib import Path

from .core import CompanionError, Journal, deliver_result, parse_json, run_job, sync_recovery, validate_job, validate_profile
from .storage import InstanceLock, data_directory, journal_path, load_configuration, save_configuration
from .transport import HttpTransport
from .windows import NativeEcus, inspect_process


def read_profile(path: str):
    try:
        return parse_json(Path(path).read_text(encoding="utf-8"))
    except OSError as error:
        raise CompanionError("The installed-version profile could not be read.") from error


def confirm(payload: dict, profile_id: str, *, ask=False) -> bool:
    # JSON encoding prevents source text from becoming terminal escape commands.
    print("\nApproved export draft:")
    print("Shipment:", json.dumps(payload["reference"], ensure_ascii=False))
    print("Approved by:", json.dumps(payload["approvedBy"], ensure_ascii=False))
    print("Approved at:", payload["approvedAt"])
    print("Goods rows:", len(payload["form"]["goods"]))
    print("Installation profile:", profile_id)
    print("This creates and saves an editable EDA draft. It does not sign or transmit.")
    print("Close existing ECUS declaration editors. Do not use the mouse/keyboard during the transfer.")
    if not ask:
        print("Executing the employee-confirmed website submission.")
        return True
    return input("Test mode: type CREATE to create this approved draft, or press Enter to decline: ").strip() == "CREATE"


def poll(args):
    directory = data_directory()
    config = load_configuration(directory)
    transport = HttpTransport(config["baseUrl"], config["token"])
    journal = Journal(journal_path(directory, config))
    with closing(journal.connection), InstanceLock(directory / "session.lock"):
        while True:
            try:
                journal.recover_interrupted()
                # Delivery retries never operate ECUS, including after HTTP
                # acknowledgement loss following a successful database commit.
                for result in journal.pending():
                    try:
                        delivered = deliver_result(result, journal, transport)
                        print("Recorded result:", delivered["jobId"], delivered["status"])
                    except CompanionError as error:
                        # A reviewed decision may already exist on the website.
                        # Always attempt recovery sync before deciding readiness.
                        print("Result delivery pending:", str(error), file=sys.stderr)
                recovery_error = None
                try:
                    sync_recovery(journal, transport)
                except CompanionError as error:
                    recovery_error = str(error)
                ready, profile_id, reason = False, "", ""
                profile = read_profile(args.profile)
                try:
                    profile_id = validate_profile(profile)
                    if recovery_error:
                        raise CompanionError(recovery_error)
                    if journal.unresolved():
                        raise CompanionError("An interrupted/uncertain transfer needs review in the website recovery screen. Inspect ECUS and record its actual disposition there; never delete the local journal.")
                    if journal.acknowledgements():
                        raise CompanionError("The reviewed recovery is saved locally. Waiting for the website to acknowledge this computer's record before another transfer.")
                    if journal.pending():
                        raise CompanionError("A completed result is still waiting for website delivery. No new transfer will start yet.")
                    NativeEcus(profile).preflight()
                    ready = True
                except CompanionError as error:
                    reason = str(error)
                response = transport.post({"action": "poll", "ready": ready, "profileId": profile_id})
                job = response.get("job")
                if job:
                    if not ready:
                        raise CompanionError("The website returned a job although this computer was not ready.")
                    driver = NativeEcus(profile, job)
                    result = run_job(job, profile, driver, journal, transport,
                                     lambda payload, identity: confirm(payload, identity, ask=args.confirm_each_job))
                    print("Transfer:", result["jobId"], result["status"])
                    print(result["message"])
                elif reason:
                    print("Not ready:", reason)
                elif args.once:
                    print("Ready; no queued export draft.")
            except CompanionError as error:
                print(str(error), file=sys.stderr)
                if args.once:
                    return 1
            if args.once:
                return 0
            time.sleep(args.interval)


def main(argv=None):
    parser = argparse.ArgumentParser(description="AICD attended Windows ECUS export-draft companion")
    commands = parser.add_subparsers(dest="command", required=True)
    configure = commands.add_parser("configure", help="Store website origin and paired-device key using Windows DPAPI")
    configure.add_argument("--base-url", required=True)
    inspect = commands.add_parser("inspect", help="Read native control identities; no actions or edits")
    inspect.add_argument("--pid", type=int, required=True)
    inspect.add_argument("--output", required=True)
    validate = commands.add_parser("validate-profile", help="Validate calibrated selector/field coverage offline")
    validate.add_argument("--profile", required=True)
    validate.add_argument("--job", help="Optionally validate a downloaded job envelope and its exact values")
    poller = commands.add_parser("poll", help="Run one attended ECUS job at a time")
    poller.add_argument("--profile", required=True)
    poller.add_argument("--once", action="store_true")
    poller.add_argument("--confirm-each-job", action="store_true", help="Optional extra Windows confirmation for supervised calibration tests")
    poller.add_argument("--interval", type=float, default=5)
    commands.add_parser("status", help="Show local interrupted jobs without operating ECUS")
    args = parser.parse_args(argv)
    try:
        if args.command == "configure":
            directory = data_directory()
            with InstanceLock(directory / "session.lock"):
                save_configuration(directory, args.base_url, getpass.getpass("Paired computer key from website Settings: ").strip())
            print("Connection stored for this Windows user. The key is protected by Windows DPAPI.")
        elif args.command == "inspect":
            output = Path(args.output)
            if output.exists():
                raise CompanionError("Choose a new inspection output filename; existing files are preserved.")
            data = inspect_process(args.pid)
            output.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            print("Native control inventory saved. Treat it as potentially sensitive business data.")
        elif args.command == "validate-profile":
            profile = read_profile(args.profile)
            payload = validate_job(parse_json(Path(args.job).read_text(encoding="utf-8"))) if args.job else None
            print("Validated profile:", validate_profile(profile, payload))
            print("Structural validation is not a successful test on the installed ECUS application.")
        elif args.command == "poll":
            if not 5 <= args.interval <= 60:
                raise CompanionError("Poll interval must be between 5 and 60 seconds.")
            return poll(args)
        elif args.command == "status":
            directory = data_directory()
            config = load_configuration(directory)
            journal = Journal(journal_path(directory, config))
            with closing(journal.connection):
                print(json.dumps({"unresolved": journal.unresolved(), "pendingResults": len(journal.pending()),
                                  "pendingRecoveryAcknowledgements": journal.acknowledgements()}, indent=2))
        return 0
    except (CompanionError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Stopped. Any interrupted ECUS write remains in the journal for reconciliation.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
