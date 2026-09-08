import { createFileRoute } from "@tanstack/react-router";

import { CasesView } from "@/console/views/CasesView";

export const Route = createFileRoute("/_console/cases")({
  component: CasesView,
});
