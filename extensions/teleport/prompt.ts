export function teleportCustomPrompt(
	preserve: boolean,
	customPrompt: string | undefined,
): string | undefined {
	return preserve ? customPrompt : undefined;
}
