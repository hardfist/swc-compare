import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { compileOnce } from "./compile.mjs";
import { loaderVariants } from "./config.mjs";

const DEFAULTS = Object.freeze({
  modules: 2_000,
  warmups: 5,
  runs: 30,
});

const benchmarkDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = path.dirname(benchmarkDirectory);
const workloadDirectory = path.join(workspaceDirectory, ".benchmark-workload");
const variants = Object.keys(loaderVariants);

function positiveInteger(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const value = Number(raw);
  const minimum = allowZero ? 0 : 1;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

const settings = Object.freeze({
  modules: positiveInteger("BENCH_MODULES", DEFAULTS.modules),
  warmups: positiveInteger("BENCH_WARMUPS", DEFAULTS.warmups, {
    allowZero: true,
  }),
  runs: positiveInteger("BENCH_RUNS", DEFAULTS.runs),
});

function runProcess(arguments_, { captureJson = false } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(process.execPath, arguments_, {
      cwd: workspaceDirectory,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const processMs = performance.now() - startedAt;
      if (code !== 0) {
        reject(
          new Error(
            `Child failed (${signal ?? `exit ${code}`}):\n${stderr || stdout}`,
          ),
        );
        return;
      }

      if (!captureJson) {
        resolve({ processMs, stdout, stderr });
        return;
      }

      try {
        resolve({ ...JSON.parse(stdout), processMs });
      } catch (error) {
        reject(
          new Error(`Could not parse child output as JSON:\n${stdout}`, {
            cause: error,
          }),
        );
      }
    });
  });
}

function orderForRound(round) {
  return round % 2 === 0 ? variants : [...variants].reverse();
}

async function runColdRound(round) {
  const samples = [];
  const order = orderForRound(round);
  for (const [position, variant] of order.entries()) {
    samples.push({
      ...(await runProcess(
        [path.join(benchmarkDirectory, "run-one.mjs"), variant],
        { captureJson: true },
      )),
      round,
      position,
    });
  }
  return samples;
}

async function runWarmRound(round) {
  const samples = [];
  const order = orderForRound(round);
  for (const [position, variant] of order.entries()) {
    samples.push({
      variant,
      ...(await compileOnce(loaderVariants[variant])),
      round,
      position,
    });
  }
  return samples;
}

