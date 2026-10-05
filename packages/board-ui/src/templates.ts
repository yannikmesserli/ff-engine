import type { ActionTemplate } from "@bb/engine";

/** The action template with the given `type`. */
export type TemplateOf<T extends ActionTemplate["type"]> = Extract<ActionTemplate, { type: T }>;

/** The available template of the given type, narrowed, if any. */
export const findTemplate = <T extends ActionTemplate["type"]>(templates: ActionTemplate[], type: T) =>
  templates.find((t): t is TemplateOf<T> => t.type === type);
