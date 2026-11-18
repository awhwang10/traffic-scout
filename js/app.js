// ==========================================================================
// Traffic Scout — Main Application Controller
// ==========================================================================

import { CONFIG, CORRIDOR_PRESETS, getHighwayBadgeInfo } from "./config.js";
import { getDistance, getBearing, bearingToCardinal, sortCamerasSpatially } from "./geometry.js";
import { fetchCaltransCameras, fetchImageAsBase64 } from "./api.js";
import { GeminiService } from "./gemini.js";
import { MapController } from "./map.js";

// --- Application State ---
const state = {
    mode: "auto", // 'auto' | 'manual'
    theme: localStorage.getItem("traffic_scout_theme") || "auto",
    gridMode: false,
    sortReversed: false,
    apiKey: localStorage.getItem("gemini_api_key") || "",
    cameras: [],
    visibleCameras: [],
    nearbyRoutes: [],
    routeOverride: null, // null = auto-nearest route, 'ALL' = all nearby routes, or route number string
    activePresetId: null,
    user: { lat: null, lon: null, heading: 0, speed: 0 },
    lastGpsCoords: null, // Stores latest hardware GPS coordinates so returning to Local is instant
    currentRoute: null,
    lastFetchLocation: { lat: 0, lon: 0 },
    lastRefreshTime: null,
    activeCamId: null,
    observer: null,
    ptr: { startY: 0, currentY: 0, isPulling: false },
    currentAudio: null,
    loggedKeys: false,
    gpsWatchId: null,
    gpsFallbackTimer: null
};

let mapCtrl = null;
let els = {};

function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

function log(msg) {
    console.log(`[Traffic Scout] ${msg}`);
    if (els.debugInfo) {
        const timestamp = new Date().toLocaleTimeString([], { hour12: false });
        els.debugInfo.innerHTML =
            `<span class="opacity-60">[${timestamp}]</span> ${msg}<br>` +
            els.debugInfo.innerHTML.substring(0, 1200);
    }
}

export function setStatus(msg, icon = "info") {
    if (!els.statusBar || !els.statusText) return;
    els.statusText.innerText = msg;
    if (els.statusIcon) els.statusIcon.innerText = icon;
    els.statusBar.classList.remove("hidden");
    requestAnimationFrame(() => {
        els.statusBar.classList.remove("opacity-0", "-translate-y-2");
    });

    clearTimeout(state.statusTimeout);
    state.statusTimeout = setTimeout(() => {
        els.statusBar.classList.add("opacity-0", "-translate-y-2");
        setTimeout(() => els.statusBar.classList.add("hidden"), 300);
    }, 3200);
}

function showLoading(isLoading) {
    if (els.loading) {
        els.loading.classList.toggle("hidden", !isLoading);
    }
}

// --- Theme Management ---
export function setTheme(theme) {
    state.theme = theme;
    localStorage.setItem("traffic_scout_theme", theme);
    const html = document.documentElement;

    ["auto", "light", "dark"].forEach(t => {
        const btn = document.getElementById(`theme-${t}`);
        if (btn) {
            btn.className =
                t === theme
                    ? "flex-1 py-2 rounded-full type-label-small transition-all seg-btn-active"
                    : "flex-1 py-2 rounded-full type-label-small transition-all seg-btn-inactive";
        }
    });

    let isDark = true;
    if (theme === "light") {
        html.setAttribute("data-theme", "light");
        isDark = false;
    } else if (theme === "dark") {
        html.removeAttribute("data-theme");
        isDark = true;
    } else {
        if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
            html.removeAttribute("data-theme");
            isDark = true;
        } else {
            html.setAttribute("data-theme", "light");
            isDark = false;
        }
    }

    if (mapCtrl) {
        mapCtrl.updateBaseTiles(isDark);
    }

    const metaTheme = document.getElementById("meta-theme-color");
    if (metaTheme) {
        metaTheme.setAttribute("content", isDark ? "#0F0E13" : "#F6F5FA");
    }
}

// --- PWA Service Worker & Install Prompt ---
let deferredInstallPrompt = null;

function initPWA() {
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker
            .register("./sw.js")
            .then(() => log("PWA Service Worker active."))
            .catch(err => console.warn("SW registration skipped:", err));
    }

    window.addEventListener("beforeinstallprompt", e => {
        e.preventDefault();
        deferredInstallPrompt = e;
        const installBtn = document.getElementById("pwa-install-btn");
        if (installBtn) {
            installBtn.classList.remove("hidden");
            installBtn.classList.add("inline-flex");
        }
    });

    window.addEventListener("appinstalled", () => {
        deferredInstallPrompt = null;
        const installBtn = document.getElementById("pwa-install-btn");
        if (installBtn) {
            installBtn.classList.add("hidden");
            installBtn.classList.remove("inline-flex");
        }
        setStatus("Traffic Scout installed to home screen!", "check_circle");
    });
}

export async function installPWA() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === "accepted") {
        deferredInstallPrompt = null;
        const installBtn = document.getElementById("pwa-install-btn");
        if (installBtn) installBtn.classList.add("hidden");
    }
}

// --- Grid View Toggle ---
export function toggleGridView() {
    state.gridMode = !state.gridMode;
    if (els.feedContainer) {
        els.feedContainer.classList.toggle("grid-mode", state.gridMode);
        els.feedContainer.classList.toggle("space-y-4", !state.gridMode);
    }
    const icon = document.getElementById("grid-toggle-icon");
    if (icon) {
        icon.innerText = state.gridMode ? "view_agenda" : "grid_view";
    }
    setStatus(state.gridMode ? "2-Column Tactical Grid View" : "Cinema Feed View", "dashboard");
}

// --- API Key Management ---
export function saveApiKey(val) {
    state.apiKey = (val || "").trim();
    localStorage.setItem("gemini_api_key", state.apiKey);
}

// --- Sort & Route Selection ---
export function toggleSort() {
    state.sortReversed = !state.sortReversed;
    updateFeeds({ shouldFitBounds: false, forceRebuild: true });
    setStatus(`Sorted ${els.telemetry?.innerText || "Reversed"}`, "swap_vert");
}

export function selectRouteFilter(routeKey) {
    state.routeOverride = routeKey;
    updateFeeds({ shouldFitBounds: true, forceRebuild: true });
}

/**
 * One-tap return to Local GPS Monitoring from the Corridor Chip bar.
 */
