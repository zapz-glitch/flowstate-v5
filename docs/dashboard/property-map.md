# Subject property map

The map anchors on the subject, never a bounding box containing comparables.
Changing subject address/coordinates remounts the map session and ignores pending
results from the old session. Changing comparable selection does not reset it.

Street View opens first when Google supplies official outdoor imagery within
80 meters. The exact returned panorama ID is used, with a bearing from that
panorama toward the subject. The UI discloses distance and that neighboring
buildings may appear: proximity is **not** visual proof of a building match.
A precise rooftop address match can correct provider coordinates. Street-only
matches must be within 250 meters; distant corrections require a verified
state/ZIP-qualified address. Failed or ambiguous geocoding retains report
coordinates and discloses that the address was not confirmed.

“Back to map” opens photorealistic Map3D at 45 degrees, using a ground-relative
camera to accommodate terrain elevation. Center and tilt remain anchored during
zoom, orbit and resizing. Double-click or the rotate button advances N→W→S→E.
Zooming within 45 meters enters available Street View; zooming out at its minimum
magnification returns to a 200-meter aerial range. Without nearby Street View,
close aerial zoom stays available. Street View can also be opened explicitly.
Camera range belongs to the review controls. Google can temporarily report zero
range while rotating; only explicit wheel, pinch, or button zoom enters Street
View. Initialization uses a ground-relative camera probe and steady-frame events,
because zero-duration Google camera moves do not reliably emit animation-end.
Native `PinElement` markers render through occlusion so roofs cannot hide subject
and comparable locations. Only the visible renderer runs. Failed 3D/library loading falls back to ordinary
satellite imagery; absent panoramas never substitute an arbitrary distant image.

## Verification

- `npm run build:production --workspace=apps/dashboard`
- `node scripts/run-regression-tests.mjs dashboard`
- `node scripts/check-subject-map-interactions.mjs` — deterministic browser fixture
- `node scripts/check-subject-map.mjs` — built dashboard with fixture account data
  and **real Google services**; needs an authorized browser API key and WebGL.

Browser scripts accept `FLOWSTATE_PLAYWRIGHT_MODULE` and `CHROME_BIN`.
Real-service QA optionally accepts `FLOWSTATE_MAP_TEST_ENV=/path/to/.env.local`
to use an existing development Google key for the test bootstrap only. It does
not change the application build or Google key restrictions, and results record
that production-origin authorization still needs verification. Real-service
QA makes Google Maps requests but uses synthetic application API responses and
does not change customer reports. It fails explicitly if real 3D or Street View
is unavailable. Check narrow mobile layouts, address/coordinate corrections,
slow property switching, missing coverage, and map attribution before release.

## Google integration

Use the Maps JavaScript weekly channel and its supported `maps3d` library.
The legacy raster `setTilt(45)` path is retired. Required Google domains are
allowed in the production CSP without enabling general JavaScript eval.
Geocoding and Street View load independently from optional 3D rendering; service
requests are bounded. Keep key restrictions appropriate to deployment origins.

Primary references:
- https://developers.google.com/maps/documentation/javascript/maptypes
- https://developers.google.com/maps/documentation/javascript/reference/3d-map
- https://developers.google.com/maps/documentation/javascript/3d/altitude-modes
- https://developers.google.com/maps/documentation/javascript/reference/street-view-service
- https://developers.google.com/maps/documentation/javascript/content-security-policy
- https://developers.google.com/maps/domains
