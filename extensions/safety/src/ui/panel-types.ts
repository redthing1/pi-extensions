import type {
	ContainmentMode,
	EffectiveSafetyPolicy,
	EnvironmentMode,
	NetworkMode,
	ReinsMode,
	SafetyProfileName,
} from "../config/types.js";
import type { SafetyControllerPaths } from "../controller/controller.js";

export interface SafetyPanelModel {
	policy: EffectiveSafetyPolicy;
	paths: SafetyControllerPaths;
	clientZdr: boolean;
	auditRecordingEnabled: boolean;
	approvals: string[];
	saveableSessionApprovals: number | undefined;
	containmentSupport: string;
}

export interface SafetyPanelCallbacks {
	onEnabledChange: (enabled: boolean) => void;
	onProfileChange: (profile: SafetyProfileName) => void;
	onReinsModeChange: (mode: ReinsMode) => void;
	onContainmentModeChange: (mode: ContainmentMode) => void;
	onNetworkChange: (network: NetworkMode) => void;
	onEnvironmentChange: (environment: EnvironmentMode) => void;
	onForgetApproval: (choice: string) => void;
	onSaveSessionApprovals: () => void;
	onCancel: () => void;
}

export interface ChoiceOption {
	value: string;
	label: string;
	description?: string;
}
