import { createFileRoute } from "@tanstack/react-router";

import { InvestigateView } from "@/console/views/InvestigateView";

export const Route = createFileRoute("/_console/investigate")({
  component: InvestigateView,
});
