"""Database-free request boundary checks, including chunked ASGI input."""
import asyncio
import hashlib
import json

import pytest
from fastapi import FastAPI, Request

from eval_engine.main import MAX_REQUEST_BODY_BYTES, _buffer_json_body


@pytest.fixture
def boundary(monkeypatch):
    monkeypatch.setenv("V4_API_CREDENTIALS", json.dumps([{
        "tenant_id": "test-tenant", "user_id": "test-user",
        "token_sha256": hashlib.sha256(b"boundary-test-token").hexdigest(),
    }]))
    application = FastAPI()
    application.middleware("http")(_buffer_json_body)

    @application.post("/v1/probe")
    async def probe(request: Request):
        body = await request.body()
        assert body == request.state.raw_body
        return {"sha256": hashlib.sha256(body).hexdigest(), "size": len(body)}

    def invoke(chunks, *, authorization="Bearer boundary-test-token", length=None):
        headers = []
        if authorization is not None:
            headers.append((b"authorization", authorization.encode()))
        if length is not None:
            headers.append((b"content-length", str(length).encode()))
        scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
                 "http_version": "1.1", "method": "POST", "scheme": "http",
                 "path": "/v1/probe", "raw_path": b"/v1/probe", "query_string": b"",
                 "headers": headers, "server": ("test", 80), "client": ("test", 1)}
        messages = []
        consumed = 0

        async def receive():
            nonlocal consumed
            assert consumed < len(chunks), "unexpected extra body read"
            chunk = chunks[consumed]
            consumed += 1
            return {"type": "http.request", "body": chunk,
                    "more_body": consumed < len(chunks)}

        async def send(message):
            messages.append(message)

        asyncio.run(application(scope, receive, send))
        status = next(m["status"] for m in messages if m["type"] == "http.response.start")
        body = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
        return status, json.loads(body), consumed

    return invoke


@pytest.mark.parametrize("authorization", [None, "Basic wrong", "Bearer invalid-token"])
def test_rejects_auth_without_reading_body(boundary, authorization):
    status, _, consumed = boundary([], authorization=authorization)
    assert status == 401
    assert consumed == 0


@pytest.mark.parametrize("length", [MAX_REQUEST_BODY_BYTES + 1, "9" * 5000])
def test_declared_oversize_rejected_without_reading(boundary, length):
    status, _, consumed = boundary([], length=length)
    assert status == 413
    assert consumed == 0


@pytest.mark.parametrize("length", [None, 1])
def test_stream_limit_catches_missing_or_lying_length(boundary, length):
    status, _, consumed = boundary([b"x" * MAX_REQUEST_BODY_BYTES, b"x", b"unread"], length=length)
    assert status == 413
    assert consumed == 2


@pytest.mark.parametrize("length", ["-1", "abc", "1,2", ""])
def test_invalid_length_rejected(boundary, length):
    status, _, consumed = boundary([], length=length)
    assert status == 400
    assert consumed == 0


def test_exact_limit_allowed_and_raw_bytes_preserved(boundary):
    body = b" " * (MAX_REQUEST_BODY_BYTES - 2) + b"{}"
    status, result, _ = boundary([body[:100], body[100:]], length=len(body))
    assert status == 200
    assert result == {"sha256": hashlib.sha256(body).hexdigest(), "size": len(body)}


def test_unmodified_json_whitespace_and_unicode(boundary):
    body = ' { "city": "Montréal" }\n'.encode()
    status, result, _ = boundary([body[:3], body[3:]])
    assert status == 200
    assert result["sha256"] == hashlib.sha256(body).hexdigest()
