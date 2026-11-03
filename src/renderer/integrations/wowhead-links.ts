export const wowheadScriptUrl = "https://wow.zamimg.com/js/tooltips.js";
export const wowheadOptions = {
  colorLinks: false,
  iconizeLinks: false,
  renameLinks: false,
};

export function validSpellId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 2147483647
  );
}

export function wowheadSpellLink(spellId: number) {
  return validSpellId(spellId)
    ? {
        href: `https://www.wowhead.com/cn/spell=${spellId}`,
        "data-wowhead": `spell=${spellId}&domain=cn`,
      }
    : undefined;
}
