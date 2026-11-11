import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type EventHandler = (event: never, context: ExtensionContext) => unknown;

/** Partial Pi double: unsupported APIs fail rather than silently succeeding. */
export function createMockPi() {
  const commands = new Map<string, Command>();
  const events = new Map<string, EventHandler[]>();
  const messages: { message: Parameters<ExtensionAPI["sendMessage"]>[0]; options: Parameters<ExtensionAPI["sendMessage"]>[1] }[] = [];
  const notifications: { message: string; type: string }[] = [];
  const emittedEvents: { name: string; data: unknown }[] = [];
  let idle = true;
  let pending = false;
  let renderer: Parameters<ExtensionAPI["registerToolRenderer"]>[0] | undefined;
  const context = {
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui",
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    ui: { notify(message: string, type = "info") { notifications.push({ message, type }); } },
  } as unknown as ExtensionCommandContext;
  const pi = {
    events: { emit(name: string, data: unknown) { emittedEvents.push({ name, data }); } },
    registerToolRenderer(resolver: Parameters<ExtensionAPI["registerToolRenderer"]>[0]) { renderer = resolver; },
    sendMessage(message: Parameters<ExtensionAPI["sendMessage"]>[0], options?: Parameters<ExtensionAPI["sendMessage"]>[1]) { messages.push({ message, options }); },
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    on(name: string, handler: EventHandler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
      return () => {
        const index = handlers.indexOf(handler);
        if (index !== -1) handlers.splice(index, 1);
      };
    },
  } as unknown as ExtensionAPI;
  return {
    pi, context, notifications, messages, emittedEvents,
    setIdle(value: boolean) { idle = value; },
    setPending(value: boolean) { pending = value; },
    renderer(name: string, next: () => unknown) {
      if (!renderer) throw new Error("No registered renderer");
      return renderer(name, next as never);
    },
    async runCommand(name: string, args = "") {
      const command = commands.get(name);
      if (!command) throw new Error(`Unknown command: ${name}`);
      await command.handler(args, context);
    },
    async emit(name: string, event: unknown) {
      const results: unknown[] = [];
      for (const handler of [...(events.get(name) ?? [])]) {
        results.push(await handler(event as never, context));
      }
      return results;
    },
  };
}
