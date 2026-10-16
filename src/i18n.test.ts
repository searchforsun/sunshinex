import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, getLanguage, setLanguage, parseLanguage } from './i18n';
import { describeIncomplete } from './tui/stop-reason';

test('parseLanguage：缺省 zh（G14.104 主用户群中文,杜绝混排）；显式 en 才 en', () => {
  assert.equal(parseLanguage(undefined), 'zh');
  assert.equal(parseLanguage(true), 'zh');
  assert.equal(parseLanguage('fr'), 'zh');
  assert.equal(parseLanguage('zh'), 'zh');
  assert.equal(parseLanguage('en'), 'en');
});

test('t：按进程语言取值；setLanguage 影响后续调用（用后复原）', () => {
  setLanguage('en');
  assert.equal(getLanguage(), 'en');
  assert.equal(t('hello', '你好'), 'hello');
  setLanguage('zh');
  assert.equal(getLanguage(), 'zh');
  assert.equal(t('hello', '你好'), '你好');
  setLanguage('en');
  assert.equal(getLanguage(), 'en');
});

test('stop-reason：zh 模式回中文终止文案，en 缺省英文（用后复原）', () => {
  setLanguage('zh');
  assert.equal(describeIncomplete('max-steps'), '未完成终止：已达步数上限');
  assert.equal(describeIncomplete('deadline'), '未完成终止：已达单次提交时间上限');
  assert.equal(describeIncomplete('budget'), '未完成终止：token 预算耗尽（可续跑）');
  setLanguage('en');
  assert.equal(describeIncomplete('max-steps'), 'Incomplete: max steps reached');
  assert.equal(describeIncomplete(undefined), '');
});
