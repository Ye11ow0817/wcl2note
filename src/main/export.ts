import { filename } from "../domain/report";

export function noteFilename(input: string): string {
  let result = filename(input).replace(/[. ]+$/, "");
  if (!result.toLowerCase().endsWith(".txt")) result += ".txt";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result))
    result = `_${result}`;
  return result;
}
export const windowsText = (text: string) => text.replace(/\r?\n/g, "\r\n");
