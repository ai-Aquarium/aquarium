import type { IconProps } from "@/components/ui/icons";

/** Playbook-only glyphs on the shared 24-unit, 2 px round-stroke grid. */
function Glyph({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Two columns side by side — the Compare toggle. */
export const CompareIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="3" y="4" width="7" height="16" rx="1.5" />
    <rect x="14" y="4" width="7" height="16" rx="1.5" />
  </Glyph>
);

/** Arrows both ways — swap the two compared versions. */
export const SwapIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" />
  </Glyph>
);
