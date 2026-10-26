/** server 域内共享类型（Task 17 骨架）。 */

/** worker 执行器接缝（依赖注入——createServer/dispatchTool 只依赖此接口，不依赖具体实现）。
 *  协议形态（plan Task 18 落真实实现 `server/src/worker.ts`）：持久 PowerShell 子进程，
 *  stdin/stdout 行分隔 JSON，请求 `{"id":1,"op":"screenshot","params":{…}}` 按 id 配对回执
 *  `{"id":1,"ok":true,"result":{…}}` / `{"id":1,"ok":false,"error":"…"}`；同请求队列串行（桌面输入本就串行语义）。
 *  本任务（Task 17）dispatch 不触 worker——工具执行为占位回执；Task 18 注入 createWorker() 产物。 */
export interface WorkerClient {
  op<T>(op: string, params: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}
