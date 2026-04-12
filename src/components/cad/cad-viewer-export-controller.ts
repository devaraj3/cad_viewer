import type { ModelSession } from "./model-session";
import {
  exportSelectedPartFromSession,
  makeSuccessfulExportMessage,
  validatePartExportSelection,
  type PartExportFormat,
  type PartExportPlan,
} from "./exporters/part-export";

type ExportPartFn = typeof exportSelectedPartFromSession;

export type TriggerSelectedPartExportArgs = {
  session: ModelSession | null | undefined;
  selectedPartKey: string | null | undefined;
  plan: PartExportPlan;
  worker?: Worker | null;
  exportPartFn?: ExportPartFn;
};

export type TriggerSelectedPartExportResult = {
  ok: boolean;
  message: string;
  exportedFormat: PartExportFormat | null;
  usedFallback: boolean;
};

export async function triggerSelectedPartExport(
  args: TriggerSelectedPartExportArgs,
): Promise<TriggerSelectedPartExportResult> {
  const validation = validatePartExportSelection(args.session, args.selectedPartKey);
  if ("reason" in validation) {
    return {
      ok: false,
      message: validation.reason,
      exportedFormat: null,
      usedFallback: false,
    };
  }

  const exportPart = args.exportPartFn ?? exportSelectedPartFromSession;
  try {
    const result = await exportPart(args.session!, args.selectedPartKey!, args.plan, {
      worker: args.worker,
    });
    return {
      ok: true,
      message: makeSuccessfulExportMessage(result.format),
      exportedFormat: result.format,
      usedFallback: !!result.fallbackFrom,
    };
  } catch (error: unknown) {
    const message =
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "Failed to export the selected part.";
    return { ok: false, message, exportedFormat: null, usedFallback: false };
  }
}
