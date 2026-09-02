import type { EventBus } from "./event-bus.ts";
import type { ForgeEvent } from "./event-types.ts";

export function publish(bus: EventBus | undefined, event: ForgeEvent): void {
  if (!bus) return;
  bus.publish(event);
}
