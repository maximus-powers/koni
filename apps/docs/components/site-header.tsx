import Link from "next/link";
import { primaryNav } from "@/content/navigation";
import { site } from "@/content/site";
import { GithubIcon } from "@/lib/icons";
import { BridgeMark } from "./bridge-mark";
import { SearchDialog } from "./search-dialog";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Link className="wordmark" href="/" aria-label="Köni documentation home">
          <BridgeMark />
          <span>Köni</span>
          <small>docs</small>
        </Link>
        <nav className="desktop-nav" aria-label="Primary navigation">
          {primaryNav.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
        </nav>
        <div className="header-actions">
          <SearchDialog />
          <a className="github-link" href={site.repository} aria-label="Köni on GitHub">
            <GithubIcon />
          </a>
        </div>
      </div>
      <nav className="mobile-nav shell" aria-label="Mobile navigation">
        {primaryNav.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
      </nav>
    </header>
  );
}
