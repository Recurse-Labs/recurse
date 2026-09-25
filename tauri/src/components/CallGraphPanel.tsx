import { useEffect, useState } from "react";
import {
	Background,
	Controls,
	Handle,
	MarkerType,
	MiniMap,
	Position,
	ReactFlow,
	ReactFlowProvider,
	useReactFlow,
	type Edge,
	type Node,
	type NodeProps,
	useEdgesState,
	useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ELK from "elkjs/lib/elk-api.js";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api } from "@/api";
import { cn } from "@/lib/utils";
import { useAnalysisStore } from "@/store/analysisStore";
import type { CallGraph } from "@/types";

function fmtAddr(a: number): string {
	return `0x${a.toString(16)}`;
}

type FnData = {
	addr: number;
	name: string;
	isLeaf: boolean;
	isCalled: boolean;
};
type FnNode = Node<FnData, "fnnode">;

function FnNodeComponent({ data }: NodeProps<FnNode>) {
	return (
		<div
			className={cn(
				"border-border bg-card rounded border px-2.5 py-1.5 font-mono text-[11px] shadow",
				data.isLeaf ? "bg-muted/40" : "bg-card",
				!data.isCalled && "border-primary/40",
			)}
		>
			<Handle
				type="target"
				position={Position.Top}
				className="!opacity-0"
			/>
			<div className="text-primary truncate font-semibold">
				{data.name}
			</div>
			<div className="text-muted-foreground">{fmtAddr(data.addr)}</div>
			<Handle
				type="source"
				position={Position.Bottom}
				className="!opacity-0"
			/>
		</div>
	);
}

const nodeTypes = { fnnode: FnNodeComponent };

const NODE_WIDTH = 160;
const NODE_HEIGHT = 44;

const elk = new ELK({
	workerFactory: () =>
		new Worker(new URL("elkjs/lib/elk-worker.min.js", import.meta.url)),
});

/**
 * Use ELK's layered Sugiyama layout for a stable, top-to-bottom hierarchy.
 * ELK runs in a worker, so layout work does not block scrolling or input.
 */
async function layout(nodes: FnNode[], edges: Edge[]): Promise<FnNode[]> {
	if (nodes.length === 0) return [];
	const graph = {
		id: "root",
		layoutOptions: {
			"elk.algorithm": "layered",
			"elk.direction": "DOWN",
			"elk.edgeRouting": "ORTHOGONAL",
			"elk.spacing.nodeNode": "42",
			"elk.layered.spacing.nodeNodeBetweenLayers": "128",
			"elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
			"elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
			"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
		},
		children: nodes.map((node) => ({
			id: node.id,
			width: NODE_WIDTH,
			height: NODE_HEIGHT,
		})),
		edges: edges.map((edge) => ({
			id: edge.id,
			sources: [edge.source],
			targets: [edge.target],
		})),
	};
	const result = await elk.layout(graph);
	const positions = new Map(
		result.children?.map((node) => [node.id, node]) ?? [],
	);
	return nodes.map((node) => {
		const position = positions.get(node.id);
		return {
			...node,
			position: {
				x: position?.x ?? 0,
				y: position?.y ?? 0,
			},
		};
	});
}

/** Estimate whether the laid-out graph needs a readable top-level viewport. */
function graphNeedsTopView(nodes: FnNode[], edges: Edge[]): boolean {
	if (nodes.length > 300 || edges.length > 3_000) return true;
	const maxX = Math.max(
		...nodes.map((node) => node.position.x + NODE_WIDTH),
		0,
	);
	const maxY = Math.max(
		...nodes.map((node) => node.position.y + NODE_HEIGHT),
		0,
	);
	const minX = Math.min(...nodes.map((node) => node.position.x), 0);
	const minY = Math.min(...nodes.map((node) => node.position.y), 0);
	return maxX - minX > 1_200 || maxY - minY > 820;
}

/** Convert the bounded API response into React Flow elements. */
function toGraph(cg: CallGraph): { nodes: FnNode[]; edges: Edge[] } {
	const nodes: FnNode[] = cg.nodes.map((f) => ({
		id: String(f.addr),
		type: "fnnode",
		position: { x: 0, y: 0 },
		data: {
			addr: f.addr,
			name: f.name,
			isLeaf: f.is_leaf,
			isCalled: f.is_called,
		},
	}));
	const nodeIds = new Set(nodes.map((node) => node.id));
	const edges: Edge[] = cg.edges
		.filter((e) => nodeIds.has(String(e.from)) && nodeIds.has(String(e.to)))
		.map((e, i) => ({
			id: `e${i}-${e.from}-${e.to}`,
			source: String(e.from),
			target: String(e.to),
			type: "smoothstep",
			markerEnd: { type: MarkerType.ArrowClosed },
			style: {
				stroke: "var(--muted-foreground)",
				strokeOpacity: 0.3,
				strokeWidth: 1,
			},
		}));
	return { nodes, edges };
}

