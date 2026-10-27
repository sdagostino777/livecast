import { navigate } from "../router";
import { useBrand } from "../brand";
import { BrandMark } from "../components/BrandMark";

/** The public face of the install: a door to the player and to the panel. */
export function Landing() {
  const brand = useBrand();
  return (
    <div className="landing">
      <div className="landing-brand">
        <BrandMark name={brand} size={44} />
      </div>
      <p className="muted">Trasmissioni in diretta. Apri il link della diretta che ti hanno condiviso.</p>
      <div className="landing-actions">
        <button className="btn btn-ghost" onClick={() => navigate("/admin")}>
          Area conduttore
        </button>
      </div>
    </div>
  );
}
