"""Bounded HTTPS transport; redirects never receive the paired-device key."""
from __future__ import annotations

import re
import urllib.error
import urllib.parse
import urllib.request

from .core import CompanionError, canonical, parse_json


def validate_base_url(value: str) -> str:
    parts = urllib.parse.urlsplit(value)
    if (parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password
            or parts.query or parts.fragment or parts.path not in ("", "/")):
        raise CompanionError("Use the application's HTTPS origin without a path, credentials or query.")
    if parts.scheme == "http" and parts.hostname not in ("127.0.0.1", "localhost"):
        raise CompanionError("Plain HTTP is allowed only for the app on this Windows PC's loopback address.")
    try:
        parts.port
    except ValueError as error:
        raise CompanionError("Invalid application port.") from error
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, "", "", ""))


def validate_token(token: str) -> str:
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,160}\.[A-Za-z0-9_-]{16,512}", token):
        raise CompanionError("Paste the complete paired computer key from website Settings.")
    return token


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise CompanionError("The companion endpoint redirected the request. Check the configured origin; no redirect was followed.")


class HttpTransport:
    def __init__(self, base_url: str, token: str):
        self.base_url = validate_base_url(base_url)
        self.token = validate_token(token)
        # Disable environment proxies for local Windows loopback. HTTPS retains
        # the normal OS/Python proxy configuration and certificate verification.
        handlers = [NoRedirects()]
        if urllib.parse.urlsplit(base_url).scheme == "http":
            handlers.append(urllib.request.ProxyHandler({}))
        self.opener = urllib.request.build_opener(*handlers)

    def post(self, body: dict) -> dict:
        data = canonical(body).encode("utf-8")
        if len(data) > 2 * 1024 * 1024:
            raise CompanionError("The companion request exceeds its bounded size limit.")
        request = urllib.request.Request(self.base_url + "/api/ecus/companion", data=data, method="POST",
                                        headers={"Authorization": "Bearer " + self.token,
                                                 "Content-Type": "application/json", "Accept": "application/json"})
        try:
            with self.opener.open(request, timeout=20) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise CompanionError("The website returned an oversized response.")
                value = parse_json(raw.decode("utf-8"))
                if not isinstance(value, dict):
                    raise CompanionError("The website returned an invalid response.")
                return value
        except urllib.error.HTTPError as error:
            # Never echo server HTML, auth headers, response bodies, or keys.
            raise CompanionError(f"Website rejected the companion request (HTTP {error.code}). Saved results remain in the local journal.") from error
        except (urllib.error.URLError, TimeoutError, OSError, UnicodeError) as error:
            raise CompanionError("The website could not be reached. Saved results remain in the local journal; ECUS operations will not be replayed.") from error
