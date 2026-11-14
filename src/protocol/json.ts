/** Parses a response body; an empty or malformed body is undefined, never an exception. */
export function parseJson(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
