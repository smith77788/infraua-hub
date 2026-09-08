import { createFileRoute } from "@tanstack/react-router";

import { GraphView } from "@/console/views/GraphView";

export const Route = createFileRoute("/_console/graph")({
  component: GraphView,
});
