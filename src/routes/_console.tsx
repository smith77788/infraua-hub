import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/console/components/AppShell";
import { SignIn } from "@/console/components/SignIn";
import { Spinner } from "@/console/components/primitives";
import { SessionProvider, useSession } from "@/console/hooks/useSession";

/**
 * The console's layout route: everything under /console renders inside it.
 *
 * The session gate lives here rather than in each child so there is exactly
 * one place that decides whether an operator is signed in — and so a new view
 * cannot be added that accidentally renders without it.
 */
export const Route = createFileRoute("/_console")({
  head: () => ({
    meta: [
      { title: "Palanter — консоль аналітика" },
      {
        name: "description",
        content:
          "Граф знань, розслідування з обґрунтуванням, мапа та журнал аудиту з контролем допуску.",
      },
      // The console is an operator tool behind a credential, not a page that
      // belongs in search results.
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: ConsoleLayout,
});

function ConsoleGate() {
  const { status } = useSession();

  if (status === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (status !== "authenticated") return <SignIn />;

  return <AppShell />;
}

function ConsoleLayout() {
  return (
    <SessionProvider>
      <ConsoleGate />
    </SessionProvider>
  );
}
