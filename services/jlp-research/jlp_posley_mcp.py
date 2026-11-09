"""Read the JLP accounts over Posley MCP's authenticated HTTP transport."""

from contextlib import closing
from http.client import HTTPException, HTTPSConnection
from http.cookies import CookieError, SimpleCookie
import json
from time import monotonic


HOST = "mcp.posley.capital"
PATH = "/mcp"
PROTOCOL_VERSION = "2025-03-26"
REQUEST_TIMEOUT_SECONDS = 8
MAX_RESPONSE_BYTES = 256 * 1024
AFFINITY_COOKIES = ("AWSALB", "AWSALBCORS")


class PosleyMcpError(RuntimeError):
    """A safe error suitable for the dashboard service log."""


class _SessionExpired(PosleyMcpError):
    pass


def _decode_json(raw):
    try:
        return json.loads(raw)
    except (ValueError, RecursionError):
        raise PosleyMcpError("Posley MCP returned invalid JSON") from None


def _read_reply(response, request_id, deadline):
    content_type = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
    if content_type == "application/json":
        body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise PosleyMcpError("Posley MCP response exceeds the size limit")
        reply = _decode_json(body)
        if isinstance(reply, dict) and reply.get("id") == request_id:
            return reply
    elif content_type == "text/event-stream":
        remaining = MAX_RESPONSE_BYTES
        event_data = []
        while remaining and monotonic() < deadline:
            line = response.readline(remaining + 1)
            if not line:
                break
            remaining -= len(line)
            if remaining < 0:
                raise PosleyMcpError("Posley MCP response exceeds the size limit")
            line = line.rstrip(b"\r\n")
            if not line:
                if event_data:
                    reply = _decode_json(b"\n".join(event_data))
                    if isinstance(reply, dict) and reply.get("id") == request_id:
                        return reply
                    event_data.clear()
            elif line.startswith(b"data:"):
                event_data.append(line[5:].removeprefix(b" "))
        if not remaining:
            raise PosleyMcpError("Posley MCP response exceeds the size limit")
    else:
        raise PosleyMcpError("Posley MCP returned an unexpected content type")
    raise PosleyMcpError("Posley MCP did not return the requested reply")


class PosleyMcpClient:
    """One sequential client session, scoped by the server's read-only key."""

    def __init__(self, api_key):
        if not isinstance(api_key, str):
            raise PosleyMcpError("Posley MCP service key is invalid")
        self._api_key = api_key.strip()
        if not self._api_key or len(self._api_key) > 1024 or not all(
            33 <= ord(character) <= 126 for character in self._api_key
        ):
            raise PosleyMcpError("Posley MCP service key is invalid")
        self._request_id = 0
        self._reset()

    def _reset(self):
        self._initialized = False
        self._session_id = None
        self._cookies = {}

    def _remember_affinity(self, response):
        for name, value in response.getheaders():
            if name.lower() != "set-cookie":
                continue
            cookie = SimpleCookie()
            try:
                cookie.load(value)
            except CookieError:
                continue
            for name in AFFINITY_COOKIES:
                if name in cookie:
                    self._cookies[name] = cookie[name].coded_value

    def _post(self, message):
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        }
        if message["method"] != "initialize":
            headers["MCP-Protocol-Version"] = PROTOCOL_VERSION
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        if self._cookies:
            headers["Cookie"] = "; ".join(f"{name}={value}" for name, value in self._cookies.items())

        deadline = monotonic() + REQUEST_TIMEOUT_SECONDS
        try:
            with closing(HTTPSConnection(HOST, timeout=REQUEST_TIMEOUT_SECONDS)) as connection:
                connection.request("POST", PATH, json.dumps(message), headers)
                with closing(connection.getresponse()) as response:
                    if response.status == 404 and self._session_id:
                        raise _SessionExpired("Posley MCP session expired")
                    if not 200 <= response.status < 300:
                        raise PosleyMcpError(f"Posley MCP HTTP {response.status}")
                    self._remember_affinity(response)
                    if "id" not in message:
                        return None
                    reply = _read_reply(response, message["id"], deadline)
                    if reply.get("jsonrpc") != "2.0" or "error" in reply or "result" not in reply:
                        raise PosleyMcpError("Posley MCP returned a JSON-RPC error")
                    if message["method"] == "initialize":
                        session_id = response.getheader("Mcp-Session-Id")
                        if session_id and (
                            len(session_id) > 256 or not all(33 <= ord(c) <= 126 for c in session_id)
                        ):
                            raise PosleyMcpError("Posley MCP returned an invalid session ID")
                        self._session_id = session_id
                    return reply["result"]
        except (OSError, HTTPException, ValueError):
            raise PosleyMcpError("Posley MCP transport failed") from None

    def _rpc(self, method, params):
        self._request_id += 1
        return self._post({
            "jsonrpc": "2.0",
            "id": self._request_id,
            "method": method,
            "params": params,
        })

    def _initialize(self):
        self._reset()
        reply = self._rpc("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "tradfi-jlp-render", "version": "1.0"},
        })
        if not isinstance(reply, dict) or reply.get("protocolVersion") != PROTOCOL_VERSION:
            raise PosleyMcpError("Posley MCP protocol negotiation failed")
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self._initialized = True

    def account_positions(self, account_id):
        if type(account_id) is not int or account_id <= 0:
            raise PosleyMcpError("Posley MCP account ID is invalid")
        for attempt in range(2):
            try:
                if not self._initialized:
                    self._initialize()
                reply = self._rpc("tools/call", {
                    "name": "get_account_positions",
                    "arguments": {"accountId": account_id, "includeFreshness": True, "format": "json"},
                })
            except _SessionExpired:
                self._reset()
                if attempt:
                    raise PosleyMcpError("Posley MCP session expired after reconnecting") from None
                continue
            break

        if not isinstance(reply, dict) or reply.get("isError"):
            raise PosleyMcpError("Posley MCP position lookup failed")
        content = reply.get("content")
        if not isinstance(content, list) or len(content) != 1 or not isinstance(content[0], dict):
            raise PosleyMcpError("Posley MCP position response is incomplete")
        entry = content[0]
        if entry.get("type") != "text" or not isinstance(entry.get("text"), str):
            raise PosleyMcpError("Posley MCP position response is incomplete")
        envelope = _decode_json(entry["text"])
        if not isinstance(envelope, dict) or not isinstance(envelope.get("meta"), dict) or not isinstance(envelope.get("rows"), list):
            raise PosleyMcpError("Posley MCP position response is incomplete")
        return envelope
