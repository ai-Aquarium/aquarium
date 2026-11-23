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

/** A tick in a circle — Make active. */
export const MakeActiveIcon = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12.5 2.5 2.5L16 9.5" />
  </Glyph>
);

/** A branch moved up onto the main line — Update onto active. */
export const RebaseIcon = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="12" r="2" />
    <path d="M6 7v10M16.2 11.1 8 6M16 12H6" />
  </Glyph>
);
