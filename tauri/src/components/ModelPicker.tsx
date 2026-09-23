import { useEffect, useMemo, useRef, useState } from "react";
import {
	ArrowUpDown,
	Check,
	Eye,
	EyeOff,
	ExternalLink,
	Loader2,
	RotateCw,
	Unplug,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useLlmStore } from "@/store/llmStore";
import { useProviderStore } from "@/store/providerStore";
import { useUiStore } from "@/store/uiStore";
import type { ModelInfo, ProviderStatus } from "@/types";

type SortMode = "default" | "price-asc" | "price-desc";

function priceOf(m: ModelInfo): number {
	const p = parseFloat(m.prompt_price);
	return Number.isFinite(p) ? p : 0;
}

function fmtPrice(m: ModelInfo): string {
	return `$${(priceOf(m) * 1_000_000).toFixed(2)}/M`;
}
/** Trigger-button label: the active provider's short name plus the
 * current model, so the picker communicates both at a glance instead of
 * just a bare model id. */
function selectedActiveLabel(
	providers: ProviderStatus[],
	model: string,
): string {
	const active = providers.find((p) => p.is_active);
	if (!active) return model || "select model";
	return model ? `${active.name} · ${model}` : active.name;
}

function groupLabel(p: ProviderStatus): string {
	if (
		p.auth_kind === "oauth_anthropic" ||
		p.auth_kind === "oauth_github_copilot"
	) {
		return "Subscriptions";
	}
	if (p.auth_kind === "local") return "Local";
	return "API Keys";
}

/** Providers grouped in picker order: subscriptions first, then API-key
 * vendors, then local runtimes — matching `crate::providers::PROVIDERS`'
 * own ordering intent (the highest-value "already have this" option
 * first). */
function groupProviders(
	providers: ProviderStatus[],
): [string, ProviderStatus[]][] {
	const order = ["Subscriptions", "API Keys", "Local"];
	const groups: Record<string, ProviderStatus[]> = {};
	for (const p of providers) {
		const label = groupLabel(p);
		(groups[label] ??= []).push(p);
	}
	return order
		.filter((label) => groups[label])
		.map((label) => [label, groups[label]]);
}

function StatusDot({ configured }: { configured: boolean }) {
	return (
		<span
			className={cn(
				"inline-block h-1.5 w-1.5 shrink-0 rounded-full",
				configured ? "bg-primary" : "bg-muted-foreground/30",
			)}
		/>
	);
}

function ProviderRow({
	provider,
	selected,
	onSelect,
}: {
	provider: ProviderStatus;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			onClick={onSelect}
			className={cn(
				"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
				selected
					? "bg-accent text-accent-foreground"
					: "hover:bg-accent/50",
			)}
		>
			<StatusDot configured={provider.configured} />
			<span className="min-w-0 flex-1 truncate">{provider.name}</span>
			{provider.is_active && (
				<Check className="text-primary h-3 w-3 shrink-0" />
			)}
		</button>
	);
}

/** Inline auth panel for whichever provider is selected in the sidebar:
 * an API key field, or a "connect with your subscription" OAuth flow
 * (Claude Pro/Max's paste-a-code flow, or GitHub Copilot's device-code
 * flow), depending on `provider.auth_kind`. */
