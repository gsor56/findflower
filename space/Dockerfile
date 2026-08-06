FROM python:3.11-slim

WORKDIR /app

# HF Spaces run as a non-root user; keep caches writable.
ENV HF_HOME=/app/.cache \
    TRANSFORMERS_CACHE=/app/.cache \
    PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Render injects $PORT; default to 7860 for local/HF use. Shell form so $PORT expands.
EXPOSE 7860
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT:-7860}
