export function isShellOption(arg: string): boolean {
	return arg.startsWith("-") && arg !== "-";
}

export function isShortOption(arg: string, option: string): boolean {
	return /^-[^-]/.test(arg) && arg.slice(1).includes(option);
}

export function isPathLikeShellArg(arg: string): boolean {
	if (arg.length === 0 || arg === "--") return false;
	if (isShellOption(arg)) return false;
	if (arg.includes("=") && !arg.includes("/")) return false;
	return true;
}

export function optionConsumesNext(arg: string, optionsWithValues: ReadonlySet<string>): boolean {
	if (optionsWithValues.has(arg)) return true;
	for (const option of optionsWithValues) {
		if (option.startsWith("--") && arg.startsWith(`${option}=`)) return false;
	}
	return false;
}

export function valueAfterEquals(arg: string): string | undefined {
	const index = arg.indexOf("=");
	if (index === -1 || index === arg.length - 1) return undefined;
	return arg.slice(index + 1);
}
