import { DEFAULT_SAFETY_CONFIG } from "../../src/config/defaults.js";
import { isProfile } from "../../src/config/guards.js";
import {
	formatProfileName,
	isSafetyProfilePresetName,
	safetyProfileListText,
	safetyProfileStrictness,
	SAFETY_PROFILE_CHOICES,
	SAFETY_PROFILE_PRESETS,
} from "../../src/profiles/presets.js";
import { applyProfile, inferProfile } from "../../src/profiles/resolve.js";
import { assert } from "./assert.js";

export function checkProfiles(): void {
	const choiceNames = SAFETY_PROFILE_CHOICES.map((profile) => profile.name);
	assert(safetyProfileListText() === choiceNames.join(", "), "profile list text should come from profile choices");

	for (const preset of SAFETY_PROFILE_PRESETS) {
		assert(isProfile(preset.name), `${preset.name} should be accepted as a profile`);
		assert(isSafetyProfilePresetName(preset.name), `${preset.name} should be accepted as a preset profile`);
		assert(formatProfileName(preset.name) === preset.label, `${preset.name} label should come from the profile catalog`);
		assert(safetyProfileStrictness(preset.name) === preset.strictness, `${preset.name} strictness should come from the profile catalog`);

		const applied = applyProfile(DEFAULT_SAFETY_CONFIG, preset.name);
		assert(applied.profile === preset.name, `${preset.name} should apply from the profile catalog`);
		assert(inferProfile(applied) === preset.name, `${preset.name} should infer from its catalog modes`);
	}

	assert(isProfile("custom"), "custom should be accepted as an inferred profile");
	assert(!isSafetyProfilePresetName("custom"), "custom should not be accepted as a preset profile");
}
