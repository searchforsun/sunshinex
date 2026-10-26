/** 工具面定义表（MCP tools/list 载荷）：name/description/inputSchema。
 *
 *  strict 兼容口径（沿主仓 `src/harness/tools/builtin.ts` 惯例）：`additionalProperties:false`、
 *  **全字段 required**、可选项以 `|null` 联合表达（模型侧传 null 即缺省——dispatch/worker 落地时剥 null
 *  取缺省，沿主仓「null 联合可选项」消费口径）；可选枚举字段的 enum 并入 null。
 *  名单 = spec §5.2 收敛动作面 11 工具（观察三件 + 动作八件）：
 *  screenshot/uia_snapshot/window_list（观察）+ click/type/key/scroll/drag/wait/wait_for/app（动作）。 */

/** 极简 JSON Schema 形态（镜像主仓 `src/types.ts` JsonSchema 声明面字段；子包自持不跨包引源）。 */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  minItems?: number;
  maxItems?: number;
}

/** MCP Tool 条目（server 域内形态；tools/list 时原样下发）。 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** null 归入可选枚举的 strict 口径糖（`['string','null']` + enum 并 null——两关键字必须同含 null 才互洽）。 */
function nullableEnum(values: string[]): JsonSchema {
  return { type: ['string', 'null'], enum: [...values, null] };
}

/** 观察类（只读）+ 动作类（写面）11 工具；入参名与 spec §5.2「确切参数」逐字对齐。 */
export const TOOLS: ToolDef[] = [
  {
    name: 'screenshot',
    description:
      'Capture the screen as a JPEG image (long edge capped at 1568px); returns the image plus text metadata (original vs sent size for coordinate accounting, cursor position, foreground window title) — always screenshot before acting so click coordinates match what you saw',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['region', 'display'],
      properties: {
        region: {
          type: ['array', 'null'],
          items: { type: 'number' },
          minItems: 4,
          maxItems: 4,
          description: 'Optional capture region [left, top, right, bottom] in physical screen pixels; null captures the full virtual screen',
        },
        display: { type: ['integer', 'null'], description: 'Optional 0-based display index; null uses the primary display' },
      },
    },
  },
  {
    name: 'uia_snapshot',
    description:
      'Read a structured accessibility (UIA) element listing of the desktop or the foreground window — id/ControlType/Name/BoundingRect/IsEnabled per interactive element (capped at 300); prefer this over screenshots when you only need to locate controls or read text',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['scope'],
      properties: {
        scope: {
          ...nullableEnum(['window', 'desktop']),
          description: "'window' lists elements of the foreground window; 'desktop' lists top-level elements of the whole desktop; null defaults to 'window'",
        },
      },
    },
  },
  {
    name: 'window_list',
    description: 'List top-level windows (title, pid, foreground flag, z-order) to find the window to focus or to verify the active window',
    inputSchema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
  {
    name: 'click',
    description:
      'Move the mouse to (x, y) and click — coordinates are in the pixel space of the LAST screenshot you took (they are remapped to physical screen coordinates server-side); take a fresh screenshot first if the screen may have changed',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y', 'button', 'clicks'],
      properties: {
        x: { type: 'number', description: 'X coordinate in the last screenshot\'s pixel space' },
        y: { type: 'number', description: 'Y coordinate in the last screenshot\'s pixel space' },
        button: { ...nullableEnum(['left', 'right', 'middle']), description: 'Mouse button; null defaults to left' },
        clicks: { type: ['integer', 'null'], enum: [1, 2, 3, null], description: 'Click count (2 = double click, 3 = triple); null defaults to 1' },
      },
    },
  },
  {
    name: 'type',
    description: 'Type text into the focused window character by character (Unicode input); focus the target window/app first',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string', description: 'Text to type verbatim (newline characters are sent as Enter presses)' } },
    },
  },
  {
    name: 'key',
    description: 'Press a key combination — keys are pressed in order, held, then released in reverse (e.g. ["Ctrl","Shift","Esc"]); use for shortcuts, Enter/Esc/Tab/arrows',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['keys'],
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Key names in press order, e.g. ["Ctrl","C"] or ["Enter"]; modifiers: Ctrl/Alt/Shift/Win',
        },
      },
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the mouse wheel up or down; optionally at a specific point (coordinates in the last screenshot\'s pixel space, remapped server-side)',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['direction', 'amount', 'x', 'y'],
      properties: {
        direction: { type: 'string', enum: ['up', 'down'], description: 'Wheel direction' },
        amount: { type: 'integer', description: 'Number of wheel notches (positive integer)' },
        x: { type: ['integer', 'null'], description: 'Optional X coordinate in the last screenshot\'s pixel space; null scrolls at the current cursor position' },
        y: { type: ['integer', 'null'], description: 'Optional Y coordinate in the last screenshot\'s pixel space; null scrolls at the current cursor position' },
      },
    },
  },
  {
    name: 'drag',
    description: 'Press the left button at `from`, move along an interpolated path, and release at `to` (coordinates in the last screenshot\'s pixel space, remapped server-side); use for window moves, sliders, selections',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to'],
      properties: {
        from: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Start point [x, y] in the last screenshot\'s pixel space' },
        to: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'End point [x, y] in the last screenshot\'s pixel space' },
      },
    },
  },
  {
    name: 'wait',
    description: 'Sleep for the given number of seconds (bounded, for animations/launch delays) — prefer wait_for when waiting for specific UI text',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['seconds'],
      properties: { seconds: { type: 'number', description: 'Seconds to sleep (fractional allowed, e.g. 1.5)' } },
    },
  },
  {
    name: 'wait_for',
    description:
      'Poll the UIA tree until the target text appears or disappears (single call polls internally, default timeout 10s) — use after launching an app or clicking instead of blind wait+screenshot rounds',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['target', 'mode', 'timeout'],
      properties: {
        target: { type: 'string', description: 'UIA text to wait for (exact substring of an element name)' },
        mode: { ...nullableEnum(['appear', 'disappear']), description: "'appear' (default) resolves when the text shows up; 'disappear' when it is gone; null defaults to 'appear'" },
        timeout: { type: ['number', 'null'], description: 'Timeout in seconds; null defaults to 10' },
      },
    },
  },
  {
    name: 'app',
    description: "Launch an app by name from the Start Menu or executable path ('launch'), or bring an existing window to the foreground by title ('focus')",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'target'],
      properties: {
        action: { type: 'string', enum: ['launch', 'focus'], description: "'launch' starts a new process; 'focus' activates an existing window" },
        target: { type: 'string', description: "Start-Menu name or executable path for 'launch'; window title for 'focus'" },
      },
    },
  },
];
