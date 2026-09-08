import { Lock } from "lucide-react";
import { Badge } from "@/console/components/primitives";
import { ClearanceLevel } from "@/console/lib/types";
import { cn } from "@/lib/utils";
import { clearanceClasses, clearanceName } from "@/console/lib/format";

export function ClearanceBadge({
  level,
  showIcon = false,
  className,
}: {
  level: ClearanceLevel;
  showIcon?: boolean;
  className?: string;
}) {
  return (
    <Badge
      className={cn(clearanceClasses(level), className)}
      title={`Класифікація: ${clearanceName(level)}`}
    >
      {showIcon && <Lock className="h-2.5 w-2.5" aria-hidden />}
      {clearanceName(level)}
    </Badge>
  );
}
