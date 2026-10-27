/**
 * MakeID E1 (WEWIN "new protocol") label printer driver over Web Bluetooth.
 * Ported from E1_Hack/e1_print.py.
 *
 * frame = 0x66, length (uint16 LE, whole frame), cmd, payload..., checksum (all bytes sum to 0)
 * PC -> printer: write-without-response on ABF1, printer -> PC: notifications on ABF2
 * cmd 0x10 status, 0x50 info, 0x1B print block (LZO1X-compressed 96-dot rows, max 170 rows per block)
 */

const SERVICE = 0xabf0;
const WRITE_CHAR = 0xabf1;
const NOTIFY_CHAR = 0xabf2;
const CHUNK = 58;

export const E1_HEAD_DOTS = 96;
const DEFAULT_MAX_ROWS = 170;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const e1Frame = (cmd: number, payload: Uint8Array = new Uint8Array()): Uint8Array => {
  const len = payload.length + 5;
  const f = new Uint8Array(len);
  f.set([0x66, len & 0xff, len >> 8, cmd]);
  f.set(payload, 4);
  f[len - 1] = -f.reduce((a, b) => a + b, 0) & 0xff;
  return f;
};

/** LZO1X stream holding the data as one literal run (valid for any LZO1X decompressor). */
export const lzoStore = (data: Uint8Array): Uint8Array => {
  const out: number[] = [];
  const n = data.length;
  if (n <= 238) {
    out.push(17 + n);
  } else {
    // long literal run: t = 0, zero bytes add 255 each, then 15 + b + 3 = run length
    let rem = n - 18;
    const zeros = Math.floor((rem - 1) / 255);
    for (let i = 0; i < zeros; i++) out.push(0);
    rem -= zeros * 255;
    out.unshift(0);
    out.push(rem);
  }
  return new Uint8Array([...out, ...data, 0x11, 0x00, 0x00]);
};

/**
 * Pack a canvas into printer rows: each row runs across the tape (96 dots, MSB first, 1 = black),
 * rows advance along the label. Canvas is the label as designed (long side horizontal, 96 px tall).
 */
export const e1PackCanvas = (canvas: HTMLCanvasElement): { rows: number; data: Uint8Array } => {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rows = canvas.width;
  const bpr = E1_HEAD_DOTS / 8;
  const yOff = Math.floor((canvas.height - E1_HEAD_DOTS) / 2); // center a taller/shorter canvas on the head
  const data = new Uint8Array(rows * bpr);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < E1_HEAD_DOTS; c++) {
      // dot c across the tape = canvas row (95 - c): letter tops face high dots, as the MakeID app does
      const y = E1_HEAD_DOTS - 1 - c + yOff;
      if (y < 0 || y >= canvas.height) continue;
      const i = (y * canvas.width + r) * 4;
      const dark = img.data[i + 3] > 127 && img.data[i] + img.data[i + 1] + img.data[i + 2] < 384;
      if (dark) data[r * bpr + (c >> 3)] |= 0x80 >> (c & 7);
    }
  }
  return { rows, data };
};

/** Cut blank rows off both ends of the label, keeping `margin` blank rows at each end. */
export const e1TrimRows = (rows: number, data: Uint8Array, margin = 4 /* 0.5 mm */): { rows: number; data: Uint8Array } => {
  const bpr = E1_HEAD_DOTS / 8;
  const blank = (r: number) => data.subarray(r * bpr, (r + 1) * bpr).every((b) => b === 0);
  let first = 0;
  let last = rows - 1;
  while (first < rows && blank(first)) first++;
  if (first === rows) return { rows, data }; // empty label: print as designed
  while (blank(last)) last--;
  const content = data.subarray(first * bpr, (last + 1) * bpr);
  const out = new Uint8Array(content.length + 2 * margin * bpr);
  out.set(content, margin * bpr);
  return { rows: out.length / bpr, data: out };
};

export const e1BuildBlocks =(rows: number, data: Uint8Array, darkness = 0x14, maxRows = DEFAULT_MAX_ROWS) => {
  const bpr = E1_HEAD_DOTS / 8;
  const blocks: Uint8Array[] = [];
  for (let r = 0; r < rows; r += maxRows) blocks.push(data.subarray(r * bpr, Math.min(rows, r + maxRows) * bpr));
  return blocks.map((block, n) => {
    const height = block.length / bpr;
    const header = new Uint8Array([
      0x20 | (darkness & 0x1f), 0x03,
      1, 0, // total copies
      1, 0, // current copy
      1,
      rows & 0xff, rows >> 8, // whole label length
      height & 0xff, height >> 8, // rows in this block
      blocks.length - n - 1, // blocks still to come
      0,
    ]);
    const lzo = lzoStore(block);
    const payload = new Uint8Array(header.length + lzo.length);
    payload.set(header);
    payload.set(lzo, header.length);
    return e1Frame(0x1b, payload);
  });
};

export interface E1Info {
  firmware: string[];
  maxRows: number;
}

