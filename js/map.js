// ==========================================================================
// Traffic Scout — Leaflet Interactive Map & Google Traffic Controller
// ==========================================================================

export class MapController {
    constructor(mapElementId, callbacks = {}) {
        this.mapElementId = mapElementId;
        this.callbacks = callbacks;
        this.map = null;
        this.baseLayer = null;
        this.trafficLayer = null;
        this.trafficVisible = true;
        this.userPannedMap = false;
        this.isProgrammaticMove = false;
        this.markers = {
            user: null,
            cameras: {}
        };
        this.activeCamId = null;
        this.mapMovedForId = null;
    }

    init(isDark = true) {
        const el = document.getElementById(this.mapElementId);
        if (!el || this.map) return;

        this.map = L.map(this.mapElementId, {
            zoomControl: false,
            attributionControl: false
        }).setView([34.0522, -118.2437], 10);

        this.updateBaseTiles(isDark);

        // Google Traffic Overlay (Default ON)
        this.trafficLayer = L.tileLayer(
            "https://mt0.google.com/vt/lyrs=m,traffic&x={x}&y={y}&z={z}",
            {
                opacity: 0.78,
                maxZoom: 19,
                attribution: "Traffic Data"
            }
        ).addTo(this.map);

        // Detect manual user drag so we don't interrupt map exploration with auto-panning
        this.map.on("dragstart", () => {
            if (!this.isProgrammaticMove) {
                this.userPannedMap = true;
                if (this.callbacks.onUserPan) {
                    this.callbacks.onUserPan(true);
                }
            }
        });

        this.map.on("click", e => {
            if (this.callbacks.onMapClick) {
                this.callbacks.onMapClick(e.latlng.lat, e.latlng.lng);
            }
        });
    }

    updateBaseTiles(isDark) {
        if (!this.map) return;

        const url = isDark
            ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";

        if (this.baseLayer) {
            this.baseLayer.setUrl(url);
        } else {
            this.baseLayer = L.tileLayer(url, {
                attribution: "&copy; CartoDB",
                subdomains: "abcd",
                maxZoom: 19
            }).addTo(this.map);
            this.baseLayer.bringToBack();
        }
    }

    toggleTrafficLayer() {
        if (!this.map || !this.trafficLayer) return this.trafficVisible;
        if (this.trafficVisible) {
            this.map.removeLayer(this.trafficLayer);
            this.trafficVisible = false;
        } else {
            this.trafficLayer.addTo(this.map);
            this.trafficVisible = true;
        }
        return this.trafficVisible;
    }

    zoomIn() {
        if (this.map) this.map.zoomIn();
    }

    zoomOut() {
        if (this.map) this.map.zoomOut();
    }

    recenter(userLat, userLon, cameras = []) {
        if (!this.map || !userLat) return;
        this.userPannedMap = false;
        if (this.callbacks.onUserPan) {
            this.callbacks.onUserPan(false);
        }

        const bounds = L.latLngBounds([[userLat, userLon]]);
        cameras.forEach(c => bounds.extend([c.lat, c.lon]));

        this.isProgrammaticMove = true;
        if (cameras.length > 0) {
            this.map.flyToBounds(bounds, { padding: [48, 48], maxZoom: 14, duration: 0.6 });
        } else {
            this.map.flyTo([userLat, userLon], 12, { duration: 0.6 });
        }
        setTimeout(() => {
            this.isProgrammaticMove = false;
        }, 700);
    }

