import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOOTSTRAP_ITERATIONS = 100_000;
const benchmarkDirectory = path.dirname(fileURLToPath(import.meta.url));
const workloadDirectory = path.join(
  path.dirname(benchmarkDirectory),
  ".benchmark-workload",
);
const resultsFile = path.join(workloadDirectory, "results.json");
const analysisFile = path.join(workloadDirectory, "analysis.json");
const summaryFile = path.join(workloadDirectory, "summary.md");
const results = JSON.parse(await readFile(resultsFile, "utf8"));

if (results.schemaVersion !== 2) {
  throw new Error(
    `Unsupported benchmark result schema ${JSON.stringify(results.schemaVersion)}; expected 2`,
  );
}
if (
  typeof results.workload?.shapeId !== "string" ||
  !Number.isSafeInteger(results.workload?.unitCount) ||
  results.workload.unitCount < 1
) {
  throw new Error("Benchmark result is missing valid workload metadata");
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function medianAbsoluteDeviation(values) {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function percentile(sorted, ratio) {
  return sorted[Math.ceil(sorted.length * ratio) - 1];
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
}

function bootstrapMedianByPosition(pairs, seed) {
  const random = randomGenerator(seed);
  const strata = [0, 1].map((position) =>
    pairs.filter((pair) => pair.builtinPosition === position),
  );
  const bootstrapped = new Array(BOOTSTRAP_ITERATIONS);

  for (let iteration = 0; iteration < BOOTSTRAP_ITERATIONS; iteration += 1) {
    const sample = [];
    for (const stratum of strata) {
      for (let index = 0; index < stratum.length; index += 1) {
        sample.push(stratum[Math.floor(random() * stratum.length)].ratio);
      }
    }
    bootstrapped[iteration] = median(sample);
  }

  bootstrapped.sort((left, right) => left - right);
  return {
    lower: percentile(bootstrapped, 0.025),
    upper: percentile(bootstrapped, 0.975),
  };
}

function pairedSamples(section, metric) {
  const builtinByRound = new Map(
    results[section].builtin.samples.map((sample) => [sample.round, sample]),
  );
  return results[section].external.samples.map((external) => {
    const builtin = builtinByRound.get(external.round);
    return {
      ratio: external[metric] / builtin[metric],
      difference: external[metric] - builtin[metric],
      builtinPosition: builtin.position,
    };
  });
}

const scenarios = [
  ["coldProcess", "cold", "processMs", "Cold process end to end"],
  ["coldCompileApi", "cold", "apiMs", "Cold Rspack API lifecycle"],
  ["warmCompileApi", "warm", "apiMs", "Persistent-process full build"],
  ["coldMaxRss", "cold", "maxRssMiB", "Cold max RSS"],
];

const analysis = Object.fromEntries(
  scenarios.map(([key, section, metric, label], index) => {
    const pairs = pairedSamples(section, metric);
    const ratios = pairs.map((pair) => pair.ratio);
    const externalToBuiltinRatio = median(ratios);
    const lowerVariant =
      externalToBuiltinRatio >= 1 ? "builtin" : "external";
    const lowerValueReductionPercent =
      lowerVariant === "builtin"
        ? (1 - 1 / externalToBuiltinRatio) * 100
        : (1 - externalToBuiltinRatio) * 100;
    return [
      key,
      {
        label,
        metric,
        builtin: results[section].builtin.metrics[metric],
        external: results[section].external.metrics[metric],
        paired: {
          externalToBuiltinRatioMedian: externalToBuiltinRatio,
          externalToBuiltinRatioMad: medianAbsoluteDeviation(ratios),
          confidence95: bootstrapMedianByPosition(
            pairs,
            0x5f3759df + index * 0x9e3779b9,
          ),
          lowerVariant,
          lowerValueReductionPercent,
          builtinWinCount: ratios.filter((ratio) => ratio > 1).length,
          pairCount: ratios.length,
          externalMinusBuiltinMedian: median(
            pairs.map((pair) => pair.difference),
          ),
        },
      },
    ];
  }),
);

function formatBytes(bytes) {
  const units = ["bytes", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = units[0];
  for (const candidate of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = candidate;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(2)} ${unit}`;
}

function formatWorkload() {
  if (results.workload.kind === "large-file") {
    return `${formatBytes(results.workload.payloadBytes)} payload, ${results.workload.unitCount} AST units`;
  }
  return `${results.workload.payloadFiles} payload modules`;
}

function formatMeasurement(value, unit) {
  return `${value.median.toFixed(2)} ± ${value.medianAbsoluteDeviation.toFixed(2)} ${unit}`;
}

function createMarkdownSummary() {
  const rows = Object.values(analysis).map((value) => {
    const unit = value.metric === "maxRssMiB" ? "MiB" : "ms";
    const paired = value.paired;
    return `| ${value.label} | ${formatMeasurement(value.builtin, unit)} | ${formatMeasurement(value.external, unit)} | ${paired.externalToBuiltinRatioMedian.toFixed(3)}x (${paired.confidence95.lower.toFixed(3)}–${paired.confidence95.upper.toFixed(3)}) | ${paired.lowerVariant} lower by ${paired.lowerValueReductionPercent.toFixed(1)}% |`;
  });

  return `## SWC loader benchmark — ${results.workload.kind}

> Smoke benchmark on a shared runner. Ratios are diagnostic only and are not a performance gate.

| Metric | builtin median ± MAD | external median ± MAD | paired external / builtin (95% CI) | Lower value |
| --- | ---: | ---: | ---: | ---: |
${rows.join("\n")}

- Workload: ${formatWorkload()} (${results.workload.shapeId})
- Sampling: ${results.settings.warmups} warmups, ${results.settings.runs} measured pairs
- Runtime: ${results.environment.node}, ${results.environment.platform} ${results.environment.architecture}, ${results.environment.logicalCpuCount} logical CPUs
- Versions: @rspack/core ${results.versions["@rspack/core"]}, @swc/core ${results.versions["@swc/core"]}, swc-loader ${results.versions["swc-loader"]}, swc_core ${results.versions.swc_core}
- Output: ${formatBytes(results.output.bytes)}, SHA-256 \`${results.output.sha256}\`
- Runtime checksum: \`${results.output.runtimeChecksum}\` (verified)
`;
}

const markdownSummary = createMarkdownSummary();
await Promise.all([
  writeFile(analysisFile, `${JSON.stringify(analysis, null, 2)}\n`, "utf8"),
  writeFile(summaryFile, markdownSummary, "utf8"),
]);

if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, markdownSummary, "utf8");
}

for (const value of Object.values(analysis)) {
  const unit = value.metric === "maxRssMiB" ? "MiB" : "ms";
  process.stdout.write(`\n${value.label}\n`);
  process.stdout.write(
    `  builtin: ${value.builtin.median.toFixed(2)} ± ${value.builtin.medianAbsoluteDeviation.toFixed(2)} ${unit}\n`,
  );
  process.stdout.write(
    `  external: ${value.external.median.toFixed(2)} ± ${value.external.medianAbsoluteDeviation.toFixed(2)} ${unit}\n`,
  );
  process.stdout.write(
    `  paired external/builtin ratio: ${value.paired.externalToBuiltinRatioMedian.toFixed(3)}x (95% CI ${value.paired.confidence95.lower.toFixed(3)}–${value.paired.confidence95.upper.toFixed(3)}), ${value.paired.builtinWinCount}/${value.paired.pairCount} builtin wins\n`,
  );
}

process.stdout.write(`\nAnalysis: ${analysisFile}\n`);
process.stdout.write(`Summary: ${summaryFile}\n`);
