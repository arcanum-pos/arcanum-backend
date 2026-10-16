// A Durable Object with an alarm (the backend's ChargePoller), in the
// process — for running self-hosted (SELF_HOSTING.md: the backend is one
// replica). Its storage keeps one alarm time; when it's due, the object's
// alarm() runs. An alarm that throws is tried again a little later, as
// Cloudflare does.
const RETRY_MS = 30_000;

interface AlarmObject {
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
}

export class AlarmState {
  private at: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  object: AlarmObject | null = null;

  readonly storage = {
    getAlarm: async (): Promise<number | null> => this.at,
    setAlarm: async (time: number | Date): Promise<void> => this.schedule(typeof time === 'number' ? time : time.getTime()),
    deleteAlarm: async (): Promise<void> => this.schedule(null),
  };

  private schedule(at: number | null) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.at = at;
    if (at === null) return;
    this.timer = setTimeout(() => void this.ring(), Math.max(0, at - Date.now()));
    this.timer.unref?.();
  }

  private async ring() {
    this.at = null;
    this.timer = null;
    try {
      await this.object?.alarm();
    } catch (err) {
      console.error('alarm', err);
      if (this.at === null) this.schedule(Date.now() + RETRY_MS);
    }
  }
}

export class AlarmNamespace<T extends AlarmObject> {
  private objects = new Map<string, { object: T; state: AlarmState }>();

  constructor(private readonly create: (state: AlarmState) => T) {}

  idFromName(name: string): { name: string; toString(): string } {
    return { name, toString: () => name };
  }

  get(id: { name: string }): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } {
    const { object } = this.instance(id.name);
    return { fetch: (input, init) => object.fetch(new Request(input, init)) };
  }

  instance(name: string): { object: T; state: AlarmState } {
    let entry = this.objects.get(name);
    if (!entry) {
      const state = new AlarmState();
      const object = this.create(state);
      state.object = object;
      entry = { object, state };
      this.objects.set(name, entry);
    }
    return entry;
  }
}