    updateMarkers(user, cameras, { shouldFitBounds = false } = {}) {
        if (!this.map) this.init();
        if (!this.map) return;

        // 1. Update or Create User Marker
        if (user && user.lat && user.lon) {
            if (this.markers.user) {
                this.markers.user.setLatLng([user.lat, user.lon]);
            } else {
                const userIcon = L.divIcon({
                    className: "",
                    html: `<div class="user-gps-marker"><div class="user-gps-pulse"></div><div class="user-gps-dot"></div></div>`,
                    iconSize: [24, 24],
                    iconAnchor: [12, 12]
                });
                this.markers.user = L.marker([user.lat, user.lon], {
                    icon: userIcon,
                    zIndexOffset: 1000
                })
                    .addTo(this.map)
                    .bindPopup(
                        `<div class="text-xs font-medium"><b>Observation Point</b><br><span class="opacity-75 font-mono-tech">${user.lat.toFixed(4)}, ${user.lon.toFixed(4)}</span></div>`
                    );
            }
        }

        // 2. Clear Existing Camera Markers
        const prevActiveId = this.activeCamId;
        Object.values(this.markers.cameras).forEach(m => this.map.removeLayer(m));
        this.markers.cameras = {};

        const bounds = L.latLngBounds();
        if (user && user.lat) bounds.extend([user.lat, user.lon]);

        // 3. Add Numbered Tactical Camera Markers
        cameras.forEach((cam, idx) => {
            const isActive = cam.id === prevActiveId;
            const pinIcon = L.divIcon({
                className: "",
                html: `<div id="map-pin-${cam.id}" class="cam-map-pin ${isActive ? "is-active" : ""}">${idx + 1}</div>`,
                iconSize: [22, 22],
                iconAnchor: [11, 11],
                popupAnchor: [0, -12]
            });

            const marker = L.marker([cam.lat, cam.lon], {
                icon: pinIcon,
                zIndexOffset: isActive ? 900 : 100
            })
                .addTo(this.map)
                .bindPopup(
                    `<div class="min-w-[175px]">
                        <div class="flex items-center justify-between gap-2 mb-1">
                            <span class="hwy-shield ${cam.badge.shieldClass}">${cam.badge.full}</span>
                            <span class="text-[10px] opacity-75 font-mono-tech">CAM #${idx + 1}</span>
                        </div>
                        <div class="font-semibold text-xs leading-snug">${cam.locationName}</div>
                        ${cam.nearbyPlace ? `<div class="text-[11px] opacity-70 mt-0.5">${cam.nearbyPlace}${cam.county ? ` · ${cam.county} Co.` : ""}</div>` : ""}
                    </div>`
                );

            marker.on("click", () => {
                if (this.callbacks.onMarkerClick) {
                    this.callbacks.onMarkerClick(cam);
                }
            });

            this.markers.cameras[cam.id] = marker;
            bounds.extend([cam.lat, cam.lon]);
        });

        // Only move the map bounds when explicitly requested (corridor/location/route change)
        if (shouldFitBounds) {
            this.userPannedMap = false;
            if (this.callbacks.onUserPan) {
                this.callbacks.onUserPan(false);
            }
            this.isProgrammaticMove = true;
            if (user && user.lat && cameras.length > 0) {
                this.map.fitBounds(bounds, { padding: [48, 48], maxZoom: 13 });
            } else if (user && user.lat) {
                this.map.setView([user.lat, user.lon], 11);
            }
            setTimeout(() => {
                this.isProgrammaticMove = false;
            }, 600);
        }
    }

    highlightCameraMarker(camId, user, { forcePan = false } = {}) {
        this.activeCamId = camId;

        Object.entries(this.markers.cameras).forEach(([id, m]) => {
            const el = document.getElementById(`map-pin-${id}`);
            if (el) el.classList.toggle("is-active", id === camId);
            m.setZIndexOffset(id === camId ? 900 : 100);
        });

        if (forcePan) {
            this.userPannedMap = false;
            if (this.callbacks.onUserPan) {
                this.callbacks.onUserPan(false);
            }
        }

        // If user manually panned the map, don't yank their map view during passive feed scroll
        if (this.userPannedMap && !forcePan) {
            return;
        }

        if (this.mapMovedForId === camId && !forcePan) return;
        this.mapMovedForId = camId;

        const activeMarker = this.markers.cameras[camId];
        if (activeMarker && user && user.lat) {
            const bounds = L.latLngBounds([
                [user.lat, user.lon],
                activeMarker.getLatLng()
            ]);
            this.isProgrammaticMove = true;
            this.map.flyToBounds(bounds, {
                padding: [56, 56],
                maxZoom: 14,
                animate: true,
                duration: 0.45
            });
            setTimeout(() => {
                this.isProgrammaticMove = false;
            }, 550);
        }
    }

    invalidateSize() {
        if (this.map) {
            setTimeout(() => this.map.invalidateSize(), 150);
        }
    }
}
