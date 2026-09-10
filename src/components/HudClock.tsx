import { useEffect, useState } from "react";

/** Живий годинник: місцевий + UTC, у стилі шапки консолі. Рендерити всередині
 * <ClientOnly>, щоб уникнути розбіжності гідратації. */
export default function HudClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const local = now.toLocaleTimeString("uk-UA", { hour12: false });
  const utc = now.toISOString().slice(11, 19);

  return (
    <span className="hidden items-center gap-1.5 font-mono text-[10px] tabular-nums text-muted-foreground md:flex">
      <span className="text-foreground">{local}</span>
      <span className="opacity-50">лок.</span>
      <span className="opacity-40">/</span>
      <span>{utc}</span>
      <span className="opacity-50">UTC</span>
    </span>
  );
}
