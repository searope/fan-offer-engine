import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Agent SDK spawns a bundled Claude Code binary; keep it out of the server bundle.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
