import path from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = path.dirname(benchmarkDirectory);

export const loaderVariants = Object.freeze({
  builtin: "builtin:swc-loader",
  external: "swc-loader",
});

const supportedLoaders = new Set(Object.values(loaderVariants));

const swcOptions = Object.freeze({
  swcrc: false,
  configFile: false,
  jsc: {
    experimental: {
      disableAllLints: true,
    },
    parser: {
      syntax: "typescript",
      tsx: false,
      decorators: false,
    },
    target: "es2018",
  },
  module: {
    type: "es6",
  },
  minify: false,
  sourceMaps: false,
});

/**
 * Create either benchmark configuration. The loader is the sole varying input;
 * every other Rspack and SWC option is shared by both variants.
 */
export function createRspackConfig(loader) {
  if (!supportedLoaders.has(loader)) {
    throw new TypeError(
      `Unsupported loader ${JSON.stringify(loader)}. Expected one of: ${[
        ...supportedLoaders,
      ].join(", ")}`,
    );
  }

  return {
    context: workspaceDirectory,
    mode: "development",
    cache: false,
    devtool: false,
    entry: path.join(workspaceDirectory, ".benchmark-workload/src/index.ts"),
    output: {
      path: path.join(workspaceDirectory, ".benchmark-workload/dist"),
      filename: "bundle.js",
      clean: true,
      pathinfo: false,
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: [
            {
              loader,
              // Rspack normalizes builtin loader options in place, so each
              // compiler must receive a fresh object to avoid cross-run state.
              options: structuredClone(swcOptions),
            },
          ],
        },
      ],
    },
    resolve: {
      extensions: [".ts", ".js"],
    },
    optimization: {
      chunkIds: "deterministic",
      moduleIds: "named",
      minimize: false,
    },
  };
}
