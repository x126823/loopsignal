import type { ItemState } from "../../generated/prisma/enums";
import { Badge } from "@/components/ui/badge";
import { STATE_LABEL, STATE_TONE } from "@/lib/labels";

export function StateBadge({ state }: { state: ItemState }) {
  return <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>;
}
