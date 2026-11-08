import { choiceIndexForNumberKey } from "../../src/ui/number-shortcuts.js";
import { assert } from "./assert.js";

export function checkNumberShortcuts(): void {
	assert(choiceIndexForNumberKey("1", 4) === 0, "1 should select the first choice");
	assert(choiceIndexForNumberKey("2", 4) === 1, "2 should select the second choice");
	assert(choiceIndexForNumberKey("4", 4) === 3, "4 should select the fourth choice");
	assert(choiceIndexForNumberKey("5", 4) === undefined, "out-of-range choices should be ignored");
	assert(choiceIndexForNumberKey("0", 4) === undefined, "0 should not select a choice");
	assert(choiceIndexForNumberKey("\x1b[50u", 4) === 1, "Kitty CSI-u 2 should select the second choice");
	assert(choiceIndexForNumberKey("\x1b[51;1u", 4) === 2, "Kitty CSI-u 3 should select the third choice");
}
