"""V4 evaluation engine entrypoint."""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from .decision_tree import evaluate
from .health import (
    DatabaseHealthResponse,
    ReadinessResponse,
    check_database,
    check_readiness,
)
from .schemas import EvaluateRequest, EvaluateResponse, HealthResponse

def validate_startup_configuration() -> None:
    if os.environ.get("V4_TEST_PROFILE", "false").lower() == "true":
        return
    if not os.environ.get("V4_INTERNAL_API_TOKEN", "").strip():
        raise RuntimeError("V4_INTERNAL_API_TOKEN is required outside the test profile")


@asynccontextmanager
async def lifespan(_: FastAPI):
    validate_startup_configuration()
    yield


app = FastAPI(
    title="flowstate-eval-engine-v4",
    version="0.1.0",
    lifespan=lifespan,
)


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
    """Compatibility alias: contract docs reference GET /ready."""
    return _ready_payload()


if os.environ.get("V4_TEST_PROFILE", "false").lower() == "true":
    @app.post("/evaluate", response_model=EvaluateResponse)
    def evaluate_property(request: EvaluateRequest) -> EvaluateResponse:
        try:
            return evaluate(request)
        except NotImplementedError as exc:
            raise HTTPException(status_code=501, detail=str(exc)) from exc
