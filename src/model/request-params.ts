/**
 * 自定义请求参数（providers models[].params）：用户声明键值对，适配器装配请求体时原样并入。
 * 厂商私有字段（缓存路由键、思考模板开关、采样扩展等）一律由此声明——适配器不写任何厂商分支，
 * 新增一种端点扩展=用户在设置页加一行参数。
 * 零依赖叶模块（T14 跨包叶子纪律）：config 解析面（宽容告警）、catalog 写面（严格拒收）、
 * GUI 弹窗（前置拦截）三面共用同一校验实现与保留键清单，口径不分叉。
 */

/** 请求参数值：JSON 可表示值（string/number/boolean/null/数组/对象）——原样并入请求体 */
export type RequestParamValue = string | number | boolean | null | RequestParamValue[] | { [key: string]: RequestParamValue };

/** 自定义请求参数字典（键=请求体顶层字段名） */
export type RequestParams = Record<string, RequestParamValue>;

/** 协议字段：请求体由适配器按协议装配，自定义参数不得占用——占用会改变协议语义
 *  （如 stream 关流、messages 换载荷）。解析面告警忽略该键、写面拒收、GUI 前置拦截三面同源 */
export const RESERVED_REQUEST_PARAM_KEYS: readonly string[] = ['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options'];

/** 嵌套上限：JSON 载荷真实嵌套远低于此，超限视为形态错误（防循环引用/失控深递归） */
const MAX_PARAM_DEPTH = 8;

/** 单值校验结果：ok=true 带归一值；false 已把原因写入 problems（调用方决定记告警还是拒收） */
type Checked = { ok: true; value: RequestParamValue } | { ok: false };

function checkValue(v: unknown, path: string, depth: number, problems: string[]): Checked {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return { ok: true, value: v };
  if (typeof v === 'number') {
    // JSON 无 NaN/Infinity，序列化会退化成 null——静默变形不如显式报出
    if (!Number.isFinite(v)) {
      problems.push(`${path} 须为有限数值`);
      return { ok: false };
    }
    return { ok: true, value: v };
  }
  if (depth >= MAX_PARAM_DEPTH) {
    problems.push(`${path} 嵌套超过 ${MAX_PARAM_DEPTH} 层`);
    return { ok: false };
  }
  if (Array.isArray(v)) {
    const out: RequestParamValue[] = [];
    for (let i = 0; i < v.length; i++) {
      const r = checkValue(v[i], `${path}[${i}]`, depth + 1, problems);
      if (!r.ok) return { ok: false }; // 数组内任一元素坏 → 整个键判坏（不留半截数组）
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  if (typeof v === 'object') {
    const out: Record<string, RequestParamValue> = {};
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (k.trim() === '') {
        problems.push(`${path} 存在空键名`);
        return { ok: false };
      }
      const r = checkValue(child, `${path}.${k}`, depth + 1, problems);
      if (!r.ok) return { ok: false };
      out[k] = r.value;
    }
    return { ok: true, value: out };
  }
  problems.push(`${path} 须为 JSON 值（string/number/boolean/null/数组/对象），收到 ${typeof v}`);
  return { ok: false };
}

/**
 * params 校验单点（宽容口径）：逐键检查，坏键剔出记 problems、好键保留——解析面按告警忽略
 * （坏参数不连坐模型本体，与 contextWindow 同纪律），写面 problems 非空即拒收。
 * 顶层非对象 → 空产物 + 一条问题；键名空白与协议保留键各记一条。
 */
export function sanitizeRequestParams(raw: unknown): { params: RequestParams; problems: string[] } {
  const params: RequestParams = {};
  const problems: string[] = [];
  if (raw === undefined) return { params, problems };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push('params 须为对象（键值对）');
    return { params, problems };
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.trim() === '') {
      problems.push('params 键名不得为空');
      continue;
    }
    if (RESERVED_REQUEST_PARAM_KEYS.includes(key)) {
      problems.push(`params.${key} 是协议字段，自定义参数不得占用`);
      continue;
    }
    const r = checkValue(value, `params.${key}`, 0, problems);
    if (r.ok) params[key] = r.value;
  }
  return { params, problems };
}
