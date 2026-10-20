import { geoContains, geoDistance, geoGraticule10, geoOrthographic, geoPath, type GeoPermissibleObjects } from 'd3-geo'
import { useEffect, useRef, useState } from 'react'
import { feature } from 'topojson-client'
import type { GeometryCollection, Topology } from 'topojson-specification'
import type { RegionCheck } from '@/services/website'

/** Where each DNS check region sits on the map (the resolver subnets in domain-check.ts). */
const REGION_AT: Record<string, { lon: number; lat: number }> = {
  na: { lon: -98, lat: 39 },
  sa: { lon: -47, lat: -15 },
  eu: { lon: 10, lat: 50 },
  af: { lon: 3.4, lat: 6.5 },
  as: { lon: 90.4, lat: 23.8 },
  oc: { lon: 151.2, lat: -33.9 },
}

type Country = { type: 'Feature'; properties: { name: string }; geometry: GeoPermissibleObjects }
let countriesCache: Promise<Country[]> | null = null
/** The world map (110m Natural Earth countries, ~100 KB) loads only when a globe is shown. */
function loadCountries(): Promise<Country[]> {
  countriesCache ??= import('world-atlas/countries-110m.json').then((m) => {
    const topo = (m.default ?? m) as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>
    return (feature(topo, topo.objects.countries) as unknown as { features: Country[] }).features
  })
  return countriesCache
}

/**
 * The domain status at a glance: a white globe that turns slowly (drag to turn it, hover a
 * country to see its name), with one pin per region the DNS check asked. A pin is blue when
 * that region already sees the domain, red when it does not, grey before the first check.
 */
export function DomainGlobe({ regions, label }: { regions: RegionCheck[] | null; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState<{ name: string; x: number; y: number } | null>(null)
  const regionsRef = useRef(regions)
  regionsRef.current = regions

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let countries: Country[] = []
    let hovered: Country | null = null
    // Start over Bangladesh/Asia, slightly tilted, like the reference.
    let rotate: [number, number] = [-80, -18]
    let drag: { x: number; y: number; r: [number, number] } | null = null
    let frame = 0
    let last = performance.now()
    let visible = true
    let dirty = true

    const size = () => {
      const w = el.clientWidth || 240
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      el.width = Math.round(w * dpr)
      el.height = Math.round(w * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      dirty = true
      return w
    }
    let w = size()
    const projection = geoOrthographic().clipAngle(90)
    const path = geoPath(projection, ctx)
    const graticule = geoGraticule10()

    const draw = () => {
      const r = w / 2 - 6
      projection.translate([w / 2, w / 2]).scale(r).rotate(rotate)
      ctx.clearRect(0, 0, w, w)
      // A soft white atmosphere, then the white ocean, shaded toward the edge.
      const halo = ctx.createRadialGradient(w / 2, w / 2, r * 0.9, w / 2, w / 2, r + 6)
      halo.addColorStop(0, 'rgb(255 255 255 / 0.5)')
      halo.addColorStop(1, 'rgb(255 255 255 / 0)')
      ctx.fillStyle = halo
      ctx.beginPath(); ctx.arc(w / 2, w / 2, r + 6, 0, Math.PI * 2); ctx.fill()
      const ocean = ctx.createRadialGradient(w * 0.38, w * 0.32, r * 0.1, w / 2, w / 2, r)
      ocean.addColorStop(0, '#ffffff')
      ocean.addColorStop(1, '#dce5f2')
      ctx.fillStyle = ocean
      ctx.beginPath(); path({ type: 'Sphere' }); ctx.fill()
      ctx.strokeStyle = 'rgb(30 64 120 / 0.07)'; ctx.lineWidth = 0.6
      ctx.beginPath(); path(graticule); ctx.stroke()
      for (const c of countries) {
        ctx.beginPath(); path(c.geometry)
        ctx.fillStyle = c === hovered ? '#7f93b0' : '#bccadc'
        ctx.fill()
      }
      ctx.strokeStyle = 'rgb(255 255 255 / 0.9)'; ctx.lineWidth = 0.5
      ctx.beginPath(); for (const c of countries) path(c.geometry); ctx.stroke()
      // Region pins (only on the visible side).
      for (const region of regionsRef.current ?? Object.keys(REGION_AT).map((code) => ({ code, name: code, ok: false, answers: [] as string[], unknown: true }))) {
        const at = REGION_AT[region.code]
        if (!at) continue
        // Only pins on the side facing us (less than 90° from the centre of the view).
        const visibleSide = geoDistance([at.lon, at.lat], [-rotate[0], -rotate[1]]) < Math.PI / 2 - 0.05
        const p = projection([at.lon, at.lat])
        if (!p || !visibleSide) continue
        const unknown = 'unknown' in region
        const color = unknown ? '113 113 122' : region.ok ? '37 99 235' : '220 38 38'
        ctx.fillStyle = `rgb(${color} / 0.2)`
        ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = `rgb(${color})`
        ctx.beginPath(); ctx.arc(p[0], p[1], 3.2, 0, Math.PI * 2); ctx.fill()
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1
        ctx.stroke()
      }
      dirty = false
    }

    const tick = (now: number) => {
      const dt = Math.min(64, now - last)
      last = now
      if (visible && !drag && !reduce && !hovered) { rotate = [rotate[0] + dt * 0.006, rotate[1]]; dirty = true }
      if (visible && dirty) draw()
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    void loadCountries().then((list) => { countries = list; dirty = true }).catch(() => undefined)

    const local = (e: PointerEvent) => { const b = el.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top } }
    const onDown = (e: PointerEvent) => { const p = local(e); drag = { x: p.x, y: p.y, r: rotate }; el.setPointerCapture(e.pointerId) }
    const onMove = (e: PointerEvent) => {
      const p = local(e)
      if (drag) {
        rotate = [drag.r[0] + (p.x - drag.x) * 0.4, Math.max(-60, Math.min(60, drag.r[1] - (p.y - drag.y) * 0.4))]
        dirty = true
        return
      }
      const at = projection.invert?.([p.x, p.y])
      const inside = Math.hypot(p.x - w / 2, p.y - w / 2) <= w / 2 - 6
      const found = at && inside ? countries.find((c) => geoContains(c.geometry, at)) ?? null : null
      if (found !== hovered) { hovered = found; dirty = true }
      setHover(found ? { name: found.properties.name, x: p.x, y: p.y } : null)
    }
    const onUp = (e: PointerEvent) => { drag = null; if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId) }
    const onLeave = () => { hovered = null; dirty = true; setHover(null) }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('pointerleave', onLeave)
    const io = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? true })
    io.observe(el)
    const ro = new ResizeObserver(() => { w = size() })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      io.disconnect(); ro.disconnect()
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[220px]">
      <canvas ref={canvas} className="size-full cursor-grab touch-pan-y active:cursor-grabbing" role="img" aria-label={label} />
      {hover && (
        <span className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[140%] rounded-md bg-[#18181b] px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-white shadow"
          style={{ left: hover.x, top: hover.y }}>{hover.name}</span>
      )}
    </div>
  )
}
