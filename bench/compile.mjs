import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { rspack } from "@rspack/core";
import { createRspackConfig } from "./config.mjs";

function runCompiler(compiler) {
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      if (error) {
        reject(error);
        return;
      }

      if (!stats) {
        reject(new Error("Rspack completed without returning stats"));
        return;
      }

      if (stats.hasErrors()) {
        const details = stats.toString({
          all: false,
          errors: true,
          errorDetails: true,
          colors: false,
        });
        reject(new Error(details));
        return;
      }

      resolve(stats);
    });
  });
}

function closeCompiler(compiler) {
  return new Promise((resolve, reject) => {
    compiler.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function compileOnce(loader, { includeOutput = false } = {}) {
  const config = createRspackConfig(loader);
  const startedAt = performance.now();
  const compiler = rspack(config);
  let stats;

  try {
    stats = await runCompiler(compiler);
  } finally {
    await closeCompiler(compiler);
  }

  const apiMs = performance.now() - startedAt;
  const statsMs = stats.endTime - stats.startTime;
  const result = {
    apiMs,
    statsMs,
  };

  if (includeOutput) {
    const outputFile = path.join(config.output.path, config.output.filename);
    const output = await readFile(outputFile);
    result.hash = createHash("sha256").update(output).digest("hex");
    result.outputBytes = output.byteLength;
  }

  return result;
}
