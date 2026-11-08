import { decodeKittyPrintable } from "@earendil-works/pi-tui";

export function choiceIndexForNumberKey(data: string, choiceCount: number): number | undefined {
	const printable = decodeKittyPrintable(data) ?? data;
	if (!/^[1-9]$/.test(printable)) return undefined;
	const index = Number(printable) - 1;
	return index < choiceCount ? index : undefined;
}
