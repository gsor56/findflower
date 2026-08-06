FROM python:3.11-slim

WORKDIR /app

# HF cache must be writable and inside the container.
ENV HF_HOME=/app/.cache \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py class_names.json ./

# Render injects $PORT. Shell form so $PORT expands.
# Single worker: the ONNX session is ~250MB, two would exceed the 512MB tier.
EXPOSE 7860
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT:-7860} --workers 1
