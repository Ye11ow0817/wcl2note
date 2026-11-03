import { useLayoutEffect, useRef } from "react";

export function useKeyboardFocus<T extends HTMLElement>() {
  const container = useRef<T>(null);
  useLayoutEffect(() => {
    // Modifier keys used with the mouse must not reveal keyboard focus rings.
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Tab" && container.current)
        container.current.dataset.keyboardFocus = "true";
    };
    const pointer = () => {
      if (container.current) delete container.current.dataset.keyboardFocus;
    };
    document.addEventListener("keydown", keyboard, true);
    document.addEventListener("pointerdown", pointer, true);
    return () => {
      document.removeEventListener("keydown", keyboard, true);
      document.removeEventListener("pointerdown", pointer, true);
    };
  }, []);
  return container;
}