export function activateLocalGps() {
    state.mode = "auto";
    state.activePresetId = null;
    state.routeOverride = null;
    syncModeButtons();
    renderCorridorPresets();

    if (state.lastGpsCoords) {
        state.user.lat = state.lastGpsCoords.lat;
        state.user.lon = state.lastGpsCoords.lon;
        state.user.heading = state.lastGpsCoords.heading || 0;
        state.user.speed = state.lastGpsCoords.speed || 0;
        setStatus("Returned to Local GPS Monitoring", "my_location");
        fetchCameras(state.user.lat, state.user.lon, { shouldFitBounds: true });
        return;
    }

    if (navigator.geolocation) {
        setStatus("Acquiring Local GPS Position...", "my_location");
        showLoading(true);
        navigator.geolocation.getCurrentPosition(
            pos => {
                showLoading(false);
                const { latitude, longitude, heading, speed } = pos.coords;
                state.lastGpsCoords = {
                    lat: latitude,
                    lon: longitude,
                    heading: heading || 0,
                    speed: speed ? (speed * 2.23694).toFixed(0) : 0
                };
                state.user.lat = latitude;
                state.user.lon = longitude;
                state.user.heading = heading || 0;
                setStatus("Local GPS Locked", "my_location");
                fetchCameras(latitude, longitude, { shouldFitBounds: true });
            },
            () => {
                showLoading(false);
                const def = CONFIG.DEFAULT_FALLBACK_COORDS;
                state.user.lat = def.lat;
                state.user.lon = def.lon;
                setStatus("GPS permission unavailable — using default local hub", "location_searching");
                fetchCameras(def.lat, def.lon, { shouldFitBounds: true });
            },
            { enableHighAccuracy: true, timeout: 6000 }
        );
    }
}

export function selectCorridorPreset(presetId) {
    // Tapping an already-active preset chip returns to Local GPS mode
    if (state.activePresetId === presetId && state.mode === "manual") {
        activateLocalGps();
        return;
    }

    const preset = CORRIDOR_PRESETS.find(p => p.id === presetId);
    if (!preset) return;

    state.activePresetId = preset.id;
    state.mode = "manual";
    state.routeOverride = preset.routeHint || null;
    syncModeButtons();

    state.user.lat = preset.lat;
    state.user.lon = preset.lon;
    state.user.heading = 0;

    const latInput = document.getElementById("manual-lat");
    const lonInput = document.getElementById("manual-lon");
    if (latInput) latInput.value = preset.lat.toFixed(4);
    if (lonInput) lonInput.value = preset.lon.toFixed(4);

    renderCorridorPresets();
    setStatus(`Monitoring ${preset.label}`, "explore");
    fetchCameras(preset.lat, preset.lon, { shouldFitBounds: true });
}

function renderCorridorPresets() {
    if (!els.corridorBar) return;

    const isLocalActive = state.mode === "auto" && !state.activePresetId;
    const localGpsChip = `
        <button onclick="activateLocalGps()"
                class="filter-chip ${isLocalActive ? "active" : ""}"
                title="Monitor cameras around your local GPS position">
            <span class="material-symbols-outlined text-[15px] ${isLocalActive ? "text-on-primary-container" : "text-primary"}">my_location</span>
            <span class="font-semibold">My GPS</span>
        </button>
    `;

    const presetChips = CORRIDOR_PRESETS.map(preset => {
        const isActive = state.activePresetId === preset.id && state.mode === "manual";
        const badge = getHighwayBadgeInfo(preset.routeHint);
        return `
            <button onclick="selectCorridorPreset('${preset.id}')"
                    class="filter-chip ${isActive ? "active" : ""}"
                    title="${isActive ? "Tap again to return to My GPS" : `Jump to ${preset.label}`}">
                <span class="hwy-shield ${badge.shieldClass} !text-[10px] !px-1.5 !py-0">${badge.full}</span>
                <span>${preset.label}</span>
            </button>
        `;
    }).join("");

    els.corridorBar.innerHTML = localGpsChip + presetChips;
}

function renderNearbyRouteBar(nearestRoute) {
    if (!els.routeChipBar) return;
    if (!state.nearbyRoutes || state.nearbyRoutes.length <= 1) {
        els.routeChipBar.classList.add("hidden");
        return;
    }

    els.routeChipBar.classList.remove("hidden");
    const activeRoute = state.routeOverride || nearestRoute;

    const routeButtons = state.nearbyRoutes.map(r => {
        const badge = getHighwayBadgeInfo(r.route);
        const isSelected = activeRoute === r.route;
        return `
            <button onclick="selectRouteFilter('${r.route}')"
                    class="filter-chip ${isSelected ? "active" : ""}">
                <span class="hwy-shield ${badge.shieldClass} !text-[10px] !px-1.5 !py-0">${badge.full}</span>
                <span class="opacity-80 text-[11px] font-mono-tech">${r.count}</span>
            </button>
        `;
    });

    const allSelected = state.routeOverride === "ALL";
    routeButtons.push(`
        <button onclick="selectRouteFilter('ALL')"
                class="filter-chip ${allSelected ? "active" : ""}">
            <span class="material-symbols-outlined text-[14px]">hub</span>
            <span>All Nearby</span>
        </button>
    `);

    els.routeChipBar.innerHTML = routeButtons.join("");
}

// --- Data Fetching & Feed Computation ---
export async function fetchCameras(targetLat, targetLon, { shouldFitBounds = true } = {}) {
    showLoading(true);

    try {
        const cameras = await fetchCaltransCameras(targetLat, targetLon, keys => {
            if (!state.loggedKeys) {
                log(`Fields: ${keys.slice(0, 10).join(", ")}...`);
                state.loggedKeys = true;
            }
        });

        state.cameras = cameras;
        state.lastFetchLocation = { lat: targetLat, lon: targetLon };
        state.lastRefreshTime = new Date();

        if (els.camCount) els.camCount.innerText = state.cameras.length;
        log(`Fetched ${state.cameras.length} active Caltrans cameras.`);

        updateFeeds({ shouldFitBounds, forceRebuild: true });
    } catch (error) {
        log(`Fetch Error: ${error.message}`);
        setStatus("Caltrans API Connection Error", "error");
    } finally {
        showLoading(false);
    }
}

