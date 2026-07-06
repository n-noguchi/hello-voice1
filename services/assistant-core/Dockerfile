FROM python:3.11-slim

ARG INSTALL_STT=1

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    PYTHONIOENCODING=utf-8

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY assistant_core ./assistant_core

RUN python -m pip install --upgrade pip \
    && if [ "$INSTALL_STT" = "1" ]; then \
         python -m pip install --no-cache-dir ".[stt]"; \
       else \
         python -m pip install --no-cache-dir .; \
       fi

EXPOSE 8000

CMD ["uvicorn", "assistant_core.main:app", "--host", "0.0.0.0", "--port", "8000"]
