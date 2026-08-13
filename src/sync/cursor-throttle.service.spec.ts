import { CursorThrottleService } from './cursor-throttle.service';

describe('CursorThrottleService', () => {
  let service: CursorThrottleService;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new CursorThrottleService(100);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('broadcasts the first update in a quiet window immediately (leading edge)', () => {
    const broadcast = jest.fn();
    service.submit('client-1', { userId: 'alice', position: 5 }, broadcast);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({ userId: 'alice', position: 5 });
  });

  it('does not immediately broadcast a second update within the throttle window', () => {
    const broadcast = jest.fn();
    service.submit('client-1', { userId: 'alice', position: 5 }, broadcast);
    service.submit('client-1', { userId: 'alice', position: 6 }, broadcast);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('broadcasts the LATEST position as a trailing update once the window closes', () => {
    const broadcast = jest.fn();
    service.submit('client-1', { userId: 'alice', position: 5 }, broadcast);
    service.submit('client-1', { userId: 'alice', position: 6 }, broadcast);
    service.submit('client-1', { userId: 'alice', position: 7 }, broadcast);

    jest.advanceTimersByTime(100);

    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenLastCalledWith({
      userId: 'alice',
      position: 7,
    });
  });

  it('does not send a trailing update if nothing changed after the leading edge', () => {
    const broadcast = jest.fn();
    service.submit('client-1', { userId: 'alice', position: 5 }, broadcast);

    jest.advanceTimersByTime(100);

    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('allows an immediate broadcast again once a new quiet window starts', () => {
    const broadcast = jest.fn();
    service.submit('client-1', { userId: 'alice', position: 5 }, broadcast);
    jest.advanceTimersByTime(100);
    broadcast.mockClear();

    service.submit('client-1', { userId: 'alice', position: 10 }, broadcast);

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({ userId: 'alice', position: 10 });
  });

  it('throttles each key independently', () => {
    const broadcast = jest.fn();
    service.submit('client-1', { userId: 'alice', position: 1 }, broadcast);
    service.submit('client-2', { userId: 'bob', position: 2 }, broadcast);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it('onModuleDestroy clears pending timers so a trailing broadcast never fires', () => {
    const broadcast = jest.fn();
    service.submit('client-1', { userId: 'alice', position: 5 }, broadcast);
    service.submit('client-1', { userId: 'alice', position: 6 }, broadcast);

    expect(() => service.onModuleDestroy()).not.toThrow();
    jest.advanceTimersByTime(1000);

    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});
