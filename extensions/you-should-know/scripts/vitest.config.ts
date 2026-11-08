import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export default async function () {
	const checkout = process.env.PI_BTW_CHECKOUT;
	if (!checkout) throw new Error("PI_BTW_CHECKOUT must name the Pi source checkout");
	const { default: base } = await import(
		pathToFileURL(resolve(checkout, "packages/coding-agent/vitest.config.ts")).href
	);
	return {
		...base,
		root: fileURLToPath(new URL("..", import.meta.url)),
		test: {
			...base.test,
			cache: false,
			silent: false,
			include: [
				"scripts/*.test.ts",
				"../llamacpp-router/test/openai-format.test.ts",
				"../llamacpp-router/test/stream.test.ts",
				"../vllm-router/test/stream.test.ts",
			],
		},
		resolve: {
			...base.resolve,
			alias: [
				{
					find: /^@earendil-works\/pi-coding-agent$/,
					replacement: resolve(checkout, "packages/coding-agent/src/index.ts"),
				},
				...base.resolve.alias,
			],
		},
	};
}
