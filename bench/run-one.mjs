import { compileOnce } from "./compile.mjs";
import { loaderVariants } from "./config.mjs";

const variant = process.argv[2];
const loader = loaderVariants[variant];

if (!loader) {
  throw new TypeError(
    `Expected one variant (${Object.keys(loaderVariants).join(" or ")}), received ${JSON.stringify(variant)}`,
  );
}

const result = await compileOnce(loader);

process.stdout.write(
  `${JSON.stringify({
    variant,
    ...result,
    maxRssMiB: process.resourceUsage().maxRSS / 1024,
  })}\n`,
);
