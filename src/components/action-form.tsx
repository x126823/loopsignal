import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/field";

/**
 * A two-step control for consequential actions, with no JavaScript needed: the summary reveals a form with an optional
 * note and a final, explicit submit button. Nothing happens on the first click.
 */
export function ActionForm({
  action, fields, summary, submitLabel, variant = "default", noteLabel = "Note (optional)", description,
}: {
  action: (formData: FormData) => void | Promise<void>;
  /** Hidden inputs: ids and the expected version. Convenience only; the server re-validates and re-authorizes. */
  fields: Record<string, string>;
  summary: string;
  submitLabel: string;
  variant?: "default" | "danger" | "outline";
  noteLabel?: string;
  description?: ReactNode;
}) {
  const id = `note-${Object.values(fields).join("-").slice(0, 60)}-${submitLabel}`.replace(/[^a-zA-Z0-9-]/g, "");
  return (
    <details className="group rounded-md border border-border bg-card">
      <summary className="cursor-pointer list-none rounded-md px-4 py-2 text-sm font-medium hover:bg-muted">{summary}</summary>
      <form action={action} className="flex flex-col gap-3 border-t border-border px-4 py-3">
        {Object.entries(fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
        <Label htmlFor={id}>{noteLabel}</Label>
        <Textarea id={id} name="reason" maxLength={500} rows={2} />
        <div>
          <Button type="submit" variant={variant}>{submitLabel}</Button>
        </div>
      </form>
    </details>
  );
}
