import { describe, expect, it, vi } from "vitest";
import { stopAllBooted, trackBooted } from "../src/boot/registry.js";

describe("boot registry", () => {
	it("stops every tracked app, and a tracked app that is untracked is not stopped", async () => {
		const a = { stop: vi.fn(async () => {}) };

		const b = { stop: vi.fn(async () => {}) };

		const untrackB = trackBooted(b);

		trackBooted(a);
		untrackB();

		await stopAllBooted();

		expect(a.stop).toHaveBeenCalledTimes(1);
		expect(b.stop).not.toHaveBeenCalled();
	});

	it("keeps going when one app fails to stop", async () => {
		const bad = {
			stop: vi.fn(async () => {
				throw new Error("down failed");
			}),
		};

		const good = { stop: vi.fn(async () => {}) };

		trackBooted(bad);
		trackBooted(good);

		await expect(stopAllBooted()).resolves.toBeUndefined();
		expect(good.stop).toHaveBeenCalled();
	});
});
