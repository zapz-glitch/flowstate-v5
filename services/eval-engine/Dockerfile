FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN groupadd --system flowstate && useradd --system --gid flowstate flowstate

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY --chown=flowstate:flowstate src/ ./src/

USER flowstate
EXPOSE 8004
CMD ["uvicorn", "eval_engine.main:app", "--host", "0.0.0.0", "--port", "8004", "--app-dir", "src"]
