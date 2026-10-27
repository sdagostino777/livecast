import { navigate } from "../router";

/** The public face of the install: a door to the player and to the panel. */
export function Landing() {
  return (
    <div className="landing">
      <div className="landing-brand">
        <span className="dot" aria-hidden />
        NDX <b>Live</b>
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
