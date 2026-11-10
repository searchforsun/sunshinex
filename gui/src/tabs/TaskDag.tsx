import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { Edge, Node, NodeProps } from '@xyflow/react';
import { Graph as DagreGraph, layout as dagreLayout } from '@dagrejs/dagre';
import { AlarmClock, Bot, Pause } from 'lucide-react';
import type { BoardTask } from '../projection';
import { t } from '../i18n';
import { fmtDurMs } from '../ui-util';
import '@xyflow/react/dist/style.css';

/**
 * 任务卡 DAG 视图(G14.2xx:mermaid 拼源渲染退役,改开源图组件 React Flow(@xyflow/react,MIT)+
 * dagre 自动布局(@dagrejs/dagre,MIT)——节点=任务状态图标+任务名+执行子智能体名,交互面(平移/滚轮
 * 缩放/控制钮)组件内置,mermaid 时代的拼源/容错/lightbox 全部不再需要。
 * 节点点击:仅「有执行子智能体」的任务可点 → 上抛 onTaskOpen。
 * dependsOn 为实线依赖边；retryOf 为虚线并标「重试」，布局排在前驱之后。
 * START/END 补齐并行任务的起止。未知依赖与集合外 retryOf 忽略；环交 dagre 割环。
 */

/** 任务节点盒尺寸(dagre 布局步进 + React Flow 免实测尺寸的既定值;CSS 同值配套) */
export const TASK_NODE_W = 224;
export const TASK_NODE_H = 66; // 2026-11-09 节点字号统一 14px:两行(标题+执行者/耗时)+内边距
export const TASK_NODE_H_COMPACT = 42;
/** 起止虚拟节点尺寸 */
const TERMINAL_W = 92;
const TERMINAL_H = 32;
const START_ID = '__start';
const END_ID = '__end';

export interface TaskNodeData extends Record<string, unknown> {
  id: string;
  title: string;
  status: BoardTask['status'];
  /** 执行子智能体显示名(空串=未派发:不显行、不可点) */
  agent: string;
  clickable: boolean;
  /** 完成/运行耗时(ms)；缺省不显 */
  durationMs?: number;
}

interface TerminalNodeData extends Record<string, unknown> {
  label: string;
}

export interface TaskDagProps {
  readonly tasks: readonly BoardTask[];
  /** taskId → 执行子智能体显示名(未派发回空串);布局(有无代理行)与可点判定共用同一单点 */
  readonly agentOf: (taskId: string) => string;
  /** taskId → 耗时 ms（完成态 artifact / 运行中实时）；缺省不显 */
  readonly durationOf?: (taskId: string) => number | undefined;
  /** 任务节点点击上抛(仅 agentOf 命中的节点会触发) */
  readonly onTaskOpen?: (taskId: string) => void;
  /** pending|running 节点 hover 停止 */
  readonly onStopTask?: (taskId: string) => void;
  /** 正文点任务定位：命中节点居中并 flash */
  readonly focusId?: string;
  readonly focusNonce?: number;
}

const DagStopContext = createContext<((taskId: string) => void) | undefined>(undefined);

/** 任务图 → { nodes, edges }(纯函数):dagre LR 分层布局,START→根任务/汇点→END 补起止;
 *  布局坐标为 dagre 中心点,转 React Flow 左上角落位;width/height 显式给出(免实测,jsdom 亦可渲) */
