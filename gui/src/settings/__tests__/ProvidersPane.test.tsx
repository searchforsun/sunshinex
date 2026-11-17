import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProvidersPane } from '../ProvidersPane';
import type { ProvidersPaneConn } from '../ProvidersPane';
import type { Connection, ProviderEntry, SettingsKeyRow, SettingsView } from '../../connection';

/**
 * Task 26 ProvidersPane 重构桩测(提供方 ResourceCard 卡片化+op 端点写面+编辑弹窗+
 * 请求参数卡散键行退役):conn 全桩(settings/putSettings/putProviderOp 三面,不出网),
 * 用例沿 task brief——①卡片渲染含默认标记(choices[0]=默认模型)+密钥状态点+warnings;
 * ②删除调 op remove+成功重拉;③models 上移下移提交 modelMove(文件级手术+行重播种);
 * ④apiKey 提交走 setKey 且输入框清空(关弹窗)、重拉响应无键值回显;⑤新增提交 op add
 * (密钥留空零 setKey);⑥请求参数卡无「API 地址」行/模型散键 Combo 退役;⑦请求参数卡
 * 恒全局写钉测(2026-10-29 用户裁定豁免:root 恒 ''——PUT /settings 无 root 即缺省全局,
 * 断言 putSettings 首参 global/second undefined);⑧refreshTick 重拉;⑨表单校验(空名/空
 * models)拦截零落盘;⑩空清单空态;⑪工具栏单件(2026-10-29 用户裁定:页面即全局——
 * ScopeSelect/SearchBar 撤除只留新增钮;读恒省参=仅全局清单;新增/删除恒写全局 op
 * scope=global 省参 root);⑫models 行边界禁用(首行 ↑ disabled/末行 ↓ disabled,客户端
 * 拦截零 op——2026-10-29 用户裁定);⑬op 失败透出服务端 {error,hint}(connection 层组装,
 * 行内错误条呈真因非 `-> 409` 连接层格式)。
 * 测试基准语言钉 en(test-setup G14.104),断言单语 en。
 * 注:挂载=两笔 settings 请求(内嵌 SettingsForm 表单面+卡面,均恒全局省参——页面即全局);
 * settingsCalls 断言按此计数。
 * 键行 source 钉 'global'(SettingsForm 恒全局读——daemon 无 root GET 投影即全局面,
 * 行 source=global → 写恒 global 桶)。
 */

/** putProviderOp 输入形(connection.ts 内联签名提取——桩记录类型用,McpPane.test 同款) */
type ProviderOpInputShape = Parameters<Connection['putProviderOp']>[0];

/** GET /settings providers.entries 行构造器(daemon listProviders 富化行形合法缺省——
 *  apiKeyEnv/apiKeyPresent 恒在场,Task 26 评审修补后 GUI 密钥点直读本行字段) */
const entryOf = (over: Partial<ProviderEntry> = {}): ProviderEntry => ({
  name: 'p1',
  baseUrl: 'https://api.p1/v1',
  models: [{ model: 'm1', tier: 'large' }, { model: 'm2' }],
  apiKeyEnv: 'SUNSHINEX_API_KEY_P1',
  apiKeyPresent: true,
  ...over,
});

/** 键行构造器(SettingsKeyRow 合法缺省——SettingsForm 行仅渲染 daemon 报键面;
 *  source 钉 'global':内嵌请求参数卡恒全局读) */
const keyRow = (key: string, value: string | null): SettingsKeyRow => ({ key, value, source: 'global', envOverride: false });

/** GET /settings 应答构造器:providers 面 choices+entries+apiKeyPresent+warnings 可编程;
 *  keys 面=请求参数卡两语义键(tier/reasoningEffort,global 来源——写路径钉 global 桶) */
const viewOf = (providers: Partial<SettingsView['providers']> = {}): SettingsView => ({
  keys: [keyRow('tier', 'medium'), keyRow('reasoningEffort', null)],
  permissions: {
    merged: { deny: [], allow: [], additionalDirs: [] },
    project: { deny: [], allow: [], additionalDirs: [] },
    global: { deny: [], allow: [], additionalDirs: [] },
  },
  providers: {
    choices: [
      { id: 'p1/m1', provider: 'p1', model: 'm1', baseUrl: 'https://api.p1/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_P1' },
      { id: 'p1/m2', provider: 'p1', model: 'm2', baseUrl: 'https://api.p1/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_P1' },
      { id: 'p2/m9', provider: 'p2', model: 'm9', baseUrl: 'https://api.p2/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_P2' },
    ],
    entries: [entryOf(), entryOf({ name: 'p2', baseUrl: 'https://api.p2/v1', models: [{ model: 'm9' }], apiKeyEnv: 'SUNSHINEX_API_KEY_P2', apiKeyPresent: false })],
    apiKeyPresent: { p1: true, p2: false },
    warnings: ['providers warn line'],
    ...providers,
  },
  warnings: [],
});

