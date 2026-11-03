import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { classColors } from "../../domain/actor";
import type { SourceNode } from "../../domain/model";
import { ActorIcon } from "./GameIcon";

// Lift darker class colors for readable names on menu hover and selection.
// Keep the canonical WoW palette in the domain layer.
export const actorTextColors: Readonly<Record<string, string>> = {
  ...classColors,
  deathknight: "#f58b9b",
  demonhunter: "#d38cf1",
  evoker: "#65c7ad",
  shaman: "#73b4ff",
  warlock: "#b7a3e8",
};

function actorTitle(node: SourceNode) {
  return [
    node.name,
    `Actor ID: ${node.actorId}`,
    node.gameID ? `ID: ${node.gameID}` : "",
    node.instance != null ? `Instance ID: ${node.instance}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function FloatingMenu({
  anchor,
  level,
  label,
  children,
  onEnter,
  onLeave,
}: {
  anchor: HTMLElement;
  level: number;
  label: string;
  children: ReactNode;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const element = menu.current!;
    function place() {
      const row = anchor.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      let left = level ? row.right : row.left;
      if (level && left + box.width > width - 8) left = row.left - box.width;
      left = Math.max(8, Math.min(left, width - box.width - 8));
      const top = Math.max(
        8,
        Math.min(level ? row.top : row.bottom + 4, height - box.height - 8),
      );
      setPosition((previous) =>
        previous?.left === left && previous.top === top
          ? previous
          : { left, top },
      );
    }
    const observer = new ResizeObserver(place);
    observer.observe(element);
    observer.observe(anchor);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    place();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, level]);
  return (
    <div
      ref={menu}
      className="actor-menu"
      role="menu"
      aria-label={label}
      data-level={level}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        ...position,
        visibility: position ? "visible" : "hidden",
        zIndex: level + 1,
      }}
    >
      {children}
    </div>
  );
}

function MenuItems({
  nodes,
  selected,
  level,
  activeKey,
  onActivate,
  onSelect,
  onBack,
  onForward,
}: {
  nodes: SourceNode[];
  selected?: string;
  level: number;
  activeKey?: string;
  onActivate: (node: SourceNode, element: HTMLElement, level: number) => void;
  onSelect: (node: SourceNode) => void;
  onBack: (level: number) => void;
  onForward: (level: number) => void;
}) {
  const instances = nodes.filter((node) => node.instance != null);
  const actors = nodes.filter((node) => node.instance == null);
  const columns = Array.from(
    { length: Math.ceil(actors.length / 10) },
    (_, index) => actors.slice(index * 10, index * 10 + 10),
  );
  function item(node: SourceNode) {
    const hasChildren = node.children.length > 0;
    return (
      <button
        key={node.key}
        role="menuitem"
        className={`source${selected === node.key ? " active" : ""}${activeKey === node.key ? " actor-hovered" : ""}`}
        aria-label={node.name}
        aria-current={selected === node.key ? true : undefined}
        aria-haspopup={hasChildren ? "menu" : undefined}
        aria-expanded={hasChildren ? activeKey === node.key : undefined}
        title={actorTitle(node)}
        onClick={() => onSelect(node)}
        onMouseEnter={(event) => onActivate(node, event.currentTarget, level)}
        onFocus={(event) => onActivate(node, event.currentTarget, level)}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" && hasChildren) {
            event.preventDefault();
            onActivate(node, event.currentTarget, level);
            onForward(level);
          } else if (event.key === "ArrowLeft" && level > 0) {
            event.preventDefault();
            onBack(level);
          }
        }}
      >
        {node.instance != null ? (
          node.instance
        ) : (
          <>
            <ActorIcon node={node} />
            <span
              className="actor-name"
              style={{ color: actorTextColors[node.className ?? ""] }}
            >
              {node.name}
            </span>
            {!!node.gameID && (
              <small className="actor-id">ID: {node.gameID}</small>
            )}
            {hasChildren && (
              <ChevronRight
                className="actor-submenu-indicator"
                size={12}
                aria-hidden="true"
              />
            )}
          </>
        )}
      </button>
    );
  }
  return (
    <>
      {!!instances.length && (
        <div
          className="actor-instances"
          role="group"
          aria-label="Instance ID"
          style={{
            gridTemplateColumns: `repeat(${Math.min(10, instances.length)}, 30px)`,
          }}
        >
          {instances.map(item)}
        </div>
      )}
      {!!columns.length && (
        <div className="actor-columns">
          {columns.map((column, index) => (
            <div
              className="actor-column"
              role="group"
              aria-label={`第 ${index + 1} 列`}
              key={index}
            >
              {column.map(item)}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function ActorPicker({
  nodes,
  selected,
  onSelect,
  allLabel,
  label,
}: {
  nodes: SourceNode[];
  selected?: SourceNode;
  onSelect: (node?: SourceNode) => void;
  allLabel: string;
  label?: "Source" | "Target";
}) {
  const picker = useRef<HTMLDetailsElement>(null);
  const popups = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<
    { node: SourceNode; anchor: HTMLElement }[]
  >([]);
  function cancelLeave() {
    clearTimeout(leaveTimer.current);
  }
  function close(focus = false) {
    cancelLeave();
    setOpen(false);
    setBranches([]);
    if (picker.current) {
      picker.current.open = false;
      if (focus) picker.current.querySelector("summary")?.focus();
    }
  }
  function choose(node?: SourceNode) {
    onSelect(node);
    close(true);
  }
  function activate(node: SourceNode, anchor: HTMLElement, level: number) {
    cancelLeave();
    setBranches((previous) => {
      if (
        node.children.length &&
        previous.length === level + 1 &&
        previous[level]?.node.key === node.key &&
        previous[level].anchor === anchor
      )
        return previous;
      return [
        ...previous.slice(0, level),
        ...(node.children.length ? [{ node, anchor }] : []),
      ];
    });
  }
  function forward(level: number) {
    requestAnimationFrame(() =>
      popups.current
        ?.querySelector<HTMLButtonElement>(
          `[data-level="${level + 1}"] [role="menuitem"]`,
        )
        ?.focus(),
    );
  }
  function back(level: number) {
    branches[level - 1]?.anchor.focus();
    setBranches((previous) => previous.slice(0, level - 1));
  }
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !picker.current?.contains(event.target) &&
        !popups.current?.contains(event.target)
      )
        close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const anchor = picker.current?.querySelector("summary");
  const menuItems = (items: SourceNode[], level: number) => (
    <MenuItems
      nodes={items}
      selected={selected?.key}
      level={level}
      activeKey={branches[level]?.node.key}
      onActivate={activate}
      onSelect={choose}
      onBack={back}
      onForward={forward}
    />
  );
  const floating = (
    element: HTMLElement,
    items: SourceNode[],
    level: number,
    label: string,
  ) => (
    <FloatingMenu
      key={level}
      anchor={element}
      level={level}
      label={label}
      onEnter={cancelLeave}
      onLeave={() => {
        leaveTimer.current = setTimeout(() => setBranches([]), 160);
      }}
    >
      {!level && (
        <button
          role="menuitem"
          className={!selected ? "source active actor-all" : "source actor-all"}
          onMouseEnter={() => setBranches([])}
          onFocus={() => setBranches([])}
          onClick={() => choose()}
        >
          {allLabel}
        </button>
      )}
      {menuItems(items, level)}
      {!items.length && <p className="hint">暂无可选角色</p>}
    </FloatingMenu>
  );
  return (
    <details
      className="actor-picker"
      ref={picker}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (!event.currentTarget.open) {
          cancelLeave();
          setBranches([]);
        }
      }}
    >
      <summary
        aria-label={label ? `${label}列表` : "角色列表"}
        aria-haspopup="menu"
        aria-expanded={open}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            picker.current!.open = true;
            setOpen(true);
            forward(-1);
          }
        }}
      >
        {selected && <ActorIcon node={selected} />}
        <strong
          className={selected ? "selected-actor" : undefined}
          style={{ color: actorTextColors[selected?.className ?? ""] }}
          title={selected ? actorTitle(selected) : allLabel}
        >
          {selected?.name ?? allLabel}
        </strong>
        {selected ? (
          <button
            type="button"
            className="actor-clear"
            aria-label={label ? `清除${label}筛选` : "清除角色筛选"}
            title={`返回${allLabel}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              choose();
            }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : (
          <ChevronDown size={16} aria-hidden="true" />
        )}
      </summary>
      {open &&
        anchor &&
        createPortal(
          <div className="actor-popups" ref={popups}>
            {floating(anchor, nodes, 0, label ?? "角色")}
            {branches.map(({ node, anchor: row }, index) =>
              floating(row, node.children, index + 1, node.name),
            )}
          </div>,
          document.body,
        )}
    </details>
  );
}
