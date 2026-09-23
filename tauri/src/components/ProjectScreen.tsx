import { Download, Upload } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Logo, LogoMark } from "@/components/Logo";
import { api } from "@/api";
import { useProjectStore } from "@/store/projectStore";
import { useUiStore } from "@/store/uiStore";

function baseName(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

function fmtDate(secs: number): string {
	const d = new Date(secs * 1000);
	return Number.isNaN(d.getTime())
		? ""
		: d.toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
			});
}

export function ProjectScreen() {
	const projects = useProjectStore((s) => s.projects);
	const loading = useProjectStore((s) => s.loading);
	const openProject = useProjectStore((s) => s.openProject);
	const deleteProject = useProjectStore((s) => s.deleteProject);
	const setNewProjectOpen = useUiStore((s) => s.setNewProjectOpen);
	const [status, setStatus] = useState<string | null>(null);
	const [exportingName, setExportingName] = useState<string | null>(null);

	const importProject = async () => {
		const path = await api.pickZip("Import project archive");
		if (!path || typeof path !== "string") return;
		setStatus(null);
		try {
			const project = await api.importProject(path);
			setStatus(`Imported "${project.name}"`);
			await useProjectStore.getState().loadProjects();
		} catch (e) {
			setStatus(`Import failed: ${String(e)}`);
		}
	};

	const exportProject = async (name: string) => {
		setExportingName(name);
		setStatus(null);
		try {
			const path = await api.exportProject(name);
			setStatus(`Exported to ${path}`);
		} catch (e) {
			setStatus(`Export failed: ${String(e)}`);
		} finally {
			setExportingName(null);
		}
	};

	return (
		<div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center overflow-auto px-6 py-14">
			<div className="flex flex-col items-center text-center">
				<Logo className="h-32 w-auto" />
				<h1 className="mt-5 text-3xl font-bold tracking-tight">
					Recurse
				</h1>
				<p className="text-muted-foreground mt-2 max-w-sm text-sm leading-relaxed">
					Agentic reverse engineering. Resume a project or open a new
					target.
				</p>
			</div>

			<div className="mt-9 flex flex-col items-center gap-2">
				<div className="flex items-center gap-2">
					<Button
						size="lg"
						className="h-11 px-10 text-sm tracking-wide"
						onClick={() => setNewProjectOpen(true)}
					>
						New Project
					</Button>
					<Button
						size="lg"
						variant="outline"
						className="h-11 px-5 text-sm tracking-wide"
						onClick={() => void importProject()}
						title="Import a project exported with Export"
					>
						<Upload className="h-4 w-4" /> Import
					</Button>
				</div>
				<span className="text-muted-foreground text-xs">
					projects live in{" "}
					<code className="text-primary font-mono">~/.recurse</code>
				</span>
				{status && (
					<span className="text-muted-foreground max-w-md text-center text-[11px]">
						{status}
					</span>
				)}
			</div>

			{loading && (
				<div className="text-muted-foreground mt-12 text-xs">
					loading projects…
				</div>
			)}

			{!loading && projects.length > 0 && (
				<div className="mt-12 w-full">
					<div className="flex items-center justify-between px-1">
						<h2 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
							Recent projects
						</h2>
						<span className="text-muted-foreground text-xs">
							{projects.length}
						</span>
					</div>
					<ul className="border-border bg-card divide-border mt-2 divide-y rounded-lg border">
						{projects.map((p) => (
							<li key={p.name} className="group">
								<div className="flex items-center gap-1 px-1.5 py-1">
									<button
										type="button"
										onClick={() => openProject(p.name)}
										className="hover:bg-accent flex min-w-0 flex-1 items-center gap-3 rounded px-2 py-1.5 text-left transition-colors"
									>
										<LogoMark className="h-5 w-auto shrink-0" />
										<div className="min-w-0 flex-1">
											<div className="truncate text-sm font-medium">
												{p.name}
											</div>
											<div className="text-muted-foreground truncate font-mono text-xs">
												{baseName(p.binary_path)}
											</div>
										</div>
										<span className="text-muted-foreground shrink-0 text-xs">
											{fmtDate(p.updated_at)}
										</span>
									</button>
									<Button
										variant="ghost"
										size="icon"
										className="h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
										onClick={(e) => {
											e.stopPropagation();
											void exportProject(p.name);
										}}
										disabled={exportingName === p.name}
										title={`Export ${p.name} as a zip`}
									>
										<Download className="h-3.5 w-3.5" />
									</Button>
									<Button
										variant="toolbar"
										size="sm"
										className="shrink-0 opacity-0 group-hover:opacity-100"
										onClick={() => deleteProject(p.name)}
									>
										Delete
									</Button>
								</div>
							</li>
						))}
					</ul>
				</div>
			)}

			{!loading && projects.length === 0 && (
				<div className="mt-12 flex flex-col items-center gap-2 text-center">
					<p className="text-muted-foreground text-xs">
						No projects yet. Create one to get started.
					</p>
				</div>
			)}
		</div>
	);
}
