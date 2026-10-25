import { z } from "zod";

/**
 * Text normalization is opt-in: every flag defaults to the most literal comparison so that
 * meaningful whitespace in command output is never silently discarded.
 */
export const normalizationInput = z.object({
  trim: z.boolean().default(false),
  normalizeLineEndings: z.boolean().default(false),
  collapseWhitespace: z.boolean().default(false),
  ignoreCase: z.boolean().default(false),
  ignoreTrailingNewline: z.boolean().default(false),
  trimLineEnds: z.boolean().default(false),
  ignoreBlankLines: z.boolean().default(false),
});
export type Normalization = z.infer<typeof normalizationInput>;

export const defaultNormalization: Normalization = normalizationInput.parse({});
/** Sensible defaults for free-text command answers: surrounding whitespace carries no meaning. */
export const textAnswerNormalization: Normalization = normalizationInput.parse({
  trim: true, normalizeLineEndings: true,
});
/** Defaults for predicted command output: line endings are an artifact of the editor, not the answer. */
export const outputNormalization: Normalization = normalizationInput.parse({
  normalizeLineEndings: true, ignoreTrailingNewline: true, trimLineEnds: true,
});

export function normalizeText(value: string, options: Normalization): string {
  let text = value;
  if (options.normalizeLineEndings) text = text.replace(/\r\n?/g, "\n");
  if (options.trimLineEnds) text = text.split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n");
  if (options.ignoreBlankLines) text = text.split("\n").filter((line) => line.trim() !== "").join("\n");
  if (options.ignoreTrailingNewline) text = text.replace(/\n+$/, "");
  if (options.collapseWhitespace) text = text.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n");
  if (options.trim) text = text.trim();
  if (options.ignoreCase) text = text.toLowerCase();
  return text;
}

/** Describes which normalization rules were applied, for honest student-facing feedback. */
export function describeNormalization(options: Normalization): string[] {
  const labels: [keyof Normalization, string][] = [
    ["trim", "surrounding whitespace ignored"],
    ["normalizeLineEndings", "line endings normalized"],
    ["collapseWhitespace", "repeated spaces collapsed"],
    ["ignoreCase", "case ignored"],
    ["ignoreTrailingNewline", "trailing newline ignored"],
    ["trimLineEnds", "trailing spaces on each line ignored"],
    ["ignoreBlankLines", "blank lines ignored"],
  ];
  return labels.filter(([key]) => options[key]).map(([, label]) => label);
}