export function updateFeeds({ shouldFitBounds = false, forceRebuild = false } = {}) {
    if (!state.cameras.length) {
        renderList([], "No camera feeds loaded for this region.");
        return;
    }

    if (!state.user.lat) return;

    // 1. Identify nearest camera & compute nearby highway routes within 25 miles
    let nearestCam = null;
    let minDist = Infinity;
    const routeCounts = new Map();

    state.cameras.forEach(cam => {
        const d = getDistance(state.user.lat, state.user.lon, cam.lat, cam.lon);
        if (d < minDist) {
            minDist = d;
            nearestCam = cam;
        }
        if (d <= 25 && cam.route && cam.route !== "0") {
            const entry = routeCounts.get(cam.route) || { route: cam.route, count: 0, minDist: d };
            entry.count += 1;
            if (d < entry.minDist) entry.minDist = d;
            routeCounts.set(cam.route, entry);
        }
    });

    if (!nearestCam || minDist > 100) {
        renderList([], "No Caltrans cameras within 100 miles of this point.");
        return;
    }

    state.nearbyRoutes = Array.from(routeCounts.values())
        .sort((a, b) => a.minDist - b.minDist)
        .slice(0, 7);

    const hasOverrideInArea =
        state.routeOverride === "ALL" ||
        (state.routeOverride && state.nearbyRoutes.some(r => r.route === state.routeOverride));

    const targetRoute = hasOverrideInArea ? state.routeOverride : nearestCam.route;
    state.currentRoute = targetRoute === "ALL" ? nearestCam.route : targetRoute;

    renderNearbyRouteBar(nearestCam.route);

    // 2. Filter candidate cameras within 50 miles and aligned with travel heading (<85° in auto mode)
    const candidates = state.cameras.filter(cam => {
        const dist = getDistance(state.user.lat, state.user.lon, cam.lat, cam.lon);
        if (targetRoute !== "ALL" && cam.route !== targetRoute) return false;
        if (dist > CONFIG.MAX_ROUTE_RADIUS_MILES) return false;

        if (state.mode === "manual" || !state.user.speed || state.user.speed <= 1) {
            return true;
        }

        const bearingToCam = getBearing(state.user.lat, state.user.lon, cam.lat, cam.lon);
        const angleDiff = Math.abs(state.user.heading - bearingToCam);
        const normalizedDiff = angleDiff > 180 ? 360 - angleDiff : angleDiff;
        return normalizedDiff < CONFIG.HEADING_TOLERANCE_DEG;
    });

    // 3. Pick closest 20 cameras
    candidates.sort((a, b) => {
        const da = getDistance(state.user.lat, state.user.lon, a.lat, a.lon);
        const db = getDistance(state.user.lat, state.user.lon, b.lat, b.lon);
        return da - db;
    });

    const top20 = candidates.slice(0, CONFIG.MAX_VISIBLE_CAMERAS);

    // 4. Spatial sort (North-South vs East-West)
    const { sortedCameras, sortLabel } = sortCamerasSpatially(top20, state.sortReversed);

    // 5. Update Header Route Badge & Telemetry
    const routeBadge = getHighwayBadgeInfo(state.currentRoute);
    if (els.currentRoute) {
        if (targetRoute === "ALL") {
            els.currentRoute.className = "hwy-shield hwy-shield-sr !text-[10px] !px-1.5 !py-0";
            els.currentRoute.innerText = "ALL ROUTES";
        } else {
            els.currentRoute.className = `hwy-shield ${routeBadge.shieldClass} !text-[10px] !px-1.5 !py-0`;
            els.currentRoute.innerText = routeBadge.full;
        }
    }
    if (els.telemetry) {
        const speedSuffix = state.mode === "auto" && state.user.speed > 1 ? ` · ${state.user.speed} mph` : "";
        els.telemetry.innerText = `${sortLabel}${speedSuffix}`;
    }
    if (els.feedCountBadge) {
        els.feedCountBadge.innerText = `${sortedCameras.length} Live`;
    }

    // Check if the camera sequence is identical to avoid wiping DOM or interrupting user scroll
    const prevIds = state.visibleCameras.map(c => c.id).join(",");
    const nextIds = sortedCameras.map(c => c.id).join(",");
    const sameCameraSequence = prevIds === nextIds && sortedCameras.length > 0;

    state.visibleCameras = sortedCameras;

    if (sameCameraSequence && !forceRebuild) {
        // Update distances & bearings in-place without touching scroll or map view
        updateTelemetryBadgesInPlace(sortedCameras);
        if (mapCtrl && mapCtrl.markers.user && state.user.lat) {
            mapCtrl.markers.user.setLatLng([state.user.lat, state.user.lon]);
        }
        return;
    }

    renderList(sortedCameras, "No cameras nearby.", { shouldFitBounds });
    if (mapCtrl) {
        mapCtrl.updateMarkers(state.user, sortedCameras, { shouldFitBounds });
    }
}

/**
 * Updates camera snapshot images in-place without rebuilding DOM, resetting scroll, or moving the map.
 */
export function refreshSnapshotsInPlace(showToast = false) {
    if (!state.visibleCameras.length) return;
    const timestamp = Date.now();
    state.visibleCameras.forEach(cam => {
        if (cam.url && !cam.url.toLowerCase().startsWith("rtsp")) {
            const img = document.getElementById(`cam-img-${cam.id}`);
            if (img) {
                img.src = `${cam.url}?t=${timestamp}`;
            }
        }
    });
    if (showToast) {
        setStatus("Refreshed live camera frames", "refresh");
    }
}

function updateTelemetryBadgesInPlace(cameras) {
    if (!state.user.lat) return;
    cameras.forEach(cam => {
        const dist = getDistance(state.user.lat, state.user.lon, cam.lat, cam.lon).toFixed(1);
        const bearingDeg = getBearing(state.user.lat, state.user.lon, cam.lat, cam.lon);
        const bearing = bearingToCardinal(bearingDeg);

        const distEl = document.getElementById(`cam-dist-${cam.id}`);
        const dirEl = document.getElementById(`cam-dir-${cam.id}`);
        const navEl = document.getElementById(`cam-nav-${cam.id}`);

        if (distEl) distEl.innerText = `${dist} mi`;
        if (dirEl) dirEl.innerText = bearing;
        if (navEl) navEl.style.transform = `rotate(${Math.round(bearingDeg)}deg)`;
    });
}

export function refreshSingleCard(camId, url) {
    const img = document.getElementById(`cam-img-${camId}`);
    if (img && url) {
        img.src = `${url}?t=${Date.now()}`;
        setStatus("Camera frame updated", "refresh");
    }
}

