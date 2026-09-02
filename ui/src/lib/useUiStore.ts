import { useEffect, useState } from "react";
import { createUiStore, type UiStore } from "./eventClient.ts";

let singleton: UiStore | null = null;

export function useUiStore(): UiStore {
  const [store] = useState<UiStore>(() => {
    if (!singleton) singleton = createUiStore();
    return singleton;
  });
  return store;
}

export function useStoreSnapshot<T>(store: UiStore, selector: (s: UiStore["state"]) => T): T {
  const [value, setValue] = useState<T>(() => selector(store.state));
  useEffect(() => {
    return store.subscribe(() => setValue(selector(store.state)));
  }, [store, selector]);
  return value;
}
