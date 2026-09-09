FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src

RUN groupadd --system flowstate && useradd --system --gid flowstate flowstate

WORKDIR /app
# requirements.txt is the AUTHORITATIVE hashed lock (see requirements.in for
# human-editable direct inputs). Installed with --require-hashes so any
# tampering or drift fails the build.
COPY bootstrap-requirements.txt requirements.txt ./
RUN python -m pip install --no-cache-dir --only-binary=:all: --require-hashes -r bootstrap-requirements.txt
RUN pip install --no-cache-dir --require-hashes -r requirements.txt
COPY --chown=flowstate:flowstate alembic.ini ./
COPY --chown=flowstate:flowstate alembic/ ./alembic/
COPY --chown=flowstate:flowstate src/ ./src/

USER flowstate
EXPOSE 8004
CMD ["uvicorn", "eval_engine.main:app", "--host", "0.0.0.0", "--port", "8004", "--app-dir", "src"]