function ProviderAuthPanel({ provider }: { provider: ProviderStatus }) {
	const saveApiKey = useProviderStore((s) => s.saveApiKey);
	const clearCredential = useProviderStore((s) => s.clearCredential);
	const setActive = useProviderStore((s) => s.setActive);
	const startAnthropicLogin = useProviderStore((s) => s.startAnthropicLogin);
	const submitAnthropicCode = useProviderStore((s) => s.submitAnthropicCode);
	const startCopilotLogin = useProviderStore((s) => s.startCopilotLogin);
	const cancelLogin = useProviderStore((s) => s.cancelLogin);
	const loginStage = useProviderStore((s) => s.loginStage);
	const loginError = useProviderStore((s) => s.loginError);
	const anthropicAuthorizeUrl = useProviderStore(
		(s) => s.anthropicAuthorizeUrl,
	);
	const copilotUserCode = useProviderStore((s) => s.copilotUserCode);
	const copilotVerificationUri = useProviderStore(
		(s) => s.copilotVerificationUri,
	);

	const [key, setKey] = useState("");
	const [show, setShow] = useState(false);
	const [saving, setSaving] = useState(false);
	const [pastedCode, setPastedCode] = useState("");

	if (provider.auth_kind === "oauth_anthropic") {
		if (
			loginStage === "anthropic-waiting-for-code" ||
			loginStage === "anthropic-exchanging"
		) {
			return (
				<div className="space-y-2">
					<div className="text-muted-foreground text-xs">
						A browser tab opened to sign in with your Claude
						subscription. After approving, paste the code shown
						there below.
					</div>
					{anthropicAuthorizeUrl && (
						<a
							href={anthropicAuthorizeUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="text-primary flex items-center gap-1 text-xs underline"
						>
							Open sign-in page again{" "}
							<ExternalLink className="h-3 w-3" />
						</a>
					)}
					<div className="flex gap-1.5">
						<Input
							placeholder="code#state"
							value={pastedCode}
							onChange={(e) => setPastedCode(e.target.value)}
							autoFocus
							className="min-w-0 flex-1"
						/>
						<Button
							size="sm"
							disabled={
								!pastedCode.trim() ||
								loginStage === "anthropic-exchanging"
							}
							onClick={() => void submitAnthropicCode(pastedCode)}
						>
							{loginStage === "anthropic-exchanging" ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								"Submit"
							)}
						</Button>
						<Button
							size="sm"
							variant="outline"
							onClick={cancelLogin}
						>
							Cancel
						</Button>
					</div>
				</div>
			);
		}
		return (
			<div className="space-y-2">
				{provider.configured ? (
					<div className="flex items-center gap-2">
						<Badge variant="outline" className="text-2xs">
							connected
						</Badge>
						<Button
							size="sm"
							variant="outline"
							onClick={() => void clearCredential(provider.id)}
						>
							<Unplug className="mr-1 h-3 w-3" /> Disconnect
						</Button>
						{!provider.is_active && (
							<Button
								size="sm"
								onClick={() => void setActive(provider.id)}
							>
								Use this provider
							</Button>
						)}
					</div>
				) : (
					<Button
						size="sm"
						onClick={() => void startAnthropicLogin()}
					>
						Connect with Claude
					</Button>
				)}
				{loginStage === "error" && loginError && (
					<div className="text-destructive text-xs">{loginError}</div>
				)}
			</div>
		);
	}

	if (provider.auth_kind === "oauth_github_copilot") {
		if (loginStage === "copilot-waiting-for-approval") {
			return (
				<div className="space-y-2">
					<div className="text-muted-foreground text-xs">
						A browser tab opened to github.com/login/device. Enter
						this code there:
					</div>
					{copilotUserCode && (
						<div className="bg-muted/40 rounded-md px-3 py-2 text-center font-mono text-lg tracking-widest">
							{copilotUserCode}
						</div>
					)}
					{copilotVerificationUri && (
						<a
							href={copilotVerificationUri}
							target="_blank"
							rel="noopener noreferrer"
							className="text-primary flex items-center justify-center gap-1 text-xs underline"
						>
							Open {copilotVerificationUri}{" "}
							<ExternalLink className="h-3 w-3" />
						</a>
					)}
					<div className="text-muted-foreground flex items-center justify-center gap-1.5 text-xs">
						<Loader2 className="h-3 w-3 animate-spin" /> Waiting for
						approval…
					</div>
					<Button
						size="sm"
						variant="outline"
						className="w-full"
						onClick={cancelLogin}
					>
						Cancel
					</Button>
				</div>
			);
		}
		return (
			<div className="space-y-2">
				{provider.configured ? (
					<div className="flex items-center gap-2">
						<Badge variant="outline" className="text-2xs">
							connected
						</Badge>
						<Button
							size="sm"
							variant="outline"
							onClick={() => void clearCredential(provider.id)}
						>
							<Unplug className="mr-1 h-3 w-3" /> Disconnect
						</Button>
						{!provider.is_active && (
							<Button
								size="sm"
								onClick={() => void setActive(provider.id)}
							>
								Use this provider
							</Button>
						)}
					</div>
				) : (
					<Button size="sm" onClick={() => void startCopilotLogin()}>
						Connect with GitHub
					</Button>
				)}
				{loginStage === "error" && loginError && (
					<div className="text-destructive text-xs">{loginError}</div>
				)}
			</div>
		);
	}

	if (provider.auth_kind === "local") {
		return (
			<div className="space-y-2">
				<div className="text-muted-foreground text-xs">
					No API key required — this provider talks to a local server.
				</div>
				{!provider.is_active && (
					<Button
						size="sm"
						onClick={() => void setActive(provider.id)}
					>
						Use this provider
					</Button>
				)}
			</div>
		);
	}

	// auth_kind === "api_key"
	return (
		<div className="space-y-2">
			<div className="flex gap-1.5">
				<Input
					type={show ? "text" : "password"}
					placeholder={
						provider.configured
							? "•••••• (saved) — replace?"
							: "paste API key"
					}
					value={key}
					onChange={(e) => setKey(e.target.value)}
					className="min-w-0 flex-1"
				/>
				<Button
					variant="outline"
					size="icon"
					onClick={() => setShow((s) => !s)}
					title="toggle"
				>
					{show ? <EyeOff /> : <Eye />}
				</Button>
				<Button
					size="sm"
					disabled={saving || !key.trim()}
					onClick={async () => {
						setSaving(true);
						await saveApiKey(provider.id, key);
						setSaving(false);
						setKey("");
					}}
				>
					{saving ? "…" : "Save"}
				</Button>
			</div>
			<div className="flex items-center gap-2">
				{provider.configured && (
					<Button
						size="sm"
						variant="outline"
						onClick={() => void clearCredential(provider.id)}
					>
						<Unplug className="mr-1 h-3 w-3" /> Remove key
					</Button>
				)}
				{provider.configured && !provider.is_active && (
					<Button
						size="sm"
						onClick={() => void setActive(provider.id)}
					>
						Use this provider
					</Button>
				)}
			</div>
			{provider.docs_url && (
				<a
					href={provider.docs_url}
					target="_blank"
					rel="noopener noreferrer"
					className="text-muted-foreground flex items-center gap-1 text-xs underline"
				>
					Get an API key <ExternalLink className="h-3 w-3" />
				</a>
			)}
		</div>
	);
}

