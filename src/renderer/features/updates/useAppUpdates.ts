import { useCallback, useEffect, useState } from "react";
import { desktop, unwrap } from "../../api/wcl/client";
import type { Reply } from "../../../shared/desktop";
import type { UpdateSnapshot } from "../../../shared/updates";

export function useAppUpdates() {
  const [state, setState] = useState<UpdateSnapshot>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const unsubscribe = desktop().onUpdateState((next) => {
      receivedEvent = true;
      if (active) {
        setError("");
        setState(next);
      }
    });
    void desktop()
      .getUpdateState()
      .then(unwrap)
      .then((next) => {
        if (active && !receivedEvent) setState(next);
      })
      .catch((error: Error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const run = useCallback(async <T>(action: () => Promise<Reply<T>>) => {
    setError("");
    try {
      return unwrap(await action());
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "更新操作失败，请重试。",
      );
    }
  }, []);
  return { state, error, run };
}
export type AppUpdates = ReturnType<typeof useAppUpdates>;
