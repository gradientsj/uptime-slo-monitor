import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/**
 * Loads and validates services.yaml. The merged, per-service config (defaults
 * applied) is what the rest of the system consumes.
 */

const StatusList = z.array(z.number().int()).min(1);

const Defaults = z.object({
  method: z.string().default("GET"),
  expect_status: StatusList.default([200, 204]),
  timeout_ms: z.number().int().positive().default(5000),
  window_days: z.number().int().positive().default(30),
  availability_target: z.number().gt(0).lt(1).default(0.99),
  latency_percentile: z.number().int().min(1).max(99).default(95),
  latency_target_ms: z.number().positive().default(800),
});

const ServiceInput = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "name must be lowercase kebab/snake case"),
  description: z.string().optional(),
  url: z.string().url(),
  method: z.string().optional(),
  expect_status: StatusList.optional(),
  timeout_ms: z.number().int().positive().optional(),
  window_days: z.number().int().positive().optional(),
  availability_target: z.number().gt(0).lt(1).optional(),
  latency_percentile: z.number().int().min(1).max(99).optional(),
  latency_target_ms: z.number().positive().optional(),
});

const ConfigInput = z.object({
  defaults: Defaults.optional(),
  services: z.array(ServiceInput).min(1),
});

export type ServiceConfig = {
  name: string;
  description?: string;
  url: string;
  method: string;
  expect_status: number[];
  timeout_ms: number;
  window_days: number;
  availability_target: number;
  latency_percentile: number;
  latency_target_ms: number;
};

export type LoadedConfig = {
  services: ServiceConfig[];
};

let cache: LoadedConfig | undefined;

export function loadServices(force = false): LoadedConfig {
  if (cache && !force) return cache;

  const path = join(process.cwd(), process.env.SERVICES_CONFIG ?? "services.yaml");
  const raw = parse(readFileSync(path, "utf8"));
  const parsed = ConfigInput.parse(raw);
  const defaults = Defaults.parse(parsed.defaults ?? {});

  const seen = new Set<string>();
  const services: ServiceConfig[] = parsed.services.map((s) => {
    if (seen.has(s.name)) throw new Error(`duplicate service name: ${s.name}`);
    seen.add(s.name);
    return {
      name: s.name,
      description: s.description,
      url: s.url,
      method: s.method ?? defaults.method,
      expect_status: s.expect_status ?? defaults.expect_status,
      timeout_ms: s.timeout_ms ?? defaults.timeout_ms,
      window_days: s.window_days ?? defaults.window_days,
      availability_target: s.availability_target ?? defaults.availability_target,
      latency_percentile: s.latency_percentile ?? defaults.latency_percentile,
      latency_target_ms: s.latency_target_ms ?? defaults.latency_target_ms,
    };
  });

  cache = { services };
  return cache;
}

export function getService(name: string): ServiceConfig | undefined {
  return loadServices().services.find((s) => s.name === name);
}
