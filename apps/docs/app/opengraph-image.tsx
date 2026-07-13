import { ImageResponse } from "next/og";

export const alt = "Köni — make agent work traversable";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  const nodes = [
    [105, 150], [235, 285], [380, 145], [135, 460], [400, 435],
  ];
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", background: "#111410", color: "#f5f2ea", padding: "68px 76px", position: "relative", overflow: "hidden", fontFamily: "Arial, sans-serif" }}>
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: "650px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "16px", fontSize: "28px", fontWeight: 700 }}>
          <div style={{ width: "42px", height: "42px", border: "2px solid #b7f34b", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "#b7f34b" }}>K</div>
          Köni <span style={{ color: "#737a70", fontWeight: 400 }}>docs</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ color: "#b7f34b", fontSize: "20px", letterSpacing: "4px", marginBottom: "18px" }}>GRAPH-COMPILED AGENT WORK</div>
          <div style={{ display: "flex", flexDirection: "column", fontFamily: "Georgia, serif", fontSize: "76px", lineHeight: 1.02, letterSpacing: "-3px" }}><span>Make the work</span><span>traversable.</span></div>
        </div>
        <div style={{ color: "#aab0a7", fontSize: "24px" }}>Intent → graph → bounded work → proof</div>
      </div>
      <div style={{ position: "absolute", right: "0", top: "0", width: "520px", height: "630px", display: "flex", background: "#171c16", borderLeft: "1px solid #31372e" }}>
        {[1, 2].map((line) => <div key={line} style={{ position: "absolute", left: 0, top: line === 1 ? 210 : 400, width: 520, height: 58, borderTop: "2px solid #46615d", borderBottom: "2px solid #46615d", transform: line === 1 ? "rotate(-4deg)" : "rotate(3deg)", opacity: .7 }} />)}
        {nodes.map(([left, top], index) => (
          <div key={index} style={{ position: "absolute", left, top, width: index === 4 ? 68 : 56, height: index === 4 ? 68 : 56, borderRadius: "50%", border: index === 4 ? "3px solid #b7f34b" : "2px solid #697164", background: "#171c16", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: "11px", height: "11px", borderRadius: "50%", background: index === 4 ? "#b7f34b" : "#f5f2ea" }} />
          </div>
        ))}
        <div style={{ position: "absolute", right: "34px", bottom: "28px", color: "#b7f34b", letterSpacing: "3px", fontSize: "14px" }}>07 CROSSINGS</div>
      </div>
    </div>,
    size,
  );
}
