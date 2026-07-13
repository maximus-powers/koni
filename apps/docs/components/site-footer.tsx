import Link from "next/link";
import { primaryNav } from "@/content/navigation";
import { site } from "@/content/site";
import { BridgeMark } from "./bridge-mark";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell footer-grid">
        <div className="footer-brand">
          <BridgeMark />
          <div><strong>Köni</strong><span>Make the work traversable.</span></div>
        </div>
        <nav aria-label="Footer navigation">
          {primaryNav.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
        </nav>
        <div className="footer-meta">
          <a href={site.repository}>GitHub</a>
          <span>Open source · MIT</span>
        </div>
      </div>
    </footer>
  );
}
