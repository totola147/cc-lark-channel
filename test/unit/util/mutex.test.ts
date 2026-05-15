import { describe, it, expect } from "vitest";
import { Mutex } from "../../../src/util/mutex.ts";

describe("Mutex", () => {
  it("allows sequential acquisition", async () => {
    const mutex = new Mutex();
    const release = await mutex.acquire();
    release();
    const release2 = await mutex.acquire();
    release2();
  });

  it("queues concurrent acquisitions", async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    const release1 = await mutex.acquire();

    const p2 = mutex.acquire().then((release) => {
      order.push(2);
      release();
    });

    const p3 = mutex.acquire().then((release) => {
      order.push(3);
      release();
    });

    order.push(1);
    release1();

    await Promise.all([p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("release is idempotent", async () => {
    const mutex = new Mutex();
    const release = await mutex.acquire();
    release();
    release(); // should not throw or double-release
    const release2 = await mutex.acquire();
    release2();
  });
});
