import { WIKI_INFERENCE_ATTEMPTS } from "./execution-limits";

/** Retry invalid model output before publication, within the caller's deadline.
 * Provider errors and cancellation are not validation failures. */
export async function validatedInference<T>(
  generate: (feedback: string) => Promise<unknown>,
  validate: (output: unknown) => T,
  signal: AbortSignal,
): Promise<T> {
  let feedback = "";
  for (let attempt = 1; attempt <= WIKI_INFERENCE_ATTEMPTS; attempt++) {
    signal.throwIfAborted();
    const output = await generate(feedback);
    signal.throwIfAborted();
    try { return validate(output); }
    catch (error) {
      signal.throwIfAborted();
      if (attempt === WIKI_INFERENCE_ATTEMPTS) throw new Error(`AI output still failed validation after ${attempt} attempts. ` + (error instanceof Error ? error.message : "Invalid output"));
      feedback = "\nYour previous response failed validation: " + (error instanceof Error ? error.message : "Invalid output") + ". Generate a corrected response from the original body. " +
        "Copy each quote as one exact contiguous substring of the supplied body, including Markdown markers, backslashes, accents, punctuation and whitespace. " +
        "Do not translate, simplify, join excerpts or replace text with ellipses in quotes. " +
        "Use shorter excerpts when necessary. Every candidate name must occur exactly inside its quote. " +
        "Respect all field, count and character limits; omit optional claims or candidates you cannot support. " +
        "Return the complete corrected JSON object. This is automatic correction attempt " + attempt + ` of ${WIKI_INFERENCE_ATTEMPTS - 1}.`;
    }
  }
  throw new Error("Unreachable validation attempt");
}
