import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PropertyMap } from '../../../apps/dashboard/src/components/analysis/PropertyMap'

const parameters = new URLSearchParams(location.search)
const fixture = window.fixture = { aerialMounts: 0, panoramaMounts: [], panoramaRequests: [], selected: [], noPanorama: parameters.has('no-panorama'), no3D: parameters.has('no-3d'), stalled3D: parameters.has('stalled-3d'), delayed: parameters.has('delayed') }
const coordinate = number => number === '202' ? { lat: 39.76, lng: -104.98 } : { lat: 39.75, lng: -104.99 }
const latLng = value => ({ ...value, toJSON: () => value })
window.google = { maps: {
  importLibrary: name => name === 'maps3d' && fixture.no3D ? Promise.reject(new Error('3D unavailable')) : Promise.resolve({}),
  Geocoder: class {
    async geocode({ address }) {
      const number = address.split(' ')[0]
      return { results: [{ geometry: { location: latLng(coordinate(number)), location_type: 'ROOFTOP' }, address_components: [
        { long_name: number, types: ['street_number'] }, { long_name: 'Test Street', short_name: 'Test St', types: ['route'] },
        { long_name: 'Denver', types: ['locality'] }, { long_name: 'Colorado', short_name: 'CO', types: ['administrative_area_level_1'] }, { long_name: '80202', types: ['postal_code'] },
      ] }] }
    }
  },
  StreetViewService: class {
    async getPanorama(request) {
      fixture.panoramaRequests.push(request)
      const second = request.location.lat === 39.76
      if (fixture.delayed && !second) await new Promise(resolve => { fixture.resolveOldPanorama = resolve })
      if (fixture.noPanorama) throw new Error('ZERO_RESULTS')
      return { data: { location: { pano: second ? 'pano-202' : 'pano-101', latLng: latLng({ lat: request.location.lat - 0.0002, lng: request.location.lng }) } } }
    }
  },
  StreetViewPanorama: class {
    constructor(element, options) { this.options = options; this.zoom = options.zoom; this.element = element; element.style.height = '300px'; fixture.panoramaMounts.push(options); fixture.panorama = this }
    addListener() { return { remove() {} } }
    setPano(pano) { this.options.pano = pano; this.element.dataset.panorama = pano }
    getStatus() { return 'OK' }
    getZoom() { return this.zoom }
    setZoom(value) { this.zoom = value }
    setVisible() {}
  },
  Marker: class { addListener() {} setMap() {} },
  SymbolPath: { CIRCLE: 0 },
  StreetViewPreference: { NEAREST: 'nearest' },
  StreetViewSource: { GOOGLE: 'google', OUTDOOR: 'outdoor' },
  StreetViewStatus: { OK: 'OK' },
  event: { clearInstanceListeners() {}, trigger() {} },
} }

function App() {
  const [number, setNumber] = useState('101')
  const [enabled, setEnabled] = useState(true)
  fixture.replaceSubject = () => setNumber('202')
  fixture.toggleComp = () => setEnabled(value => !value)
  const center = coordinate(number)
  return <div style={{ width: 900, height: 650 }}>
    <PropertyMap subject={{ address: `${number} Test Street, Denver, CO 80202`, latitude: center.lat + 0.0001, longitude: center.lng }} comps={{ items: [{ address: '103 Test Street', latitude: 39.7505, longitude: -104.991, isEnabled: enabled }] }} onMarkerSelect={(...args) => fixture.selected.push(args)} />
  </div>
}
createRoot(document.getElementById('root')).render(<App />)
