import { createFileRoute } from "@tanstack/react-router";

import { ConsoleFrame } from "@/console/components/ConsoleFrame";
import { AuditView } from "@/console/views/AuditView";

export const Route = createFileRoute("/audit")({
  head: () => ({
    // The console is an operator tool behind a credential, not a page that
    // belongs in search results.
    meta: [{ title: "Palanter — журнал аудиту" }, { name: "robots", content: "noindex, nofollow" }],
  }),
  component: Page,
});

function Page() {
  return (
    <ConsoleFrame>
      <AuditView />
    </ConsoleFrame>
  );
}
