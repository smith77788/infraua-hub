import { EventEmitter } from 'events';

export interface FactoryEvent {
  task_id: string;
  actor: string;
  type: string;
  message: string;
  timestamp: string;
  data?: unknown;
}

/**
 * Process-wide event bus. The orchestrator emits one event per
 * meaningful step; the API layer subscribes and forwards events to
 * the web UI over SSE. Kept as a plain EventEmitter for the MVP -
 * no message broker needed for a single-process system.
 */
export class EventBus extends EventEmitter {
  publish(event: Omit<FactoryEvent, 'timestamp'>): FactoryEvent {
    const full: FactoryEvent = { ...event, timestamp: new Date().toISOString() };
    this.emit('event', full);
    return full;
  }
}

export const globalEventBus = new EventBus();
