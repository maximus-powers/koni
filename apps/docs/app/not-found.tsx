import Link from "next/link";
import { BridgeMark } from "@/components/bridge-mark";

export default function NotFound() {
  return (
    <section className="not-found shell">
      <BridgeMark />
      <span>404 · Missing crossing</span>
      <h1>This bridge is not in the graph.</h1>
      <p>The document may have moved, or the edge was never compiled.</p>
      <Link className="button button-primary" href="/">Return home</Link>
    </section>
  );
}
