// ==========================================================================
// Traffic Scout — Configuration, Endpoints & Corridor Presets
// ==========================================================================

export const CONFIG = {
    CALTRANS_ENDPOINT: "https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/CCTV/FeatureServer/0/query",
    GEMINI_VISION_MODEL: "gemini-2.5-flash-preview-09-2025",
    GEMINI_TTS_MODEL: "gemini-2.5-flash-preview-tts",
    GEMINI_TTS_VOICE: "Kore",
    SEARCH_BUFFER_DEG: 0.85,
    MAX_ROUTE_RADIUS_MILES: 50,
    HEADING_TOLERANCE_DEG: 85,
    MAX_VISIBLE_CAMERAS: 20,
    MAX_AI_SNAPSHOTS: 10,
    AUTO_REFRESH_MS: 30000,
    OBSERVER_DEBOUNCE_MS: 250,
    DEFAULT_FALLBACK_COORDS: {
        name: "Los Angeles Metro (I-110 / US-101)",
        lat: 34.0522,
        lon: -118.2437
    }
};

// Known California Interstates & US Highways for authentic shield rendering
export const INTERSTATE_ROUTES = new Set([
    "5", "8", "10", "15", "40", "80", "105", "110", "205", "210", "215",
    "238", "280", "380", "405", "505", "580", "605", "680", "710", "780",
    "805", "880", "980"
]);

export const US_ROUTES = new Set([
    "6", "50", "95", "97", "101", "199", "395"
]);

// Quick California Corridor Presets for instant monitoring & testing
export const CORRIDOR_PRESETS = [
    { id: "sr-91", label: "SR-91 Canyon / OC", routeHint: "91", lat: 33.8685, lon: -117.6745 },
    { id: "la-dtla", label: "LA Downtown", routeHint: "110", lat: 34.0522, lon: -118.2520 },
    { id: "la-405", label: "I-405 Sepulveda", routeHint: "405", lat: 34.0762, lon: -118.4665 },
    { id: "oc-irvine", label: "OC I-5 / I-405", routeHint: "5", lat: 33.6469, lon: -117.7426 },
    { id: "sf-bay", label: "SF Bay Bridge", routeHint: "80", lat: 37.7983, lon: -122.3778 },
    { id: "sd-mission", label: "San Diego I-8", routeHint: "8", lat: 32.7658, lon: -117.1611 },
    { id: "sac-capitol", label: "Sacramento I-5", routeHint: "5", lat: 38.5780, lon: -121.5035 },
    { id: "tahoe-donner", label: "Donner Pass I-80", routeHint: "80", lat: 39.3280, lon: -120.3289 }
];

export function getHighwayBadgeInfo(routeNumStr) {
    const clean = (routeNumStr || "").toString().replace(/[^0-9]/g, "");
    if (!clean || clean === "0") {
        return { prefix: "HWY", number: "?", full: "HWY ?", shieldClass: "hwy-shield-sr" };
    }
    if (INTERSTATE_ROUTES.has(clean)) {
        return { prefix: "I", number: clean, full: `I-${clean}`, shieldClass: "hwy-shield-interstate" };
    }
    if (US_ROUTES.has(clean)) {
        return { prefix: "US", number: clean, full: `US-${clean}`, shieldClass: "hwy-shield-us" };
    }
    return { prefix: "SR", number: clean, full: `SR-${clean}`, shieldClass: "hwy-shield-sr" };
}