export function ModelPicker() {
	const model = useLlmStore((s) => s.model);
	const models = useLlmStore((s) => s.models);
	const loading = useLlmStore((s) => s.modelsLoading);
	const error = useLlmStore((s) => s.modelsError);
	const refresh = useLlmStore((s) => s.refresh);
	const selectModel = useLlmStore((s) => s.selectModel);

	const providers = useProviderStore((s) => s.providers);
	const refreshProviders = useProviderStore((s) => s.refresh);
	const cancelLogin = useProviderStore((s) => s.cancelLogin);

	const open = useUiStore((s) => s.modelPickerOpen);
	const setOpen = useUiStore((s) => s.setModelPickerOpen);
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<SortMode>("default");
	const [customModel, setCustomModel] = useState("");
	const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
		null,
	);
	const [highlight, setHighlight] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		void refreshProviders();
	}, [open, refreshProviders]);

	useEffect(() => {
		if (!open) cancelLogin();
	}, [open, cancelLogin]);

	const effectiveProviderId =
		selectedProviderId ??
		providers.find((p) => p.is_active)?.id ??
		providers[0]?.id ??
		null;
	const selectedProvider =
		providers.find((p) => p.id === effectiveProviderId) ?? null;
	const grouped = useMemo(() => groupProviders(providers), [providers]);

	const filtered = useMemo(() => {
		const q = query.toLowerCase();
		const list = models.filter(
			(m) =>
				m.id.toLowerCase().includes(q) ||
				m.name.toLowerCase().includes(q),
		);
		if (sort === "price-asc")
			return [...list].sort((a, b) => priceOf(a) - priceOf(b));
		if (sort === "price-desc")
			return [...list].sort((a, b) => priceOf(b) - priceOf(a));
		return list;
	}, [models, query, sort]);

	const clampedHighlight =
		filtered.length > 0 ? Math.min(highlight, filtered.length - 1) : 0;

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (filtered.length === 0) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setHighlight(Math.min(clampedHighlight + 1, filtered.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setHighlight(Math.max(clampedHighlight - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			const target = filtered[clampedHighlight];
			if (target) {
				void selectModel(target.id);
				setOpen(false);
			}
		}
	};

	useEffect(() => {
		const el = listRef.current?.querySelector<HTMLElement>(
			`[data-idx="${clampedHighlight}"]`,
		);
		el?.scrollIntoView({ block: "nearest" });
	}, [clampedHighlight]);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					variant="toolbar"
					size="sm"
					className="max-w-[220px] truncate"
				>
					{selectedActiveLabel(providers, model)}
					<span className="text-muted-foreground">▾</span>
				</Button>
			</DialogTrigger>
			<DialogContent className="max-h-[90vh] w-[95vw] max-w-4xl overflow-hidden p-0 sm:max-w-4xl">
				<DialogHeader className="border-border/50 border-b p-4 pb-3">
					<DialogTitle>Model & Provider</DialogTitle>
				</DialogHeader>
				<div className="flex min-h-0 flex-1">
					{/* Provider sidebar */}
					<div className="border-border/50 w-56 shrink-0 overflow-y-auto border-r p-2">
						{grouped.map(([label, list]) => (
							<div key={label} className="mb-2">
								<div className="text-muted-foreground text-2xs px-2 py-1 font-medium tracking-wide uppercase">
									{label}
								</div>
								{list.map((p) => (
									<ProviderRow
										key={p.id}
										provider={p}
										selected={p.id === effectiveProviderId}
										onSelect={() => {
											setSelectedProviderId(p.id);
											cancelLogin();
										}}
									/>
								))}
							</div>
						))}
					</div>

					{/* Main pane: auth for the selected provider, then the model list */}
					<div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
						{selectedProvider && (
							<div className="border-border/50 border-b pb-3">
								<ProviderAuthPanel
									provider={selectedProvider}
								/>
							</div>
						)}

						<div className="flex gap-1.5">
							<Input
								placeholder="or type a model id, e.g. llama3.1:8b"
								value={customModel}
								onChange={(e) => setCustomModel(e.target.value)}
								className="min-w-0 flex-1"
							/>
							<Button
								variant="outline"
								disabled={!customModel.trim()}
								onClick={() => {
									void selectModel(customModel.trim());
									setCustomModel("");
									setOpen(false);
								}}
							>
								Use
							</Button>
						</div>
						<div className="flex items-center gap-1.5">
							<Input
								placeholder={`Search ${models.length} models…`}
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								onKeyDown={onKeyDown}
								autoFocus
								className="min-w-0 flex-1"
							/>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="outline"
										size="sm"
										title="Sort models"
									>
										<ArrowUpDown />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuLabel>
										Sort by price
									</DropdownMenuLabel>
									<DropdownMenuItem
										onClick={() => setSort("price-asc")}
									>
										Low → High
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={() => setSort("price-desc")}
									>
										High → Low
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={() => setSort("default")}
									>
										Default
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
							<Button
								variant="outline"
								size="icon"
								onClick={refresh}
								disabled={loading}
								title="Refresh list"
							>
								<RotateCw
									className={loading ? "animate-spin" : ""}
								/>
							</Button>
						</div>
						{error && (
							<div className="bg-destructive/10 text-destructive rounded-md p-2 text-xs">
								{error}
							</div>
						)}
						<div
							ref={listRef}
							className="bg-muted/20 max-h-[45vh] min-h-0 overflow-x-hidden overflow-y-auto rounded-md"
						>
							{filtered.length === 0 && !loading && (
								<div className="text-muted-foreground p-3 text-center text-xs">
									No models found.
								</div>
							)}
							{filtered.map((m, idx) => {
								const active = m.id === model;
								return (
									<button
										key={m.id}
										data-idx={idx}
										onClick={() => {
											void selectModel(m.id);
											setOpen(false);
										}}
										onMouseEnter={() => setHighlight(idx)}
										className={cn(
											"flex w-full min-w-0 items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs",
											active
												? "bg-primary/10 text-primary"
												: idx === clampedHighlight
													? "bg-accent"
													: "hover:bg-accent/50",
										)}
									>
										<span className="min-w-0 flex-1 truncate">
											{m.name || m.id}
										</span>
										<span className="flex shrink-0 items-center gap-1.5">
											{m.free && (
												<Badge
													variant="outline"
													className="text-2xs"
												>
													free
												</Badge>
											)}
											{!m.free && priceOf(m) > 0 && (
												<Badge
													variant="outline"
													className="text-2xs px-1.5 py-0"
												>
													{fmtPrice(m)}
												</Badge>
											)}
											{m.context_length > 0 && (
												<span className="text-muted-foreground text-2xs">
													{Math.round(
														m.context_length / 1000,
													)}
													k
												</span>
											)}
											{active && (
												<Check className="h-3 w-3" />
											)}
										</span>
									</button>
								);
							})}
						</div>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
