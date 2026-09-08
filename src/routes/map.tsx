import { createFileRoute } from "@tanstack/react-router";

import { ConsoleFrame } from "@/console/components/ConsoleFrame";
import { MapView } from "@/console/views/MapView";

export const Route = createFileRoute("/map")({
  head: () => ({
    // The console is an operator tool behind a credential, not a page that
    // belongs in search results.
    meta: [{ title: "Palanter — мапа" }, { name: "robots", content: "noindex, nofollow" }],
  }),
  component: Page,
});

function Page() {
  return (
    <ConsoleFrame>
      <MapView />
    </ConsoleFrame>
  );
}
