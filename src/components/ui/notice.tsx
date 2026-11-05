import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const noticeVariants = cva("rounded-md border px-4 py-3 text-sm", {
  variants: {
    tone: {
      info: "border-info/40 bg-info/10 text-foreground",
      success: "border-success/40 bg-success/10 text-foreground",
      warning: "border-warning/40 bg-warning/10 text-foreground",
      danger: "border-danger/40 bg-danger/10 text-foreground",
    },
  },
  defaultVariants: { tone: "info" },
});

export function Notice({ className, tone, ...props }: HTMLAttributes<HTMLDivElement> & VariantProps<typeof noticeVariants>) {
  return <div role={tone === "danger" || tone === "warning" ? "alert" : "status"} className={cn(noticeVariants({ tone }), className)} {...props} />;
}
