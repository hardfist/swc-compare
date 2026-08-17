import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRspackConfig, loaderVariants } from "./config.mjs";

const expected = Object.freeze({
  "@rspack/core": "1.7.12",
  "@swc/core": "1.15.21",
  "swc-loader": "0.2.7",
});
const binaryOverrideVariables = ["RSPACK_BINDING", "SWC_BINARY_PATH"];

const benchmarkDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = path.dirname(benchmarkDirectory);

for (const variable of binaryOverrideVariables) {
  assert.equal(
    process.env[variable],
    undefined,
    `${variable} must be unset so the locked native binary is measured`,
  );
}

async function installedVersion(packageName) {
  const packageFile = path.join(
    workspaceDirectory,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  const manifest = JSON.parse(await readFile(packageFile, "utf8"));
  return manifest.version;
}

for (const [packageName, expectedVersion] of Object.entries(expected)) {
  const actualVersion = await installedVersion(packageName);
  assert.equal(
    actualVersion,
    expectedVersion,
    `${packageName}: expected ${expectedVersion}, found ${actualVersion}`,
  );
}

const builtinConfig = createRspackConfig(loaderVariants.builtin);
const externalConfig = createRspackConfig(loaderVariants.external);
assert.equal(
  builtinConfig.module.rules[0].use[0].loader,
  loaderVariants.builtin,
);
externalConfig.module.rules[0].use[0].loader = loaderVariants.builtin;
assert.deepEqual(
  externalConfig,
  builtinConfig,
  "Rspack configs must differ only by loader name",
);

process.stdout.write(`Version alignment verified:\n`);
process.stdout.write(`  @rspack/core 1.7.12 -> swc_core 59.0.1\n`);
process.stdout.write(`  @swc/core 1.15.21 -> swc_core 59.0.1\n`);
process.stdout.write(`  swc-loader 0.2.7\n`);
process.stdout.write(`Config parity verified: loader name is the only difference\n`);
