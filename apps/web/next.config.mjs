/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { remotePatterns: [{ protocol: "https", hostname: "**" }] },
  experimental: { typedRoutes: false },
  transpilePackages: ["@ostra/shared"],
};
export default nextConfig;
