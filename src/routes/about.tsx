import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Activity,
  Boxes,
  Cpu,
  Globe2,
  Layers,
  LineChart,
  Lock,
  Radar,
  Satellite,
  ShieldCheck,
  Waypoints,
  Zap,
} from "lucide-react";

import heroImage from "@/assets/hero-infraua.jpg";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "InfraUA — моніторинг критичної інфраструктури України" },
      {
        name: "description",
        content:
          "InfraUA — платформа ситуаційної обізнаності: збирає відкриті дані про енергетику, транспорт і звʼязок України в одну карту та граф звʼязків.",
      },
      { property: "og:title", content: "InfraUA — ситуаційна обізнаність для критичної інфраструктури" },
      {
        property: "og:description",
        content:
          "Єдина карта, граф звʼязків та аналітика по енергетиці, транспорту й звʼязку України на основі відкритих джерел.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const NAV = [
  { href: "#platform", label: "Платформа" },
  { href: "#capabilities", label: "Можливості" },
  { href: "#sources", label: "Джерела" },
  { href: "#how", label: "Як працює" },
  { href: "#contact", label: "Контакти" },
];

const CAPABILITIES = [
  {
    icon: Radar,
    title: "Жива карта",
    text: "Обʼєкти енергетики, транспортні вузли та вузли звʼязку на одній GPU-карті — з фільтрами за областями й типами.",
  },
  {
    icon: Waypoints,
    title: "Граф звʼязків",
    text: "Хто від кого залежить: підстанція → лінія → підприємство. Видно, що впаде наступним у разі відключення.",
  },
  {
    icon: Activity,
    title: "Події в реальному часі",
    text: "Сейсміка, пожежі, погодні аномалії та повідомлення з відкритих каналів автоматично привʼязуються до обʼєктів.",
  },
  {
    icon: LineChart,
    title: "Аналітика стійкості",
    text: "Оцінка критичності вузлів, сценарії «що якщо» та історія інцидентів по кожному обʼєкту.",
  },
  {
    icon: Layers,
    title: "Шари даних",
    text: "Вмикайте лише те, що потрібно: енергомережа, залізниця, логістика, телеком, водопостачання.",
  },
  {
    icon: ShieldCheck,
    title: "Рівні доступу",
    text: "Розмежування прав на рівні сервера: кожен аналітик бачить лише свій контур даних.",
  },
];

const SOURCES = [
  { icon: Satellite, name: "NASA FIRMS / EONET", note: "пожежі та стихійні явища" },
  { icon: Globe2, name: "USGS", note: "сейсмічна активність" },
  { icon: Boxes, name: "OpenStreetMap", note: "інфраструктурна геометрія" },
  { icon: Zap, name: "Відкриті енергозвіти", note: "стан мереж і генерації" },
  { icon: Cpu, name: "Публічні канали", note: "геопривʼязані повідомлення" },
  { icon: Lock, name: "Власні набори", note: "закриті дані вашої команди" },
];

const STEPS = [
  {
    n: "01",
    title: "Збір",
    text: "Конектори тягнуть відкриті й ваші власні дані за розкладом, нормалізують формати та геокодують обʼєкти.",
  },
  {
    n: "02",
    title: "Онтологія",
    text: "Кожен запис лягає у граф як сутність із перевіреним типом: обʼєкт, оператор, подія, локація.",
  },
  {
    n: "03",
    title: "Аналіз",
    text: "Семантичний пошук і детерміновані запити по графу дають відповідь із посиланням на першоджерело.",
  },
  {
    n: "04",
    title: "Рішення",
    text: "Карта, звіт і сповіщення — у форматі, придатному для оперативного штабу, а не для скріншота.",
  },
];

const STATS = [
  { value: "24/7", label: "оновлення потоків" },
  { value: "12+", label: "категорій обʼєктів" },
  { value: "<2 хв", label: "затримка події" },
  { value: "100%", label: "простежувані джерела" },
];

