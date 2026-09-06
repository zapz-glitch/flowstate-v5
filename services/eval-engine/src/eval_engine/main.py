"""V4 evaluation engine entrypoint."""
import json
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from .api.deps import configured_credentials
from .api.errors import ApiFailure
from .api.routes import router as v1_router
from .decision_tree import evaluate
from .health import (
    DatabaseHealthResponse,
    ReadinessResponse,
    check_database,
    check_readiness,
)
from .persistence.repositories import IdempotencyConflict, LeaseMismatch, TerminalReplay
from .schemas import EvaluateRequest, EvaluateResponse, HealthResponse


def validate_startup_configuration() -> None:
    if os.environ.get("V4_TEST_PROFILE", "false").lower() == "true":
        return
    configured_credentials()


@asynccontextmanager
async def lifespan(_: FastAPI):
    validate_startup_configuration()
    yield


app = FastAPI(
    title="flowstate-eval-engine-v4",
    version="0.1.0",
    lifespan=lifespan,
)


@app.middleware("http")
async def _buffer_json_body(request: Request, call_next):
    if request.url.path.startswith("/v1/") and request.method == "POST":
        request.state.raw_body = await request.body()
    return await call_next(request)


def _typed(code: str, message: str, status: int):
    return JSONResponse(
        status_code=status,
        content={"code": code, "message": message, "section": "", "retriable": False},
    )


@app.exception_handler(ApiFailure)
async def _api_failure_handler(_: Request, exc: ApiFailure) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": exc.code, "message": exc.public_message, "section": exc.section, "retriable": exc.retriable},
    )


@app.exception_handler(IdempotencyConflict)
async def _idempotency_handler(_: Request, exc: IdempotencyConflict) -> JSONResponse:
    return _typed("IDEMPOTENCY_CONFLICT", "idempotency key reused with different payload", 409)


@app.exception_handler(LeaseMismatch)
async def _lease_handler(_: Request, exc: LeaseMismatch) -> JSONResponse:
    return _typed("LEASE_CONFLICT", "lease conflict", 409)


@app.exception_handler(TerminalReplay)
async def _replay_handler(_: Request, exc: TerminalReplay) -> JSONResponse:
    return _typed("DOMAIN_ERROR", "terminal result already committed", 409)


@app.exception_handler(RequestValidationError)
async def _request_validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    return _typed("VALIDATION_ERROR", "request validation failed", 422)


@app.exception_handler(ValidationError)
async def _pydantic_validation_handler(_: Request, exc: ValidationError) -> JSONResponse:
    return _typed("VALIDATION_ERROR", "request validation failed", 422)


@app.exception_handler(StarletteHTTPException)
async def _http_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    if request.url.path.startswith("/v1/") and exc.status_code == 400:
        try:
            body = await request.body()
            json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _typed("MALFORMED_JSON", "request body must be valid JSON", 400)
        return _typed("INVALID_SHAPE", "request body has an invalid shape", exc.status_code)
    return JSONResponse(status_code=exc.status_code, content={"detail": "request failed"})


@app.exception_handler(Exception)
async def _unexpected_handler(_: Request, exc: Exception) -> JSONResponse:
    return _typed("INTERNAL_ERROR", "request could not be completed", 500)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse()


@app.get("/health/db", response_model=DatabaseHealthResponse)
def health_db() -> JSONResponse:
    check = check_database()
    status_code = 200 if check.ok else 503
    payload = DatabaseHealthResponse(
        status="ok" if check.ok else "unavailable",
        database=check.label,
        detail=check.detail,
    )
    return JSONResponse(status_code=status_code, content=payload.model_dump())


def _ready_payload() -> JSONResponse:
    ready, checks = check_readiness()
    status_code = 200 if ready else 503
    payload = ReadinessResponse(
        status="ready" if ready else "not_ready",
        ready=ready,
        checks=checks,
    )
    return JSONResponse(status_code=status_code, content=payload.model_dump())


@app.get("/health/ready", response_model=ReadinessResponse)
def health_ready() -> JSONResponse:
    return _ready_payload()


@app.get("/ready", response_model=ReadinessResponse, include_in_schema=False)
def ready_alias() -> JSONResponse:
    return _ready_payload()


app.include_router(v1_router)


if os.environ.get("V4_TEST_PROFILE", "false").lower() == "true":
    @app.post("/evaluate", response_model=EvaluateResponse)
    def evaluate_property(request: EvaluateRequest) -> EvaluateResponse:
        try:
            return evaluate(request)
        except NotImplementedError as exc:
            raise HTTPException(status_code=501, detail=str(exc)) from exc
