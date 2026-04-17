// itinerario.js — Itinerário Inteligente v5.5
// Google Places API (New) + Routes API + Maps JavaScript API

const PLACES_KEY = "AIzaSyBKLXfozJI7nvryAipKBV5o__2wX16afCI";
const ROUTES_KEY = "AIzaSyBSG1LJSPabqvH8BSZM17c2u_TM3qUEJqA";
const MAPS_KEY   = PLACES_KEY; // same project, reuse Places key for Maps JS

// Luanda centre bias
const LUANDA_CENTRE = { lat: -8.836, lng: 13.234 };
const LUANDA_RADIUS = 30000; // 30 km

// ─────────────────────────────────────────────────────────
// PHASE 1 — Places Text Search (New) per shop name
// Returns { shopName, placeId, displayName, address, lat, lng }
// ─────────────────────────────────────────────────────────
async function findNearestPlace(shopName, biasLat, biasLng) {
  const url = "https://places.googleapis.com/v1/places:searchText";
  const body = {
    textQuery:      `${shopName} supermercado Luanda Angola`,
    languageCode:   "pt",
    maxResultCount: 1,
    locationBias: {
      circle: {
        center: { latitude: biasLat, longitude: biasLng },
        radius: LUANDA_RADIUS,
      },
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":     "application/json",
      "X-Goog-Api-Key":   PLACES_KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Places API (${shopName}): ${err?.error?.message || resp.statusText}`);
  }

  const data  = await resp.json();
  const place = data.places?.[0];
  if (!place) return null;

  return {
    shopName,
    placeId:     place.id,
    displayName: place.displayName?.text || shopName,
    address:     place.formattedAddress  || "",
    lat:         place.location.latitude,
    lng:         place.location.longitude,
  };
}

// ─────────────────────────────────────────────────────────
// PHASE 2 — Routes API computeRoutes (optimised TSP)
// ─────────────────────────────────────────────────────────
async function computeOptimisedRoute(originLatLng, destinationLatLng, places, returnToOrigin) {
  const url  = "https://routes.googleapis.com/directions/v2:computeRoutes";

  const toWaypoint = ({ lat, lng, placeId }) =>
    placeId
      ? { via: false, placeId }
      : { via: false, location: { latLng: { latitude: lat, longitude: lng } } };

  const origin      = { location: { latLng: { latitude: originLatLng.lat, longitude: originLatLng.lng } } };
  const destination = returnToOrigin
    ? { location: { latLng: { latitude: originLatLng.lat, longitude: originLatLng.lng } } }
    : { location: { latLng: { latitude: destinationLatLng.lat, longitude: destinationLatLng.lng } } };

  const intermediates = places.map(p => ({
    via:     false,
    placeId: p.placeId,
  }));

  const body = {
    origin,
    destination,
    intermediates,
    travelMode:             "DRIVE",
    optimizeWaypointOrder:  true,
    routingPreference:      "TRAFFIC_AWARE",
    computeAlternativeRoutes: false,
    routeModifiers:         { avoidTolls: false, avoidHighways: false },
    languageCode:           "pt-PT",
    units:                  "METRIC",
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":   "application/json",
      "X-Goog-Api-Key": ROUTES_KEY,
      "X-Goog-FieldMask":
        "routes.duration,routes.distanceMeters,routes.optimizedIntermediateWaypointIndex," +
        "routes.legs,routes.polyline.encodedPolyline",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Routes API: ${err?.error?.message || resp.statusText}`);
  }

  return await resp.json();
}

