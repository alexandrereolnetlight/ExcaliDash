import { useEffect, useState } from "react";
import { getAiStatus, type EnabledAiStatus } from "../../api/ai";

/**
 * The AI assistant status for this editor session, or null when the assistant
 * is off, unavailable here, or its status could not be loaded.
 */
export const useAssistantStatus = (
  available: boolean,
): EnabledAiStatus | null => {
  const [status, setStatus] = useState<EnabledAiStatus | null>(null);
  useEffect(() => {
    if (!available) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    getAiStatus()
      .then((next) => {
        if (!cancelled) setStatus(next.enabled ? next : null);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [available]);
  return status;
};
