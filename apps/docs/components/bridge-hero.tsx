export function BridgeHero() {
  return (
    <div className="bridge-hero" aria-label="A semantic graph crossing two streams through seven bridges" role="img">
      <svg viewBox="0 0 760 560" aria-hidden="true">
        <defs>
          <linearGradient id="hero-river" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="currentColor" stopOpacity=".03" />
            <stop offset=".5" stopColor="currentColor" stopOpacity=".18" />
            <stop offset="1" stopColor="currentColor" stopOpacity=".03" />
          </linearGradient>
        </defs>
        <path className="hero-river" d="M-20 173c119-67 212 52 350-8s260 46 451-23" />
        <path className="hero-river second" d="M-20 380c128-59 237 50 381-2s256 57 420-10" />
        <path className="hero-edge e1" d="M99 90c71 41 74 92 136 115" />
        <path className="hero-edge e2" d="M235 205c75-19 90-107 172-108" />
        <path className="hero-edge e3" d="M235 205c62 54 42 139 108 177" />
        <path className="hero-edge e4" d="M407 97c63 36 65 112 135 135" />
        <path className="hero-edge e5" d="M343 382c91 4 105-120 199-150" />
        <path className="hero-edge e6" d="M99 90c108-65 210-66 308 7" />
        <path className="hero-edge e7" d="M343 382c81 70 175 53 259-7" />
        <g className="hero-node n1" transform="translate(99 90)"><circle r="22" /><text y="43">goal</text></g>
        <g className="hero-node n2" transform="translate(235 205)"><circle r="22" /><text y="43">plan</text></g>
        <g className="hero-node n3" transform="translate(407 97)"><circle r="22" /><text y="43">contract</text></g>
        <g className="hero-node n4" transform="translate(343 382)"><circle r="22" /><text y="43">change</text></g>
        <g className="hero-node n5" transform="translate(542 232)"><circle r="27" /><circle r="7" /><text y="49">proof</text></g>
        <g className="hero-node n6" transform="translate(602 375)"><circle r="22" /><text y="43">integrate</text></g>
        <g className="hero-pill" transform="translate(422 296)"><rect width="126" height="34" rx="17" /><circle cx="18" cy="17" r="4" /><text x="31" y="21">edge verified</text></g>
      </svg>
      <div className="hero-telemetry telemetry-a"><span>GRAPH</span><strong>07</strong><small>crossings</small></div>
      <div className="hero-telemetry telemetry-b"><span>STATE</span><strong>live</strong><small>receipt-bound</small></div>
    </div>
  );
}