// --- Feed Rendering & IntersectionObserver Sync ---
function renderList(cameras, emptyMessage = "No cameras nearby.", { shouldFitBounds = false } = {}) {
    if (!els.feedContainer) return;
    els.feedContainer.innerHTML = "";
    if (els.ptrSpinner) els.feedContainer.appendChild(els.ptrSpinner);

    if (cameras.length === 0) {
        const emptyDiv = document.createElement("div");
        emptyDiv.className = "col-span-full h-full flex flex-col items-center justify-center text-on-surface-variant p-8 text-center";
        emptyDiv.innerHTML = `
            <div class="w-16 h-16 rounded-2xl bg-surface-container-high flex items-center justify-center mb-4 border border-outline-variant">
                <span class="material-symbols-outlined text-3xl text-primary">videocam_off</span>
            </div>
            <p class="type-title-medium text-on-surface mb-1">${emptyMessage}</p>
            <p class="type-label-small text-on-surface-variant max-w-xs mb-4">
                Select one of the California corridor presets above or tap anywhere in California on the map in Manual Mode.
            </p>
        `;
        els.feedContainer.appendChild(emptyDiv);
        return;
    }

    const timestamp = Date.now();

    cameras.forEach((cam, index) => {
        const distObj = state.user.lat
            ? getDistance(state.user.lat, state.user.lon, cam.lat, cam.lon)
            : null;
        const dist = distObj !== null ? distObj.toFixed(1) : "--";
        const bearingDeg = state.user.lat
            ? getBearing(state.user.lat, state.user.lon, cam.lat, cam.lon)
            : 0;
        const bearing = state.user.lat ? bearingToCardinal(bearingDeg) : "";

        const targetUrl = cam.streamUrl || cam.url;
        const safeLocation = cam.locationName.replace(/'/g, "\\'");

        let viewportHTML = "";

        if (cam.url && !cam.url.toLowerCase().startsWith("rtsp")) {
            viewportHTML = `
                <div class="cam-image-container group" id="img-wrap-${cam.id}">
                    <div class="active-indicator-bar"></div>
                    <img id="cam-img-${cam.id}"
                         src="${cam.url}?t=${timestamp}"
                         loading="lazy"
                         class="cam-image"
                         alt="${cam.locationName}"
                         onload="this.parentElement.classList.add('loaded')"
                         onerror="handleImageError(this, '${safeLocation}')">

                    <!-- Top Telemetry Overlay -->
                    <div class="absolute top-0 left-0 right-0 p-3 flex items-center justify-between top-card-overlay z-10">
                        <div class="flex items-center gap-1.5">
                            <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase bg-black/70 text-white backdrop-blur-md border border-white/15 font-mono-tech">
                                <span class="live-dot"></span>
                                CAM #${index + 1}
                            </span>
                            ${cam.direction ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-medium bg-black/60 text-white/90 backdrop-blur-md border border-white/10">${cam.direction}bound</span>` : ""}
                            <span class="on-map-pill px-2 py-0.5 rounded-full text-[10px] font-bold bg-primary text-on-primary shadow-sm">
                                ACTIVE
                            </span>
                        </div>

                        <div class="flex items-center gap-1.5">
                            <button onclick="event.stopPropagation(); refreshSingleCard('${cam.id}', '${cam.url}')"
                                    class="w-7 h-7 rounded-full bg-black/65 hover:bg-black/85 text-white flex items-center justify-center backdrop-blur-md border border-white/15 transition-transform active:scale-90"
                                    title="Refresh Snapshot">
                                <span class="material-symbols-outlined text-[15px]">refresh</span>
                            </button>
                            <button onclick="event.stopPropagation(); openCameraLightbox('${cam.id}')"
                                    class="w-7 h-7 rounded-full bg-black/65 hover:bg-black/85 text-white flex items-center justify-center backdrop-blur-md border border-white/15 transition-transform active:scale-90"
                                    title="Inspect Fullscreen">
                                <span class="material-symbols-outlined text-[15px]">fullscreen</span>
                            </button>
                            <button onclick="event.stopPropagation(); window.open('${targetUrl}', '_blank')"
                                    class="w-7 h-7 rounded-full bg-black/65 hover:bg-black/85 text-white flex items-center justify-center backdrop-blur-md border border-white/15 transition-transform active:scale-90"
                                    title="Open Caltrans Source">
                                <span class="material-symbols-outlined text-[15px]">open_in_new</span>
                            </button>
                        </div>
                    </div>
                </div>`;
        } else if (cam.streamUrl && cam.streamUrl.toLowerCase().startsWith("rtsp")) {
            viewportHTML = `
                <div class="cam-image-container loaded bg-surface-container-high flex flex-col items-center justify-center p-4">
                    <div class="active-indicator-bar"></div>
                    <span class="material-symbols-outlined text-primary text-3xl mb-2">videocam</span>
                    <p class="text-primary font-bold text-xs mb-1">Live RTSP Stream Only</p>
                    <a href="${cam.streamUrl}" target="_blank" rel="noopener"
                       class="bg-primary-container text-on-primary-container px-3.5 py-1.5 rounded-full text-[11px] font-medium hover:brightness-110">
                        Open Stream
                    </a>
                </div>`;
        } else {
            viewportHTML = `
                <div class="cam-image-container loaded bg-surface-container-high flex items-center justify-center">
                    <div class="active-indicator-bar"></div>
                    <div class="text-on-surface-variant text-xs">No Image Source Available</div>
                </div>`;
        }

        const placeMeta = [
            cam.nearbyPlace,
            cam.county ? `${cam.county} Co.` : "",
            cam.elevation ? `Elev ${cam.elevation}` : ""
        ]
            .filter(Boolean)
            .join(" · ");

        const footerHTML = `
            <div class="cam-card-footer">
                <div class="flex items-center gap-3 min-w-0">
                    <span class="hwy-shield ${cam.badge.shieldClass}">${cam.badge.full}</span>
                    <div class="min-w-0">
                        <h3 class="text-on-surface font-semibold text-[13.5px] leading-snug truncate">${cam.locationName}</h3>
                        <p class="text-on-surface-variant text-[11px] truncate mt-0.5">
                            ${placeMeta || `Lat ${cam.lat.toFixed(3)}, Lon ${cam.lon.toFixed(3)}`}
                        </p>
                    </div>
                </div>

                <div class="shrink-0 flex items-center gap-1.5 bg-surface px-2.5 py-1.5 rounded-xl border border-outline-variant/80">
                    <span id="cam-nav-${cam.id}"
                          class="material-symbols-outlined text-[14px] text-primary"
                          style="transform: rotate(${Math.round(bearingDeg)}deg)">navigation</span>
                    <span id="cam-dist-${cam.id}" class="font-mono-tech text-on-surface font-semibold text-[11.5px]">
                        ${dist} mi
                    </span>
                    <span id="cam-dir-${cam.id}" class="font-mono-tech text-[10px] text-on-surface-variant font-medium">${bearing}</span>
                </div>
            </div>
        `;

        const card = document.createElement("div");
        card.className = "cam-card cursor-pointer";
        card.dataset.id = cam.id;
        card.id = `cam-${cam.id}`;
        card.onclick = () => {
            visualHighlightCard(cam.id);
            // Clicking a card explicitly pans the map to that camera and re-engages map sync
            if (mapCtrl) mapCtrl.highlightCameraMarker(cam.id, state.user, { forcePan: true });
            updateMapHudActiveCam(cam, dist, bearing);
        };
        card.innerHTML = viewportHTML + footerHTML;
        els.feedContainer.appendChild(card);
    });

    initObserver();

    if (cameras.length > 0 && shouldFitBounds) {
        const first = cameras[0];
        const firstDist = state.user.lat
            ? getDistance(state.user.lat, state.user.lon, first.lat, first.lon).toFixed(1)
            : "--";
        const firstBearing = state.user.lat
            ? bearingToCardinal(getBearing(state.user.lat, state.user.lon, first.lat, first.lon))
            : "";
        visualHighlightCard(first.id);
        updateMapHudActiveCam(first, firstDist, firstBearing);
    }
}

export function handleImageError(imgEl, camName) {
    const parent = imgEl.parentElement;
    if (!parent) return;
    parent.classList.add("loaded");
    const fallback = document.createElement("div");
    fallback.className = "absolute inset-0 flex flex-col items-center justify-center bg-surface-container-high text-on-surface-variant p-4 text-center";
    fallback.innerHTML = `
        <span class="material-symbols-outlined text-2xl opacity-60 mb-1">hide_image</span>
        <span class="text-xs font-medium text-on-surface">Snapshot Temporarily Offline</span>
        <span class="text-[11px] opacity-70 mt-0.5">${camName}</span>
    `;
    imgEl.replaceWith(fallback);
}

function initObserver() {
    if (state.observer) state.observer.disconnect();

    const options = {
        root: els.feedContainer,
        rootMargin: "-40% 0px -40% 0px",
        threshold: 0
    };

    const debouncedHighlight = debounce(id => {
        if (mapCtrl) mapCtrl.highlightCameraMarker(id, state.user, { forcePan: false });
        const cam = state.visibleCameras.find(c => c.id === id);
        if (cam && state.user.lat) {
            const dist = getDistance(state.user.lat, state.user.lon, cam.lat, cam.lon).toFixed(1);
            const bearing = bearingToCardinal(getBearing(state.user.lat, state.user.lon, cam.lat, cam.lon));
            updateMapHudActiveCam(cam, dist, bearing);
        }
    }, CONFIG.OBSERVER_DEBOUNCE_MS);

    state.observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const id = entry.target.dataset.id;
                debouncedHighlight(id);
                visualHighlightCard(id);
            }
        });
    }, options);

    document.querySelectorAll(".cam-card").forEach(card => {
        state.observer.observe(card);
    });
}

function visualHighlightCard(id) {
    document.querySelectorAll(".cam-card").forEach(c => c.classList.remove("active-card"));
    const newCard = document.getElementById(`cam-${id}`);
    if (newCard) newCard.classList.add("active-card");
}

function updateMapHudActiveCam(cam, dist, bearing) {
    if (!els.mapActiveHud || !cam) return;
    els.mapActiveHud.classList.remove("hidden");
    els.mapActiveHud.innerHTML = `
        <span class="hwy-shield ${cam.badge.shieldClass} !text-[10px] !px-1.5 !py-0">${cam.badge.full}</span>
        <span class="truncate max-w-[170px] sm:max-w-[240px] font-medium text-xs text-on-surface">${cam.locationName}</span>
        <span class="font-mono-tech text-[11px] text-primary shrink-0">${dist} mi ${bearing}</span>
    `;
}

// --- Fullscreen Camera Lightbox Inspector ---
export function openCameraLightbox(camId) {
    const cam = state.visibleCameras.find(c => c.id === camId) || state.cameras.find(c => c.id === camId);
    if (!cam || !els.lightboxModal) return;

    const dist = state.user.lat
        ? `${getDistance(state.user.lat, state.user.lon, cam.lat, cam.lon).toFixed(1)} mi`
        : "--";

    document.getElementById("lightbox-title").innerText = cam.locationName;
    document.getElementById("lightbox-subtitle").innerText =
        [cam.nearbyPlace, cam.county ? `${cam.county} County` : "", `${cam.lat.toFixed(4)}, ${cam.lon.toFixed(4)}`]
            .filter(Boolean)
            .join(" · ");

    const badgeEl = document.getElementById("lightbox-badge");
    badgeEl.className = `hwy-shield ${cam.badge.shieldClass}`;
    badgeEl.innerText = cam.badge.full;

    document.getElementById("lightbox-dist").innerText = dist;
    const imgEl = document.getElementById("lightbox-img");
    imgEl.src = `${cam.url}?t=${Date.now()}`;

    const refreshBtn = document.getElementById("lightbox-refresh-btn");
    refreshBtn.onclick = () => {
        imgEl.src = `${cam.url}?t=${Date.now()}`;
        setStatus("Snapshot refreshed", "refresh");
    };

    const extBtn = document.getElementById("lightbox-ext-btn");
    extBtn.onclick = () => window.open(cam.streamUrl || cam.url, "_blank");

    els.lightboxModal.classList.remove("hidden");
}

export function closeCameraLightbox() {
    if (els.lightboxModal) {
        els.lightboxModal.classList.add("hidden");
    }
}

// --- Pull-To-Refresh ---
function initPullToRefresh() {
    const container = els.feedContainer;
    if (!container) return;

    container.addEventListener(
        "touchstart",
        e => {
            if (container.scrollTop === 0) {
                state.ptr.startY = e.touches[0].clientY;
                state.ptr.isPulling = true;
            }
        },
        { passive: true }
    );

    container.addEventListener(
        "touchmove",
        e => {
            if (!state.ptr.isPulling) return;

            const y = e.touches[0].clientY;
            const diff = y - state.ptr.startY;

            if (diff > 0 && container.scrollTop === 0) {
                state.ptr.currentY = diff;
                if (diff < 110 && els.ptrSpinner) {
                    els.ptrSpinner.style.top = `${diff / 2}px`;
                }
            } else {
                state.ptr.isPulling = false;
                if (els.ptrSpinner) els.ptrSpinner.style.top = "-48px";
            }
        },
        { passive: true }
    );

    container.addEventListener("touchend", () => {
        if (!state.ptr.isPulling) return;
        state.ptr.isPulling = false;

        if (state.ptr.currentY > 60) {
            if (els.ptrSpinner) els.ptrSpinner.style.top = "12px";
            refreshSnapshotsInPlace(true);
            setTimeout(() => {
                if (els.ptrSpinner) els.ptrSpinner.style.top = "-48px";
            }, 900);
        } else {
            if (els.ptrSpinner) els.ptrSpinner.style.top = "-48px";
        }
        state.ptr.currentY = 0;
    });
}

// --- Settings & Location Mode ---
export function toggleSettings() {
    if (els.settingsModal) {
        els.settingsModal.classList.toggle("hidden");
    }
}

function syncModeButtons() {
    const btnAuto = els.btns?.auto;
    const btnManual = els.btns?.manual;
    const manualPanel = els.manualInputs;
    if (!btnAuto || !btnManual || !manualPanel) return;

    const activeClass = "flex-1 py-2 rounded-full type-label-small transition-all seg-btn-active";
    const inactiveClass = "flex-1 py-2 rounded-full type-label-small transition-all seg-btn-inactive";

    if (state.mode === "auto") {
        btnAuto.className = activeClass;
        btnManual.className = inactiveClass;
        manualPanel.classList.add("hidden");
    } else {
        btnManual.className = activeClass;
        btnAuto.className = inactiveClass;
        manualPanel.classList.remove("hidden");
    }
}

export function setMode(newMode) {
    if (newMode === "auto") {
        toggleSettings();
        activateLocalGps();
        return;
    }

    state.mode = "manual";
    syncModeButtons();
    renderCorridorPresets();
}

export function handlePaste(val) {
    const parts = (val || "").split(",");
    if (parts.length === 2) {
        const lat = parseFloat(parts[0].trim());
        const lon = parseFloat(parts[1].trim());
        if (!isNaN(lat) && !isNaN(lon)) {
            document.getElementById("manual-lat").value = lat;
            document.getElementById("manual-lon").value = lon;
        }
    }
}

export function updateManualLocation() {
    const lat = parseFloat(document.getElementById("manual-lat").value);
    const lon = parseFloat(document.getElementById("manual-lon").value);

    if (isNaN(lat) || isNaN(lon)) {
        setStatus("Invalid coordinates entered", "warning");
        return;
    }

    state.user.lat = lat;
    state.user.lon = lon;
    state.user.heading = 0;
    state.activePresetId = null;
    state.routeOverride = null;
    renderCorridorPresets();

    toggleSettings();
    setStatus("Location updated. Searching...", "my_location");
    fetchCameras(lat, lon, { shouldFitBounds: true });
}

export function showRawData() {
    if (!state.cameras.length) {
        setStatus("No camera JSON data loaded yet", "info");
        return;
    }
    const subset = state.cameras.slice(0, 3).map(c => ({
        name: c.locationName,
        route: c.badge.full,
        url: c.url,
        stream: c.streamUrl,
        lat: c.lat,
        lon: c.lon
    }));
    alert(JSON.stringify(subset, null, 2));
}

// --- Map HUD Controls ---
export function toggleTrafficOverlay() {
    if (!mapCtrl) return;
    const isOn = mapCtrl.toggleTrafficLayer();
    const btn = document.getElementById("traffic-toggle-btn");
    const dot = document.getElementById("traffic-status-dot");
    if (btn) {
        btn.classList.toggle("border-primary", isOn);
    }
    if (dot) {
        dot.style.backgroundColor = isOn ? "var(--status-live)" : "var(--md-sys-color-outline)";
    }
    setStatus(isOn ? "Google Traffic Layer Enabled" : "Google Traffic Layer Hidden", "traffic");
}

export function recenterMap() {
    if (!mapCtrl || !state.user.lat) return;
    mapCtrl.recenter(state.user.lat, state.user.lon, state.visibleCameras);
    setStatus("Map recentered & auto-sync resumed", "my_location");
}

export function refreshAllSnapshots() {
    refreshSnapshotsInPlace(true);
}

// --- Gemini AI Visual Traffic Analyst & Native Audio TTS ---
export function toggleAI() {
    if (!els.aiModal) return;
    els.aiModal.classList.toggle("hidden");
    stopSpeech();
}

export function stopSpeech() {
    if (state.currentAudio) {
        state.currentAudio.pause();
        state.currentAudio = null;
    }
}

export function speakText(text, btn) {
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<span class="material-symbols-outlined text-[16px] animate-spin">sync</span> Synthesizing...`;
    btn.disabled = true;

    GeminiService.speak(state.apiKey, text)
        .then(audio => {
            stopSpeech();
            state.currentAudio = audio;
            state.currentAudio.play();

            btn.innerHTML = `
                <span class="eq-bars"><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span></span>
                <span>Stop Audio</span>
            `;
            btn.disabled = false;
            btn.onclick = () => {
                stopSpeech();
                btn.innerHTML = originalHTML;
                btn.onclick = () => speakText(text, btn);
            };

            state.currentAudio.onended = () => {
                btn.innerHTML = originalHTML;
                btn.onclick = () => speakText(text, btn);
            };
        })
        .catch(err => {
            console.error("TTS Error:", err);
            setStatus(`Audio synthesis failed: ${err.message}`, "error");
            btn.innerHTML = originalHTML;
            btn.disabled = false;
        });
}

function formatMarkdownToHTML(mdText) {
    const lines = mdText.split("\n");
    let html = "";
    let inList = false;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            if (inList) {
                html += "</ul>";
                inList = false;
            }
            continue;
        }
        const boldParsed = line.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
        if (boldParsed.startsWith("- ") || boldParsed.startsWith("* ")) {
            if (!inList) {
                html += "<ul>";
                inList = true;
            }
            html += `<li>${boldParsed.substring(2)}</li>`;
        } else {
            if (inList) {
                html += "</ul>";
                inList = false;
            }
            html += `<p>${boldParsed}</p>`;
        }
    }
    if (inList) html += "</ul>";
    return html;
}

function renderReport(text, meta = {}) {
    if (text.startsWith("ERROR:")) {
        setStatus(text.replace("ERROR: ", ""), "key");
        toggleAI();
        toggleSettings();
        return;
    }

    const container = document.createElement("div");
    container.className = "flex flex-col gap-3 animate-[fadeIn_0.28s_ease-out]";

    const metaHeader = document.createElement("div");
    metaHeader.className = "flex items-center justify-between px-1 text-[11px] text-on-surface-variant";
    metaHeader.innerHTML = `
        <span class="flex items-center gap-1.5 font-medium">
            <span class="material-symbols-outlined text-[15px] text-primary">${meta.usingVision ? "visibility" : "map"}</span>
            ${meta.usingVision ? `Visual Inspection (${meta.imageCount} live frames)` : `Corridor Checkpoint Analysis`}
        </span>
        <span class="font-mono-tech">${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
    `;

    const div = document.createElement("div");
    div.className =
        "bg-surface-container-low p-4 rounded-2xl border border-outline-variant text-sm text-on-surface prose shadow-sm";
    div.innerHTML = formatMarkdownToHTML(text);

    const actionsRow = document.createElement("div");
    actionsRow.className = "flex items-center justify-end gap-2";

    const ttsBtn = document.createElement("button");
    ttsBtn.className =
        "flex items-center gap-2 type-label-small bg-primary-container text-on-primary-container px-4 py-2.5 rounded-full font-semibold hover:brightness-110 transition-all shadow-sm";
    ttsBtn.innerHTML = '<span class="material-symbols-outlined text-[18px]">volume_up</span> Read Aloud (Kore)';
    ttsBtn.onclick = function () {
        speakText(text, this);
    };

    actionsRow.appendChild(ttsBtn);
    container.appendChild(metaHeader);
    container.appendChild(div);
    container.appendChild(actionsRow);

    els.aiContent.innerHTML = "";
    els.aiContent.appendChild(container);
}

export async function generateTrafficBriefing() {
    stopSpeech();
    if (!state.apiKey) {
        renderReport("ERROR: Please set your Gemini API Key in Settings first.");
        return;
    }

    const visibleCams = state.visibleCameras || [];
    if (visibleCams.length === 0) {
        renderReport("No cameras visible in the current feed to analyze.");
        return;
    }

    const targetCams = visibleCams.slice(0, CONFIG.MAX_AI_SNAPSHOTS);
    const thumbStrip = targetCams
        .filter(c => c.url && !c.url.includes("rtsp"))
        .slice(0, 5)
        .map(
            c =>
                `<img src="${c.url}?t=${Date.now()}" class="w-12 h-8 object-cover rounded-md border border-outline-variant" alt="${c.locationName}">`
        )
        .join("");

    els.aiContent.innerHTML = `
        <div class="bg-surface-container p-6 rounded-2xl border border-outline-variant flex flex-col items-center text-center animate-pulse">
            <div class="w-12 h-12 rounded-full bg-primary-container flex items-center justify-center mb-3">
                <span class="material-symbols-outlined text-2xl text-on-primary-container animate-spin">sync</span>
            </div>
            <p class="type-body-medium text-on-surface font-medium">Capturing ${targetCams.length} Corridor Snapshots...</p>
            <p class="type-label-small text-on-surface-variant mt-1">Inspecting conditions along ${els.currentRoute?.innerText || "highway"}</p>
            <div class="flex items-center gap-1.5 mt-4">${thumbStrip}</div>
        </div>
    `;

    const fetchPromises = targetCams
        .filter(c => c.url && !c.url.includes("rtsp"))
        .map(c => fetchImageAsBase64(c.url));

    const images = await Promise.all(fetchPromises);
    const validImages = images.filter(img => img !== null);

    let prompt = "";
    let usingVision = false;

    if (validImages.length > 0) {
        usingVision = true;
        els.aiContent.innerHTML = `
            <div class="bg-surface-container p-6 rounded-2xl border border-outline-variant flex flex-col items-center text-center animate-pulse">
                <div class="w-12 h-12 rounded-full bg-primary-container flex items-center justify-center mb-3">
                    <span class="material-symbols-outlined text-2xl text-on-primary-container">smart_toy</span>
                </div>
                <p class="type-body-medium text-on-surface font-medium">Analyzing ${validImages.length} Live Feeds...</p>
                <p class="type-label-small text-on-surface-variant mt-1">Gemini 2.5 Flash Vision evaluating traffic density & hazards</p>
                <div class="flex items-center gap-1.5 mt-4">${thumbStrip}</div>
            </div>
        `;

        const locations = targetCams.map(c => `${c.badge.full} @ ${c.locationName}`).join(", ");
        prompt = `You are a California Caltrans Traffic Operations Analyst. Analyze these ${validImages.length} traffic camera images from ${locations}.

Provide a single, direct, high-value summary of the traffic conditions.
Do not describe each image one by one.
Highlight:
- **Overall Flow**: Free-flowing, moderate, or congested.
- **Problem Spots**: Specific bottlenecks, slowdowns, weather visibility issues, or lane closures near named locations.
Keep the tone crisp, authoritative, and broadcast-ready.`;
    } else {
        els.aiContent.innerHTML = `
            <div class="bg-surface-container p-6 rounded-2xl border border-outline-variant flex flex-col items-center text-center animate-pulse">
                <div class="w-12 h-12 rounded-full bg-primary-container flex items-center justify-center mb-3">
                    <span class="material-symbols-outlined text-2xl text-on-primary-container">satellite_alt</span>
                </div>
                <p class="type-body-medium text-on-surface font-medium">Synthesizing Corridor Briefing...</p>
                <p class="type-label-small text-on-surface-variant mt-1">Evaluating ${targetCams.length} Caltrans camera checkpoints</p>
                <div class="flex items-center gap-1.5 mt-4">${thumbStrip}</div>
            </div>
        `;

        const cameraList = targetCams
            .map(c => `- ${c.badge.full} at ${c.locationName} (${c.nearbyPlace || c.county || "CA"})`)
            .join("\n");
        prompt = `Act as a California Traffic Operations Center analyst. Direct snapshot binary downloads were blocked by browser CORS policy, so analyze this active corridor sequence instead:
${cameraList}

Based on these specific California highway checkpoints (interchanges, commuter bottlenecks, grade transitions), provide a concise, actionable driver briefing covering expected choke points and strategic lane/route awareness.`;
    }

    const response = await GeminiService.generateMultimodal(state.apiKey, prompt, validImages);

    let finalReport = response;
    if (!usingVision && targetCams.length > 0 && !response.startsWith("ERROR:")) {
        finalReport =
            "**Note:** Direct pixel inspection was restricted by browser CORS headers. Providing corridor checkpoint analysis instead.\n\n" +
            response;
    }

    renderReport(finalReport, { usingVision, imageCount: validImages.length });
}

// --- Initialization ---
function initApp() {
    els = {
        loading: document.getElementById("loading-indicator"),
        currentRoute: document.getElementById("current-route"),
        telemetry: document.getElementById("telemetry"),
        feedCountBadge: document.getElementById("feed-count-badge"),
        feedContainer: document.getElementById("feed-container"),
        corridorBar: document.getElementById("corridor-bar"),
        routeChipBar: document.getElementById("route-chip-bar"),
        ptrSpinner: document.getElementById("ptr-spinner"),
        statusBar: document.getElementById("status-bar"),
        statusText: document.getElementById("status-text"),
        statusIcon: document.getElementById("status-icon"),
        settingsModal: document.getElementById("settings-modal"),
        aiModal: document.getElementById("ai-modal"),
        aiContent: document.getElementById("ai-content"),
        aiPlaceholder: document.getElementById("ai-placeholder"),
        lightboxModal: document.getElementById("lightbox-modal"),
        mapActiveHud: document.getElementById("map-active-hud"),
        recenterBtn: document.getElementById("recenter-map-btn"),
        camCount: document.getElementById("cam-count"),
        manualInputs: document.getElementById("manual-inputs"),
        debugInfo: document.getElementById("debug-info"),
        emptyState: document.getElementById("empty-state"),
        btns: {
            auto: document.getElementById("mode-auto"),
            manual: document.getElementById("mode-manual")
        }
    };

    mapCtrl = new MapController("map", {
        onUserPan: isPaused => {
            if (els.recenterBtn) {
                els.recenterBtn.classList.toggle("border-primary", isPaused);
                els.recenterBtn.classList.toggle("text-primary", isPaused);
            }
        },
        onMapClick: (lat, lng) => {
            if (state.mode === "manual") {
                state.user.lat = lat;
                state.user.lon = lng;
                state.user.heading = 0;
                state.activePresetId = null;
                state.routeOverride = null;
                renderCorridorPresets();

                const latInput = document.getElementById("manual-lat");
                const lonInput = document.getElementById("manual-lon");
                if (latInput) latInput.value = lat.toFixed(6);
                if (lonInput) lonInput.value = lng.toFixed(6);

                setStatus("Observation point updated. Fetching cameras...", "pin_drop");
                fetchCameras(lat, lng, { shouldFitBounds: true });
            } else {
                setStatus("Tap a Corridor Chip or switch to Manual Mode to pin map points.", "touch_app");
            }
        },
        onMarkerClick: cam => {
            const card = document.getElementById(`cam-${cam.id}`);
            if (card) {
                card.scrollIntoView({ behavior: "smooth", block: "center" });
                visualHighlightCard(cam.id);
                mapCtrl.highlightCameraMarker(cam.id, state.user, { forcePan: false });
            }
        }
    });

    mapCtrl.init(true);
    initPWA();
    initPullToRefresh();
    setTheme(state.theme);
    renderCorridorPresets();

    if (state.apiKey) {
        const keyInput = document.getElementById("api-key-input");
        if (keyInput) keyInput.value = state.apiKey;
    }

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (state.theme === "auto") {
            setTheme("auto");
        }
    });

    window.addEventListener("resize", () => {
        if (mapCtrl) mapCtrl.invalidateSize();
    });

    // Fallback to default California corridor if GPS is unavailable or slow (>2.2s) on desktop
    const loadDefaultCorridorFallback = () => {
        if (state.user.lat !== null) return;
        const def = CONFIG.DEFAULT_FALLBACK_COORDS;
        log(`GPS unavailable or outside active fix — loading ${def.name}`);
        state.user.lat = def.lat;
        state.user.lon = def.lon;
        state.user.heading = 0;
        renderCorridorPresets();
        fetchCameras(def.lat, def.lon, { shouldFitBounds: true });
    };

    state.gpsFallbackTimer = setTimeout(loadDefaultCorridorFallback, 2200);

    if (navigator.geolocation) {
        state.gpsWatchId = navigator.geolocation.watchPosition(
            pos => {
                clearTimeout(state.gpsFallbackTimer);

                const coords = pos.coords;
                const inCalifornia =
                    coords.latitude >= 32.0 &&
                    coords.latitude <= 42.5 &&
                    coords.longitude >= -125.0 &&
                    coords.longitude <= -114.0;

                if (inCalifornia) {
                    state.lastGpsCoords = {
                        lat: coords.latitude,
                        lon: coords.longitude,
                        heading: coords.heading || 0,
                        speed: coords.speed && coords.speed > 1 ? (coords.speed * 2.23694).toFixed(0) : 0
                    };
                }

                if (state.mode !== "auto") return;

                if (!inCalifornia && state.cameras.length > 0) {
                    log("GPS fix outside California; keeping California corridor active.");
                    return;
                }

                const isFirstFix = !state.cameras.length;
                state.user.lat = coords.latitude;
                state.user.lon = coords.longitude;
                if (coords.speed && coords.speed > 1) {
                    state.user.heading = coords.heading || 0;
                    state.user.speed = (coords.speed * 2.23694).toFixed(0);
                }

                const d = getDistance(
                    state.user.lat,
                    state.user.lon,
                    state.lastFetchLocation.lat,
                    state.lastFetchLocation.lon
                );
                if (isFirstFix || d > 20) {
                    fetchCameras(state.user.lat, state.user.lon, { shouldFitBounds: isFirstFix });
                } else {
                    // Non-intrusive update: only updates distances/bearings in-place unless route changed
                    updateFeeds({ shouldFitBounds: false, forceRebuild: false });
                }
            },
            err => {
                console.warn("Geolocation notice:", err.message);
                loadDefaultCorridorFallback();
            },
            { enableHighAccuracy: true, maximumAge: 15000, timeout: 5000 }
        );
    } else {
        loadDefaultCorridorFallback();
    }

    // Periodic 30-second live snapshot refresh: updates <img> src in-place WITHOUT moving map or resetting scroll!
    setInterval(() => {
        if (state.visibleCameras.length > 0) {
            refreshSnapshotsInPlace(false);
        }
    }, CONFIG.AUTO_REFRESH_MS);
}

// Expose handlers globally for HTML onclick attributes
Object.assign(window, {
    installPWA,
    toggleSort,
    toggleGridView,
    toggleSettings,
    toggleAI,
    setTheme,
    saveApiKey,
    setMode,
    activateLocalGps,
    handlePaste,
    updateManualLocation,
    showRawData,
    generateTrafficBriefing,
    selectCorridorPreset,
    selectRouteFilter,
    openCameraLightbox,
    closeCameraLightbox,
    refreshSingleCard,
    handleImageError,
    toggleTrafficOverlay,
    recenterMap,
    refreshAllSnapshots,
    mapZoomIn: () => mapCtrl?.zoomIn(),
    mapZoomOut: () => mapCtrl?.zoomOut()
});

document.addEventListener("DOMContentLoaded", initApp);
