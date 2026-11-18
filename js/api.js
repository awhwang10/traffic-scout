// ==========================================================================
// Traffic Scout — Caltrans ArcGIS REST API & Image Processing
// ==========================================================================

import { CONFIG, getHighwayBadgeInfo } from "./config.js";

/**
 * Normalizes raw Caltrans ArcGIS FeatureServer records into clean camera objects.
 */
export function processFeatures(features, onLogKeys) {
    if (!features || features.length === 0) return [];

    const firstProps = features[0].attributes;
    if (firstProps && onLogKeys) {
        onLogKeys(Object.keys(firstProps));
    }

    return features
        .map(f => {
            const props = f.attributes || {};
            const geom = f.geometry || {};

            const lat = Number(props.latitude ?? props.Latitude ?? geom.y);
            const lon = Number(props.longitude ?? props.Longitude ?? geom.x);

            let imgUrl =
                props.currentImageURL ||
                props.cctv_url ||
                props.url ||
                props.URL ||
                "";

            let streamUrl = props.streamingVideoURL || "";

            const rawRoute = (props.route || props.Route || "0").toString();
            const routeNum = rawRoute.replace(/[^0-9]/g, "") || "0";
            const badge = getHighwayBadgeInfo(routeNum);

            const name = (
                props.locationName ||
                props.location ||
                props.Location ||
                "Caltrans CCTV"
            ).trim();

            const nearbyPlace = (props.nearbyPlace || "").trim();
            const county = (props.county || "").trim();
            const direction = (props.direction || "").trim();
            const inService = props.inService !== "false" && props.inService !== false;
            const elevation = props.elevation ? `${props.elevation} ft` : null;

            if (imgUrl && imgUrl.startsWith("http:")) {
                imgUrl = imgUrl.replace("http:", "https:");
            }
            if (streamUrl && streamUrl.startsWith("http:")) {
                streamUrl = streamUrl.replace("http:", "https:");
            }

            return {
                id: String(props.index_ || props.OBJECTID || `${lat}-${lon}`),
                lat,
                lon,
                route: routeNum,
                originalRoute: rawRoute,
                badge,
                locationName: name,
                nearbyPlace,
                county,
                direction,
                inService,
                elevation,
                url: imgUrl,
                streamUrl,
                raw: props
            };
        })
        .filter(c => !isNaN(c.lat) && !isNaN(c.lon) && c.lat !== 0 && (c.url || c.streamUrl));
}

/**
 * Queries the Caltrans CCTV ArcGIS REST endpoint within an envelope around target coordinates.
 */
export async function fetchCaltransCameras(targetLat, targetLon, onLogKeys) {
    const buffer = CONFIG.SEARCH_BUFFER_DEG;
    const envelope = `${targetLon - buffer},${targetLat - buffer},${targetLon + buffer},${targetLat + buffer}`;

    const params = new URLSearchParams({
        where: "1=1",
        outFields: "*",
        geometry: envelope,
        geometryType: "esriGeometryEnvelope",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outSR: "4326",
        f: "json"
    });

    const response = await fetch(`${CONFIG.CALTRANS_ENDPOINT}?${params.toString()}`);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (data.error) {
        throw new Error(`API Error: ${data.error.message}`);
    }

    return processFeatures(data.features, onLogKeys);
}

/**
 * Attempts to fetch a camera snapshot as Base64 JPEG for Gemini Vision.
 * Gracefully returns null if blocked by CORS so the caller can fall back to location metadata.
 */
export async function fetchImageAsBase64(url) {
    try {
        const response = await fetch(url, { mode: "cors", cache: "no-cache" });
        if (!response.ok) throw new Error("CORS or HTTP Error");
        const blob = await response.blob();

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const result = reader.result || "";
                const base64data = result.includes(",") ? result.split(",")[1] : null;
                resolve(base64data);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch {
        // Fail silently; caller falls back to map/corridor text analysis
        return null;
    }
}
