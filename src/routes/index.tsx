import { createFileRoute } from "@tanstack/react-router";

import { ConsoleFrame } from "@/console/components/ConsoleFrame";
import { OverviewView } from "@/console/views/OverviewView";

export const Route = createFileRoute("/")({
  head: () => ({
    // The console is an operator tool behind a credential, not a page that
    // belongs in search results.
    meta: [{ title: "Palanter — огляд" }, { name: "robots", content: "noindex, nofollow" }],
  }),
  component: Page,
});

function Page() {
  return (
    <ConsoleFrame>
      <OverviewView />
    </ConsoleFrame>
  );
}