// ─────────────────────────────────────────────────────────
// MAIN — Build itinerary from lista + origin
// ─────────────────────────────────────────────────────────
export async function buildItinerary({ shops, origin, returnToOrigin = true, onStatus }) {
  // shops: [{ shopName }] — unique shop names from lista
  // origin: { lat, lng }

  onStatus?.("A pesquisar filiais próximas…");

  // Phase 1: resolve each shop to a place
  const placeResults = await Promise.all(
    shops.map(s => findNearestPlace(s.shopName, origin.lat, origin.lng).catch(() => null))
  );

  const validPlaces = placeResults.filter(Boolean);

  if (!validPlaces.length) {
    throw new Error("Nenhuma filial encontrada nas proximidades.");
  }

  onStatus?.(`${validPlaces.length} filial(ais) encontrada(s). A calcular rota…`);

  // Phase 2: compute optimised route
  const routeData = await computeOptimisedRoute(
    origin, origin, validPlaces, returnToOrigin
  );

  const route = routeData.routes?.[0];
  if (!route) throw new Error("Nenhuma rota encontrada.");

  // Re-order places by optimised waypoint order
  const orderIdx = route.optimizedIntermediateWaypointIndex || validPlaces.map((_, i) => i);
  const orderedPlaces = orderIdx.map(i => validPlaces[i]);

  // Build legs summary
  const legs = route.legs || [];
  const orderedStops = orderedPlaces.map((place, i) => {
    const leg     = legs[i] || {};
    const legNext = legs[i + 1] || {};
    return {
      ...place,
      legDuration:  leg.duration   || "0s",
      legDistance:  leg.distanceMeters || 0,
    };
  });

  const totalSeconds  = sumDuration(route.duration);
  const totalMetres   = route.distanceMeters || 0;
  const encodedPoly   = route.polyline?.encodedPolyline || null;

  return {
    origin,
    returnToOrigin,
    stops:          orderedStops,
    totalDuration:  totalSeconds,
    totalDistance:  totalMetres,
    encodedPolyline: encodedPoly,
    legs,
    notFound:       placeResults.filter(p => !p).length,
    skipped:        shops.filter(s => !placeResults.find(p => p?.shopName === s.shopName)),
  };
}

function sumDuration(durationStr) {
  if (!durationStr) return 0;
  const m = durationStr.match(/(\d+)s/);
  return m ? parseInt(m[1]) : 0;
}

export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}min`;
  return `${m} min`;
}

export function formatDistance(metres) {
  if (metres >= 1000) return `${(metres / 1000).toFixed(1)} km`;
  return `${metres} m`;
}

// ─────────────────────────────────────────────────────────
// MAPS — Load Maps JS API dynamically and render map
// ─────────────────────────────────────────────────────────
let mapsLoaded = false;
let mapsLoadPromise = null;

function loadMapsAPI() {
  if (mapsLoaded) return Promise.resolve();
  if (mapsLoadPromise) return mapsLoadPromise;
  mapsLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}&libraries=geometry`;
    script.async = true;
    script.onload  = () => { mapsLoaded = true; resolve(); };
    script.onerror = () => reject(new Error("Erro ao carregar Google Maps."));
    document.head.appendChild(script);
  });
  return mapsLoadPromise;
}

export async function renderMap(containerId, itinerary) {
  await loadMapsAPI();

  const container = document.getElementById(containerId);
  if (!container) return;

  const { google } = window;
  const map = new google.maps.Map(container, {
    zoom:             12,
    center:           itinerary.origin,
    mapTypeId:        "roadmap",
    disableDefaultUI: false,
    styles: [
      { featureType: "poi", stylers: [{ visibility: "off" }] },
      { featureType: "transit", stylers: [{ visibility: "off" }] },
    ],
  });

  const bounds = new google.maps.LatLngBounds();

  // Origin marker
  const originPos = { lat: itinerary.origin.lat, lng: itinerary.origin.lng };
  new google.maps.Marker({
    position: originPos,
    map,
    title: "Ponto de partida",
    icon: {
      path:        google.maps.SymbolPath.CIRCLE,
      scale:       10,
      fillColor:   "#1A1714",
      fillOpacity: 1,
      strokeColor: "#fff",
      strokeWeight: 2,
    },
    zIndex: 10,
  });
  bounds.extend(originPos);

  // Shop markers with numbered labels
  itinerary.stops.forEach((stop, i) => {
    const pos = { lat: stop.lat, lng: stop.lng };
    new google.maps.Marker({
      position: pos,
      map,
      title:    `${i + 1}. ${stop.displayName}`,
      label: {
        text:      String(i + 1),
        color:     "#fff",
        fontFamily: "Syne, sans-serif",
        fontWeight: "700",
        fontSize:  "13px",
      },
      icon: {
        path:        google.maps.SymbolPath.CIRCLE,
        scale:       16,
        fillColor:   "#2D6A4F",
        fillOpacity: 1,
        strokeColor: "#fff",
        strokeWeight: 2,
      },
      zIndex: 5,
    });
    bounds.extend(pos);
  });

  // Draw polyline if available
  if (itinerary.encodedPolyline && google.maps.geometry?.encoding) {
    const path = google.maps.geometry.encoding.decodePath(itinerary.encodedPolyline);
    new google.maps.Polyline({
      path,
      map,
      strokeColor:   "#2D6A4F",
      strokeOpacity: 0.85,
      strokeWeight:  4,
    });
    path.forEach(p => bounds.extend(p));
  }

  map.fitBounds(bounds, { padding: 48 });
}