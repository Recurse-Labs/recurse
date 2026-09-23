import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
	AgentEvent,
	AnthropicLoginStart,
	AsmInsn,
	AsmResult,
	Backend,
	BinaryInfo,
	CallGraph,
	ChatMessage,
	DebugSnapshot,
	DebugTraceEntry,
	DecompileResult,
	DeviceLoginInfo,
	DiffResult,
	Findings,
	Function,
	GeneratedReport,
	GeneratedSignature,
	Import,
	LlmStatus,
	ModelInfo,
	Project,
	ProviderStatus,
	R2String,
	Recon,
	FunctionGraph,
	SemanticIndexResult,
	SemanticSimilarResult,
	Session,
	Xref,
} from "./types";

export async function pickBinary(): Promise<string | null> {
	const path = await open({
		multiple: false,
		title: "Open binary",
	});
	return typeof path === "string" ? path : null;
}

export const api = {
	openBinary: (path: string) => invoke<BinaryInfo>("open_binary", { path }),
	analyze: () => invoke<void>("analyze"),
	closeBinary: () => invoke<void>("close_binary"),
	functions: () => invoke<Function[]>("functions"),
	renameFunction: (addr: number, name: string) =>
		invoke<void>("rename_function", { addr, name }),
	debugCommand: (op: string, args?: Record<string, unknown>) =>
		invoke<unknown>("debug_command", { op, args: args ?? null }),
	debugSnapshot: () => invoke<DebugSnapshot | null>("debug_snapshot"),
	recon: () => invoke<Recon>("recon"),
	analysisProgress: () =>
		invoke<{ function_count: number; indexing: boolean }>(
			"analysis_progress",
		),
	functionAt: (addr: number) => invoke<Function>("function_at", { addr }),
	functionDisasm: (addr: number) =>
		invoke<AsmResult>("function_disasm", { addr }),
	functionGraph: (addr: number) =>
		invoke<FunctionGraph>("function_graph", { addr }),
	disassemble: (addr: number, count: number) =>
		invoke<AsmInsn[]>("disassemble", { addr, count }),
	strings: () => invoke<R2String[]>("strings"),
	imports: () => invoke<Import[]>("imports"),
	xrefsTo: (addr: number) => invoke<Xref[]>("xrefs_to", { addr }),
	decompile: (addr: number) => invoke<DecompileResult>("decompile", { addr }),
	raw: (cmd: string) => invoke<unknown>("raw", { cmd }),
	getBackend: () => invoke<{ backend: Backend }>("get_backend"),
	setBackend: (backend: string) => invoke<void>("set_backend", { backend }),
	setZoom: (scale: number) => invoke<void>("set_zoom", { scale }),
	agentChat: (
		message: string,
		sessionId: string,
		onEvent: Channel<AgentEvent>,
	) => invoke<void>("agent_chat", { message, sessionId, onEvent }),
	agentCancel: () => invoke<void>("agent_cancel_run"),
	agentReset: () => invoke<void>("agent_reset"),
	agentHistory: () => invoke<ChatMessage[]>("agent_history"),
	sessionsList: (project: string) =>
		invoke<Session[]>("sessions_list", { project }),
	sessionsCreate: () => invoke<Session>("sessions_create"),
	sessionsSelect: (sessionId: string) =>
		invoke<Session>("sessions_select", { sessionId }),
	sessionsDelete: (project: string, sessionId: string) =>
		invoke<void>("sessions_delete", { project, sessionId }),
	sessionsRename: (project: string, sessionId: string, name: string) =>
		invoke<void>("sessions_rename", { project, sessionId, name }),
	llmStatus: () => invoke<LlmStatus>("llm_status"),
	setModel: (id: string) => invoke<void>("set_model", { id }),
	saveApiKey: (key: string) => invoke<void>("save_api_key", { key }),
	setEndpoint: (endpoint: string) =>
		invoke<void>("set_endpoint", { endpoint }),
	listModels: (refresh = false) =>
		invoke<ModelInfo[]>("list_models", { refresh }),
	listProjects: () => invoke<Project[]>("list_projects"),
	createProject: (name: string, binaryPath: string) =>
		invoke<Project>("create_project", { name, binaryPath }),
	openProject: (name: string) => invoke<Project>("open_project", { name }),
	deleteProject: (name: string) => invoke<void>("delete_project", { name }),
	projectReadFile: (name: string, path: string) =>
		invoke<string>("project_read_file", { name, path }),
	projectWriteFile: (name: string, path: string, content: string) =>
		invoke<void>("project_write_file", { name, path, content }),
	projectListFiles: (name: string) =>
		invoke<string[]>("project_list_files", { name }),
	memoriesList: (project: string) =>
		invoke<string[]>("memories_list", { project }),
	memoryGet: (project: string, key: string) =>
		invoke<string>("memory_get", { project, key }),
	memorySave: (project: string, key: string, content: string) =>
		invoke<void>("memory_save", { project, key, content }),
	memoryRemove: (project: string, key: string) =>
		invoke<void>("memory_remove", { project, key }),
	memorySearch: (project: string, query: string, limit?: number) =>
		invoke<{ key: string; snippet: string }[]>("memory_search", {
			project,
			query,
			limit,
		}),
	providersList: () => invoke<ProviderStatus[]>("providers_list"),
	providerSaveApiKey: (id: string, key: string) =>
		invoke<void>("provider_save_api_key", { id, key }),
	providerClearCredential: (id: string) =>
		invoke<void>("provider_clear_credential", { id }),
	providerSetActive: (id: string) =>
		invoke<void>("provider_set_active", { id }),
	anthropicOauthStart: () =>
		invoke<AnthropicLoginStart>("anthropic_oauth_start"),
	anthropicOauthFinish: (pastedCode: string, verifier: string) =>
		invoke<void>("anthropic_oauth_finish", { pastedCode, verifier }),
	githubCopilotDeviceStart: () =>
		invoke<DeviceLoginInfo>("github_copilot_device_start"),
	githubCopilotDeviceFinish: (
		deviceCode: string,
		intervalSecs: number,
		expiresInSecs: number,
	) =>
		invoke<void>("github_copilot_device_finish", {
			deviceCode,
			intervalSecs,
			expiresInSecs,
		}),

	readBytes: (addr: number, len: number) =>
		invoke<number[]>("read_bytes", { addr, len }),
	writeBytes: (addr: number, bytes: number[]) =>
		invoke<void>("write_bytes", { addr, bytes }),
	findings: () => invoke<Findings>("findings"),
	diffWith: (otherPath: string) =>
		invoke<DiffResult>("diff_with", { otherPath }),
	generateSignature: (addr: number) =>
		invoke<GeneratedSignature>("generate_signature", { addr }),
	semanticIndex: () => invoke<SemanticIndexResult>("semantic_index"),
	semanticSimilar: (addr: number) =>
		invoke<SemanticSimilarResult>("semantic_similar", { addr }),
	callGraph: () => invoke<CallGraph>("call_graph"),
	generateReport: () => invoke<GeneratedReport>("generate_report"),
	exportProject: (name: string) => invoke<string>("export_project", { name }),
	importProject: (zipPath: string) =>
		invoke<Project>("import_project", { zipPath }),
	pickZip: (title: string) =>
		open({
			multiple: false,
			title,
			filters: [{ name: "Zip", extensions: ["zip"] }],
		}),
	debugTrace: () => invoke<DebugTraceEntry[]>("debug_trace"),
	debugTraceClear: () => invoke<void>("debug_trace_clear"),
};
