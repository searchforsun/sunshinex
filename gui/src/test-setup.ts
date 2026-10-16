import { setLanguage } from './i18n';

/** G14.104 测试基准语言钉 en：语言缺省翻 zh（主用户群中文）后，断言面（按钮名/文案）
 *  以 en 书写的既有测试需钉语言——zh 文案由 i18n.test 与专项用例覆盖 */
setLanguage('en');
