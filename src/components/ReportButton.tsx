import { Flag } from "lucide-react";
import { useState } from "react";

import type { Threat } from "@/lib/air";
import { REPORT_REASONS, type ReportReason } from "@/lib/map-reports";

/**
 * «Тут неправильно» в картці цілі (опитувальник 01.11). Скарга несе знімок
 * цілі — тип, джерела, курс, час — і йде власнику в Telegram, тож помилку
 * можна знайти без скриншота й здогадок.
 */
const REASONS: ReportReason[] = ["type", "duplicate", "ghost", "course", "place", "other"];

export default function ReportButton({ t }: { t: Threat }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const send = async (reason: ReportReason) => {
    setState("sending");
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason,
          target: {
            id: t.id,
            name: t.name,
            type: t.type ?? "unknown",
            lat: t.lat,
            lon: t.lon,
            heading: typeof t.heading === "number" ? t.heading : null,
            source: t.source,
            sources: t.sources ?? [],
            lastSeen: t.lastSeen ?? t.since,
            typeFromChannels: t.typeFromChannels === true,
          },
        }),
      });
      setState(res.ok ? "sent" : "error");
    } catch {
      setState("error");
    }
  };

  if (state === "sent") return <p className="pt-1 text-emerald-400">Дякуємо, скаргу передано.</p>;

  return (
    <div className="border-t border-current/15 pt-1.5">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-1 text-[11px] opacity-70 hover:opacity-100"
        >
          <Flag className="size-3" /> Тут неправильно
        </button>
      ) : (
        <div className="space-y-1">
          <p className="text-[11px] opacity-70">Що саме не так?</p>
          <div className="flex flex-wrap gap-1">
            {REASONS.map((r) => (
              <button
                key={r}
                type="button"
                disabled={state === "sending"}
                onClick={() => void send(r)}
                className="rounded border border-current/25 px-1.5 py-0.5 text-[11px] hover:bg-white/10 disabled:opacity-50"
              >
                {REPORT_REASONS[r]}
              </button>
            ))}
          </div>
          {state === "error" ? (
            <p className="text-[11px] text-red-400">Не вдалося надіслати. Спробуйте ще раз.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