export function layoutTaskDag(
  tasks: readonly BoardTask[],
  agentOf: (taskId: string) => string,
  durationOf: (taskId: string) => number | undefined = () => undefined,
): { nodes: Node[]; edges: Edge[] } {
  const sorted = [...tasks].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const inSet = new Set(sorted.map((x) => x.id));
  const g = new DagreGraph();
  g.setGraph({ rankdir: 'LR', nodesep: 26, ranksep: 64, marginx: 8, marginy: 8 });
  g.setDefaultEdgeLabel(() => ({}));
  const heightOf = (task: BoardTask): number => {
    const hasAgent = agentOf(task.id) !== '';
    const hasDur = durationOf(task.id) !== undefined;
    if (hasAgent || hasDur) return TASK_NODE_H;
    return TASK_NODE_H_COMPACT;
  };
  for (const task of sorted) g.setNode(task.id, { width: TASK_NODE_W, height: heightOf(task) });
  g.setNode(START_ID, { width: TERMINAL_W, height: TERMINAL_H });
  g.setNode(END_ID, { width: TERMINAL_W, height: TERMINAL_H });
  const edges: Edge[] = [];
  const link = (from: string, to: string, kind: 'frame' | 'dep' | 'retry'): void => {
    g.setEdge(from, to);
    if (kind === 'retry') {
      edges.push({
        id: `r-${from}-${to}`,
        source: from,
        target: to,
        animated: false,
        className: 'tb-dag-retry',
        label: t('Retry', '重试'),
        style: { strokeDasharray: '6 4' },
      });
      return;
    }
    edges.push({
      id: `${kind === 'dep' ? 'd' : 'f'}-${from}-${to}`,
      source: from,
      target: to,
      // 2026-11-03 用户裁定:依赖线=数据流动效果(RF 内建 animated 流动虚线,dashdraw 沿路径推进)
      animated: true,
      className: kind === 'dep' ? 'tb-dag-dep' : 'tb-dag-frame',
    });
  };
  for (const task of sorted) {
    // 集合外的 dependsOn / retryOf 忽略（补发交错时引用尚未入图）
    const deps = task.dependsOn.filter((d) => inSet.has(d));
    const retryPred = task.retryOf !== undefined && inSet.has(task.retryOf) ? task.retryOf : undefined;
    if (deps.length === 0 && retryPred === undefined) link(START_ID, task.id, 'frame');
    for (const d of deps) link(d, task.id, 'dep');
    if (retryPred !== undefined) link(retryPred, task.id, 'retry');
    const hasDown = sorted.some((x) => x.dependsOn.includes(task.id) || x.retryOf === task.id);
    if (!hasDown) link(task.id, END_ID, 'frame');
  }
  dagreLayout(g);
  const at = (id: string, w: number, h: number): { x: number; y: number } => {
    const n = g.node(id);
    return { x: n.x - w / 2, y: n.y - h / 2 };
  };
  const terminal = (id: string, label: string): Node<TerminalNodeData, 'terminal'> => ({
    id,
    type: 'terminal',
    position: at(id, TERMINAL_W, TERMINAL_H),
    width: TERMINAL_W,
    height: TERMINAL_H,
    draggable: false,
    deletable: false,
    data: { label },
  });
  return {
    nodes: [
      terminal(START_ID, t('▶ start', '▶ 开始')),
      ...sorted.map((task) => {
        const h = heightOf(task);
        const agent = agentOf(task.id);
        const durationMs = durationOf(task.id);
        return {
          id: task.id,
          type: 'task' as const,
          position: at(task.id, TASK_NODE_W, h),
          width: TASK_NODE_W,
          height: h,
          deletable: false,
          data: {
            id: task.id,
            title: task.title !== '' ? task.title : task.id,
            status: task.status,
            agent,
            clickable: agent !== '',
            ...(durationMs !== undefined ? { durationMs } : {}),
          },
        };
      }),
      terminal(END_ID, t('◼ end', '◼ 结束')),
    ],
    edges,
  };
}

/** 任务节点:状态点+任务名+执行子智能体行。pending/running hover 出停止。
 *  节点名恒单行截断——hover 全名走 data-tip。 */
