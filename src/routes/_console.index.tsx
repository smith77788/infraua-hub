import { createFileRoute } from "@tanstack/react-router";

import { OverviewView } from "@/console/views/OverviewView";

export const Route = createFileRoute("/_console/")({
  component: OverviewView,
});
