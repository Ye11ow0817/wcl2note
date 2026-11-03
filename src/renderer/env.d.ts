import type { DesktopBridge } from "../shared/desktop";
import type { wowheadOptions } from "./integrations/wowhead-links";

declare global {
  interface Window {
    wcl2note: DesktopBridge;
    whTooltips: typeof wowheadOptions;
    WH?: { Tooltips: { hide: () => void } };
  }
}