export class E1Client {
  private device?: BluetoothDevice;
  private writeChar?: BluetoothRemoteGATTCharacteristic;
  private replies: Uint8Array[] = [];
  private waiters: ((d: Uint8Array) => void)[] = [];
  private pollTimer?: ReturnType<typeof setInterval>;
  maxRows = DEFAULT_MAX_ROWS;
  battery?: number;
  onDisconnect?: () => void;

  get name(): string {
    return this.device?.name ?? "E1";
  }

  /** A previously allowed E1, if the browser can hand it back without a picker (Chrome getDevices). */
  static async rememberedDevice(): Promise<BluetoothDevice | undefined> {
    const bt = navigator.bluetooth as Bluetooth & { getDevices?: () => Promise<BluetoothDevice[]> };
    if (!bt?.getDevices) return undefined;
    const devices = await bt.getDevices();
    return devices.find((d) => d.name?.startsWith("E1"));
  }

  /** Wait until a remembered device is in range (its advertisements are seen), then connect. */
  async reconnect(device: BluetoothDevice, timeoutMs = 15_000): Promise<E1Info> {
    const d = device as BluetoothDevice & { watchAdvertisements?: () => Promise<void> };
    if (d.watchAdvertisements) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("E1 not found nearby - is it on?")), timeoutMs);
        const seen = () => {
          clearTimeout(t);
          device.removeEventListener("advertisementreceived", seen);
          resolve();
        };
        device.addEventListener("advertisementreceived", seen);
        d.watchAdvertisements!().catch(reject);
      });
    }
    return this.connect(device);
  }

  async connect(device?: BluetoothDevice): Promise<E1Info> {
    this.device =
      device ??
      (await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE] }, { namePrefix: "E1" }],
        optionalServices: [SERVICE],
      }));
    this.device.addEventListener("gattserverdisconnected", () => {
      clearInterval(this.pollTimer);
      this.onDisconnect?.();
    });
    const gatt = await this.device.gatt!.connect();
    const svc = await gatt.getPrimaryService(SERVICE);
    this.writeChar = await svc.getCharacteristic(WRITE_CHAR);
    const notify = await svc.getCharacteristic(NOTIFY_CHAR);
    notify.addEventListener("characteristicvaluechanged", (e) => {
      const v = (e.target as BluetoothRemoteGATTCharacteristic).value!;
      this.onReply(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
    });
    await notify.startNotifications();

    const status = await this.request(e1Frame(0x10, new Uint8Array([0])));
    const info = await this.request(e1Frame(0x50));
    const firmware = new TextDecoder()
      .decode(info.subarray(4, -1))
      .split("\0")
      .filter((s) => s);
    this.startPolling();
    return { firmware, maxRows: this.parseStatus(status) };
  }

  disconnect() {
    clearInterval(this.pollTimer);
    this.device?.gatt?.disconnect();
  }

  /** Print a canvas (label as designed, long side horizontal). */
  async printCanvas(
    canvas: HTMLCanvasElement,
    opts: { darkness?: number; trim?: boolean; trimMargin?: number; onProgress?: (percents: number) => void } = {},
  ) {
    const { darkness, trim = true, trimMargin, onProgress } = opts;
    let { rows, data } = e1PackCanvas(canvas);
    if (trim) ({ rows, data } = e1TrimRows(rows, data, trimMargin));
    const frames = e1BuildBlocks(rows, data, darkness, this.maxRows);
    clearInterval(this.pollTimer);
    try {
      await this.send(e1Frame(0x10, new Uint8Array([2])));
      await sleep(100);
      for (let i = 0; i < frames.length; i++) {
        // the app waits for the printer to answer each block before sending the next
        await this.request(frames[i], 10_000).catch(() => console.warn("E1: no reply to block", i));
        onProgress?.(Math.round(((i + 1) / frames.length) * 100));
      }
      await sleep(1500);
    } finally {
      this.startPolling();
    }
  }

  private startPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      this.request(e1Frame(0x10, new Uint8Array([0])), 2000)
        .then((s) => this.parseStatus(s))
        .catch(() => {});
    }, 2000);
  }

  private parseStatus(s: Uint8Array): number {
    if (s.length >= 44 && s[3] === 0x10) {
      this.maxRows = s[41] | (s[42] << 8) || DEFAULT_MAX_ROWS;
      this.battery = s[5];
    }
    return this.maxRows;
  }

  private onReply(d: Uint8Array) {
    const w = this.waiters.shift();
    if (w) w(d);
    else this.replies.push(d);
  }

  private async send(data: Uint8Array) {
    for (let i = 0; i < data.length; i += CHUNK) {
      await this.writeChar!.writeValueWithoutResponse(data.slice(i, i + CHUNK) as Uint8Array<ArrayBuffer>);
      await sleep(15);
    }
  }

  private async request(data: Uint8Array, timeoutMs = 3000): Promise<Uint8Array> {
    this.replies = [];
    const reply = new Promise<Uint8Array>((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(new Error("E1: reply timeout"));
      }, timeoutMs);
      const done = (d: Uint8Array) => {
        clearTimeout(t);
        resolve(d);
      };
      this.waiters.push(done);
    });
    await this.send(data);
    return reply;
  }
}
