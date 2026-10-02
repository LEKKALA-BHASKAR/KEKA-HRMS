"use client";

import { useEffect, useState } from "react";

/**
 * What a clock-in form needs beyond the button when the attendance policy
 * asks for it: the device's location (hidden fields, filled from the
 * browser's geolocation once the person allows it) and a selfie taken with
 * the front camera. The server makes the actual decision; this only gathers.
 */
export function ClockCapture({ locate, selfie }: { locate: boolean; selfie: boolean }) {
  const [pos, setPos] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const [status, setStatus] = useState<"idle" | "finding" | "found" | "denied" | "unavailable">("idle");
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!locate) return;
    if (!("geolocation" in navigator)) { setStatus("unavailable"); return; }
    setStatus("finding");
    const id = navigator.geolocation.watchPosition(
      (p) => { setPos({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }); setStatus("found"); },
      (e) => setStatus(e.code === e.PERMISSION_DENIED ? "denied" : "unavailable"),
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [locate]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  return (
    <>
      {locate ? (
        <>
          <input type="hidden" name="latitude" value={pos?.lat ?? ""} />
          <input type="hidden" name="longitude" value={pos?.lng ?? ""} />
          <input type="hidden" name="accuracy" value={pos ? Math.round(pos.acc) : ""} />
          <div className="text-xs subtle" role="status" style={{ marginBottom: 6 }}>
            {status === "finding" ? "Finding your location…"
              : status === "found" ? `Location found (within ${Math.round(pos!.acc)} m)`
              : status === "denied" ? "Location access is blocked. Allow it in your browser to clock in."
              : status === "unavailable" ? "Your location is not available right now."
              : null}
          </div>
        </>
      ) : null}
      {selfie ? (
        <label className="stack text-xs" style={{ marginBottom: 8, gap: 4 }}>
          <span>Selfie</span>
          <input className="input" type="file" name="selfie" accept="image/jpeg,image/png" capture="user" required
            onChange={(e) => { const f = e.target.files?.[0]; setPreview(f ? URL.createObjectURL(f) : null); }} />
          {preview ? <img src={preview} alt="Your selfie" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8 }} /> : null}
        </label>
      ) : null}
    </>
  );
}
