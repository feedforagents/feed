import type { SVGProps } from "react";

export const FEED_MARK_PATH =
  "M27 17H73Q90 17 90 34V64Q90 80 73 80H43L23 93V79Q10 76 10 63V34Q10 17 27 17Z M32 42A5 5 0 0 1 42 42V55A5 5 0 0 1 32 55Z M58 42A5 5 0 0 1 68 42V55A5 5 0 0 1 58 55Z";

export const FEED_WORDMARK_PATHS = [
  { x: 0, d: "M43 13C26 8 22 19 22 33V80M8 36H43" },
  { x: 53, d: "M12 52H48C48 20 10 20 10 52C10 80 36 87 49 70" },
  { x: 112, d: "M12 52H48C48 20 10 20 10 52C10 80 36 87 49 70" },
  { x: 171, d: "M48 12V80M48 52C48 20 10 20 10 52C10 85 48 85 48 52" },
] as const;

export const FEED_DOMAIN_PATHS = [
  { x: 256, d: "M43 13C26 8 22 19 22 33V80M8 36H43" },
  { x: 309, d: "M10 34V60C10 89 47 89 47 60V34" },
  { x: 368, d: "M10 80V34M10 54C10 26 47 26 47 54V80" },
] as const;

/** Peep speech-bubble silhouette with transparent eye cutouts. */
export function FeedMark(props: SVGProps<SVGGElement>) {
  return (
    <g {...props}>
      <path d={FEED_MARK_PATH} fill="currentColor" fillRule="evenodd" />
    </g>
  );
}

/** Feed mascot icon inheriting the surrounding text color. */
export function FeedIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" className={className} aria-hidden="true" {...props}>
      <FeedMark />
    </svg>
  );
}

export type FeedFullLogoProps = SVGProps<SVGSVGElement> & {
  /** Include the `.fun` domain suffix next to the wordmark. */
  domain?: boolean;
};

/** Peep mascot paired with the custom Feed wordmark. */
export function FeedFullLogo({ className, domain = false, ...props }: FeedFullLogoProps) {
  const letters = domain ? [...FEED_WORDMARK_PATHS, ...FEED_DOMAIN_PATHS] : FEED_WORDMARK_PATHS;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${domain ? 549 : 353} 108`}
      className={className}
      aria-hidden="true"
      {...props}
    >
      <FeedMark transform="translate(4 9) scale(.88)" />
      <g
        transform="translate(110 8)"
        fill="none"
        stroke="currentColor"
        strokeWidth="11"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {letters.map(({ x, d }) => (
          <path key={x} transform={`translate(${x} 0)`} d={d} />
        ))}
        {domain && <circle cx="238" cy="78" r="6" fill="currentColor" stroke="none" />}
      </g>
    </svg>
  );
}

export type HouseIconProps = SVGProps<SVGSVGElement> & {
  /** Render the solid active variant when true or when `fill` is not `"none"`. */
  active?: boolean;
};

/** Home navigation icon that renders filled when active and stroked when inactive. */
export function HouseIcon({ className, active, fill = "none", ...props }: HouseIconProps) {
  const isFilled = active ?? fill !== "none";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill={isFilled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M21.591 7.146L12.52 1.157c-.316-.21-.724-.21-1.04 0l-9.071 5.99c-.26.173-.409.456-.409.757v13.183c0 .502.418.913.929.913H9.14c.51 0 .929-.41.929-.913v-7.075h3.909v7.075c0 .502.417.913.928.913h6.165c.511 0 .929-.41.929-.913V7.904c0-.301-.158-.584-.408-.758z" />
    </svg>
  );
}

export type BrandMarkProps = SVGProps<SVGSVGElement> & {
  /** Which lockup variant to render. */
  variant?: "icon" | "logo" | "domain";
};

/** Feed brand lockup combining the Peep icon and optional wordmark. */
export function BrandMark({ variant = "logo", className, ...props }: BrandMarkProps) {
  if (variant === "icon") {
    return <FeedIcon className={className} {...props} />;
  }
  return <FeedFullLogo domain={variant === "domain"} className={className} {...props} />;
}
