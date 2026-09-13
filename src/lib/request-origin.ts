/**
 * Публічний origin запиту за TLS-термінуючим проксі.
 *
 * Railway (і будь-який подібний edge) завершує TLS у себе й передає запит углиб
 * як http:// із внутрішнім хостом. Тому `new URL(request.url)` бачить не ту
 * адресу, під якою сервіс доступний ззовні. Публічну знають лише forwarded-
 * заголовки, які ставить сам проксі.
 *
 * Це важить не косметично: на цьому будується адреса вебхука Telegram. Без
 * forwarded-заголовків вебхук реєструвався б на http://внутрішній-хост, і
 * Telegram його відхиляв би — саме це тримало бота німим.
 */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}
