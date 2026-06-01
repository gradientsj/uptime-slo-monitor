/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output keeps the Docker image small and lets the same build
  // run on Vercel or in a container on GKE.
  output: "standalone",
  experimental: {
    // The probe and metrics routes use the `postgres` driver (Node APIs).
    serverComponentsExternalPackages: ["postgres"],
  },
};

export default nextConfig;
