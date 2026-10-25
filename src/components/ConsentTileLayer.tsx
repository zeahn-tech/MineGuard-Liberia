import { reopenConsent, useConsent } from "@/lib/consent";
import { tileAttribution, tileCrossOrigin, tileTemplate } from "@/lib/map-tiles";
import { TileLayer } from "react-leaflet";

/** The ONLY place a map background is requested from a third party. Renders
 *  nothing until the visitor has opted in to the map background. */
export function ConsentTileLayer() {
  const { mapTiles } = useConsent();
  if (!mapTiles) return null;
  return (
    <TileLayer
      attribution={tileAttribution()}
      url={tileTemplate()}
      crossOrigin={tileCrossOrigin()}
      minZoom={5}
      maxZoom={14}
    />
  );
}

/** Small prompt shown over a map while the background is off. Place inside the
 *  `relative` wrapper that contains the <MapContainer>. */
export function MapTilesNotice() {
  const { mapTiles } = useConsent();
  if (mapTiles) return null;
  return (
    <div
      className="absolute bottom-2 left-2 z-[1000] max-w-[16rem] rounded-sm border border-border bg-background/95 p-2 text-xs shadow"
      role="note"
    >
      <p className="text-muted-foreground">
        Map background is off. Turning it on loads images from OpenStreetMap, which will see your
        network address and the area you view.
      </p>
      <button
        type="button"
        onClick={reopenConsent}
        className="mt-1 min-h-7 font-medium underline underline-offset-4"
      >
        Choose in cookie settings
      </button>
    </div>
  );
}
