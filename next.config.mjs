/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output keeps the Docker image small and lets the same build
  // run on Vercel or in a container on GKE.
  output: "standalone",
  experimental: {
    // The probe and metrics routes use the `postgres` driver (Node APIs).
    serverComponentsExternalPackages: ["postgres"],
    // services.yaml is read from disk at runtime via fs. Next.js doesn't trace
    // it as a dependency, so on serverless (Vercel) it isn't bundled into the
    // function and process.cwd() can't find it. Force it (and the SQL
    // migrations the worker image may run) into every function's bundle.
    outputFileTracingIncludes: {
      "/**": ["./services.yaml"],
    },
  },
};

export default nextConfig;
