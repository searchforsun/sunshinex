import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
 * 断言 putSettings 首参 global/second undefined);⑧refreshTick 重拉;⑨global 作用域
 * 省参;⑩表单校验(空名/空 models)拦截零落盘;⑪空清单空态;⑫工具栏作用域下拉(2026-10-29
 * 目标选择器:上抛目标 root 字符串,''=全局)+壳换发 root+scope 后卡面按新目标重拉;
 * ⑬工具栏搜索过滤(name/baseUrl)。
 * 测试基准语言钉 en(test-setup G14.104),断言单语 en。
 * 注:挂载=两笔 settings 请求(内嵌 SettingsForm 表单面(2026-10-29 起恒全局省参——请求
 * 参数卡豁免)+ 本组件 providers 卡面(随目标 root));settingsCalls 断言按此计数。
 * 键行 source 钉 'global'(SettingsForm 恒全局读——daemon 无 root GET 投影即全局面,
 * 行 source=global → 写恒 global 桶)。
 */

/** putProviderOp 输入形(connection.ts 内联签名提取——桩记录类型用,McpPane.test 同款) */
type ProviderOpInput = Parameters<Connection['putProviderOp']>[0];

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
 *  next——未给 next 重拉仍答 initial) */
const connOf = (
  initial: SettingsView,
  next?: SettingsView,
): {
  conn: ProvidersPaneConn;
  settingsCalls: Array<string | undefined>;
  putSettingsCalls: Array<['project' | 'global', string | undefined, Record<string, string | number | null>]>;
  opCalls: ProviderOpInput[];
} => {
  const settingsCalls: Array<string | undefined> = [];
  const putSettingsCalls: Array<['project' | 'global', string | undefined, Record<string, string | number | null>]> = [];
  const opCalls: ProviderOpInput[] = [];
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
      putProviderOp(input: ProviderOpInput) {
        opCalls.push(input);
        return Promise.resolve();
      },
      memoryStats: () => Promise.resolve({ entries: 0, lastWriteAt: null }),
    },
    settingsCalls,
    putSettingsCalls,
    opCalls,
  };
};

