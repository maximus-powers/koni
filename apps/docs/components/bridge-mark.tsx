type BridgeMarkProps = {
  className?: string;
  title?: string;
};

export function BridgeMark({ className, title = "Köni bridge graph" }: BridgeMarkProps) {
  return (
    <svg className={className} viewBox="0 0 42 42" role="img" aria-label={title}>
      <path className="mark-water" d="M4 14c7 0 7 3 14 3s7-3 14-3 7 3 7 3M4 27c7 0 7 3 14 3s7-3 14-3 7 3 7 3" fill="none" />
      <path className="mark-bridge" d="M11 8v9m0 9v8M21 9v8m0 12v5M31 8v7m0 13v6M14 21h14" fill="none" />
      <circle className="mark-node" cx="11" cy="8" r="2" />
      <circle className="mark-node" cx="21" cy="9" r="2" />
      <circle className="mark-node" cx="31" cy="8" r="2" />
      <circle className="mark-node" cx="14" cy="21" r="2" />
      <circle className="mark-node" cx="28" cy="21" r="2" />
      <circle className="mark-node" cx="11" cy="34" r="2" />
      <circle className="mark-node" cx="21" cy="34" r="2" />
      <circle className="mark-node" cx="31" cy="34" r="2" />
    </svg>
  );
}