function Index() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="min-h-screen bg-background font-sans text-foreground antialiased">
      {/* Header */}
      <header
        className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
          scrolled ? "border-b border-border bg-background/85 backdrop-blur-md" : "border-b border-transparent"
        }`}
      >
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5">
          <a href="#top" className="flex items-center gap-2.5">
            <span className="relative flex size-2.5">
              <span className="animate-pulse-dot absolute inline-flex size-full rounded-full bg-primary" />
            </span>
            <span className="font-mono text-base font-bold tracking-[0.18em] text-foreground">
              INFRA<span className="text-primary">UA</span>
            </span>
          </a>

          <nav className="hidden items-center gap-7 md:flex">
            {NAV.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-primary"
              >
                {item.label}
              </a>
            ))}
          </nav>

          <Button asChild size="sm" className="font-mono text-xs uppercase tracking-[0.12em]">
            <Link to="/">Відкрити консоль</Link>
          </Button>
        </div>
      </header>

      <main id="top">
        {/* Hero */}
        <section className="relative overflow-hidden">
          <img
            src={heroImage}
            alt="Тривимірна карта України з підсвіченими вузлами інфраструктури"
            width={1920}
            height={1088}
            className="absolute inset-0 size-full object-cover opacity-45"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-background/85 via-background/60 to-background" />
          <div className="grid-bg absolute inset-0 opacity-70" />
          <div
            aria-hidden
            className="animate-scan pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/70 to-transparent"
          />

          <div className="relative mx-auto flex min-h-[92svh] w-full max-w-6xl flex-col justify-center px-5 pb-20 pt-32">
            <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-primary">
              Ситуаційна обізнаність · Україна
            </p>
            <h1 className="mt-6 max-w-3xl text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl">
              Критична інфраструктура{" "}
              <span className="text-primary text-glow">на одному екрані</span>
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              InfraUA збирає відкриті дані про енергетику, транспорт і звʼязок, зводить їх у граф
              залежностей і показує, що саме зараз під загрозою — з посиланням на першоджерело
              кожного факту.
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="font-mono text-xs uppercase tracking-[0.14em]">
                <a href="#contact">Отримати демо</a>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="border-border bg-background/40 font-mono text-xs uppercase tracking-[0.14em] backdrop-blur"
              >
                <a href="#platform">Як це працює</a>
              </Button>
            </div>

            <dl className="mt-16 grid grid-cols-2 gap-px overflow-hidden rounded border border-border bg-border sm:grid-cols-4">
              {STATS.map((s) => (
                <div key={s.label} className="bg-background/80 px-5 py-5 backdrop-blur">
                  <dt className="font-mono text-2xl font-bold text-primary">{s.value}</dt>
                  <dd className="mt-1 text-xs leading-snug text-muted-foreground">{s.label}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* Platform */}
        <section id="platform" className="border-t border-border py-24">
          <div className="mx-auto w-full max-w-6xl px-5">
            <div className="grid gap-12 lg:grid-cols-[1.1fr_1fr] lg:items-start">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
                  Платформа
                </p>
                <h2 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">
                  Не ще один дашборд, а робочий інструмент аналітика
                </h2>
                <p className="mt-5 text-base leading-relaxed text-muted-foreground">
                  Більшість систем показують точки на карті. InfraUA показує звʼязки між ними:
                  які обʼєкти залежать один від одного, які події їх зачепили і що станеться,
                  якщо вузол вимкнеться. Кожне твердження в системі можна розгорнути до
                  конкретного запису й джерела.
                </p>
                <ul className="mt-8 space-y-4">
                  {[
                    "Єдина онтологія обʼєктів замість розрізнених таблиць",
                    "Детерміновані запити — жодних вигаданих відповідей",
                    "Історія змін по кожному обʼєкту з часовою шкалою",
                    "Експорт зрізу даних у звіт для штабу",
                  ].map((t) => (
                    <li key={t} className="flex gap-3 text-sm text-foreground/90">
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded border border-border bg-card p-5">
                <div className="flex items-center justify-between border-b border-border pb-3">
                  <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                    node · inspector
                  </span>
                  <span className="flex items-center gap-2 font-mono text-[11px] text-primary">
                    <span className="animate-pulse-dot size-1.5 rounded-full bg-primary" />
                    live
                  </span>
                </div>
                <div className="mt-4 space-y-3 font-mono text-xs">
                  {[
                    ["entity", "substation.330kv", "text-foreground"],
                    ["region", "Харківська область", "text-foreground"],
                    ["status", "degraded", "text-accent"],
                    ["depends_on", "line.750kv.north", "text-primary"],
                    ["affects", "17 обʼєктів", "text-foreground"],
                    ["last_event", "12 хв тому", "text-muted-foreground"],
                    ["source", "open-data · verified", "text-muted-foreground"],
                  ].map(([k, v, cls]) => (
                    <div key={k} className="flex items-baseline justify-between gap-4 border-b border-border/50 pb-2">
                      <span className="text-muted-foreground">{k}</span>
                      <span className={cls}>{v}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  приклад картки обʼєкта
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Capabilities */}
        <section id="capabilities" className="border-t border-border py-24">
          <div className="mx-auto w-full max-w-6xl px-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
              Можливості
            </p>
            <h2 className="mt-4 max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
              Шість модулів, які працюють з одними й тими самими даними
            </h2>

            <div className="mt-12 grid gap-px overflow-hidden rounded border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
              {CAPABILITIES.map(({ icon: Icon, title, text }) => (
                <article
                  key={title}
                  className="group bg-card p-7 transition-colors duration-300 hover:bg-secondary"
                >
                  <Icon className="size-6 text-primary" strokeWidth={1.5} aria-hidden />
                  <h3 className="mt-5 text-lg font-semibold tracking-tight">{title}</h3>
                  <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Sources */}
        <section id="sources" className="border-t border-border py-24">
          <div className="mx-auto w-full max-w-6xl px-5">
            <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr] lg:items-center">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
                  Джерела
                </p>
                <h2 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">
                  Тільки те, що можна перевірити
                </h2>
                <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
                  Платформа працює з відкритими даними та з вашими власними наборами. Кожен
                  запис зберігає посилання на джерело й час отримання, тож будь-який висновок
                  можна відтворити.
                </p>
              </div>

              <div className="grid gap-px overflow-hidden rounded border border-border bg-border sm:grid-cols-2">
                {SOURCES.map(({ icon: Icon, name, note }) => (
                  <div key={name} className="flex items-start gap-3 bg-card px-5 py-5">
                    <Icon className="mt-0.5 size-5 shrink-0 text-accent" strokeWidth={1.5} aria-hidden />
                    <div>
                      <p className="font-mono text-xs font-semibold tracking-wide">{name}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="border-t border-border py-24">
          <div className="mx-auto w-full max-w-6xl px-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
              Як працює
            </p>
            <h2 className="mt-4 max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
              Від сирого потоку до рішення — чотири кроки
            </h2>

            <ol className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((s) => (
                <li key={s.n} className="border-t border-primary/40 pt-5">
                  <span className="font-mono text-3xl font-bold text-primary/40">{s.n}</span>
                  <h3 className="mt-3 text-lg font-semibold tracking-tight">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* CTA */}
        <section id="contact" className="relative overflow-hidden border-t border-border py-24">
          <div className="grid-bg absolute inset-0 opacity-60" />
          <div className="relative mx-auto w-full max-w-3xl px-5 text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Готові подивитись на свою інфраструктуру інакше?
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-muted-foreground">
              Напишіть кілька слів про вашу задачу — покажемо платформу на ваших даних і
              обговоримо, які джерела під неї підключити.
            </p>
            <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
              <Button asChild size="lg" className="font-mono text-xs uppercase tracking-[0.14em]">
                <a href="mailto:hello@infraua.org">Написати команді</a>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="font-mono text-xs uppercase tracking-[0.14em]"
              >
                <a href="https://github.com/smith77788/Palanter" target="_blank" rel="noreferrer">
                  Код проєкту
                </a>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border py-10">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-5 sm:flex-row">
          <span className="font-mono text-xs tracking-[0.18em] text-muted-foreground">
            INFRA<span className="text-primary">UA</span> © {new Date().getFullYear()}
          </span>
          <span className="text-xs text-muted-foreground">
            Побудовано на відкритих даних. Зроблено в Україні.
          </span>
        </div>
      </footer>
    </div>
  );
}
