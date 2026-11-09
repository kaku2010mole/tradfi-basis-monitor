"""Verify the Posley MCP wire protocol without sending network requests."""

from io import BytesIO
import json
import unittest
from unittest.mock import patch

from jlp_posley_mcp import (
    MAX_RESPONSE_BYTES,
    PROTOCOL_VERSION,
    REQUEST_TIMEOUT_SECONDS,
    PosleyMcpClient,
    PosleyMcpError,
)


FIXTURE_KEY = "pmcp_live_example_fake"
POSITIONS = {"meta": {"freshnessStatus": "fresh"}, "rows": [{"symbol": "JLP"}]}


class Response(BytesIO):
    def __init__(self, status=200, body=b"", headers=()):
        super().__init__(body)
        self.status = status
        self.headers = headers

    def getheaders(self):
        return self.headers

    def getheader(self, key, default=None):
        return next((value for name, value in self.headers if name.lower() == key.lower()), default)


def json_response(request_id, result, headers=()):
    body = json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}).encode()
    return Response(body=body, headers=(("Content-Type", "application/json; charset=utf-8"), *headers))


def initialize_response(request_id=1, session="fixture-session", cookie="fixture-affinity"):
    return json_response(request_id, {"protocolVersion": PROTOCOL_VERSION}, (
        ("Mcp-Session-Id", session),
        ("Set-Cookie", f"AWSALB={cookie}; Secure; HttpOnly"),
        ("Set-Cookie", "AWSALBCORS=fixture-cors; Secure"),
        ("Set-Cookie", "unknown=ignore"),
    ))


def positions_response(request_id, *, sse=False):
    result = {"content": [{"type": "text", "text": json.dumps(POSITIONS)}]}
    if not sse:
        return json_response(request_id, result)
    body = json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result})
    return Response(body=(
        ': heartbeat\r\n\r\n'
        'data: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\n'
        f"event: message\r\ndata: {body}\r\n\r\n"
    ).encode(), headers=(("Content-Type", "text/event-stream"),))


class PosleyMcpTests(unittest.TestCase):
    def setUp(self):
        connection = patch("jlp_posley_mcp.HTTPSConnection")
        self.connect = connection.start()
        self.addCleanup(connection.stop)
        self.http = self.connect.return_value
        self.client = PosleyMcpClient(FIXTURE_KEY)

    def requests(self):
        requests = []
        for call in self.http.request.call_args_list:
            verb, path, body, headers = call.args
            self.assertEqual((verb, path), ("POST", "/mcp"))
            self.assertEqual(headers["Authorization"], f"Bearer {FIXTURE_KEY}")
            self.assertEqual(headers["Accept"], "application/json, text/event-stream")
            requests.append((json.loads(body), headers))
        return requests

    def test_initialization_and_reused_session_accept_json_and_sse(self):
        self.http.getresponse.side_effect = [
            initialize_response(), Response(status=202),
            positions_response(2), positions_response(3, sse=True),
        ]
        self.assertEqual(self.client.account_positions(1), POSITIONS)
        self.assertEqual(self.client.account_positions(2), POSITIONS)
        self.connect.assert_called_with("mcp.posley.capital", timeout=REQUEST_TIMEOUT_SECONDS)
        init, notify, first, second = self.requests()
        self.assertEqual(init[0]["method"], "initialize")
        self.assertEqual(init[0]["params"]["protocolVersion"], PROTOCOL_VERSION)
        self.assertNotIn("Mcp-Session-Id", init[1])
        self.assertEqual(notify[0], {"jsonrpc": "2.0", "method": "notifications/initialized"})
        for account_id, call in enumerate((first, second), 1):
            self.assertEqual(call[0]["method"], "tools/call")
            self.assertEqual(call[0]["params"], {
                "name": "get_account_positions",
                "arguments": {"accountId": account_id, "includeFreshness": True, "format": "json"},
            })
        for _, headers in (notify, first, second):
            self.assertEqual(headers["Mcp-Session-Id"], "fixture-session")
            self.assertEqual(headers["MCP-Protocol-Version"], PROTOCOL_VERSION)
            self.assertEqual(headers["Cookie"], "AWSALB=fixture-affinity; AWSALBCORS=fixture-cors")

    def test_404_reinitializes_once_and_drops_expired_affinity(self):
        self.http.getresponse.side_effect = [
            initialize_response(), Response(status=202), Response(status=404),
            initialize_response(3, "new-session", "new-affinity"), Response(status=202),
            positions_response(4, sse=True),
        ]
        self.assertEqual(self.client.account_positions(1), POSITIONS)
        calls = self.requests()
        self.assertEqual([message["method"] for message, _ in calls], [
            "initialize", "notifications/initialized", "tools/call",
            "initialize", "notifications/initialized", "tools/call",
        ])
        self.assertNotIn("Mcp-Session-Id", calls[3][1])
        self.assertNotIn("Cookie", calls[3][1])
        self.assertEqual(calls[-1][1]["Mcp-Session-Id"], "new-session")
        self.assertIn("AWSALB=new-affinity", calls[-1][1]["Cookie"])

    def test_transport_and_tool_failures_do_not_echo_private_data(self):
        self.http.getresponse.side_effect = TimeoutError(f"private {FIXTURE_KEY}")
        with self.assertRaisesRegex(PosleyMcpError, "^Posley MCP transport failed$"):
            self.client.account_positions(1)

        self.http.getresponse.side_effect = [
            initialize_response(2), Response(status=202),
            json_response(3, {"isError": True, "content": [{"type": "text", "text": FIXTURE_KEY}]}),
        ]
        with self.assertRaisesRegex(PosleyMcpError, "^Posley MCP position lookup failed$"):
            self.client.account_positions(1)

    def test_oversize_or_unmatched_reply_is_rejected(self):
        self.http.getresponse.side_effect = [
            initialize_response(), Response(status=202),
            Response(body=b"x" * (MAX_RESPONSE_BYTES + 1), headers=(("Content-Type", "application/json"),)),
            positions_response(9, sse=True),
        ]
        with self.assertRaisesRegex(PosleyMcpError, "size limit"):
            self.client.account_positions(1)
        with self.assertRaisesRegex(PosleyMcpError, "did not return the requested reply"):
            self.client.account_positions(1)

    def test_invalid_account_id_never_opens_connection(self):
        with self.assertRaisesRegex(PosleyMcpError, "invalid"):
            self.client.account_positions(True)
        self.connect.assert_not_called()
