import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useCallback } from 'react';
import { useEvents, type StudioEvent } from '../api/events';

// jsdom has no EventSource. This fake records the listeners the hook registers, so a test can prove
// which event names reach a page and that a reconnect runs the refresh callback (B08).
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, EventListener[]> = {};
  onopen: (() => void) | null = null;
  constructor() { FakeEventSource.instances.push(this); }
  addEventListener(type: string, cb: EventListener) { (this.listeners[type] ??= []).push(cb); }
  close() {}
  emit(type: string, data: unknown) { for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) } as MessageEvent); }
}
vi.stubGlobal('EventSource', FakeEventSource);
beforeEach(() => { FakeEventSource.instances.length = 0; });
afterEach(() => cleanup());

/** Every named event the server publishes to a tenant stream and a screen listens for. */
const NAMED = ['request.updated', 'balance.updated', 'operator.updated', 'alert', 'setup.updated', 'billing.updated', 'org.updated'];

function Probe({ onEvent, onOpen, enabled = true }: { onEvent: (e: StudioEvent) => void; onOpen: () => void; enabled?: boolean }) {
  const handler = useCallback((e: StudioEvent) => onEvent(e), [onEvent]);
  useEvents(handler, enabled, onOpen);
  return null;
}

describe('useEvents', () => {
  it('delivers every named event the screens subscribe to', () => {
    const onEvent = vi.fn();
    render(<Probe onEvent={onEvent} onOpen={vi.fn()} />);
    const es = FakeEventSource.instances[0]!;
    for (const name of NAMED) es.emit(name, { type: name, payload: { name }, at: '2026-09-12T00:00:00Z' });
    expect(onEvent.mock.calls.map((c) => (c[0] as StudioEvent).type)).toEqual(NAMED);
  });

  it('does not deliver an event name nobody subscribed to', () => {
    const onEvent = vi.fn();
    render(<Probe onEvent={onEvent} onOpen={vi.fn()} />);
    FakeEventSource.instances[0]!.emit('something.else', { type: 'something.else', payload: null, at: 'x' });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('runs the reconnect callback on open, and opens nothing while disabled', () => {
    const onOpen = vi.fn();
    render(<Probe onEvent={vi.fn()} onOpen={onOpen} />);
    FakeEventSource.instances[0]!.onopen?.();
    expect(onOpen).toHaveBeenCalledTimes(1);

    cleanup();
    FakeEventSource.instances.length = 0;
    render(<Probe onEvent={vi.fn()} onOpen={vi.fn()} enabled={false} />);
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