function Canvas() {
	const [nodes, setNodes, onNodesChange] = useNodesState<FnNode>([]);
	const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
	const [loading, setLoading] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [meta, setMeta] = useState<{
		truncated: boolean;
		total: number;
		visible: number;
		edges: number;
	} | null>(null);
	const largeGraph = graphNeedsTopView(nodes, edges);
	const flow = useReactFlow<FnNode, Edge>();
	const selectFn = useAnalysisStore((s) => s.selectFn);
	const funcs = useAnalysisStore((s) => s.funcs);

	const build = async () => {
		setLoading(true);
		setErr(null);
		try {
			const cg = await api.callGraph();
			const { nodes: ns, edges: es } = toGraph(cg);
			const positioned = await layout(ns, es);
			setNodes(positioned);
			setEdges(es);
			setMeta({
				truncated: cg.truncated,
				total: cg.total_functions,
				visible: ns.length,
				edges: es.length,
			});
		} catch (e) {
			setErr(String(e));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		if (!largeGraph || nodes.length === 0) return;
		const root = nodes[0];
		const frame = requestAnimationFrame(() => {
			void flow.setCenter(
				root.position.x + NODE_WIDTH / 2,
				root.position.y + NODE_HEIGHT / 2,
				{ zoom: 0.7, duration: 250 },
			);
		});
		return () => cancelAnimationFrame(frame);
	}, [flow, largeGraph, nodes]);

	const onNodeClick = (_: unknown, node: FnNode) => {
		const f = funcs.find((x) => x.addr === node.data.addr);
		if (f) selectFn(f);
	};

	return (
		<div className="flex h-full w-full flex-col">
			<div className="border-border bg-card flex items-center gap-2 border-b px-3 py-1.5">
				<Button
					size="sm"
					variant="outline"
					onClick={() => void build()}
				>
					{nodes.length > 0 ? "Rebuild" : "Build call graph"}
				</Button>
				{meta && (
					<span className="text-muted-foreground text-[11px]">
						{meta.total.toLocaleString()} functions ·{" "}
						{meta.visible.toLocaleString()} shown ·{" "}
						{meta.edges.toLocaleString()} edges
						{meta.truncated ? " · truncated" : ""}
					</span>
				)}
				{loading && (
					<Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
				)}
			</div>
			<div className="min-h-0 flex-1">
				{err ? (
					<div className="border-destructive bg-destructive/10 text-destructive m-3 rounded-md border p-2.5 text-[11px]">
						{err}
					</div>
				) : nodes.length === 0 && !loading ? (
					<div className="text-muted-foreground flex h-full items-center justify-center px-6 text-center text-xs">
						Aggregates call edges across every discovered function
						into one navigable graph — distinct from the
						per-function CFG in the disassembly view.
					</div>
				) : (
					<ReactFlow
						nodes={nodes}
						edges={edges}
						nodeTypes={nodeTypes}
						onNodesChange={onNodesChange}
						onEdgesChange={onEdgesChange}
						onNodeClick={onNodeClick}
						fitView={!largeGraph}
						defaultViewport={{ x: 24, y: 24, zoom: 0.8 }}
						fitViewOptions={{ padding: largeGraph ? 0.05 : 0.15 }}
						nodesDraggable={false}
						nodesConnectable={false}
						elementsSelectable
						onlyRenderVisibleElements
						panOnScroll
						panOnScrollSpeed={0.8}
						zoomOnScroll={false}
						zoomOnPinch
						zoomOnDoubleClick={false}
						minZoom={0.02}
						proOptions={{ hideAttribution: true }}
						className="bg-background"
					>
						<Background gap={18} size={1} />
						<Controls showInteractive={false} />
						{largeGraph && (
							<div className="pointer-events-none absolute right-3 bottom-3 z-10 flex flex-col items-end gap-1.5">
								<div className="border-border bg-card/95 flex items-center gap-2 rounded-md border px-2 py-1 text-[10px] shadow-lg backdrop-blur-sm">
									<span className="font-medium">
										Overview
									</span>
									<span className="text-muted-foreground">
										drag to navigate
									</span>
								</div>
								<MiniMap
									pannable
									zoomable
									ariaLabel="Call graph overview"
									className="border-border pointer-events-auto !relative !right-auto !bottom-auto overflow-hidden rounded-md border shadow-lg"
									style={{ width: 190, height: 120 }}
									bgColor="rgba(8, 12, 20, 0.94)"
									maskColor="rgba(2, 6, 12, 0.72)"
									maskStrokeColor="rgba(148, 163, 184, 0.55)"
									maskStrokeWidth={1}
									nodeColor="#64748b"
									nodeStrokeColor="#94a3b8"
									nodeBorderRadius={2}
									nodeStrokeWidth={1}
								/>
							</div>
						)}
					</ReactFlow>
				)}
			</div>
		</div>
	);
}

/**
 * Whole-binary call graph: aggregates call edges across the binary's
 * functions (host-capped — see `analysis_extra::CALL_GRAPH_FUNCTION_CAP`)
 * into one navigable graph, distinct from `GraphPanel`'s per-function CFG.
 * Clicking a node selects that function everywhere else in the app.
 */
export function CallGraphPanel() {
	return (
		<div className="min-h-0 min-w-0 flex-1">
			<ReactFlowProvider>
				<Canvas />
			</ReactFlowProvider>
		</div>
	);
}
