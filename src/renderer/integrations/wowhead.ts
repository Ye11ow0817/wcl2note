import { wowheadOptions, wowheadScriptUrl } from "./wowhead-links";

export function installWowheadTooltips() {
  if (document.getElementById("wowhead-tooltips-script")) return;
  window.whTooltips = { ...wowheadOptions };
  const script = document.createElement("script");
  script.id = "wowhead-tooltips-script";
  script.src = wowheadScriptUrl;
  script.async = true;
  document.head.appendChild(script);

  // The official widget appends its own DOM to body. Native modal dialogs sit
  // above body, so keep that unmodified widget inside the active dialog.
  let anchor: HTMLAnchorElement | undefined;
  function placeInDialog() {
    if (anchor && !anchor.isConnected) {
      window.WH?.Tooltips.hide();
      anchor = undefined;
    }
    const dialog = anchor?.closest("dialog[open]");
    const host =
      dialog?.querySelector("[data-wowhead-tooltip-host]") ??
      dialog ??
      document.body;
    for (const tooltip of document.querySelectorAll<HTMLElement>(
      ".wowhead-tooltip",
    )) {
      if (tooltip.parentElement !== host) host.appendChild(tooltip);
    }
  }
  document.addEventListener(
    "mouseover",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const next = target.closest<HTMLAnchorElement>("a[data-wowhead]");
      if (next) {
        anchor = next;
        placeInDialog();
      }
    },
    true,
  );
  new MutationObserver(placeInDialog).observe(document.body, {
    childList: true,
    subtree: true,
  });
  document.addEventListener(
    "close",
    () => {
      window.WH?.Tooltips.hide();
      anchor = undefined;
      placeInDialog();
    },
    true,
  );
}
