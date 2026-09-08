import { createFileRoute } from "@tanstack/react-router";

import { MapView } from "@/console/views/MapView";

export const Route = createFileRoute("/_console/map")({
  component: MapView,
});