/** conn 桩:三面调用记录(settings 挂载=两笔消费(SettingsForm+卡面)同代答 initial,重拉答
 *  next——未给 next 重拉仍答 initial);opError 在场=putProviderOp 首调即拒(错误透出钉测) */
const connOf = (
  initial: SettingsView,
  next?: SettingsView,
  opts: { opError?: Error } = {},
): {
  conn: ProvidersPaneConn;
  settingsCalls: Array<string | undefined>;
  putSettingsCalls: Array<['project' | 'global', string | undefined, Record<string, string | number | null>]>;
  opCalls: ProviderOpInputShape[];
} => {
  const settingsCalls: Array<string | undefined> = [];
  const putSettingsCalls: Array<['project' | 'global', string | undefined, Record<string, string | number | null>]> = [];
  const opCalls: ProviderOpInputShape[] = [];
  let n = 0;
  return {
    conn: {
      settings(root?: string) {
        settingsCalls.push(root);
        const view = n < 2 || next === undefined ? initial : next;
        n += 1;
        return Promise.resolve(view);
      },
      putSettings(scope, root, updates) {
        putSettingsCalls.push([scope, root, updates]);
        return Promise.resolve();
      },
      putProviderOp(input: ProviderOpInputShape) {
        opCalls.push(input);
        return opts.opError !== undefined ? Promise.reject(opts.opError) : Promise.resolve();
      },
      probeProvider: () => Promise.resolve({ ok: true }),
      memoryStats: () => Promise.resolve({ entries: 0, lastWriteAt: null }),
    },
    settingsCalls,
    putSettingsCalls,
    opCalls,
  };
};


/** 2026-11-17 拆分改版用例(提供方弹窗只建源、模型列表+模型弹窗独立):
 *  ①卡渲染(名/baseUrl/模型列表/chips/密钥点/warnings/请求参数卡)
 *  ②新增提供方=op add(models 空起点)+ setKey;③编辑=op update + setKey;密钥零回显
 *  ④模型弹窗新增=op modelAdd(entry 含窗口/最大输出/视觉/视频/强度/等级/JSON 参数)
 *  ⑤模型弹窗编辑=op update 整组 models 原位替换;⑥模型开关=update enabled false
 *  ⑦测试连接=probeProvider 调用与结果行内;⑧更多参数非法 JSON 拦截零 op;⑨删除=remove */
