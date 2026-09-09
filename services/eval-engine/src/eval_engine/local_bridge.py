"""Opt-in, database-free bridge for local V4 candidate testing."""

import hmac
import os
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .contracts.deal import EvaluationRequestV4, EvaluationResultV4
from .domain.evaluate import evaluate_v4

MAX_BODY_BYTES = 2_000_000


def configured_token() -> str:
    token = os.environ.get("V4_LOCAL_BRIDGE_TOKEN", "")
    if os.environ.get("V4_LOCAL_BRIDGE_ENABLED") != "true" or len(token) < 32:
        raise RuntimeError("Local bridge requires explicit enablement and a token of at least 32 characters")
    return token


@asynccontextmanager
async def lifespan(_: FastAPI):
    configured_token()
    yield


class BridgeResponse(BaseModel):
    engine: Literal["python-v4"] = "python-v4"
    result: EvaluationResultV4


app = FastAPI(title="Local Python V4 candidate", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "[::1]"])


@app.get("/health")
def health():
    configured_token()
    return {"status": "ok", "engine": "python-v4", "profile": "local-evidence-bridge"}


@app.post("/evaluate", response_model=BridgeResponse)
async def evaluate(request: Request):
    try:
        token = configured_token()
    except RuntimeError as exc:
        raise HTTPException(503, "Local bridge is disabled") from exc
    supplied = request.headers.get("authorization", "")
    if not hmac.compare_digest(supplied.encode(), f"Bearer {token}".encode()):
        raise HTTPException(401, "Invalid bridge credentials")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_BODY_BYTES:
            raise HTTPException(413, "Evaluation evidence is too large")
    try:
        evidence = EvaluationRequestV4.model_validate_json(body)
    except ValidationError as exc:
        fields = [{"path": ".".join(str(part) for part in error["loc"]), "message": error["msg"]}
                  for error in exc.errors(include_input=False, include_context=False)[:10]]
        raise HTTPException(422, {"message": "Invalid V4 evidence contract", "fields": fields}) from exc
    if len(evidence.comps) > 500 or evidence.evaluation_date is None:
        raise HTTPException(422, "Evaluation date and at most 500 comparables are required")
    try:
        result = evaluate_v4(evidence)
    except (ValueError, ArithmeticError) as exc:
        raise HTTPException(422, "V4 rules could not evaluate the supplied settings") from exc
    return BridgeResponse(result=result)
