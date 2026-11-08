export interface CdInvocation {
	supported: boolean;
	target?: string;
	reason: string;
}

export function parseCdInvocation(args: string[]): CdInvocation {
	const targets: Array<{ value: string; afterOptions: boolean }> = [];
	let endOfOptions = false;

	for (const arg of args) {
		if (!endOfOptions && arg === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && (arg === "-L" || arg === "-P")) continue;
		if (!endOfOptions && arg.startsWith("-")) {
			return { supported: false, reason: `cd option ${arg} is not modeled` };
		}
		targets.push({ value: arg, afterOptions: endOfOptions });
	}

	if (targets.length === 0) return { supported: true, target: "~", reason: "cd without a target defaults to HOME" };
	if (targets.length > 1) return { supported: false, reason: "cd with multiple targets is not modeled" };
	if (targets[0].value.length === 0) return { supported: false, reason: "cd with an empty target is not modeled" };
	if (targets[0].value === "-" && !targets[0].afterOptions) {
		return { supported: false, reason: "cd - depends on previous directory state" };
	}
	return { supported: true, target: targets[0].value, reason: "cd target is explicit" };
}
