import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export default async function () {
	const checkout = process.env.PI_CHECKOUT;
	if (!checkout) throw new Error("PI_CHECKOUT must name the harness source checkout");
	const { default: base } = await import(
		pathToFileURL(resolve(checkout, "packages/coding-agent/vitest.config.ts")).href
	);
	return {
		...base,
		root: fileURLToPath(new URL(".", import.meta.url)),
		test: {
			...base.test,
			cache: false,
			include: ["extensions/**/test/*.test.ts", "extensions/**/scripts/*.test.ts", "test/**/*.test.ts"],
			exclude: ["extensions/compact-horizon/test/**"],
		},
		resolve: {
			...base.resolve,
			alias: [
				{ find: /^typebox$/, replacement: resolve(checkout, "packages/coding-agent/node_modules/typebox/build/index.mjs") },
				{ find: /^@earendil-works\/pi-coding-agent$/, replacement: resolve(checkout, "packages/coding-agent/src/index.ts") },
				...base.resolve.alias,
			],
		},
	};
}
