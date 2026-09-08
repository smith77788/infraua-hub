import { createFileRoute } from "@tanstack/react-router";

import { IngestView } from "@/console/views/IngestView";

export const Route = createFileRoute("/_console/ingest")({
  component: IngestView,
});