function TaskNode({ data, selected }: NodeProps<Node<TaskNodeData, 'task'>>): JSX.Element {
  const onStopTask = useContext(DagStopContext);
  const stoppable = data.status === 'pending' || data.status === 'running';
  return (
    <div
      className={`tb-dag-node task-status-${data.status}${data.clickable ? ' clickable' : ''}${selected ? ' flash' : ''}`}
      aria-label={`${data.id} [${data.status}] ${data.title}`}
      data-tip={data.title}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="tb-dag-node-head">
        <span className={`tb-status-dot task-status-${data.status}`} aria-hidden="true" />
        <span className={`tb-dag-node-title${data.status === 'cancelled' ? ' tb-struck' : ''}`}>{data.title}</span>
        {stoppable && (
          <button
            type="button"
            className="tb-stop"
            aria-label={`${t('Stop', '停止')} ${data.id}`}
            data-tip={t('Stop', '停止')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onStopTask?.(data.id);
            }}
          >
            <Pause size={16} strokeWidth={2.25} fill="currentColor" aria-hidden="true" />
          </button>
        )}
      </div>
      {(data.agent !== '' || data.durationMs !== undefined) && (
        <div className="tb-dag-node-meta">
          {data.agent !== '' && (
            <span className="tb-dag-node-agent">
              <Bot size={14} strokeWidth={1.75} aria-hidden="true" />
              {data.agent}
            </span>
          )}
          {data.durationMs !== undefined && (
            <span className="bg-dur" data-tip={t('Elapsed', '运行时长')}>
              <AlarmClock size={14} strokeWidth={1.75} aria-hidden="true" />
              {fmtDurMs(data.durationMs)}
            </span>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

/** 起止虚拟节点(START/END):弱化的虚线胶囊,纯形态不承载交互 */
function TerminalNode({ data }: NodeProps<Node<TerminalNodeData, 'terminal'>>): JSX.Element {
  return (
    <div className="tb-dag-terminal" aria-hidden="true">
      <Handle type="target" position={Position.Left} isConnectable={false} />
      {data.label}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const NODE_TYPES = { task: TaskNode, terminal: TerminalNode };

/** 视图适配参数单点:装载 fitView 与复位钮(Controls)共用——G14.2xx 用户实测反馈「复位不可用」
 *  的真凶:Controls 不传 fitViewOptions 时默认上限吃 ReactFlow maxZoom(1.75),小图点复位反而
 *  放大;钉同一份 padding/maxZoom 后复位=回到装载态,duration 给出可见的动画回正反馈 */
const FIT_VIEW_OPTIONS = { padding: 0.12, maxZoom: 1, duration: 300 };

function TaskDagInner({ tasks, agentOf, durationOf, onTaskOpen, onStopTask, focusId, focusNonce }: TaskDagProps): JSX.Element {
  const layout = useMemo(
    () => layoutTaskDag(tasks, agentOf, durationOf),
    [tasks, agentOf, durationOf],
  );
  const { fitView, setCenter, getNode } = useReactFlow();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // 任务增减即回正视图(新任务可能落画面外);节点拖拽后的位置交布局重算统一
  useEffect(() => {
    const timer = setTimeout(() => void fitView(FIT_VIEW_OPTIONS), 30);
    return () => clearTimeout(timer);
  }, [fitView, layout.nodes.length]);
  // 侧栏拖宽即回正(2026-11-10 用户裁定「调整侧栏宽度时始终显示在最佳大小」):容器宽度变化
  // (拖宽/收窄/窗口缩放)即 fitView 回装载态;高度变化不触发(拖高不改适配)。手动缩放被回正覆盖
  // =裁定口径的既定代价(下次手动调,再拖宽又回正)
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    let last = el.clientWidth;
    let timer: number | undefined;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === last) return;
      last = el.clientWidth;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void fitView(FIT_VIEW_OPTIONS), 80);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [fitView]);
  // 正文点任务：居中 + 短暂选中 flash
  useEffect(() => {
    if (focusId === undefined || focusId === '') return;
    setSelectedId(focusId);
    const timer = setTimeout(() => {
      const node = getNode(focusId);
      if (node !== undefined) {
        const w = node.width ?? TASK_NODE_W;
        const h = node.height ?? TASK_NODE_H;
        void setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: 1, duration: 300 });
      } else {
        void fitView({ ...FIT_VIEW_OPTIONS, nodes: [{ id: focusId }] });
      }
    }, 40);
    const clear = setTimeout(() => setSelectedId(undefined), 1800);
    return () => {
      clearTimeout(timer);
      clearTimeout(clear);
    };
  }, [focusId, focusNonce, fitView, getNode, setCenter]);
  const nodes = useMemo(
    () => layout.nodes.map((n) => (n.id === selectedId ? { ...n, selected: true } : { ...n, selected: false })),
    [layout.nodes, selectedId],
  );
  const onNodeClick = useCallback<NonNullable<Parameters<typeof ReactFlow>[0]['onNodeClick']>>(
    (_, node) => {
      if (node.type === 'task' && (node.data as TaskNodeData).clickable === true) onTaskOpen?.(node.id);
    },
    [onTaskOpen],
  );
  return (
    <DagStopContext.Provider value={onStopTask}>
    <div ref={wrapRef} className="tb-dag-wrap" style={{ width: '100%', height: '100%' }}>
    <ReactFlow
      className="tb-dag-reactflow"
      nodes={nodes}
      edges={layout.edges}
      nodeTypes={NODE_TYPES}
      onNodeClick={onNodeClick}
      fitView
      fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
      minZoom={0.15}
      maxZoom={1.75}
      nodesConnectable={false}
      deleteKeyCode={null}
      defaultEdgeOptions={{ type: 'smoothstep', animated: true }}
      // G14.2xx 用户裁定:右下角 React Flow 水印去除(桌面内部应用,proOptions 官方开关)
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={14} size={1} />
      {/* 控制钮(+/−/复位)钉右下角(G14.2xx 用户裁定,左下角退役) */}
      <Controls position="bottom-right" showInteractive={false} fitViewOptions={FIT_VIEW_OPTIONS} />
    </ReactFlow>
    </div>
    </DagStopContext.Provider>
  );
}

/** default 导出为 lazy() 载入面(React Flow 不进主 bundle,与 mermaid 时代的分包纪律同口径) */
export default function TaskDag(props: TaskDagProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <TaskDagInner {...props} />
    </ReactFlowProvider>
  );
}
