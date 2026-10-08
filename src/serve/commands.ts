import { SLASH_COMMANDS, slashCommandDescriptions } from '../tui/slash-commands';

/** GET /commands 数据面(G10 spec §6):命令清单与本地化描述的唯一出口(gui 命令面板数据源)。
 *  单源 = tui/slash-commands.ts——此处零副本,命令增删/改描述自动同步;
 *  防漂移钉子:commands.test.ts 断言与 SLASH_COMMANDS 逐字同源。 */
export function listCommands(): { commands: string[]; descriptions: Record<string, string> } {
  return { commands: [...SLASH_COMMANDS], descriptions: slashCommandDescriptions() };
}
