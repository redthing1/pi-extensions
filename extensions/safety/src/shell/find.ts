/** Leading find roots, before its expression. Option values and predicates are not roots. */
export function parseFindInvocation(args: readonly string[]): { roots: string[]; shallow: boolean } {
	const roots: string[] = [];
	let index = 0;
	for (; index < args.length; index++) {
		const arg = args[index];
		if (["-H", "-L", "-P", "-x", "-s", "-d", "--"].includes(arg)) continue;
		if (arg === "-D") {
			index++;
			continue;
		}
		if (/^-O\d+$/u.test(arg)) continue;
		if (arg === "-f") {
			if (args[index + 1]) roots.push(args[++index]);
			continue;
		}
		if (arg.startsWith("-") || arg === "!" || arg === "(" || arg === ")") break;
		roots.push(arg);
	}
	const depths = args.flatMap((arg, index) => (arg === "-maxdepth" ? [args[index + 1] ?? ""] : []));
	return {
		roots: roots.length ? roots : ["."],
		shallow: depths.length > 0 && depths.every((depth) => /^(?:0|1)$/u.test(depth)),
	};
}
