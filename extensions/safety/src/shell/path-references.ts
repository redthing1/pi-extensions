import type { PathOperation } from "../paths/types.js";

export interface ShellPathReference {
	path: string;
	operation: PathOperation;
	segment: string;
}