function percentile(sorted, ratio) {
  return sorted[Math.ceil(sorted.length * ratio) - 1];
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function summarizeNumbers(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const medianValue = median(sorted);
  const absoluteDeviations = values
    .map((value) => Math.abs(value - medianValue))
    .sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    values.length;

  return {
    median: medianValue,
    medianAbsoluteDeviation: median(absoluteDeviations),
    mean,
    p95: percentile(sorted, 0.95),
    standardDeviation: Math.sqrt(variance),
    minimum: sorted[0],
    maximum: sorted.at(-1),
  };
}

function pairedComparison(samples, metric) {
  const builtinByRound = new Map(
    samples
      .filter((sample) => sample.variant === "builtin")
      .map((sample) => [sample.round, sample[metric]]),
  );
  const ratios = samples
    .filter((sample) => sample.variant === "external")
    .map((sample) => sample[metric] / builtinByRound.get(sample.round));

  return {
    metric,
    speedup: summarizeNumbers(ratios),
    builtinWinCount: ratios.filter((ratio) => ratio > 1).length,
    pairCount: ratios.length,
  };
}

function summarize(samples, metrics) {
  return Object.fromEntries(
    variants.map((variant) => {
      const selected = samples.filter((sample) => sample.variant === variant);
      return [
        variant,
        {
          samples: selected,
          metrics: Object.fromEntries(
            metrics.map((metric) => [
              metric,
              summarizeNumbers(selected.map((sample) => sample[metric])),
            ]),
          ),
        },
      ];
    }),
  );
}

function checkOutputs(...sampleGroups) {
  const hashes = new Set(
    sampleGroups.flat().map((sample) => `${sample.hash}:${sample.outputBytes}`),
  );
  if (hashes.size !== 1) {
    throw new Error(
      `Loader outputs are not byte-identical: ${[...hashes].join(", ")}`,
    );
  }
  const [identity] = hashes;
  const separator = identity.indexOf(":");
  return {
    sha256: identity.slice(0, separator),
    bytes: Number(identity.slice(separator + 1)),
  };
}

async function verifyRuntimeOutput() {
  const bundleFile = path.join(workloadDirectory, "dist", "bundle.js");
  const expectedFile = path.join(workloadDirectory, "expected-checksum.txt");
  const [bundle, expectedText] = await Promise.all([
    readFile(bundleFile, "utf8"),
    readFile(expectedFile, "utf8"),
  ]);
  const expected = Number(expectedText.trim());
  const sandbox = {};

  vm.runInNewContext(bundle, sandbox, {
    filename: bundleFile,
    timeout: 10_000,
  });

  const actual = sandbox.__SWC_LOADER_BENCHMARK_CHECKSUM__;
  if (actual !== expected) {
    throw new Error(
      `Runtime checksum mismatch: expected ${expected}, received ${actual}`,
    );
  }
  return actual;
}

function comparison(summary, metric) {
  const builtin = summary.builtin.metrics[metric].median;
  const external = summary.external.metrics[metric].median;
  return {
    metric,
    builtinMedian: builtin,
    externalMedian: external,
    builtinSpeedup: external / builtin,
    builtinTimeReductionPercent: ((external - builtin) / external) * 100,
  };
}

function formatMilliseconds(value) {
  return `${value.toFixed(1)} ms`;
}

function printComparison(label, summary, metric) {
  const result = comparison(summary, metric);
  process.stdout.write(`\n${label}\n`);
  process.stdout.write("variant                 median       p95       mean\n");
  for (const variant of variants) {
    const values = summary[variant].metrics[metric];
    process.stdout.write(
      `${variant.padEnd(23)} ${formatMilliseconds(values.median).padStart(9)} ${formatMilliseconds(values.p95).padStart(9)} ${formatMilliseconds(values.mean).padStart(9)}\n`,
    );
  }
  process.stdout.write(
    `builtin speedup: ${result.builtinSpeedup.toFixed(2)}x (${result.builtinTimeReductionPercent.toFixed(1)}% less time)\n`,
  );
}

process.stdout.write(
  `Generating ${settings.modules} modules; warmups=${settings.warmups}, measured runs=${settings.runs} per variant\n`,
);
await runProcess([
  path.join(benchmarkDirectory, "generate-fixture.mjs"),
  `--modules=${settings.modules}`,
]);
await runProcess([path.join(benchmarkDirectory, "verify-versions.mjs")]);

process.stdout.write("Warming cold-process benchmark...\n");
for (let round = 0; round < settings.warmups; round += 1) {
  await runColdRound(round);
}

process.stdout.write("Measuring cold processes...\n");
const coldSamples = [];
for (let round = 0; round < settings.runs; round += 1) {
  coldSamples.push(...(await runColdRound(round)));
  process.stdout.write(".");
}
process.stdout.write("\n");

process.stdout.write("Warming persistent-process full builds...\n");
for (let round = 0; round < settings.warmups; round += 1) {
  await runWarmRound(round);
}

process.stdout.write("Measuring persistent-process full builds...\n");
const warmSamples = [];
for (let round = 0; round < settings.runs; round += 1) {
  warmSamples.push(...(await runWarmRound(round)));
  process.stdout.write(".");
}
process.stdout.write("\n");

process.stdout.write("Verifying output equivalence...\n");
const correctnessBuilds = [];
for (const variant of variants) {
  correctnessBuilds.push({
    variant,
    ...(await compileOnce(loaderVariants[variant], { includeOutput: true })),
  });
}
const output = checkOutputs(correctnessBuilds);
output.runtimeChecksum = await verifyRuntimeOutput();
const coldSummary = summarize(coldSamples, [
  "processMs",
  "apiMs",
  "statsMs",
  "maxRssMiB",
]);
const warmSummary = summarize(warmSamples, ["apiMs", "statsMs"]);
const results = {
  generatedAt: new Date().toISOString(),
  settings,
  environment: {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpuCount: os.cpus().length,
    totalMemoryGiB: os.totalmem() / 1024 ** 3,
  },
  versions: {
    "@rspack/core": "1.7.12",
    "@swc/core": "1.15.21",
    "swc-loader": "0.2.7",
    swc_core: "59.0.1",
  },
  output,
  cold: coldSummary,
  warm: warmSummary,
  comparison: {
    coldProcess: comparison(coldSummary, "processMs"),
    coldCompileApi: comparison(coldSummary, "apiMs"),
    warmCompileApi: comparison(warmSummary, "apiMs"),
    pairedColdProcess: pairedComparison(coldSamples, "processMs"),
    pairedColdCompileApi: pairedComparison(coldSamples, "apiMs"),
    pairedWarmCompileApi: pairedComparison(warmSamples, "apiMs"),
  },
};

await mkdir(workloadDirectory, { recursive: true });
const resultsFile = path.join(workloadDirectory, "results.json");
await writeFile(resultsFile, `${JSON.stringify(results, null, 2)}\n`, "utf8");

printComparison("Cold process (end to end)", coldSummary, "processMs");
printComparison("Cold process (Rspack API compile)", coldSummary, "apiMs");
printComparison("Warm process (new compiler, full build)", warmSummary, "apiMs");
process.stdout.write(
  `\nOutput verified byte-identical: ${output.sha256} (${output.bytes} bytes)\n`,
);
process.stdout.write(
  `Runtime checksum verified: ${output.runtimeChecksum}\n`,
);
process.stdout.write(`Raw results: ${resultsFile}\n`);
