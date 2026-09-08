import { createFileRoute } from "@tanstack/react-router";

import { AuditView } from "@/console/views/AuditView";

export const Route = createFileRoute("/_console/audit")({
  component: AuditView,
});
