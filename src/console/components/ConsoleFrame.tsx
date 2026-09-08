import type { ReactNode } from "react";

import { AppShell } from "@/console/components/AppShell";
import { SignIn } from "@/console/components/SignIn";
import { Spinner } from "@/console/components/primitives";
import { SessionProvider, useSession } from "@/console/hooks/useSession";

/**
 * Wraps every console page.
 *
 * The session gate lives here and nowhere else, so a page cannot be added that
 * renders without it — the routes stay flat (one file per page, per this
 * template's convention) while the check stays in a single place.
 */
function Gate({ children }: { children: ReactNode }) {
  const { status } = useSession();

  if (status === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (status !== "authenticated") return <SignIn />;

  return <AppShell>{children}</AppShell>;
}

export function ConsoleFrame({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <Gate>{children}</Gate>
    </SessionProvider>
  );
}
