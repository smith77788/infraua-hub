import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FolderOpen, Loader2, Pin, Plus, StickyNote } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  isPinned,
  summarizeCase,
  TITLE_MAX,
  validateNote,
  validateTitle,
  type AnalystCase,
} from "@/lib/cases";
import { addCaseNote, createCase, listCases, pinToCase } from "@/lib/cases.functions";
import type { Facility } from "@/lib/infra-types";

/*
 * Справи в консолі: місце, куди можна покласти знахідку.
 *
 * До цього робота аналітика зникала при перезавантаженні сторінки — він
 * знаходив вузол, розбирав його критичність, моделював відмову, і не мав куди
 * це подіти. Знахідка, яку нікуди подіти, дорівнює її відсутності.
 *
 * Панель свідомо мала: перелік справ, створення, нотатка й «приколоти обʼєкт».
 * Усе решта — рівні доступу, відсіки, журнал аудиту — робить платформа, і
 * дублювати це тут означало б завести другу версію правди.
 *
 * Коли звʼязку з платформою немає, панель не показує помилку: консоль
 * самодостатня, і ненастроєні справи — штатний стан, а не поломка.
 */

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("uk-UA", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export default function CasePanel({
  facility,
  knownEntities,
  onOpenFacility,
}: {
  /** Обʼєкт, відкритий в інспекторі, — його й пропонуємо приколоти. */
  facility?: Facility | undefined;
  /**
   * Ідентифікатор платформи → обʼєкт консолі, для тих приколотих, що зараз
   * завантажені. Справа переживає сеанс, а завантажений набір обʼєктів — ні,
   * тож зіставлення тут часткове за побудовою: те, чого немає на екрані,
   * показується як ідентифікатор і не вдає з себе посилання.
   */
  knownEntities?: Map<string, Facility>;
  onOpenFacility?: (facilityId: string) => void;
}) {
  const qc = useQueryClient();
  const listFn = useServerFn(listCases);
  const createFn = useServerFn(createCase);
  const noteFn = useServerFn(addCaseNote);
  const pinFn = useServerFn(pinToCase);

  const [openId, setOpenId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const cases = useQuery({
    queryKey: ["cases"],
    queryFn: () => listFn(),
    staleTime: 30_000,
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ["cases"] });

  const create = useMutation({
    mutationFn: (t: string) => createFn({ data: { title: t } }),
    onSuccess: (res) => {
      if (!res.ok) return setError(res.error ?? "Не вдалося створити справу.");
      setTitle("");
      setError(null);
      if (res.case) setOpenId(res.case.id);
      refresh();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const addNote = useMutation({
    mutationFn: (vars: { id: string; text: string }) => noteFn({ data: vars }),
    onSuccess: (res) => {
      if (!res.ok) return setError(res.error ?? "Не вдалося додати нотатку.");
      setNote("");
      setError(null);
      refresh();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const pin = useMutation({
    mutationFn: (vars: { id: string; facility: Facility }) =>
      pinFn({ data: { id: vars.id, facilities: [vars.facility] } }),
    onSuccess: (res) => {
      if (!res.ok) return setError(res.error ?? "Не вдалося приколоти обʼєкт.");
      setError(null);
      refresh();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  if (cases.isLoading) {
    return (
      <div className="flex items-center gap-2 px-1 py-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Справи…
      </div>
    );
  }

  // Ненастроєна платформа — не помилка, і мовчання тут краще за напис про збій.
  if (!cases.data?.configured) return null;

  if (!cases.data.ok) {
    return (
      <p className="px-1 py-3 font-mono text-[10px] uppercase tracking-[0.12em] text-amber-400">
        Справи недоступні: {cases.data.error ?? "платформа не відповідає"}
      </p>
    );
  }

  const list: AnalystCase[] = cases.data.cases ?? [];
  const titleCheck = validateTitle(title);
  const noteCheck = validateNote(note);

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        <FolderOpen className="size-3" /> Справи
        <span className="ml-auto">{list.length}</span>
      </h3>

      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!titleCheck.ok) return setError(titleCheck.error ?? null);
          create.mutate(titleCheck.value);
        }}
      >
        <Input
          value={title}
          maxLength={TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Нова справа"
          className="h-7 text-xs"
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!titleCheck.ok || create.isPending}
          className="h-7 shrink-0 px-2"
        >
          {create.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Plus className="size-3" />
          )}
        </Button>
      </form>

      {list.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Справа — це місце, куди лягає знахідка: нотатка й приколоті обʼєкти переживуть
          перезавантаження, бо зберігаються в платформі разом із журналом аудиту.
        </p>
      ) : null}

      <ul className="space-y-1">
        {list.map((c) => {
          const s = summarizeCase(c);
          const isOpen = c.id === openId;
          return (
            <li key={c.id} className="rounded border border-border">
              <button
                type="button"
                onClick={() => setOpenId(isOpen ? null : c.id)}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-accent/40"
              >
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">{c.title}</span>
                <span className="shrink-0 font-mono text-[9px] uppercase text-muted-foreground">
                  {s.entries === 0 ? "порожня" : `${s.entries} зап.`}
                </span>
              </button>

              {isOpen ? (
                <div className="space-y-2 border-t border-border px-2 py-2">
                  <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
                    Створено {fmt(c.createdAt)} · рівень {c.clearance}
                    {c.compartments?.length ? ` · ${c.compartments.join(", ")}` : ""}
                  </p>

                  {facility ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pin.isPending || isPinned(c, facility.id)}
                      onClick={() => pin.mutate({ id: c.id, facility })}
                      className="h-7 w-full justify-start gap-1.5 px-2 font-mono text-[10px] uppercase"
                      title={`Приколоти «${facility.name}» до справи «${c.title}»`}
                    >
                      {pin.isPending ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Pin className="size-3" />
                      )}
                      <span className="truncate">
                        {isPinned(c, facility.id) ? "Уже у справі" : `Додати: ${facility.name}`}
                      </span>
                    </Button>
                  ) : null}

                  <form
                    className="flex gap-1.5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!noteCheck.ok) return setError(noteCheck.error ?? null);
                      addNote.mutate({ id: c.id, text: noteCheck.value });
                    }}
                  >
                    <Input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Нотатка"
                      className="h-7 text-xs"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      variant="outline"
                      disabled={!noteCheck.ok || addNote.isPending}
                      className="h-7 shrink-0 px-2"
                    >
                      {addNote.isPending ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <StickyNote className="size-3" />
                      )}
                    </Button>
                  </form>

                  {c.pinnedEntityIds?.length ? (
                    <div className="space-y-0.5">
                      <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
                        Приколоті обʼєкти
                      </p>
                      <ul className="space-y-0.5">
                        {c.pinnedEntityIds.map((id) => {
                          const known = knownEntities?.get(id);
                          return (
                            <li key={id}>
                              {known ? (
                                <button
                                  type="button"
                                  onClick={() => onOpenFacility?.(known.id)}
                                  className="w-full truncate text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                                  title={known.name}
                                >
                                  {known.name}
                                </button>
                              ) : (
                                <span
                                  className="block truncate font-mono text-[10px] text-muted-foreground/70"
                                  title="Обʼєкт не серед завантажених — відкрийте його область, щоб перейти"
                                >
                                  {id}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}

                  {c.notes?.length ? (
                    <ul className="space-y-1">
                      {c.notes
                        .slice(-5)
                        .reverse()
                        .map((n, i) => (
                          <li key={`${n.at}-${i}`} className="text-[11px] leading-snug">
                            <span className="text-foreground">{n.text}</span>
                            <span className="ml-1.5 font-mono text-[9px] text-muted-foreground">
                              {fmt(n.at)}
                            </span>
                          </li>
                        ))}
                    </ul>
                  ) : null}

                  {c.findings?.length ? (
                    <ul className="space-y-1">
                      {c.findings.slice(-3).map((f, i) => (
                        <li
                          key={`${f.attachedAt}-${i}`}
                          className="border-l-2 border-primary/40 pl-2 text-[11px] leading-snug text-muted-foreground"
                        >
                          {f.summary}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {error ? <p className="text-[10px] leading-snug text-amber-400">{error}</p> : null}
    </section>
  );
}
