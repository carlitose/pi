import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionFactory, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

async function setup(factory: ExtensionFactory, ui: Partial<ExtensionUIContext>) {
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(factory, process.cwd(), createEventBus(), runtime);
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), registry);
	runner.setUIContext(ui as ExtensionUIContext, "tui");
	return runner;
}

describe("remote extension UI prompts", () => {
	it("offers full select details and uses an exact remote choice without opening local UI", async () => {
		let localCalls = 0;
		const seen: string[] = [];
		const runner = await setup(
			(pi) => {
				pi.on("ui_prompt_request", async (event) => {
					seen.push(event.kind, event.title, ...(event.kind === "select" ? event.options : []));
					expect(event.requestId).toBeTruthy();
					expect(event.sessionId).toBeTruthy();
					return { action: "handled", value: "B" };
				});
			},
			{
				select: async () => {
					localCalls++;
					return "A";
				},
			},
		);
		expect(await runner.getUIContext().select("Pick", ["A", "B"])).toBe("B");
		expect(seen).toEqual(["select", "Pick", "A", "B"]);
		expect(localCalls).toBe(0);
	});

	it("preserves negative confirmations and falls back for invalid remote selections", async () => {
		const runner = await setup(
			(pi) => {
				pi.on("ui_prompt_request", (event) =>
					event.kind === "confirm"
						? { action: "handled", value: false }
						: { action: "handled", value: "not an option" },
				);
			},
			{ select: async () => "A", confirm: async () => true },
		);
		expect(await runner.getUIContext().confirm("Delete?", "Irreversible.")).toBe(false);
		expect(await runner.getUIContext().select("Pick", ["A", "B"])).toBe("A");
	});

	it("falls back when delivery declines but respects the caller's original timeout", async () => {
		let cancelled = false;
		const runner = await setup(
			(pi) => {
				pi.on("ui_prompt_request", (event) => {
					if (event.kind === "input") return { action: "pass" };
					event.signal.addEventListener(
						"abort",
						() => {
							cancelled = true;
						},
						{ once: true },
					);
					return new Promise(() => {});
				});
			},
			{ input: async () => "local", select: async () => "A" },
		);
		expect(await runner.getUIContext().input("Enter")).toBe("local");
		expect(await runner.getUIContext().select("Pick", ["A"], { timeout: 10 })).toBeUndefined();
		expect(cancelled).toBe(true);
	});

	it("opens the local UI after the bounded remote wait expires without a caller timeout", async () => {
		let cancelled = false;
		const runner = await setup(
			(pi) => {
				pi.on("ui_prompt_request", (event) => {
					event.signal.addEventListener(
						"abort",
						() => {
							cancelled = true;
						},
						{ once: true },
					);
					return new Promise(() => {});
				});
			},
			{ select: async () => "A" },
		);
		vi.useFakeTimers();
		try {
			const pending = runner.getUIContext().select("Pick", ["A"]);
			await vi.advanceTimersByTimeAsync(300_000);
			expect(await pending).toBe("A");
			expect(cancelled).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("takes only the first handled answer and cancels on caller abort", async () => {
		let secondCalls = 0;
		let entered: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const runner = await setup(
			(pi) => {
				pi.on("ui_prompt_request", (event) => {
					if (event.kind === "input") return { action: "handled", value: "remote input" };
					entered?.();
					return new Promise(() => {});
				});
				pi.on("ui_prompt_request", () => {
					secondCalls++;
					return { action: "handled", value: "B" };
				});
			},
			{ input: async () => "local", select: async () => "A" },
		);
		expect(await runner.getUIContext().input("Enter")).toBe("remote input");
		expect(secondCalls).toBe(0);
		const signal = new AbortController();
		const waiting = runner.getUIContext().select("Pick", ["A", "B"], { signal: signal.signal });
		await started;
		signal.abort();
		expect(await waiting).toBeUndefined();
		expect(secondCalls).toBe(0);
	});

	it("does not open a stale local UI after runtime invalidation", async () => {
		let localCalls = 0;
		let notifyRequest: (() => void) | undefined;
		const entered = new Promise<void>((resolve) => {
			notifyRequest = resolve;
		});
		const runner = await setup(
			(pi) => {
				pi.on("ui_prompt_request", () => {
					notifyRequest?.();
					return new Promise(() => {});
				});
			},
			{
				input: async () => {
					localCalls++;
					return "local";
				},
			},
		);
		const waiting = runner.getUIContext().input("Enter");
		await entered;
		runner.invalidate();
		expect(await waiting).toBeUndefined();
		expect(localCalls).toBe(0);
	});

	it("returns remote editor text rather than opening the TUI editor", async () => {
		let localCalls = 0;
		const runner = await setup(
			(pi) => {
				pi.on("ui_prompt_request", (event) => {
					if (event.kind !== "editor") return { action: "pass" };
					expect(event.prefill).toBe("draft");
					return { action: "handled", value: "remote text" };
				});
			},
			{
				editor: async () => {
					localCalls++;
					return "local";
				},
			},
		);
		expect(await runner.getUIContext().editor("Edit", "draft")).toBe("remote text");
		expect(localCalls).toBe(0);
	});
});
