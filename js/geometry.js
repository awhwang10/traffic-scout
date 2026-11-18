// ==========================================================================
// Traffic Scout — Spatial Geometry & Directional Sorting Utilities
// ==========================================================================

export function toRad(deg) {
    return (deg * Math.PI) / 180;
}

export function toDeg(rad) {
    return (rad * 180) / Math.PI;
}

/**
 * Calculates great-circle distance between two coordinates in miles.
 */
export function getDistance(lat1, lon1, lat2, lon2) {
    const R = 3958.8; // Earth radius in miles
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Calculates initial bearing (0-360°) from point 1 to point 2.
 */
export function getBearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x =
        Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
        Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Converts a 0-360° bearing into an 8-point cardinal direction string.
 */
export function bearingToCardinal(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return "";
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const idx = Math.round(((deg % 360) < 0 ? deg + 360 : deg) / 45) % 8;
    return dirs[idx];
}

/**
 * Sorts visible cameras spatially along their dominant geographic axis (N-S or E-W)
 * and returns both the sorted array and the human-readable sort label.
 */
export function sortCamerasSpatially(cameras, sortReversed = false) {
    const sorted = [...cameras];
    let sortLabel = "Distance";

    if (sorted.length > 1) {
        const lats = sorted.map(c => c.lat);
        const lons = sorted.map(c => c.lon);
        const latRange = Math.max(...lats) - Math.min(...lats);
        const lonRange = Math.max(...lons) - Math.min(...lons);

        if (latRange > lonRange) {
            sorted.sort((a, b) => b.lat - a.lat);
            sortLabel = sortReversed ? "South ⬆ North" : "North ⬇ South";
        } else {
            sorted.sort((a, b) => a.lon - b.lon);
            sortLabel = sortReversed ? "East ⬅ West" : "West ➡ East";
        }

        if (sortReversed) {
            sorted.reverse();
        }
    }

    return { sortedCameras: sorted, sortLabel };
}
