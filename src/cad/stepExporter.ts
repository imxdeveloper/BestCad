import type { Part } from './types'

/**
 * Exports CloneCad geometry as a standardized ISO 10303-21 STEP (AP203/AP214) file format.
 */
export function exportToSTEP(parts: Part[], documentName = 'CloneCad_Model'): void {
  const timestamp = new Date().toISOString()
  const lines: string[] = []

  lines.push('ISO-10303-21;')
  lines.push('HEADER;')
  lines.push(`FILE_DESCRIPTION(('CloneCad 3D Parametric CAD Model', '2;1'), '2;1');`)
  lines.push(`FILE_NAME('${documentName}.stp', '${timestamp}', ('CloneCad User'), ('CloneCad CAD Lab'), 'CloneCad 2026.1', 'CloneCad STEP Kernel v2.0', '');`)
  lines.push(`FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));`)
  lines.push('ENDSEC;')
  lines.push('DATA;')

  let entityId = 1
  const nextId = () => `#${entityId++}`

  const originId = nextId()
  lines.push(`${originId} = CARTESIAN_POINT('ORIGIN', (0.0, 0.0, 0.0));`)

  const zAxisId = nextId()
  lines.push(`${zAxisId} = DIRECTION('Z_AXIS', (0.0, 0.0, 1.0));`)

  const xAxisId = nextId()
  lines.push(`${xAxisId} = DIRECTION('X_AXIS', (1.0, 0.0, 0.0));`)

  const axis2PlacementId = nextId()
  lines.push(`${axis2PlacementId} = AXIS2_PLACEMENT_3D('WORLD_CSYS', ${originId}, ${zAxisId}, ${xAxisId});`)

  const solidIds: string[] = []

  for (const part of parts) {
    if (!part.visible) continue
    const [w, h, d] = part.size
    const [x, y, z] = part.position

    const ptCenter = nextId()
    lines.push(`${ptCenter} = CARTESIAN_POINT('${part.name}_POS', (${x.toFixed(4)}, ${y.toFixed(4)}, ${z.toFixed(4)}));`)

    const placement = nextId()
    lines.push(`${placement} = AXIS2_PLACEMENT_3D('${part.name}_PLACEMENT', ${ptCenter}, ${zAxisId}, ${xAxisId});`)

    const solidId = nextId()
    solidIds.push(solidId)

    if (part.kind === 'cylinder') {
      const radius = Math.min(w, d) / 2
      lines.push(`${solidId} = RIGHT_CIRCULAR_CYLINDER('${part.name}', ${placement}, ${h.toFixed(4)}, ${radius.toFixed(4)});`)
    } else if (part.kind === 'sphere') {
      const radius = w / 2
      lines.push(`${solidId} = SPHERE('${part.name}', ${placement}, ${radius.toFixed(4)});`)
    } else {
      lines.push(`${solidId} = BLOCK('${part.name}', ${placement}, ${w.toFixed(4)}, ${h.toFixed(4)}, ${d.toFixed(4)});`)
    }
  }

  const appCtxId = nextId()
  lines.push(`${appCtxId} = APPLICATION_CONTEXT('mechanical design');`)

  const prodDefCtxId = nextId()
  lines.push(`${prodDefCtxId} = PRODUCT_DEFINITION_CONTEXT('part definition', ${appCtxId}, 'design');`)

  const productId = nextId()
  lines.push(`${productId} = PRODUCT('${documentName}', '${documentName}', '', (${prodDefCtxId}));`)

  lines.push('ENDSEC;')
  lines.push('END-ISO-10303-21;')

  const stepString = lines.join('\n')
  const blob = new Blob([stepString], { type: 'application/step;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${documentName.replace(/[^a-z0-9_-]/gi, '_')}.stp`
  link.click()
  URL.revokeObjectURL(url)
}