describe('ProvidersPane(卡片化+op 写面)', () => {
  it('卡片渲染:名/baseUrl 副行/models chips/默认标记(choices[0] 所属)+密钥状态点+warnings;请求参数卡在', async () => {
    const { conn, settingsCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} root="/w/proj" />);
    expect(await screen.findByText('p1')).toBeDefined();
    expect(screen.getByText('p2')).toBeDefined();
    expect(screen.getByText('https://api.p1/v1')).toBeDefined(); // baseUrl 副行
    expect(screen.getByText('m1')).toBeDefined(); // models chips
    expect(screen.getByText('m2')).toBeDefined();
    expect(screen.getByText('m9')).toBeDefined();
    expect(screen.getAllByText('Default')).toHaveLength(1); // 默认标记恒一处(choices[0]=p1/m1)
    expect(document.querySelector('.sx-api-dot.present')).not.toBeNull(); // p1 密钥在场=绿点(entries 行 apiKeyPresent)
    expect(document.querySelectorAll('.sx-api-dot.missing')).toHaveLength(1); // p2 缺=灰点
    expect((document.querySelector('.sx-api-dot.missing') as HTMLElement).getAttribute('data-tip')).toBe('SUNSHINEX_API_KEY_P2'); // tip=entries 行 apiKeyEnv
    expect(screen.getByText('providers warn line')).toBeDefined(); // providers warnings 行
    // 挂载两笔:内嵌 SettingsForm 恒全局省参(请求参数卡豁免),卡面带目标 root
    await waitFor(() => expect(settingsCalls).toEqual([undefined, '/w/proj']));
    // 请求参数卡仅 tier/effort 两 select(SettingsForm 复用);卡片标题带恒全局注明
    expect(screen.getByText('Request parameters (global)')).toBeDefined();
    expect(screen.getByRole('button', { name: 'tier' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'reasoningEffort' })).toBeDefined();
  });

  it('散键行退役:无「API 地址」(API base URL)行、无模型档位散键(model/modelSmall…)Combo', async () => {
    const { conn } = connOf(viewOf({ entries: [], choices: [], apiKeyPresent: {} }));
    render(<ProvidersPane conn={conn} root="/w/proj" />);
    await screen.findByRole('button', { name: 'tier' });
    expect(screen.queryByText('API base URL')).toBeNull(); // en 标签
    expect(screen.queryByText('API 地址')).toBeNull(); // zh 标签
    expect(screen.queryByLabelText('model')).toBeNull(); // 模型散键 Combo 四行全退役
    expect(screen.queryByLabelText('modelSmall')).toBeNull();
    expect(screen.queryByLabelText('modelMedium')).toBeNull();
    expect(screen.queryByLabelText('modelLarge')).toBeNull();
    expect(screen.queryByLabelText('baseUrl')).toBeNull();
  });

  it('删除:卡 Delete 钮 → putProviderOp {op:remove, scope:project, root, name} + 成功重拉', async () => {
    const { conn, opCalls, settingsCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete p1' }));
    await waitFor(() => expect(opCalls).toEqual([{ op: 'remove', scope: 'project', root: '/w/proj', name: 'p1' }]));
    await waitFor(() => expect(settingsCalls.length).toBe(3)); // 成功重拉(挂载两笔+重拉一笔)
  });

  it('models 上移/下移:行按钮 → putProviderOp {op:modelMove, name, model, direction} + 重拉行重播种', async () => {
    const moved = viewOf({
      entries: [entryOf({ models: [{ model: 'm2' }, { model: 'm1', tier: 'large' }] })],
      choices: [
        { id: 'p1/m2', provider: 'p1', model: 'm2', baseUrl: 'https://api.p1/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_P1' },
        { id: 'p1/m1', provider: 'p1', model: 'm1', baseUrl: 'https://api.p1/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_P1' },
      ],
    });
    const { conn, opCalls } = connOf(viewOf(), moved);
    render(<ProvidersPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit p1' }));
    await screen.findByRole('dialog', { name: 'Edit p1' });
    fireEvent.click(screen.getByRole('button', { name: 'Move up m2' }));
    await waitFor(() =>
      expect(opCalls).toEqual([{ op: 'modelMove', scope: 'project', root: '/w/proj', name: 'p1', model: 'm2', direction: 'up' }]),
    );
    // 重拉+行重播种(次答=服务端已施行的行序):m2 移首,其下移钮可用
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move down m2' })).toBeDefined());
    expect(screen.getByRole('dialog', { name: 'Edit p1' })).toBeDefined(); // 抽屉保持开启
    fireEvent.click(screen.getByRole('button', { name: 'Move down m2' }));
    await waitFor(() =>
      expect(opCalls).toEqual([
        { op: 'modelMove', scope: 'project', root: '/w/proj', name: 'p1', model: 'm2', direction: 'up' },
        { op: 'modelMove', scope: 'project', root: '/w/proj', name: 'p1', model: 'm2', direction: 'down' },
      ]),
    );
  });

  it('moveModel 行重播种键合(T26 评审修补):本地未保存行字段编辑按模型名保留,文件外行(新增未落盘)随 fresh 丢弃+提示行言明', async () => {
    const moved = viewOf({
      entries: [entryOf({ models: [{ model: 'm2' }, { model: 'm1', tier: 'large' }] })],
      choices: [
        { id: 'p1/m2', provider: 'p1', model: 'm2', baseUrl: 'https://api.p1/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_P1' },
        { id: 'p1/m1', provider: 'p1', model: 'm1', baseUrl: 'https://api.p1/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_P1' },
      ],
    });
    const { conn, opCalls } = connOf(viewOf(), moved);
    render(<ProvidersPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit p1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit p1' });
    // 未保存行编辑:m2 行(第二行)contextWindow 填 12345;再 + 新增一行 mNew(文件外,未落盘)
    fireEvent.change(screen.getAllByLabelText('Context window')[1]!, { target: { value: '12345' } });
    fireEvent.click(screen.getByText('+ Add model'));
    fireEvent.change(screen.getAllByLabelText('Model name')[2]!, { target: { value: 'mNew' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move up m2' }));
    await waitFor(() =>
      expect(opCalls).toEqual([{ op: 'modelMove', scope: 'project', root: '/w/proj', name: 'p1', model: 'm2', direction: 'up' }]),
    );
    // 重播种:行序=fresh [m2, m1];mNew(模型名不在文件)随 fresh 丢弃;m2 的未保存窗口编辑键合保留
    await waitFor(() => expect(screen.getAllByLabelText('Model name')).toHaveLength(2));
    expect((screen.getAllByLabelText('Model name')[0] as HTMLInputElement).value).toBe('m2');
    expect((screen.getAllByLabelText('Context window')[0] as HTMLInputElement).value).toBe('12345');
    expect(within(dialog).getByText(/row order resets to the file/)).toBeDefined(); // 键合/丢弃规则提示行在
  });

  it('编辑保存+密钥:编辑态密钥框恒空(不回显)→ Save = op update(provider patch)+ setKey(键值仅入请求体);抽屉关+重拉面无键值', async () => {
    const { conn, opCalls, settingsCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit p1' }));
    await screen.findByRole('dialog', { name: 'Edit p1' });
    const keyInput = screen.getByLabelText('API key') as HTMLInputElement;
    expect(keyInput.value).toBe(''); // 密钥永不回显:编辑播种恒空串
    expect(keyInput.getAttribute('type')).toBe('password');
    fireEvent.change(keyInput, { target: { value: 'sk-secret-1' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(opCalls).toEqual([
        {
          op: 'update',
          scope: 'project',
          root: '/w/proj',
          name: 'p1',
          provider: { baseUrl: 'https://api.p1/v1', models: [{ model: 'm1', tier: 'large' }, { model: 'm2' }] },
        },
        { op: 'setKey', scope: 'project', root: '/w/proj', name: 'p1', apiKey: 'sk-secret-1' },
      ]),
    );
    expect(screen.queryByRole('dialog')).toBeNull(); // 提交后关抽屉(密钥输入框随之清空离场)
    await waitFor(() => expect(settingsCalls.length).toBe(3)); // 成功重拉(挂载两笔+重拉一笔)
    expect(document.body.textContent).not.toContain('sk-secret-1'); // 响应/重拉面零键值回显
  });

  it('新增:Save = op add(baseUrl+非空 models 必备;密钥留空零 setKey)+ 关抽屉重拉', async () => {
    const { conn, opCalls, settingsCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add provider' }));
    await screen.findByRole('dialog', { name: 'Add provider' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'p3' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.p3/v1' } });
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'm7' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(opCalls).toEqual([
        { op: 'add', scope: 'project', root: '/w/proj', name: 'p3', provider: { baseUrl: 'https://api.p3/v1', models: [{ model: 'm7' }] } },
      ]),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(settingsCalls.length).toBe(3));
  });

  it('请求参数卡恒全局写钉测(2026-10-29 用户裁定豁免):project 作用域在场仍 putSettings(global, undefined, {tier})——语义键写路径保留且无 root(缺省全局)', async () => {
    const { conn, putSettingsCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} root="/w/proj" scope="project" />); // 作用域下拉钉项目——请求参数卡不随
    await screen.findByText('p1');
    fireEvent.click(screen.getByRole('button', { name: 'tier' }));
    fireEvent.click(screen.getByRole('option', { name: 'large' }));
    await waitFor(() => expect(putSettingsCalls).toEqual([['global', undefined, { tier: 'large' }]])); // 首参 global,root 省参
  });

  it('refreshTick 变化触发重拉(config-changed 外部改动信号)', async () => {
    const { conn, settingsCalls } = connOf(viewOf());
    const { rerender } = render(<ProvidersPane conn={conn} root="/w/proj" refreshTick={0} />);
    await screen.findByText('p1');
    expect(settingsCalls).toEqual([undefined, '/w/proj']);
    rerender(<ProvidersPane conn={conn} root="/w/proj" refreshTick={1} />);
    await waitFor(() => expect(settingsCalls).toEqual([undefined, '/w/proj', '/w/proj'])); // 卡面重拉(SettingsForm 不订阅 providers tick)
  });

  it('global 作用域:卡面读省参(仅全局)+ op scope=global 省参 root', async () => {
    const { conn, settingsCalls, opCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} root="/w/proj" scope="global" />);
    await screen.findByText('p1');
    // 挂载两笔:内嵌 SettingsForm 恒全局省参(豁免),卡面省参(仅全局)
    await waitFor(() => expect(settingsCalls).toEqual([undefined, undefined]));
    fireEvent.click(screen.getByRole('button', { name: 'Delete p1' }));
    await waitFor(() => expect(opCalls).toEqual([{ op: 'remove', scope: 'global', name: 'p1' }]));
  });

  it('表单校验:空名/空 models 提交被拦(行内报错,零 op 落盘)', async () => {
    const { conn, opCalls } = connOf(viewOf());
    render(<ProvidersPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add provider' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add provider' });
    fireEvent.click(screen.getByText('Save')); // 全空:名称校验先拦
    await waitFor(() => expect(within(dialog).getAllByRole('alert').length).toBeGreaterThan(0)); // 抽屉内行内报错(warnings 亦 role=alert,within 消歧)
    expect(opCalls).toEqual([]);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'p3' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.p3/v1' } });
    fireEvent.click(screen.getByText('Save')); // models 空行:非空 models 校验拦
    await waitFor(() => expect(within(dialog).getAllByRole('alert').length).toBeGreaterThan(0));
    expect(opCalls).toEqual([]);
  });

  it('空清单:entries 空 → 空态文案(非报错面)', async () => {
    const { conn } = connOf(viewOf({ entries: [], choices: [], apiKeyPresent: {}, warnings: [] }));
    render(<ProvidersPane conn={conn} root="/w/proj" />);
    expect(await screen.findByText('No providers configured.')).toBeDefined();
  });

  it('工具栏作用域下拉(2026-10-29 目标选择器):切换上抛目标 root 字符串(\'\'=全局);壳换发 root+scope 后卡面按新目标重拉(SettingsForm 恒全局不受影响)', async () => {
    const { conn, settingsCalls } = connOf(viewOf());
    const raised: string[] = [];
    const scopeOptions = [
      { value: '', label: 'Global' },
      { value: '/w/proj', label: 'proj' },
      { value: '/w/other', label: 'other' },
    ];
    const { rerender } = render(<ProvidersPane conn={conn} root="/w/proj" scope="project" scopeOptions={scopeOptions} onScopeChange={(v) => raised.push(v)} />);
    await screen.findByText('p1');
    fireEvent.click(screen.getByRole('button', { name: 'Settings scope' }));
    fireEvent.click(screen.getByRole('option', { name: 'Global' }));
    expect(raised).toEqual(['']); // 只上抛(''=全局,状态留壳层)
    // 壳回写 targetRoot('')后随 props 回流(scope=global+root=''):卡面按新目标重拉(第三笔=global 省参)
    rerender(<ProvidersPane conn={conn} root="" scope="global" scopeOptions={scopeOptions} onScopeChange={(v) => raised.push(v)} />);
    await waitFor(() => expect(settingsCalls).toEqual([undefined, '/w/proj', undefined]));
  });

  it('工具栏搜索(2026-10-29 三件套入页):SearchBar 200ms 防抖后按 name/baseUrl 过滤,清空恢复', async () => {
    const { conn } = connOf(viewOf());
    render(<ProvidersPane conn={conn} root="/w/proj" />);
    await screen.findByText('p1');
    const toolbarSearch = (): HTMLInputElement =>
      within(document.querySelector('section.sx-providers')!).getByLabelText('Search') as HTMLInputElement; // within 消歧(内嵌 SettingsForm 另有过滤搜索)
    vi.useFakeTimers();
    try {
      fireEvent.change(toolbarSearch(), { target: { value: 'p2' } });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.queryByText('p1')).toBeNull(); // 不匹配卡滤除
      expect(screen.getByText('p2')).toBeDefined();
      fireEvent.change(toolbarSearch(), { target: { value: '' } });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByText('p1')).toBeDefined(); // 清空恢复
    } finally {
      vi.useRealTimers();
    }
  });
});
