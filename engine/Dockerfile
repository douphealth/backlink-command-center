FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml requirements.txt ./
COPY src ./src
RUN pip install --no-cache-dir .
COPY config ./config
RUN mkdir -p /app/state /app/output && chown -R 65534:65534 /app/state /app/output
USER 65534:65534
CMD ["python", "-m", "portfolio_pr.worker"]
