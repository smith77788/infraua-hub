/**
 * Перевірка `initData` з Telegram Mini App.
 *
 * Коли Mini App відкривається в Telegram, клієнт дає рядок initData, підписаний
 * ботовим токеном. Сервер, який має той самий токен, може перевірити підпис — і
 * тим самим переконатися, що запит справді прийшов від людини, яка відкрила
 * саме цього бота, а не підроблений хтось збоку.
 *
 * Це стандартний механізм автентифікації Mini App, і він рівно те, що потрібно
 * для кнопки «полагодити бота»: довести, що тисне власник, не питаючи в нього
 * жодного секрету — секрет уже вшитий у підпис, який лише сервер може звірити.
 *
 * Алгоритм (з документації Telegram):
 *   secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *   hash   = HMAC_SHA256(key=secret, msg=data_check_string)
 * де data_check_string — усі пари «ключ=значення», крім самого hash,
 * відсортовані за ключем і зʼєднані переносом рядка.
 */

export interface InitDataUser {
  id: number;
  firstName?: string;
  username?: string;
}

export interface InitDataResult {
  ok: boolean;
  reason?: string;
  user?: InitDataUser;
  authDate?: number;
}

async function hmacSha256(
  keyBytes: ArrayBuffer | Uint8Array,
  message: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Порівняння постійного часу: hex-рядок підпису не має підбиратися за таймінгом. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Перевіряє initData й повертає користувача, якщо підпис справжній.
 *
 * `maxAgeSeconds` відкидає старі initData: підписаний рядок, перехоплений
 * колись, не має працювати вічно. 24 години — запас на те, що вкладку тримають
 * відкритою, але не безмежний.
 */
/**
 * Строк для ДІЙ, а не для перегляду.
 *
 * Усталені 24 години — запас на відкриту вкладку, і для читання це доречно.
 * Але та сама перевірка боронить `/api/telegram/repair`, який перереєстровує
 * вебхук: там перехоплений підпис давав би добу адміністративного доступу.
 * Людина, що відкрила Mini App і натиснула «полагодити», робить це за хвилини,
 * тож п'ятнадцяти досить із запасом.
 */
export const ADMIN_INITDATA_MAX_AGE_SEC = 15 * 60;

export async function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 86_400,
  now = Date.now(),
): Promise<InitDataResult> {
  if (!initData || !botToken) return { ok: false, reason: "missing initData or token" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "no hash in initData" };

  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secret = await hmacSha256(new TextEncoder().encode("WebAppData"), botToken);
  const computed = toHex(await hmacSha256(secret, dataCheckString));
  if (!safeEqualHex(computed, hash.toLowerCase())) {
    return { ok: false, reason: "signature mismatch" };
  }

  const authDate = Number(params.get("auth_date") ?? 0);
  if (!authDate || now / 1000 - authDate > maxAgeSeconds) {
    return { ok: false, reason: "initData is stale" };
  }

  let user: InitDataUser | undefined;
  const userRaw = params.get("user");
  if (userRaw) {
    try {
      const parsed = JSON.parse(userRaw) as { id?: number; first_name?: string; username?: string };
      if (typeof parsed.id === "number") {
        user = {
          id: parsed.id,
          ...(parsed.first_name ? { firstName: parsed.first_name } : {}),
          ...(parsed.username ? { username: parsed.username } : {}),
        };
      }
    } catch {
      return { ok: false, reason: "malformed user field" };
    }
  }

  return { ok: true, ...(user ? { user } : {}), authDate };
}