describe('ProvidersPane(拆分弹窗改版)', () => {
  it('卡片渲染:名/baseUrl 副行/模型列表/特点 chips/密钥状态点/warnings/请求参数卡', async () => {
    const { conn, settingsCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    expect(await screen.findByText('p1')).toBeDefined();
    expect(screen.getByText('p2')).toBeDefined();
    expect(screen.getByText('https://api.p1/v1')).toBeDefined();
    expect(screen.getByText('m1')).toBeDefined(); // 模型列表行
    expect(screen.getByText('m2')).toBeDefined();
    expect(screen.getByText('m9')).toBeDefined();
    expect(document.querySelector('.sx-api-dot.present')).not.toBeNull();
    expect(document.querySelectorAll('.sx-api-dot.missing')).toHaveLength(1);
    expect(screen.getByText('providers warn line')).toBeDefined();
    expect(screen.getAllByText('Models').length).toBeGreaterThan(0); // 模型列表标题
    expect(screen.getAllByText('+ Add model')).toHaveLength(2); // 每卡一个添加模型钮
    await waitFor(() => expect(settingsCalls).toEqual([undefined, undefined]));
    expect(screen.getByRole('button', { name: 'tier' })).toBeDefined();
  });

  it('新增提供方:op add(models 空起点,支持先建源后加模型)+ 密钥 setKey;恒写全局', async () => {
    const { conn, opCalls } = connOf(viewOf({ entries: [], choices: [], apiKeyPresent: {} }));
    render(<ProvidersPane conn={conn} />);
    fireEvent.click(await screen.findByText('+ Add provider'));
    await screen.findByRole('dialog', { name: 'New provider' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'p3' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.p3/v1' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-3' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(opCalls).toEqual([
        { op: 'add', scope: 'global', name: 'p3', provider: { baseUrl: 'https://api.p3/v1', models: [] } },
        { op: 'setKey', scope: 'global', name: 'p3', apiKey: 'sk-3' },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New provider' })).toBeNull());
  });

  it('编辑提供方:密钥框恒空不回显 → op update(不含 models)+ setKey', async () => {
    const { conn, opCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit p1' }));
    await screen.findByRole('dialog', { name: 'Edit p1' });
    const keyInput = screen.getByLabelText('API key') as HTMLInputElement;
    expect(keyInput.value).toBe('');
    fireEvent.change(keyInput, { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(opCalls).toEqual([
        { op: 'update', scope: 'global', name: 'p1', provider: { baseUrl: 'https://api.p1/v1' } },
        { op: 'setKey', scope: 'global', name: 'p1', apiKey: 'sk-new' },
      ]),
    );
  });

  it('新增模型:纵向字段 → op modelAdd(entry 含窗口/最大输出/视觉+视频/强度/等级/JSON 参数)', async () => {
    const { conn, opCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    fireEvent.click((await screen.findAllByText('+ Add model'))[0]!);
    await screen.findByRole('dialog', { name: 'New model' });
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'm3' } });
    fireEvent.change(screen.getByLabelText('Context tokens'), { target: { value: '128000' } });
    fireEvent.change(screen.getByLabelText('Max output tokens'), { target: { value: '8192' } });
    fireEvent.click(screen.getByLabelText('Image input'));
    fireEvent.click(screen.getByLabelText('Video input'));
    fireEvent.change(screen.getByLabelText('More parameters'), { target: { value: '{"cache":true}' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(opCalls).toEqual([
        {
          op: 'modelAdd',
          scope: 'global',
          name: 'p1',
          entry: {
            model: 'm3',
            contextWindow: 128000,
            maxOutputTokens: 8192,
            supportsImages: true,
            supportsVideo: true,
            params: { cache: true },
          },
        },
      ]),
    );
  });

  it('编辑模型:op update 整组 models 原位替换(其余条目原样)', async () => {
    const { conn, opCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit model m1' }));
    await screen.findByRole('dialog', { name: 'Edit m1' });
    fireEvent.change(screen.getByLabelText('Context tokens'), { target: { value: '64000' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      const call = opCalls[0]!;
      expect(call.op).toBe('update');
      const models = (call.provider as { models: Array<Record<string, unknown>> }).models;
      expect(models.map((m) => m['model'])).toEqual(['m1', 'm2']);
      expect(models[0]).toEqual({ model: 'm1', contextWindow: 64000, tier: 'large' });
      expect(models[1]).toEqual({ model: 'm2' });
    });
  });

  it('模型开关:关 → op update 该条 enabled:false(其余条目保留)', async () => {
    const { conn, opCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable model m2' }));
    await waitFor(() => {
      const call = opCalls[0]!;
      expect(call.op).toBe('update');
      const models = (call.provider as { models: Array<Record<string, unknown>> }).models;
      expect(models[0]).toEqual({ model: 'm1', tier: 'large' });
      expect(models[1]).toEqual({ model: 'm2', enabled: false });
    });
  });

  it('删除模型:行内垃圾箱两段确认 → op modelRemove', async () => {
    const { conn, opCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete model m2' }));
    expect(opCalls).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete model m2' }));
    await waitFor(() => expect(opCalls).toEqual([{ op: 'modelRemove', scope: 'global', name: 'p1', model: 'm2' }]));
  });

  it('测试连接:调用 probeProvider,结果走底部悬浮提示层(2026-11-17 用户裁定)', async () => {
    const { conn } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test connection m1' }));
    const toast = await screen.findByRole('status');
    expect(toast.textContent).toContain('connected');
  });

  it('更多参数非法 JSON:行内报错且零 op', async () => {
    const { conn, opCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    fireEvent.click((await screen.findAllByText('+ Add model'))[0]!);
    await screen.findByRole('dialog', { name: 'New model' });
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'm4' } });
    fireEvent.change(screen.getByLabelText('More parameters'), { target: { value: '{oops' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText(/valid JSON/)).toBeDefined();
    expect(opCalls).toEqual([]);
  });

  it('删除提供方:两段确认 → op remove', async () => {
    const { conn, opCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete p1' }));
    expect(opCalls).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete p1' }));
    await waitFor(() => expect(opCalls).toEqual([{ op: 'remove', scope: 'global', name: 'p1' }]));
  });
});
