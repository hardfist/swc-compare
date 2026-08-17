import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MODULE_COUNT = 2_000;
const benchmarkDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = path.dirname(benchmarkDirectory);
const sourceDirectory = path.join(
  workspaceDirectory,
  ".benchmark-workload",
  "src",
);
const expectedChecksumFile = path.join(
  workspaceDirectory,
  ".benchmark-workload",
  "expected-checksum.txt",
);

function parseModuleCount(arguments_) {
  let rawCount;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (argument === "--modules") {
      rawCount = arguments_[index + 1];
      index += 1;
    } else if (argument.startsWith("--modules=")) {
      rawCount = argument.slice("--modules=".length);
    } else {
      throw new TypeError(`Unknown argument: ${argument}`);
    }
  }

  const moduleCount = rawCount ?? DEFAULT_MODULE_COUNT;

  if (
    !/^\d+$/.test(String(moduleCount)) ||
    !Number.isSafeInteger(Number(moduleCount)) ||
    Number(moduleCount) < 1
  ) {
    throw new TypeError("--modules must be a positive integer");
  }

  return Number(moduleCount);
}

function moduleName(index) {
  return `module-${String(index).padStart(5, "0")}`;
}

function exportName(index) {
  return `value${String(index).padStart(5, "0")}`;
}

function createModule(index) {
  const typeSuffix = String(index).padStart(5, "0");
  const seed = (index * 2_654_435_761) >>> 0;

  return `export interface Payload${typeSuffix} {
  readonly id: number;
  label?: string;
  meta?: {
    enabled?: boolean;
    weights?: readonly number[];
  };
}

type Mutable${typeSuffix}<T> = {
  -readonly [Key in keyof T]-?: T[Key];
};

const defaults${typeSuffix}: Payload${typeSuffix} = {
  id: ${index},
  label: "fixture-${typeSuffix}",
  meta: { enabled: ${index % 2 === 0}, weights: [${index % 7}, ${(index + 3) % 11}, ${(index + 5) % 13}] },
} satisfies Payload${typeSuffix};

class Transformer${typeSuffix}<T extends Payload${typeSuffix}> {
  #history: number[] = [];

  constructor(
    private readonly seed: number,
    private readonly fallback: T,
  ) {}

  transform(input?: Partial<T>): Mutable${typeSuffix}<Payload${typeSuffix}> {
    const merged = {
      ...this.fallback,
      ...input,
      meta: { ...this.fallback.meta, ...input?.meta },
    };
    const weighted = merged.meta?.weights?.reduce(
      (total, weight, position) => total + weight * (position + 1),
      0,
    ) ?? this.seed;
    const score = (weighted ^ this.seed) >>> 0;
    this.#history.push(score);

    return {
      id: merged.id ?? this.seed,
      label:
        (merged.label ?? "item-" + this.seed) + "-" + score.toString(36),
      meta: {
        enabled: merged.meta?.enabled ?? true,
        weights: [...(merged.meta?.weights ?? []), score],
      },
    };
  }

  get latest(): number {
    return this.#history.at(-1) ?? this.seed;
  }
}

const transformer${typeSuffix} = new Transformer${typeSuffix}(${seed}, defaults${typeSuffix});
const transformed${typeSuffix} = transformer${typeSuffix}.transform({
  label: defaults${typeSuffix}.label?.toUpperCase(),
});

export const ${exportName(index)} =
  transformed${typeSuffix}.id +
  transformed${typeSuffix}.label.length +
  transformer${typeSuffix}.latest;
`;
}

function calculateValue(index) {
  const seed = (index * 2_654_435_761) >>> 0;
  const weights = [index % 7, (index + 3) % 11, (index + 5) % 13];
  const weighted = weights.reduce(
    (total, weight, position) => total + weight * (position + 1),
    0,
  );
  const score = (weighted ^ seed) >>> 0;
  const label = `FIXTURE-${String(index).padStart(5, "0")}-${score.toString(36)}`;
  return index + label.length + score;
}

function createEntry(moduleCount) {
  const imports = [];
  const values = [];

  for (let index = 0; index < moduleCount; index += 1) {
    const name = exportName(index);
    imports.push(`import { ${name} } from "./${moduleName(index)}";`);
    values.push(name);
  }

  return `${imports.join("\n")}

const values: readonly number[] = [
  ${values.join(",\n  ")},
];

export const checksum = values.reduce(
  (total, value, index) => (total + Math.imul(value, index + 1)) >>> 0,
  0,
);

export default checksum;

globalThis.__SWC_LOADER_BENCHMARK_CHECKSUM__ = checksum;
`;
}

function calculateExpectedChecksum(moduleCount) {
  let checksum = 0;
  for (let index = 0; index < moduleCount; index += 1) {
    checksum =
      (checksum + Math.imul(calculateValue(index), index + 1)) >>> 0;
  }
  return checksum;
}

async function generateFixture(moduleCount) {
  await rm(sourceDirectory, { recursive: true, force: true });
  await mkdir(sourceDirectory, { recursive: true });

  const writes = [];
  for (let index = 0; index < moduleCount; index += 1) {
    writes.push(
      writeFile(
        path.join(sourceDirectory, `${moduleName(index)}.ts`),
        createModule(index),
        "utf8",
      ),
    );
  }

  writes.push(
    writeFile(
      path.join(sourceDirectory, "index.ts"),
      createEntry(moduleCount),
      "utf8",
    ),
  );
  writes.push(
    writeFile(
      expectedChecksumFile,
      `${calculateExpectedChecksum(moduleCount)}\n`,
      "utf8",
    ),
  );

  await Promise.all(writes);
  process.stdout.write(
    `Generated ${moduleCount} TypeScript modules in ${sourceDirectory}\n`,
  );
}

await generateFixture(parseModuleCount(process.argv.slice(2)));
