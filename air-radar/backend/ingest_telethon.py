"""Інжест сирих повідомлень із публічних Telegram-каналів через Telethon.

Продакшн-джерело з повним NLP-конвеєром: слухає задані канали, проганяє кожне
нове повідомлення через екстрактор/геокодер і публікує тактичні обʼєкти.

Потребує TG_API_ID / TG_API_HASH (див. .env). Якщо їх немає — інжест не
стартує (HUMAN ACTION: отримати ключі на https://my.telegram.org).
"""

from __future__ import annotations

import logging

from .config import settings
from .geocode import GeoDB
from .pipeline import build_from_message

log = logging.getLogger("telethon-ingest")


async def run_telethon(broadcaster, geo: GeoDB) -> None:
    if not settings.telethon_ready:
        log.warning("Telethon пропущено: немає TG_API_ID/TG_API_HASH (HUMAN ACTION).")
        return
    try:
        from telethon import TelegramClient, events
        from telethon.sessions import StringSession
    except ImportError:
        log.error("Не встановлено telethon. Додайте його до requirements та встановіть.")
        return

    session = StringSession(settings.tg_session) if len(settings.tg_session) > 40 else settings.tg_session
    client = TelegramClient(session, settings.tg_api_id, settings.tg_api_hash)

    @client.on(events.NewMessage(chats=settings.tg_channels))
    async def handler(event):  # noqa: ANN001
        text = event.raw_text or ""
        if not text.strip():
            return
        channel = getattr(event.chat, "username", None) or str(getattr(event, "chat_id", ""))
        obj = build_from_message(text, geo, source="telegram", channel=channel)
        await broadcaster.log(
            {
                "channel": channel,
                "text": text[:280],
                "confidence": obj.confidence if obj else 0.0,
                "tokens": (obj.raw and []) or [],
                "source": "telegram",
            }
        )
        if obj is not None:
            await broadcaster.upsert(obj)

    log.info("Telethon інжест запущено: канали=%s", settings.tg_channels)
    await client.start()
    await client.run_until_disconnected()
