import 'server-only';

export type QlooFailure = 'configuration' | 'authentication' | 'timeout' | 'rate-limit' | 'upstream' | 'network';
export class QlooError extends Error {
  constructor(readonly reason: QlooFailure) { super(`Qloo unavailable: ${reason}`); this.name = 'QlooError'; }
}
