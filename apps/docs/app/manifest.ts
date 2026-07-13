import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Köni Documentation",
    short_name: "Köni",
    description: "Graph-compiled agent work.",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f2ea",
    theme_color: "#b7f34b",
  };
}
