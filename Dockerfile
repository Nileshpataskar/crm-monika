# One image with everything: the built Angular app is served by FastAPI.
# Data (database + uploaded Excel files) lives in /data, so mount a persistent disk there.

# ---- 1. Build the Angular app ----
FROM node:22-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npx ng build

# ---- 2. Python app: API + the built frontend ----
FROM python:3.12-slim
WORKDIR /app/backend
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY --from=frontend /frontend/dist/crm-admin/browser /app/frontend
RUN mkdir -p /data

ENV STATIC_DIR=/app/frontend \
    DATABASE_URL=sqlite:////data/crm.db \
    UPLOAD_DIR=/data/uploads \
    REQUIRE_SECRET_KEY=1 \
    PORT=8000
EXPOSE 8000
# Hosting platforms tell the app which port to use through $PORT.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
