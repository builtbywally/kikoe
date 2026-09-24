// The pieces the app is made of, as it draws them (renderer/room/room.css):
// the logo, the pin with its head, body and foot. No state here, so they
// render on the server and cost no JavaScript.

import type { ReactNode } from "react";
import { KOE } from "./koe";

/**
 * The logo: こえ, "voice", as outlines (brand/make.mjs). `size` is its height;
 * under 28px it takes the heavier cut, whose strokes survive being small.
 */
export function Logo({ size = 22, label }: { size?: number; label?: string }) {
  const g = size < 28 ? KOE[700] : KOE[500];
  return (
    <span className="tb-logo">
      {label ? (
        <svg
          viewBox={`0 0 ${g.w} ${g.h}`}
          height={size}
          width={Math.round((size * g.w) / g.h)}
          role="img"
        >
          <title>{label}</title>
          <path fill="currentColor" d={g.d} />
        </svg>
      ) : (
        <svg
          viewBox={`0 0 ${g.w} ${g.h}`}
          height={size}
          width={Math.round((size * g.w) / g.h)}
          aria-hidden="true"
        >
          <path fill="currentColor" d={g.d} />
        </svg>
      )}
    </span>
  );
}

export function Pin({
  title,
  icon,
  age,
  asking,
  className,
  style,
  children,
  foot,
  headProps,
}: {
  title: ReactNode;
  icon?: ReactNode;
  age?: ReactNode;
  asking?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children?: ReactNode;
  foot?: ReactNode;
  headProps?: React.HTMLAttributes<HTMLDivElement>;
}) {
  return (
    <div className={className ? `pin ${className}` : "pin"} data-asking={asking} style={style}>
      <div className="pin-head" {...headProps}>
        <span className="title">
          {icon}
          {title}
        </span>
        {age != null && <span className="age">{age}</span>}
      </div>
      {children != null && <div className="pin-body">{children}</div>}
      {foot != null && <div className="pin-foot">{foot}</div>}
    </div>
  );
}

/** "◆ live" and "◆ with you" in a card's corner. */
export function Live({ children = "live" }: { children?: ReactNode }) {
  return (
    <>
      <span className="diamond">◆</span> {children}
    </>
  );
}
