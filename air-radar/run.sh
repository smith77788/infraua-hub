#!/usr/bin/env bash
# Ініціалізація та запуск тактичного радара.
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"

if [ ! -d .venv ]; then
  echo "[run] Створюю venv…"
  "$PYTHON" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

echo "[run] Встановлюю залежності…"
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

if [ ! -f backend/data/geo.sqlite ]; then
  echo "[run] Будую гео-базу (GeoNames UA)…"
  python -m backend.build_geodb
fi

[ -f .env ] || { cp .env.example .env; echo "[run] Створено .env з прикладу (за потреби додайте ключі Telegram)."; }

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
echo "[run] Старт: http://${HOST}:${PORT}"
exec python -m uvicorn backend.server:app --host "$HOST" --port "$PORT"
