import type { ActionTemplate } from "@ff-engine/engine";

/** The action template with the given `type`. */
export type TemplateOf<T extends ActionTemplate["type"]> = Extract<ActionTemplate, { type: T }>;

/** The available template of the given type, narrowed, if any. */
export const findTemplate = <T extends ActionTemplate["type"]>(templates: ActionTemplate[], type: T) =>
  templates.find((t): t is TemplateOf<T> => t.type === type);

/** Multiple Block: the first target picked on the board, waiting for a second one (or a block on it alone). */
export function multipleBlockFirst(templates: ActionTemplate[], picked: string[]): string | undefined {
  const multi = findTemplate(templates, "MULTIPLE_BLOCK");
  return multi && picked.length === 1 && multi.targetIds.includes(picked[0]!) ? picked[0] : undefined;
}
