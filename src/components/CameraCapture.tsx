// ---------------------------------------------------------------------------
// CAMERA CAPTURE (§10) — a real camera flow for evidence photos.
//
// Primary path: getUserMedia (environment-facing camera) with a live
// viewfinder, shutter button, retake — the captured frame becomes a JPEG
// Blob indistinguishable from a file-picker photo downstream (same upload,
// same offline queue, same storage policies).
//
// Fallback path: when the API or permission is unavailable (desktop without
// webcam, browser denying the prompt, insecure context — getUserMedia
// requires HTTPS), the component renders a plain file input with
// capture="environment", which mobile OSes answer with their native camera
// app. Both paths produce File objects; the caller cannot tell which was
// used, and nothing about the offline guarantee differs.
//
// The stream is ALWAYS stopped on close/unmount — holding a camera light on
// after the dialog closes is the classic leak this component exists to avoid.
// ---------------------------------------------------------------------------

import { Button } from "@/components/ui/button";
import { Camera, CameraOff, RefreshCw, SwitchCamera, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export type CameraCaptureResult = {
  blob: Blob;
  fileName: string;
  mimeType: "image/jpeg";
};

export default function CameraCapture({
  onCaptured,
  onClose,
}: {
  onCaptured: (result: CameraCaptureResult) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<"starting" | "live" | "error" | "fallback">("starting");
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [preview, setPreview] = useState<string | null>(null);
  const [lastBlob, setLastBlob] = useState<Blob | null>(null);
  const [shotCount, setShotCount] = useState(0);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const startStream = useCallback(
    async (wantFacing: "environment" | "user") => {
      setPhase("starting");
      stopStream();
      try {
        if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
          setPhase("fallback");
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: wantFacing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {
            /* autoplay policies: the video element is muted, so this rarely fires */
          });
        }
        setPhase("live");
      } catch (e) {
        console.warn("Camera unavailable, falling back to file input:", e);
        setPhase("fallback");
      }
    },
    [stopStream],
  );

  useEffect(() => {
    void startStream(facing);
    return stopStream;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facing]);

  const capture = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.videoWidth === 0) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Mirror the preview for user-facing cameras so the capture matches what
    // the user saw (and text/badges are not flipped).
    if (facing === "user") {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        setLastBlob(blob);
        const url = URL.createObjectURL(blob);
        setPreview(url);
        setShotCount((n) => n + 1);
      },
      "image/jpeg",
      0.92,
    );
  };

  const retake = () => {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setLastBlob(null);
  };

  const confirm = () => {
    if (!lastBlob) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    onCaptured({
      blob: lastBlob,
      fileName: `camera-${stamp}-${shotCount}.jpg`,
      mimeType: "image/jpeg",
    });
    if (preview) URL.revokeObjectURL(preview);
    stopStream();
  };

  // Live viewfinder or fallback picker — both produce the same result shape.
  if (phase === "fallback") {
    return (
      <div className="space-y-2 rounded border border-border bg-muted/30 p-3">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <CameraOff className="size-4 text-muted-foreground" /> Camera unavailable
          </p>
          <Button variant="ghost" size="icon" className="size-6" onClick={onClose} aria-label="Close camera">
            <X className="size-3.5" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Use the device camera app instead — the photo lands in the same
          queue with the same guarantees.
        </p>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="w-full text-sm"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              onCaptured({ blob: f, fileName: f.name || `camera-${Date.now()}.jpg`, mimeType: "image/jpeg" });
              onClose();
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Camera className="size-4 text-muted-foreground" /> Take photo
        </p>
        <div className="flex gap-1">
          {phase === "live" && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}
              aria-label="Switch camera"
            >
              <SwitchCamera className="size-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label="Close camera">
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="relative overflow-hidden rounded border border-border bg-black/80">
        {preview ? (
          <img src={preview} alt="Captured photo" className="max-h-72 w-full object-contain" />
        ) : (
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            className={`max-h-72 w-full object-contain ${facing === "user" ? "scale-x-[-1]" : ""}`}
          />
        )}
        {phase === "starting" && !preview && (
          <p className="absolute inset-0 flex items-center justify-center text-xs text-white/70">
            Starting camera…
          </p>
        )}
        {phase === "error" && !preview && (
          <p className="absolute inset-0 flex items-center justify-center text-xs text-white/70">
            Camera error.
          </p>
        )}
      </div>

      {preview ? (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="flex-1" onClick={retake}>
            <RefreshCw className="mr-1.5 size-3.5" /> Retake
          </Button>
          <Button size="sm" className="flex-1" onClick={confirm}>
            Use photo
          </Button>
        </div>
      ) : (
        <Button size="sm" className="w-full" disabled={phase !== "live"} onClick={capture}>
          <Camera className="mr-1.5 size-3.5" /> Capture
        </Button>
      )}
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
