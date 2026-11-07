// Why the camera could not start, in terms a person can act on (see
// components/CameraCapture.tsx). Pure so the mapping is unit-tested.

export type CameraReason = "denied" | "none" | "busy" | "unavailable" | "unsupported";

export const CAMERA_REASON_TEXT: Record<Exclude<CameraReason, "denied">, string> = {
  none: "No camera was found on this device.",
  busy: "The camera is being used by another app. Close that app and reopen this panel.",
  unavailable: "The camera couldn't be started.",
  unsupported: "This browser can't open the camera here (it needs a secure connection and a camera).",
};

/** Map a getUserMedia failure to a reason a person can act on. */
export function cameraReason(e: unknown): CameraReason {
  const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "none";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
  return "unavailable";
}
