# Tactical Air Radar — контейнер сервісу.
FROM python:3.12-slim
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend ./backend
COPY frontend ./frontend

EXPOSE 8000
# Гео-база будується при першому старті (потребує мережі), далі кешується у volume.
CMD ["sh", "-c", "[ -f backend/data/geo.sqlite ] || python -m backend.build_geodb; exec uvicorn backend.server:app --host 0.0.0.0 --port 8000"]
