import { useState } from "react";
import { Bot, Check, Loader2, X } from "lucide-react";

/*
 * Кнопка «полагодити бота» всередині Mini App.
 *
 * Причина існування: вебхук Telegram інколи губиться (редеплой, зміна секрету),
 * і бот тихо замовкає. Полагодити його ззовні можна лише знаючи секрет вебхука,
 * а його під рукою може не бути. Ця кнопка робить те саме без секрету: браузер
 * шле initData, який Telegram підписав ботовим токеном, а сервер звіряє підпис
 * тим самим токеном і лише тоді реєструє вебхук. Тисне власник — доводить це
 * підпис, а не наша довіра до клієнта.
 *
 * Показується лише всередині Telegram і лише коли initData є. Поза Telegram
 * кнопки немає — там і бота нема кому лагодити звідси.
 */

type State = { kind: "idle" } | { kind: "working" } | { kind: "done"; ok: boolean; text: string };

export default function BotRepair({ initData }: { initData: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });

  if (!initData) return null;

  const repair = async () => {
    setState({ kind: "working" });
    try {
      const res = await fetch("/api/telegram/repair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initData }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        reason?: string;
        telegram?: { pendingUpdates?: number; lastError?: string | null };
      } | null;
      if (res.ok && body?.ok) {
        const pending = body.telegram?.pendingUpdates ?? 0;
        setState({
          kind: "done",
          ok: true,
          text:
            "Вебхук зареєстровано. Бот має відповідати." +
            (pending ? ` У черзі було ${pending} — вони скинуті.` : ""),
        });
      } else {
        setState({ kind: "done", ok: false, text: body?.reason ?? `Помилка ${res.status}` });
      }
    } catch {
      setState({ kind: "done", ok: false, text: "Немає звʼязку з сервером." });
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Полагодити бота"
        aria-label="Полагодити бота"
        className="fixed bottom-3 right-3 z-[800] flex size-9 items-center justify-center rounded-full border border-border bg-background/90 text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
      >
        <Bot className="size-4" />
      </button>
    );
  }

  return (
    <div className="fixed bottom-3 right-3 z-[800] w-64 rounded-lg border border-border bg-background/95 p-3 backdrop-blur">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Бот
        </span>
        <button
          onClick={() => setOpen(false)}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
        Якщо бот не відповідає — перереєструвати вебхук. Підтверджується підписом Telegram, секрет
        не потрібен.
      </p>

      <button
        onClick={() => void repair()}
        disabled={state.kind === "working"}
        className="flex w-full items-center justify-center gap-1.5 rounded border border-border bg-card px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-foreground transition-colors hover:bg-card/70 disabled:opacity-50"
      >
        {state.kind === "working" ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Bot className="size-3" />
        )}
        {state.kind === "working" ? "Реєструю…" : "Полагодити бота"}
      </button>

      {state.kind === "done" ? (
        <p
          className={`mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed ${
            state.ok ? "text-emerald-400" : "text-destructive"
          }`}
        >
          {state.ok ? (
            <Check className="mt-0.5 size-3 shrink-0" />
          ) : (
            <X className="mt-0.5 size-3 shrink-0" />
          )}
          {state.text}
        </p>
      ) : null}
    </div>
  );
}
