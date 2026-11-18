import type { Part } from './types'

/**
 * Generates an SVG 2D Engineering Drawing Sheet with Orthographic Multi-Views,
 * Dimensions, and standard ISO/ANSI Engineering Title Block.
 */
export function generateEngineeringDrawingSVG(parts: Part[], documentName = 'Desk Clamp'): string {
  const safeDocumentName = documentName.toUpperCase().replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]!)
  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity

  for (const part of parts) {
    if (!part.visible) continue
    minX = Math.min(minX, part.position[0] - part.size[0] / 2)
    maxX = Math.max(maxX, part.position[0] + part.size[0] / 2)
    minY = Math.min(minY, part.position[1] - part.size[1] / 2)
    maxY = Math.max(maxY, part.position[1] + part.size[1] / 2)
    minZ = Math.min(minZ, part.position[2] - part.size[2] / 2)
    maxZ = Math.max(maxZ, part.position[2] + part.size[2] / 2)
  }

  if (minX === Infinity) {
    minX = -5; maxX = 5
    minY = 0; maxY = 5
    minZ = -3; maxZ = 3
  }

  const modelWidth = Math.max(1, maxX - minX)
  const modelHeight = Math.max(1, maxY - minY)
  const modelDepth = Math.max(1, maxZ - minZ)

  const sheetWidth = 1100
  const sheetHeight = 780
  const margin = 30

  const frontCenter = { x: 340, y: 460 }
  const topCenter = { x: 340, y: 190 }
  const rightCenter = { x: 740, y: 460 }
  const isoCenter = { x: 740, y: 190 }

  const maxModelDim = Math.max(modelWidth, modelHeight, modelDepth)
  const viewScale = Math.min(18, 180 / maxModelDim)

  const partsSvg: { front: string[]; top: string[]; right: string[]; iso: string[] } = {
    front: [],
    top: [],
    right: [],
    iso: [],
  }

  for (const part of parts) {
    if (!part.visible) continue
    const [w, h, d] = part.size
    const [px, py, pz] = part.position

    const fx = frontCenter.x + px * viewScale - (w * viewScale) / 2
    const fy = frontCenter.y - py * viewScale - (h * viewScale) / 2
    const fw = w * viewScale
    const fh = h * viewScale

    if (part.kind === 'cylinder') {
      partsSvg.front.push(`<rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" rx="1" fill="#e8edf5" stroke="#1d2735" stroke-width="1.8"/>`)
      partsSvg.front.push(`<line x1="${fx + fw / 2}" y1="${fy - 6}" x2="${fx + fw / 2}" y2="${fy + fh + 6}" stroke="#2878e2" stroke-width="1" stroke-dasharray="6,3,2,3"/>`)
    } else {
      partsSvg.front.push(`<rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="#f1f4f9" stroke="#1d2735" stroke-width="1.8"/>`)
    }

    const tx = topCenter.x + px * viewScale - (w * viewScale) / 2
    const ty = topCenter.y + pz * viewScale - (d * viewScale) / 2
    const tw = w * viewScale
    const td = d * viewScale

    if (part.kind === 'cylinder') {
      partsSvg.top.push(`<ellipse cx="${topCenter.x + px * viewScale}" cy="${topCenter.y + pz * viewScale}" rx="${tw / 2}" ry="${td / 2}" fill="#e8edf5" stroke="#1d2735" stroke-width="1.8"/>`)
    } else {
      partsSvg.top.push(`<rect x="${tx}" y="${ty}" width="${tw}" height="${td}" fill="#f1f4f9" stroke="#1d2735" stroke-width="1.8"/>`)
    }

    const rx = rightCenter.x + pz * viewScale - (d * viewScale) / 2
    const ry = rightCenter.y - py * viewScale - (h * viewScale) / 2
    const rw = d * viewScale
    const rh = h * viewScale

    partsSvg.right.push(`<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="#f1f4f9" stroke="#1d2735" stroke-width="1.8"/>`)

    const cos30 = Math.cos(Math.PI / 6)
    const sin30 = Math.sin(Math.PI / 6)

    const isoX = (x: number, _y: number, z: number) => isoCenter.x + (x - z) * cos30 * viewScale * 0.75
    const isoY = (x: number, y: number, z: number) => isoCenter.y - y * viewScale * 0.75 + (x + z) * sin30 * viewScale * 0.75

    const pX0 = px - w / 2, pX1 = px + w / 2
    const pY0 = py - h / 2, pY1 = py + h / 2
    const pZ0 = pz - d / 2, pZ1 = pz + d / 2

    const topPts = [
      `${isoX(pX0, pY1, pZ0)},${isoY(pX0, pY1, pZ0)}`,
      `${isoX(pX1, pY1, pZ0)},${isoY(pX1, pY1, pZ0)}`,
      `${isoX(pX1, pY1, pZ1)},${isoY(pX1, pY1, pZ1)}`,
      `${isoX(pX0, pY1, pZ1)},${isoY(pX0, pY1, pZ1)}`,
    ].join(' ')

    const rightPts = [
      `${isoX(pX1, pY1, pZ0)},${isoY(pX1, pY1, pZ0)}`,
      `${isoX(pX1, pY0, pZ0)},${isoY(pX1, pY0, pZ0)}`,
      `${isoX(pX1, pY0, pZ1)},${isoY(pX1, pY0, pZ1)}`,
      `${isoX(pX1, pY1, pZ1)},${isoY(pX1, pY1, pZ1)}`,
    ].join(' ')

    const frontPts = [
      `${isoX(pX0, pY1, pZ1)},${isoY(pX0, pY1, pZ1)}`,
      `${isoX(pX1, pY1, pZ1)},${isoY(pX1, pY1, pZ1)}`,
      `${isoX(pX1, pY0, pZ1)},${isoY(pX1, pY0, pZ1)}`,
      `${isoX(pX0, pY0, pZ1)},${isoY(pX0, pY0, pZ1)}`,
    ].join(' ')

    partsSvg.iso.push(`
      <polygon points="${topPts}" fill="#e8edf5" stroke="#1d2735" stroke-width="1.4"/>
      <polygon points="${rightPts}" fill="#c9d5e6" stroke="#1d2735" stroke-width="1.4"/>
      <polygon points="${frontPts}" fill="#d9e3f2" stroke="#1d2735" stroke-width="1.4"/>
    `)
  }

  const dimFrontX0 = frontCenter.x - (modelWidth * viewScale) / 2
  const dimFrontX1 = frontCenter.x + (modelWidth * viewScale) / 2
  const dimFrontY0 = frontCenter.y - (modelHeight * viewScale) / 2
  const dimFrontY1 = frontCenter.y + (modelHeight * viewScale) / 2
  const dimYOffset = dimFrontY1 + 35
  const dimXOffset = dimFrontX0 - 35

  const dimensionSvgs = `
    <g stroke="#2878e2" stroke-width="1.2">
      <line x1="${dimFrontX0}" y1="${dimFrontY1 + 8}" x2="${dimFrontX0}" y2="${dimYOffset + 8}"/>
      <line x1="${dimFrontX1}" y1="${dimFrontY1 + 8}" x2="${dimFrontX1}" y2="${dimYOffset + 8}"/>
      <line x1="${dimFrontX0}" y1="${dimYOffset}" x2="${dimFrontX1}" y2="${dimYOffset}"/>
      <polygon points="${dimFrontX0},${dimYOffset} ${dimFrontX0 + 8},${dimYOffset - 3} ${dimFrontX0 + 8},${dimYOffset + 3}" fill="#2878e2"/>
      <polygon points="${dimFrontX1},${dimYOffset} ${dimFrontX1 - 8},${dimYOffset - 3} ${dimFrontX1 - 8},${dimYOffset + 3}" fill="#2878e2"/>
    </g>
    <text x="${(dimFrontX0 + dimFrontX1) / 2}" y="${dimYOffset - 5}" font-family="monospace" font-size="12" font-weight="bold" fill="#2878e2" text-anchor="middle">${modelWidth.toFixed(1)} mm</text>

    <g stroke="#2878e2" stroke-width="1.2">
      <line x1="${dimFrontX0 - 8}" y1="${dimFrontY0}" x2="${dimXOffset - 8}" y2="${dimFrontY0}"/>
      <line x1="${dimFrontX0 - 8}" y1="${dimFrontY1}" x2="${dimXOffset - 8}" y2="${dimFrontY1}"/>
      <line x1="${dimXOffset}" y1="${dimFrontY0}" x2="${dimXOffset}" y2="${dimFrontY1}"/>
      <polygon points="${dimXOffset},${dimFrontY0} ${dimXOffset - 3},${dimFrontY0 + 8} ${dimXOffset + 3},${dimFrontY0 + 8}" fill="#2878e2"/>
      <polygon points="${dimXOffset},${dimFrontY1} ${dimXOffset - 3},${dimFrontY1 - 8} ${dimXOffset + 3},${dimFrontY1 - 8}" fill="#2878e2"/>
    </g>
    <text x="${dimXOffset - 8}" y="${(dimFrontY0 + dimFrontY1) / 2}" font-family="monospace" font-size="12" font-weight="bold" fill="#2878e2" text-anchor="middle" transform="rotate(-90, ${dimXOffset - 8}, ${(dimFrontY0 + dimFrontY1) / 2})">${modelHeight.toFixed(1)} mm</text>
  `

  const currentDate = new Date().toISOString().split('T')[0]

  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sheetWidth} ${sheetHeight}" width="100%" height="100%" style="background:#ffffff;">
  <rect x="${margin}" y="${margin}" width="${sheetWidth - margin * 2}" height="${sheetHeight - margin * 2}" fill="none" stroke="#1d2735" stroke-width="2.5"/>
  <rect x="${margin + 6}" y="${margin + 6}" width="${sheetWidth - (margin + 6) * 2}" height="${sheetHeight - (margin + 6) * 2}" fill="none" stroke="#818a98" stroke-width="0.8"/>

  <line x1="540" y1="${margin}" x2="540" y2="${sheetHeight - margin}" stroke="#e6e9ee" stroke-width="1" stroke-dasharray="4,4"/>
  <line x1="${margin}" y1="330" x2="${sheetWidth - margin}" y2="330" stroke="#e6e9ee" stroke-width="1" stroke-dasharray="4,4"/>

  <text x="${topCenter.x}" y="55" font-family="sans-serif" font-size="12" font-weight="bold" fill="#626c7a" text-anchor="middle">SECTION A-A / TOP VIEW</text>
  <text x="${frontCenter.x}" y="360" font-family="sans-serif" font-size="12" font-weight="bold" fill="#626c7a" text-anchor="middle">FRONT VIEW (PRIMARY)</text>
  <text x="${rightCenter.x}" y="360" font-family="sans-serif" font-size="12" font-weight="bold" fill="#626c7a" text-anchor="middle">RIGHT VIEW (SIDE ELEVATION)</text>
  <text x="${isoCenter.x}" y="55" font-family="sans-serif" font-size="12" font-weight="bold" fill="#626c7a" text-anchor="middle">ISOMETRIC VIEW (SCALE 1:1)</text>

  <g id="top-view">${partsSvg.top.join('\n')}</g>
  <g id="front-view">${partsSvg.front.join('\n')}</g>
  <g id="right-view">${partsSvg.right.join('\n')}</g>
  <g id="iso-view">${partsSvg.iso.join('\n')}</g>

  ${dimensionSvgs}

  <g transform="translate(${sheetWidth - margin - 380}, ${sheetHeight - margin - 120})">
    <rect x="0" y="0" width="380" height="120" fill="#f8fafc" stroke="#1d2735" stroke-width="2"/>
    <line x1="0" y1="30" x2="380" y2="30" stroke="#1d2735" stroke-width="1.2"/>
    <line x1="0" y1="60" x2="380" y2="60" stroke="#1d2735" stroke-width="1.2"/>
    <line x1="0" y1="90" x2="380" y2="90" stroke="#1d2735" stroke-width="1.2"/>
    <line x1="190" y1="30" x2="190" y2="120" stroke="#1d2735" stroke-width="1.2"/>
    <line x1="285" y1="60" x2="285" y2="120" stroke="#1d2735" stroke-width="1.2"/>

    <text x="12" y="20" font-family="sans-serif" font-size="14" font-weight="800" fill="#1d2735">BESTCAD ENGINEERING</text>
    <text x="12" y="48" font-family="sans-serif" font-size="11" font-weight="bold" fill="#475569">TITLE: ${safeDocumentName}</text>
    <text x="12" y="78" font-family="sans-serif" font-size="10" fill="#64748b">UNITS: METRIC (MM)</text>
    <text x="12" y="108" font-family="sans-serif" font-size="10" fill="#64748b">TOLERANCE: ± 0.05 MM</text>

    <text x="202" y="48" font-family="sans-serif" font-size="10" fill="#64748b">DATE: ${currentDate}</text>
    <text x="202" y="78" font-family="sans-serif" font-size="10" fill="#64748b">REV: 1.0.0</text>
    <text x="295" y="78" font-family="sans-serif" font-size="10" fill="#64748b">SHEET: 1 OF 1</text>
    <text x="202" y="108" font-family="sans-serif" font-size="10" fill="#64748b">STATUS: APPROVED</text>
    <text x="295" y="108" font-family="sans-serif" font-size="10" fill="#64748b">SCALE: 1:1</text>
  </g>
</svg>
`
}
