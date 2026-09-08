import { createFileRoute } from "@tanstack/react-router";

import { ConsoleFrame } from "@/console/components/ConsoleFrame";
import { InvestigateView } from "@/console/views/InvestigateView";

export const Route = createFileRoute("/investigate")({
  head: () => ({
    // The console is an operator tool behind a credential, not a page that
    // belongs in search results.
    meta: [{ title: "Palanter — розслідування" }, { name: "robots", content: "noindex, nofollow" }],
  }),
  component: Page,
});

function Page() {
  return (
    <ConsoleFrame>
      <InvestigateView />
    </ConsoleFrame>
  );
}
