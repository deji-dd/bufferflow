import {
  Background,
  Controls,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import {
  AlertTriangle,
  Database,
  GitFork,
  LayoutGrid,
  Network,
  Server,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { TelemetryFrame } from '../../../src/core/types';

interface DagPipelineProps {
  metrics: TelemetryFrame['metrics'];
  workers: TelemetryFrame['workers'];
  trafficActive: boolean;
  routingStrategy: string;
  maxConcurrencyPerWorker?: number;
}

// ---------------------------------------------------------------------------
// Custom Node Data Types
// ---------------------------------------------------------------------------

interface StageNodeData extends Record<string, unknown> {
  id: string;
  title: string;
  icon?: 'zap' | 'shield' | 'database' | 'git' | 'server' | 'alert';
  badge: string;
  badgeVariant?: 'default' | 'cyan' | 'purple' | 'emerald' | 'amber' | 'rose' | 'outline' | 'glass';
  value: string;
  valueColor: string;
  subvalue?: string;
  borderColor?: string;
  hasTargetHandle?: boolean;
  hasSourceHandle?: boolean;
}

const formatWorkerNumber = (name: string, fallbackIndex?: number): string => {
  const match = name.match(/\d+/);
  if (match) return `#${match[0]}`;
  if (fallbackIndex !== undefined) return `#${fallbackIndex + 1}`;
  return name;
};

interface WorkerClusterNodeData extends Record<string, unknown> {
  workers: TelemetryFrame['workers'];
  routingStrategy: string;
  trafficActive: boolean;
  drainedRps: number;
  maxConcurrencyPerWorker: number;
}

interface IndividualWorkerNodeData extends Record<string, unknown> {
  worker: TelemetryFrame['workers'][number];
  trafficActive: boolean;
  maxConcurrencyPerWorker: number;
}

// ---------------------------------------------------------------------------
// 1. Pipeline Stage Node Component (Ingress, Buffer, Router, Downstream, DLQ)
// ---------------------------------------------------------------------------

const PipelineStageNode: React.FC<NodeProps<Node<StageNodeData>>> = ({ data }) => {
  return (
    <div
      className={cn(
        'dag-node-card bg-[#0f1522]/95 backdrop-blur-md border rounded-xl p-3 min-w-[155px] shadow-xl relative transition-all duration-150',
        data.borderColor || 'border-white/10'
      )}
    >
      {data.hasTargetHandle && (
        <Handle
          type="target"
          position={Position.Left}
          className="!w-2.5 !h-2.5 !bg-[#64748b] !border-2 !border-[#07090e]"
        />
      )}

      <div className="flex items-center justify-between gap-2 mb-1.5">
        {data.icon && (
          <div className="size-6 rounded-md bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
            {data.icon === 'zap' && <Zap className="size-3.5 text-[#00f0ff]" />}
            {data.icon === 'shield' && <ShieldCheck className="size-3.5 text-[#00f0ff]" />}
            {data.icon === 'database' && <Database className="size-3.5 text-[#a855f7]" />}
            {data.icon === 'git' && <GitFork className="size-3.5 text-[#10b981]" />}
            {data.icon === 'server' && <Server className="size-3.5 text-[#10b981]" />}
            {data.icon === 'alert' && <AlertTriangle className="size-3.5 text-[#f43f5e]" />}
          </div>
        )}
        <Badge
          variant={data.badgeVariant || 'outline'}
          className={cn(
            'text-[9px] font-mono font-bold px-1.5 py-0 h-4 truncate',
            data.icon ? 'max-w-[85px]' : 'ml-auto'
          )}
        >
          {data.badge}
        </Badge>
      </div>

      <div className="dag-title text-xs font-semibold text-white tracking-wide">{data.title}</div>
      <div className={cn('font-mono text-sm font-bold mt-0.5', data.valueColor)}>{data.value}</div>
      {data.subvalue && (
        <div className="text-[10px] font-mono text-[#64748b] mt-0.5">{data.subvalue}</div>
      )}

      {data.hasSourceHandle && (
        <Handle
          type="source"
          position={Position.Right}
          className="!w-2.5 !h-2.5 !bg-[#64748b] !border-2 !border-[#07090e]"
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 2. Worker Pool Cluster Node (Merged Dynamic Pool with Real-time Circuit Breakers)
// ---------------------------------------------------------------------------

const WorkerClusterNode: React.FC<NodeProps<Node<WorkerClusterNodeData>>> = ({ data }) => {
  const { workers, routingStrategy } = data;
  const openBreakers = workers.filter((w) => w.circuitState === 'OPEN').length;
  const concurrencyLimit = data.maxConcurrencyPerWorker || 25;

  return (
    <div className="dag-node-card bg-[#0b101b]/95 backdrop-blur-md border border-white/15 rounded-2xl p-4 shadow-2xl min-w-[680px] max-w-[820px] transition-all">
      {/* Target handle from Router */}
      <Handle
        type="target"
        position={Position.Left}
        className="!w-3 !h-3 !bg-[#10b981] !border-2 !border-[#07090e]"
      />

      {/* Top right source handle to Downstream */}
      <Handle
        type="source"
        position={Position.Right}
        id="out-downstream"
        style={{ top: '30%' }}
        className="!w-3 !h-3 !bg-[#10b981] !border-2 !border-[#07090e]"
      />

      {/* Bottom right source handle to DLQ */}
      <Handle
        type="source"
        position={Position.Right}
        id="out-dlq"
        style={{ top: '70%' }}
        className="!w-3 !h-3 !bg-[#f43f5e] !border-2 !border-[#07090e]"
      />

      {/* Cluster Header */}
      <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/10">
        <div className="flex items-center gap-2.5">
          <div>
            <div className="text-xs font-bold tracking-wider text-white uppercase flex items-center gap-2">
              Worker Pool
              <span className="text-[10px] font-mono font-normal text-[#94a3b8]">
                ({workers.length} Nodes)
              </span>
            </div>
            <div className="text-[10px] font-mono text-[#64748b]">
              Concur Limit: {concurrencyLimit} req/node
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Badge variant="emerald" className="text-[10px] font-mono">
            {routingStrategy.replace(/_/g, ' ')}
          </Badge>
          {openBreakers > 0 ? (
            <Badge variant="rose" className="text-[10px] font-mono animate-pulse">
              {openBreakers} TRIPPED
            </Badge>
          ) : (
            <Badge variant="emerald" className="text-[10px] font-mono">
              ALL BREAKERS HEALTHY
            </Badge>
          )}
        </div>
      </div>

      {/* Grid of Workers inside Cluster */}
      <div
        className={cn(
          'grid gap-2.5',
          workers.length <= 4 && 'grid-cols-2 sm:grid-cols-4',
          workers.length > 4 && 'grid-cols-4'
        )}
      >
        {workers.map((w, index) => {
          const loadPct = Math.min(100, Math.round((w.activeJobs / concurrencyLimit) * 100));
          const workerLabel = formatWorkerNumber(w.name, index);
          return (
            <div
              key={w.id}
              className={cn(
                'bg-[#0a0e16]/80 border rounded-lg p-2.5 flex flex-col gap-1.5 transition',
                w.circuitState === 'OPEN'
                  ? 'border-[#f43f5e]/60 shadow-[0_0_12px_rgba(244,63,94,0.2)]'
                  : w.circuitState === 'HALF_OPEN'
                    ? 'border-[#f59e0b]/50'
                    : 'border-white/10 hover:border-white/20'
              )}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-white">
                  <span
                    className={cn(
                      'status-dot',
                      w.circuitState === 'CLOSED' && 'dot-emerald',
                      w.circuitState === 'OPEN' && 'dot-rose',
                      w.circuitState === 'HALF_OPEN' && 'dot-amber'
                    )}
                  />
                  <span>{workerLabel}</span>
                </div>
                <Badge
                  variant={
                    w.circuitState === 'OPEN'
                      ? 'rose'
                      : w.circuitState === 'HALF_OPEN'
                        ? 'amber'
                        : 'emerald'
                  }
                  className="text-[8px] font-mono font-bold px-1 py-0 h-3.5"
                >
                  {w.circuitState}
                </Badge>
              </div>

              {/* Concurrency progress bar */}
              <div>
                <div className="flex justify-between text-[9px] font-mono text-[#94a3b8] mb-0.5">
                  <span>
                    Act: {w.activeJobs}/{concurrencyLimit}
                  </span>
                  <span>{loadPct}%</span>
                </div>
                <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className={cn(
                      'h-full transition-all duration-200',
                      w.circuitState === 'OPEN'
                        ? 'bg-[#f43f5e]'
                        : loadPct > 80
                          ? 'bg-[#f59e0b]'
                          : 'bg-[#10b981]'
                    )}
                    style={{ width: `${loadPct}%` }}
                  />
                </div>
              </div>

              {/* Processed & Failed */}
              <div className="flex justify-between text-[9px] font-mono text-[#94a3b8] pt-1 border-t border-white/5">
                <span>
                  Proc: <b className="text-[#10b981]">{w.totalProcessed.toLocaleString()}</b>
                </span>
                <span>
                  Fail:{' '}
                  <b className={w.totalFailed > 0 ? 'text-[#f43f5e]' : 'text-[#64748b]'}>
                    {w.totalFailed}
                  </b>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 3. Individual Worker Node (For Expanded Mesh View)
// ---------------------------------------------------------------------------

const IndividualWorkerNode: React.FC<NodeProps<Node<IndividualWorkerNodeData>>> = ({ data }) => {
  const { worker: w } = data;
  const concurrencyLimit = data.maxConcurrencyPerWorker || 25;
  const loadPct = Math.min(100, Math.round((w.activeJobs / concurrencyLimit) * 100));

  return (
    <div
      className={cn(
        'dag-node-card bg-[#0f1522]/95 backdrop-blur-md border rounded-xl p-2.5 min-w-[170px] shadow-xl relative transition-all',
        w.circuitState === 'OPEN'
          ? 'border-[#f43f5e]/60 shadow-[0_0_12px_rgba(244,63,94,0.25)]'
          : w.circuitState === 'HALF_OPEN'
            ? 'border-[#f59e0b]/50'
            : 'border-white/10 hover:border-white/20'
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-[#10b981] !border-2 !border-[#07090e]"
      />

      <Handle
        type="source"
        position={Position.Right}
        id="out-downstream"
        style={{ top: '30%' }}
        className="!w-2.5 !h-2.5 !bg-[#10b981] !border-2 !border-[#07090e]"
      />

      <Handle
        type="source"
        position={Position.Right}
        id="out-dlq"
        style={{ top: '70%' }}
        className="!w-2.5 !h-2.5 !bg-[#f43f5e] !border-2 !border-[#07090e]"
      />

      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-white">
          <span
            className={cn(
              'status-dot',
              w.circuitState === 'CLOSED' && 'dot-emerald',
              w.circuitState === 'OPEN' && 'dot-rose',
              w.circuitState === 'HALF_OPEN' && 'dot-amber'
            )}
          />
          <span>{formatWorkerNumber(w.name)}</span>
        </div>
        <Badge
          variant={
            w.circuitState === 'OPEN'
              ? 'rose'
              : w.circuitState === 'HALF_OPEN'
                ? 'amber'
                : 'emerald'
          }
          className="text-[8px] font-mono font-bold px-1.5 py-0 h-3.5"
        >
          {w.circuitState}
        </Badge>
      </div>

      <div className="mb-1">
        <div className="flex justify-between text-[9px] font-mono text-[#94a3b8] mb-0.5">
          <span>
            Active: {w.activeJobs}/{concurrencyLimit}
          </span>
          <span>{loadPct}%</span>
        </div>
        <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full transition-all duration-200',
              w.circuitState === 'OPEN'
                ? 'bg-[#f43f5e]'
                : loadPct > 80
                  ? 'bg-[#f59e0b]'
                  : 'bg-[#10b981]'
            )}
            style={{ width: `${loadPct}%` }}
          />
        </div>
      </div>

      <div className="flex justify-between text-[9px] font-mono text-[#94a3b8] pt-1 border-t border-white/5">
        <span>
          Proc: <b className="text-[#10b981]">{w.totalProcessed}</b>
        </span>
        <span>
          Fail:{' '}
          <b className={w.totalFailed > 0 ? 'text-[#f43f5e]' : 'text-[#64748b]'}>{w.totalFailed}</b>
        </span>
      </div>
    </div>
  );
};

const nodeTypes = {
  pipelineStage: PipelineStageNode,
  workerCluster: WorkerClusterNode,
  individualWorker: IndividualWorkerNode,
};

// ---------------------------------------------------------------------------
// DagFlowInner Component (React Flow Canvas)
// ---------------------------------------------------------------------------

const DagFlowInner: React.FC<DagPipelineProps & { viewMode: 'cluster' | 'mesh' }> = ({
  metrics,
  workers,
  trafficActive,
  routingStrategy,
  maxConcurrencyPerWorker = 25,
  viewMode,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { fitView } = useReactFlow();

  const openBreakers = useMemo(
    () => workers.filter((w) => w.circuitState === 'OPEN').length,
    [workers]
  );

  // Compute cluster dimensions based on worker count
  const clusterDimensions = useMemo(() => {
    const count = workers.length || 8;
    const width = 740;
    let height = 180;
    if (count <= 4) height = 160;
    else if (count <= 8) height = 240;
    else if (count <= 12) height = 330;
    else height = 420;

    return { width, height };
  }, [workers.length]);

  // Dagre layout is structural, not telemetry-driven. Recomputing it on every
  // 250ms frame was the main cost of the mesh view.
  const workerIdsKey = workers.map((w) => w.id).join('|');
  const meshPositions = useMemo(() => {
    const positions = new Map<string, { x: number; y: number }>();
    if (viewMode !== 'mesh') return positions;

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 50 });
    g.setDefaultEdgeLabel(() => ({}));

    g.setNode('traffic', { width: 160, height: 85 });
    g.setNode('ingress', { width: 160, height: 85 });
    g.setNode('buffer', { width: 160, height: 85 });
    g.setNode('router', { width: 160, height: 85 });
    for (const id of workerIdsKey.split('|').filter(Boolean)) {
      g.setNode(`w-${id}`, { width: 175, height: 85 });
    }
    g.setNode('downstream', { width: 160, height: 85 });
    g.setNode('dlq', { width: 160, height: 85 });

    g.setEdge('traffic', 'ingress');
    g.setEdge('ingress', 'buffer');
    g.setEdge('buffer', 'router');
    for (const id of workerIdsKey.split('|').filter(Boolean)) {
      g.setEdge('router', `w-${id}`);
      g.setEdge(`w-${id}`, 'downstream');
      g.setEdge(`w-${id}`, 'dlq');
    }

    dagre.layout(g);
    for (const id of g.nodes()) {
      const node = g.node(id);
      if (node) positions.set(id, { x: node.x, y: node.y });
    }
    return positions;
  }, [viewMode, workerIdsKey]);

  // Build nodes & edges based on active viewMode
  const buildGraphElements = useCallback(() => {
    if (viewMode === 'cluster') {
      const { width: cWidth, height: cHeight } = clusterDimensions;
      const centerY = Math.max(100, Math.round(cHeight / 2) + 10);

      const clusterNodes: Node[] = [
        {
          id: 'traffic',
          type: 'pipelineStage',
          position: { x: 20, y: centerY },
          data: {
            id: 'traffic',
            title: 'Traffic Ingress',
            badge: trafficActive ? 'BURSTING' : 'IDLE',
            badgeVariant: trafficActive ? 'cyan' : 'glass',
            value: `${metrics.incomingRps.toLocaleString()} req/s`,
            valueColor: 'text-[#00f0ff]',
            subvalue: `Accepted: ${metrics.acceptedRps.toLocaleString()}/s`,
            borderColor: trafficActive ? 'border-[#00f0ff]/60' : 'border-white/10',
            hasTargetHandle: false,
            hasSourceHandle: true,
          } as StageNodeData,
        },
        {
          id: 'ingress',
          type: 'pipelineStage',
          position: { x: 205, y: centerY },
          data: {
            id: 'ingress',
            title: 'Ingress Gateway',
            badge: '<10ms',
            badgeVariant: 'cyan',
            value: `P50: ${metrics.p50LatencyMs.toFixed(1)}ms`,
            valueColor: 'text-[#00f0ff]',
            subvalue: `429 Ltd: ${metrics.rateLimitedRps}/s`,
            borderColor: 'border-white/10 hover:border-[#00f0ff]/60',
            hasTargetHandle: true,
            hasSourceHandle: true,
          } as StageNodeData,
        },
        {
          id: 'buffer',
          type: 'pipelineStage',
          position: { x: 390, y: centerY },
          data: {
            id: 'buffer',
            title: 'Shock Buffer',
            badge: `${metrics.bufferUtilizationPct}% FULL`,
            badgeVariant: 'purple',
            value: `${metrics.bufferDepth.toLocaleString()} queued`,
            valueColor: 'text-[#a855f7]',
            subvalue: `Cap: ${metrics.bufferCapacity.toLocaleString()}`,
            borderColor: 'border-white/10 hover:border-[#a855f7]/60',
            hasTargetHandle: true,
            hasSourceHandle: true,
          } as StageNodeData,
        },
        {
          id: 'router',
          type: 'pipelineStage',
          position: { x: 575, y: centerY },
          data: {
            id: 'router',
            title: 'Routing Engine',
            badge: routingStrategy.replace(/_/g, '-'),
            badgeVariant: 'emerald',
            value: `${metrics.drainedRps.toLocaleString()}/s`,
            valueColor: 'text-[#10b981]',
            subvalue: 'Load Balancer',
            borderColor: 'border-white/10 hover:border-[#10b981]/60',
            hasTargetHandle: true,
            hasSourceHandle: true,
          } as StageNodeData,
        },
        {
          id: 'workerPool',
          type: 'workerCluster',
          position: { x: 760, y: 15 },
          data: {
            workers,
            routingStrategy,
            trafficActive,
            drainedRps: metrics.drainedRps,
            maxConcurrencyPerWorker,
          } as WorkerClusterNodeData,
        },
        {
          id: 'downstream',
          type: 'pipelineStage',
          position: { x: 760 + cWidth + 40, y: Math.max(15, centerY - 65) },
          data: {
            id: 'downstream',
            title: 'Mock API / DB',
            badge: openBreakers > 0 ? `${openBreakers} OPEN` : 'HEALTHY',
            badgeVariant: openBreakers > 0 ? 'rose' : 'emerald',
            value: metrics.drainedRps > 0 ? `${metrics.drainedRps.toLocaleString()}/s` : '200 OK',
            valueColor: 'text-[#10b981]',
            subvalue: 'Target Endpoint',
            borderColor: 'border-white/10 hover:border-[#10b981]/60',
            hasTargetHandle: true,
            hasSourceHandle: false,
          } as StageNodeData,
        },
        {
          id: 'dlq',
          type: 'pipelineStage',
          position: { x: 760 + cWidth + 40, y: centerY + 65 },
          data: {
            id: 'dlq',
            title: 'Dead-Letter Queue',
            badge: 'DLQ',
            badgeVariant: metrics.dlqSize > 0 ? 'rose' : 'glass',
            value: `${metrics.dlqSize} failed`,
            valueColor: 'text-[#f43f5e]',
            subvalue: 'Poison Pill Storage',
            borderColor: metrics.dlqSize > 0 ? 'border-[#f43f5e]/60' : 'border-white/10',
            hasTargetHandle: true,
            hasSourceHandle: false,
          } as StageNodeData,
        },
      ];

      const clusterEdges = [
        {
          id: 'e-traffic-ingress',
          source: 'traffic',
          target: 'ingress',
          animated: trafficActive,
          style: { stroke: '#00f0ff', strokeWidth: 2 },
        },
        {
          id: 'e-ingress-buffer',
          source: 'ingress',
          target: 'buffer',
          animated: metrics.acceptedRps > 0,
          style: { stroke: '#a855f7', strokeWidth: 2 },
        },
        {
          id: 'e-buffer-router',
          source: 'buffer',
          target: 'router',
          animated: metrics.drainedRps > 0,
          style: { stroke: '#10b981', strokeWidth: 2 },
        },
        {
          id: 'e-router-workers',
          source: 'router',
          target: 'workerPool',
          animated: metrics.drainedRps > 0,
          style: { stroke: '#10b981', strokeWidth: 2 },
        },
        {
          id: 'e-workers-downstream',
          source: 'workerPool',
          sourceHandle: 'out-downstream',
          target: 'downstream',
          animated: metrics.drainedRps > 0,
          style: { stroke: '#10b981', strokeWidth: 2 },
        },
        {
          id: 'e-workers-dlq',
          source: 'workerPool',
          sourceHandle: 'out-dlq',
          target: 'dlq',
          animated: metrics.dlqSize > 0 || openBreakers > 0,
          style: { stroke: '#f43f5e', strokeWidth: 2 },
        },
      ];

      return { nodes: clusterNodes, edges: clusterEdges };
    }

    // Mesh view: use the memoized Dagre layout (not recomputed per frame)
    const getPos = (id: string, width: number, height: number) => {
      const node = meshPositions.get(id);
      if (!node) return { x: 0, y: 0 };
      return {
        x: Math.round(node.x - width / 2),
        y: Math.round(node.y - height / 2),
      };
    };

    const meshNodes: Node[] = [
      {
        id: 'traffic',
        type: 'pipelineStage',
        position: getPos('traffic', 160, 85),
        data: {
          id: 'traffic',
          title: 'Traffic Ingress',
          icon: 'zap',
          badge: trafficActive ? 'BURSTING' : 'IDLE',
          badgeVariant: trafficActive ? 'cyan' : 'glass',
          value: `${metrics.incomingRps.toLocaleString()} req/s`,
          valueColor: 'text-[#00f0ff]',
          subvalue: `Accepted: ${metrics.acceptedRps.toLocaleString()}/s`,
          borderColor: trafficActive ? 'border-[#00f0ff]/60' : 'border-white/10',
          hasTargetHandle: false,
          hasSourceHandle: true,
        } as StageNodeData,
      },
      {
        id: 'ingress',
        type: 'pipelineStage',
        position: getPos('ingress', 160, 85),
        data: {
          id: 'ingress',
          title: 'Ingress Gateway',
          icon: 'shield',
          badge: '<10ms',
          badgeVariant: 'cyan',
          value: `P50: ${metrics.p50LatencyMs.toFixed(1)}ms`,
          valueColor: 'text-[#00f0ff]',
          subvalue: `429 Ltd: ${metrics.rateLimitedRps}/s`,
          borderColor: 'border-white/10 hover:border-[#00f0ff]/60',
          hasTargetHandle: true,
          hasSourceHandle: true,
        } as StageNodeData,
      },
      {
        id: 'buffer',
        type: 'pipelineStage',
        position: getPos('buffer', 160, 85),
        data: {
          id: 'buffer',
          title: 'Shock Buffer',
          icon: 'database',
          badge: `${metrics.bufferUtilizationPct}% FULL`,
          badgeVariant: 'purple',
          value: `${metrics.bufferDepth.toLocaleString()} queued`,
          valueColor: 'text-[#a855f7]',
          subvalue: `Cap: ${metrics.bufferCapacity.toLocaleString()}`,
          borderColor: 'border-white/10 hover:border-[#a855f7]/60',
          hasTargetHandle: true,
          hasSourceHandle: true,
        } as StageNodeData,
      },
      {
        id: 'router',
        type: 'pipelineStage',
        position: getPos('router', 160, 85),
        data: {
          id: 'router',
          title: 'Routing Engine',
          icon: 'git',
          badge: routingStrategy.replace(/_/g, '-'),
          badgeVariant: 'emerald',
          value: `${metrics.drainedRps.toLocaleString()}/s`,
          valueColor: 'text-[#10b981]',
          subvalue: 'Load Balancer',
          borderColor: 'border-white/10 hover:border-[#10b981]/60',
          hasTargetHandle: true,
          hasSourceHandle: true,
        } as StageNodeData,
      },
      ...workers.map((w) => ({
        id: `w-${w.id}`,
        type: 'individualWorker',
        position: getPos(`w-${w.id}`, 175, 85),
        data: {
          worker: w,
          trafficActive,
          maxConcurrencyPerWorker,
        } as IndividualWorkerNodeData,
      })),
      {
        id: 'downstream',
        type: 'pipelineStage',
        position: getPos('downstream', 160, 85),
        data: {
          id: 'downstream',
          title: 'Mock API / DB',
          icon: 'server',
          badge: openBreakers > 0 ? `${openBreakers} OPEN` : 'HEALTHY',
          badgeVariant: openBreakers > 0 ? 'rose' : 'emerald',
          value: metrics.drainedRps > 0 ? `${metrics.drainedRps.toLocaleString()}/s` : '200 OK',
          valueColor: 'text-[#10b981]',
          subvalue: 'Target Endpoint',
          borderColor: 'border-white/10 hover:border-[#10b981]/60',
          hasTargetHandle: true,
          hasSourceHandle: false,
        } as StageNodeData,
      },
      {
        id: 'dlq',
        type: 'pipelineStage',
        position: getPos('dlq', 160, 85),
        data: {
          id: 'dlq',
          title: 'Dead-Letter Queue',
          icon: 'alert',
          badge: 'DLQ',
          badgeVariant: metrics.dlqSize > 0 ? 'rose' : 'glass',
          value: `${metrics.dlqSize} failed`,
          valueColor: 'text-[#f43f5e]',
          subvalue: 'Poison Pill Storage',
          borderColor: metrics.dlqSize > 0 ? 'border-[#f43f5e]/60' : 'border-white/10',
          hasTargetHandle: true,
          hasSourceHandle: false,
        } as StageNodeData,
      },
    ];

    const meshEdges = [
      {
        id: 'e-traffic-ingress',
        source: 'traffic',
        target: 'ingress',
        animated: trafficActive,
        style: { stroke: '#00f0ff', strokeWidth: 2 },
      },
      {
        id: 'e-ingress-buffer',
        source: 'ingress',
        target: 'buffer',
        animated: metrics.acceptedRps > 0,
        style: { stroke: '#a855f7', strokeWidth: 2 },
      },
      {
        id: 'e-buffer-router',
        source: 'buffer',
        target: 'router',
        animated: metrics.drainedRps > 0,
        style: { stroke: '#10b981', strokeWidth: 2 },
      },
      ...workers.flatMap((w) => [
        {
          id: `e-router-w-${w.id}`,
          source: 'router',
          target: `w-${w.id}`,
          animated: metrics.drainedRps > 0 && w.circuitState !== 'OPEN',
          style: {
            stroke: w.circuitState === 'OPEN' ? '#f43f5e' : '#10b981',
            strokeWidth: 1.5,
          },
        },
        {
          id: `e-w-${w.id}-downstream`,
          source: `w-${w.id}`,
          sourceHandle: 'out-downstream',
          target: 'downstream',
          animated: metrics.drainedRps > 0 && w.circuitState !== 'OPEN',
          style: { stroke: '#10b981', strokeWidth: 1.5 },
        },
        {
          id: `e-w-${w.id}-dlq`,
          source: `w-${w.id}`,
          sourceHandle: 'out-dlq',
          target: 'dlq',
          animated: w.circuitState === 'OPEN' || w.totalFailed > 0,
          style: { stroke: '#f43f5e', strokeWidth: 1.5 },
        },
      ]),
    ];

    return { nodes: meshNodes, edges: meshEdges };
  }, [
    viewMode,
    clusterDimensions,
    trafficActive,
    metrics.incomingRps,
    metrics.acceptedRps,
    metrics.p50LatencyMs,
    metrics.rateLimitedRps,
    metrics.bufferUtilizationPct,
    metrics.bufferDepth,
    metrics.bufferCapacity,
    metrics.drainedRps,
    metrics.dlqSize,
    workers,
    routingStrategy,
    openBreakers,
    meshPositions,
    maxConcurrencyPerWorker,
  ]);

  // React Flow is fully controlled here (no dragging/connecting/selection), so
  // there is no need for the nodes/edges state hooks and their sync effect.
  const { nodes, edges } = buildGraphElements();

  // Auto-fit view on resize or viewMode change (debounced)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const timer = setTimeout(() => {
      fitView({ padding: 0.1, duration: 250 });
    }, 60);

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitView({ padding: 0.1 });
      }, 150);
    });

    observer.observe(el);

    return () => {
      clearTimeout(timer);
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
    };
  }, [fitView, viewMode]);

  // Compute container height dynamically
  const containerHeight = useMemo(() => {
    if (viewMode === 'cluster') {
      return Math.max(420, clusterDimensions.height + 80);
    }
    return Math.max(500, Math.min(800, workers.length * 60 + 120));
  }, [viewMode, clusterDimensions.height, workers.length]);

  return (
    <div
      ref={containerRef}
      style={{ height: `${containerHeight}px` }}
      className="relative w-full bg-[#070a10]/70 border border-white/10 rounded-xl overflow-hidden transition-all duration-300"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={true}
        zoomOnScroll={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1e293b" gap={24} size={1} />
        <Controls
          showInteractive={false}
          className="!bg-[#0f1522]/90 !border !border-white/10 !rounded-lg !shadow-xl !fill-white"
        />
      </ReactFlow>
    </div>
  );
};

// ---------------------------------------------------------------------------
// DagPipeline (Main Unified Component)
// ---------------------------------------------------------------------------

export const DagPipeline: React.FC<DagPipelineProps> = (props) => {
  const [viewMode, setViewMode] = useState<'cluster' | 'mesh'>('cluster');
  const openBreakers = useMemo(
    () => props.workers.filter((w) => w.circuitState === 'OPEN').length,
    [props.workers]
  );

  return (
    <section className="glass-card rounded-2xl p-6">
      <div className="flex justify-between items-center mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-sm font-bold tracking-wider uppercase text-white flex items-center gap-2">
            <Network className="size-4 text-[#00f0ff]" />
            System Architecture &amp; Worker Pool
          </h2>
          <Badge variant="emerald" className="text-xs font-mono">
            {props.routingStrategy.replace(/_/g, ' ')}
          </Badge>
          {openBreakers > 0 ? (
            <Badge variant="rose" className="text-xs font-mono animate-pulse">
              {openBreakers} Breaker(s) Tripped
            </Badge>
          ) : (
            <Badge variant="emerald" className="text-xs font-mono hidden sm:inline-flex">
              All Breakers Healthy
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* View Mode Toggle */}
          <div className="flex items-center rounded-lg bg-white/5 border border-white/10 p-0.5 text-xs font-mono">
            <button
              type="button"
              onClick={() => setViewMode('cluster')}
              className={cn(
                'px-2.5 py-1 rounded-md transition flex items-center gap-1.5 cursor-pointer',
                viewMode === 'cluster'
                  ? 'bg-[#00f0ff]/20 text-[#00f0ff] font-bold border border-[#00f0ff]/30 shadow-xs'
                  : 'text-[#94a3b8] hover:text-white'
              )}
            >
              <LayoutGrid className="size-3.5" />
              <span>Cluster View</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('mesh')}
              className={cn(
                'px-2.5 py-1 rounded-md transition flex items-center gap-1.5 cursor-pointer',
                viewMode === 'mesh'
                  ? 'bg-[#00f0ff]/20 text-[#00f0ff] font-bold border border-[#00f0ff]/30 shadow-xs'
                  : 'text-[#94a3b8] hover:text-white'
              )}
            >
              <GitFork className="size-3.5" />
              <span>Expanded Mesh</span>
            </button>
          </div>

          {/* Color Legend */}
          <div className="hidden xl:flex items-center gap-3 text-xs text-[#94a3b8] pl-2 border-l border-white/10 font-mono text-[11px]">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#00f0ff]" /> Ingress
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#a855f7]" /> Buffer
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#10b981]" /> Healthy
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#f43f5e]" /> Tripped / DLQ
            </span>
          </div>
        </div>
      </div>

      <ReactFlowProvider>
        <DagFlowInner {...props} viewMode={viewMode} />
      </ReactFlowProvider>
    </section>
  );
};
