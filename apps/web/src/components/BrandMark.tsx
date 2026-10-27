/** The square logo mark + name, used on every page with the configured brand. */
export function BrandMark({ name, size = 38 }: { name: string; size?: number }) {
  return (
    <div className="brand" style={{ fontSize: size * 0.55 }}>
      <span className="brand-mark" style={{ width: size, height: size, borderRadius: size * 0.29 }}>
        <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} aria-hidden>
          <path d="M8 5v14l11-7z" fill="currentColor" />
        </svg>
      </span>
      <span>{name}</span>
    </div>
  );
}
