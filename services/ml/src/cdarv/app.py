"""CDARV service entrypoint: `uvicorn cdarv.app:app`.

A dedicated process — never mounted inside eval-engine — so CDARV
availability can never affect production underwriting. All routes require
the internal bearer token; the only caller is the apps/api /cdarv/* proxy.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .api.deps import configured_token_hash
from .api.errors import ApiFailure
from .api.routes import router


def validate_startup_configuration() -> None:
    if os.environ.get("CDARV_TEST_PROFILE", "false").lower() == "true":
        return
    configured_token_hash()
    # DATABASE_URL is validated lazily on first session so /health still
    # answers when the DB is down.


@asynccontextmanager
async def lifespan(_: FastAPI):
    validate_startup_configuration()
    yield


app = FastAPI(title="flowstate-cdarv", version="0.1.0", lifespan=lifespan)


@app.exception_handler(ApiFailure)
async def _api_failure(_: Request, exc: ApiFailure):
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": exc.code, "message": exc.public_message,
                 "retriable": exc.retriable},
    )


@app.get("/health")
def health():
    return {"status": "ok", "service": "cdarv"}


app.include_router(router)


__all__ = ["app"]
