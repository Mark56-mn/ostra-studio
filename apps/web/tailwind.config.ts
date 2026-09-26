import type { Config } from "tailwindcss";
const config: Config = {
  content: [
    "./src/**/*.{ts,tsx}",
    "../../packages/shared/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ostra: {
          bg: "#070A14",
          surface: "#0F1425",
          card: "#131A32",
          muted: "#6B7594",
          border: "#1E2947",
          accent: "#FF4D5A",
          accent2: "#3DE0B3",
          warn: "#FFB84D",
        },
      },
      fontFamily: {
        display: ["Geist", "system-ui", "sans-serif"],
        mono: ["Geist Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
