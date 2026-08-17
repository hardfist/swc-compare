import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MODULE_COUNT = 2_000;
const MAX_LARGE_FILE_BYTES = 64 * 1024 * 1024;
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
const fixtureMetadataFile = path.join(
  workspaceDirectory,
  ".benchmark-workload",
  "fixture-metadata.json",
);

function positiveInteger(name, raw, fallback, { maximum } = {}) {
  const value = raw ?? fallback;

  if (
    !/^\d+$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1 ||
    (maximum !== undefined && Number(value) > maximum)
  ) {
    const maximumMessage = maximum === undefined ? "" : ` and <= ${maximum}`;
    throw new TypeError(`${name} must be an integer >= 1${maximumMessage}`);
  }

  return Number(value);
}

function parseArguments(arguments_) {
  let rawCount;
  let rawLargeFileBytes;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (argument === "--modules") {
      if (arguments_[index + 1] === undefined) {
        throw new TypeError("--modules requires a value");
      }
      rawCount = arguments_[index + 1];
      index += 1;
    } else if (argument.startsWith("--modules=")) {
      rawCount = argument.slice("--modules=".length);
    } else if (argument === "--large-file-bytes") {
      if (arguments_[index + 1] === undefined) {
        throw new TypeError("--large-file-bytes requires a value");
      }
      rawLargeFileBytes = arguments_[index + 1];
      index += 1;
    } else if (argument.startsWith("--large-file-bytes=")) {
      rawLargeFileBytes = argument.slice("--large-file-bytes=".length);
    } else {
      throw new TypeError(`Unknown argument: ${argument}`);
    }
  }

  if (rawCount !== undefined && rawLargeFileBytes !== undefined) {
    throw new TypeError(
      "--modules and --large-file-bytes are mutually exclusive",
    );
  }

  if (rawLargeFileBytes !== undefined) {
    return {
      kind: "large-file",
      bytes: positiveInteger(
        "--large-file-bytes",
        rawLargeFileBytes,
        undefined,
        { maximum: MAX_LARGE_FILE_BYTES },
      ),
    };
  }

  return {
    kind: "many-modules",
    modules: positiveInteger("--modules", rawCount, DEFAULT_MODULE_COUNT),
  };
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

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

const LARGE_FOOTER_PREFIX = `const values: readonly number[] = [
  `;
const LARGE_FOOTER_SEPARATOR = ",\n  ";
const LARGE_FOOTER_SUFFIX = `,
];

export const checksum = values.reduce(
  (total, value, index) => (total + Math.imul(value, index + 1)) >>> 0,
  0,
);

export default checksum;
`;

function createLargeFooter(unitCount) {
  const values = Array.from({ length: unitCount }, (_, index) =>
    exportName(index),
  );

  return `${LARGE_FOOTER_PREFIX}${values.join(
    LARGE_FOOTER_SEPARATOR,
  )}${LARGE_FOOTER_SUFFIX}`;
}

function createLargeEntry() {
  return `import checksum from "./large-payload";

export { checksum };
export default checksum;

globalThis.__SWC_LOADER_BENCHMARK_CHECKSUM__ = checksum;
`;
}

function createLargePayload(targetBytes) {
  const blocks = [];
  let blocksBytes = 0;
  let valueNamesBytes = 0;
  let unitCount = 0;

  while (true) {
    const block = createModule(unitCount);
    const nextCount = unitCount + 1;
    const nextBlocksBytes = blocksBytes + Buffer.byteLength(block);
    const nextValueNamesBytes =
      valueNamesBytes + Buffer.byteLength(exportName(unitCount));
    const footerBytes =
      Buffer.byteLength(LARGE_FOOTER_PREFIX) +
      nextValueNamesBytes +
      (nextCount - 1) * Buffer.byteLength(LARGE_FOOTER_SEPARATOR) +
      Buffer.byteLength(LARGE_FOOTER_SUFFIX);
    const candidateBytes =
      nextBlocksBytes +
      (nextCount - 1) +
      1 +
      footerBytes;

    if (candidateBytes > targetBytes && blocks.length > 0) {
      break;
    }

    blocks.push(block);
    blocksBytes = nextBlocksBytes;
    valueNamesBytes = nextValueNamesBytes;
    unitCount = nextCount;

    if (candidateBytes >= targetBytes) {
      break;
    }
  }

  const payload = `${blocks.join("\n")}\n${createLargeFooter(unitCount)}`;
  const currentBytes = Buffer.byteLength(payload);
  if (currentBytes > targetBytes) {
    throw new RangeError(
      `--large-file-bytes is too small; minimum is ${currentBytes}`,
    );
  }

  return {
    content: `${payload}${" ".repeat(targetBytes - currentBytes)}`,
    paddingBytes: targetBytes - currentBytes,
    unitCount,
  };
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
      fixtureMetadataFile,
      `${JSON.stringify(
        {
          kind: "many-modules",
          shapeId: "standard-ts-modules-v1",
          unitCount: moduleCount,
        },
        null,
        2,
      )}\n`,
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

async function generateLargeFixture(targetBytes) {
  const { content, paddingBytes, unitCount } = createLargePayload(targetBytes);
  const entry = createLargeEntry();

  await rm(sourceDirectory, { recursive: true, force: true });
  await mkdir(sourceDirectory, { recursive: true });

  await Promise.all([
    writeFile(path.join(sourceDirectory, "large-payload.ts"), content, "utf8"),
    writeFile(path.join(sourceDirectory, "index.ts"), entry, "utf8"),
    writeFile(
      expectedChecksumFile,
      `${calculateExpectedChecksum(unitCount)}\n`,
      "utf8",
    ),
    writeFile(
      fixtureMetadataFile,
      `${JSON.stringify(
        {
          kind: "large-file",
          shapeId: "concatenated-standard-units-v1",
          unitCount,
          paddingBytes,
          payloadSha256: sha256(content),
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
  ]);

  process.stdout.write(
    `Generated ${targetBytes}-byte TypeScript payload with ${unitCount} AST units in ${sourceDirectory}\n`,
  );
}

const settings = parseArguments(process.argv.slice(2));
if (settings.kind === "large-file") {
  await generateLargeFixture(settings.bytes);
} else {
  await generateFixture(settings.modules);
}
