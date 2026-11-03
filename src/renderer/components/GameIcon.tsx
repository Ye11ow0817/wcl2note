import { useState } from "react";
import unknownIcon from "../assets/icons/inv_misc_questionmark.jpg?inline";
import type { SourceNode } from "../../domain/model";
import { classIcons, iconSource, type IconFolder } from "../../shared/icons";
import { wowheadSpellLink } from "../integrations/wowhead-links";

export function GameIcon({
  icon,
  folder = "abilities",
  className = "",
  fallbackIcon,
  spellId,
}: {
  icon?: string | null;
  folder?: IconFolder;
  className?: string;
  fallbackIcon?: string;
  spellId?: number;
}) {
  const [failed, setFailed] = useState(new Set<string>());
  const src = [iconSource(icon, folder), iconSource(fallbackIcon, folder)].find(
    (candidate) => candidate && !failed.has(candidate),
  );
  const image = (
    <img
      src={src ?? unknownIcon}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={
        src ? () => setFailed((old) => new Set([...old, src])) : undefined
      }
    />
  );
  const link = spellId == null ? undefined : wowheadSpellLink(spellId);
  return link ? (
    <a
      className={`game-icon ${className}`}
      {...link}
      aria-hidden="true"
      tabIndex={-1}
      draggable={false}
      onClick={(event) => {
        event.preventDefault();
        // An anchor is interactive label content, so preserve the old icon's
        // checkbox action explicitly instead of relying on label activation.
        event.currentTarget
          .closest("label")
          ?.querySelector<HTMLInputElement>(
            "input[type=checkbox]:not(:disabled)",
          )
          ?.click();
      }}
    >
      {image}
    </a>
  ) : (
    <span className={`game-icon ${className}`} aria-hidden="true">
      {image}
    </span>
  );
}

export function ActorIcon({
  node,
}: {
  node: Pick<SourceNode, "player" | "className" | "specIcon">;
}) {
  if (!node.player) return null;
  return (
    <GameIcon
      icon={node.specIcon ?? classIcons[node.className ?? ""]}
      fallbackIcon={classIcons[node.className ?? ""]}
      folder="icons"
      className="actor-icon"
    />
  );
}
