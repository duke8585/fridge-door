/** vitest stand-in for the workerd-only `cloudflare:workers` module (OAuthProvider imports it). */
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    readonly ctx: ExecutionContext,
    readonly env: Env,
  ) {}
}
export const env = {};
