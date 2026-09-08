import { createFileRoute } from "@tanstack/react-router";

import { ConsoleFrame } from "@/console/components/ConsoleFrame";
import { IngestView } from "@/console/views/IngestView";

export const Route = createFileRoute("/ingest")({
  head: () => ({
    // The console is an operator tool behind a credential, not a page that
    // belongs in search results.
    meta: [{ title: "Palanter — завантаження" }, { name: "robots", content: "noindex, nofollow" }],
  }),
  component: Page,
});

function Page() {
  return (
    <ConsoleFrame>
      <IngestView />
    </ConsoleFrame>
  );
}
