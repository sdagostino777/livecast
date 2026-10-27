import { useBrandLogo } from "../brand";

/**
 * The install's mark and name, used on every page. When the operator uploaded a
 * logo it replaces the generated play symbol, so a clone looks like their own
 * service rather than like this project.
 */
export function BrandMark({ name, size = 38 }: { name: string; size?: number }) {
  const logoUrl = useBrandLogo();
  return (
    <div className="brand" style={{ fontSize: size * 0.55 }}>
      {logoUrl ? (
        <img
          className="brand-mark uploaded"
          src={logoUrl}
          alt=""
          style={{ width: size, height: size, borderRadius: size * 0.29 }}
        />
      ) : (
        <span className="brand-mark" style={{ width: size, height: size, borderRadius: size * 0.29 }}>
          <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} aria-hidden>
            <path d="M8 5v14l11-7z" fill="currentColor" />
          </svg>
        </span>
      )}
      <span>{name}</span>
    </div>
  );
}
