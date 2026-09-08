import { createFileRoute } from "@tanstack/react-router";

import { AnalyticsView } from "@/console/views/AnalyticsView";

export const Route = createFileRoute("/_console/analysis")({
  component: AnalyticsView,
});
