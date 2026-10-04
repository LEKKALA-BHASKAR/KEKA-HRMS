import type { MetadataRoute } from "next";

/**
 * Lets people add the clock-in page to their phone's home screen and open it
 * full screen, like an app.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BooS-HR — Clock in",
    short_name: "Clock in",
    description: "Clock in and out from your phone",
    start_url: "/me/clock",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#3b66f6",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
