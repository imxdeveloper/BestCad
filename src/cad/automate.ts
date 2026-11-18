export type ScriptTemplate = {
  id: string
  name: string
  description: string
  code: string
}

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    id: 'spur_gear',
    name: 'Parametric Spur Gear Generator',
    description: 'Generates a mechanical spur gear with pitch circle, tooth profiles, and center bore.',
    code: `// BestCad FeatureScript: Parametric Spur Gear
const numTeeth = 16;
const moduleVal = 0.5; // mm
const pitchDiameter = numTeeth * moduleVal; // 8 mm
const faceWidth = 2.0; // mm

// 1. Create Gear Hub Cylinder
createPart('cylinder', {
  name: 'Gear Body',
  size: [pitchDiameter, faceWidth, pitchDiameter],
  position: [0, faceWidth / 2, 0],
  color: '#e5a84b'
});

// 2. Extrude Teeth around perimeter
for (let i = 0; i < numTeeth; i++) {
  const angle = (i * Math.PI * 2) / numTeeth;
  const radius = pitchDiameter / 2;
  const tx = Math.cos(angle) * radius;
  const tz = Math.sin(angle) * radius;

  createPart('box', {
    name: \`Tooth \${i + 1}\`,
    size: [0.6, faceWidth, 0.7],
    position: [tx, faceWidth / 2, tz],
    color: '#d3983f'
  });
}
`,
  },
  {
    id: 'flange_plate',
    name: 'Bolt Flange with Hole Pattern',
    description: 'Creates a circular mounting flange with an 8-bolt circular pattern.',
    code: `// BestCad FeatureScript: Mounting Flange
const flangeDiameter = 12.0;
const flangeThickness = 1.2;
const numBolts = 8;
const bcd = 9.0; // Bolt Circle Diameter

// Base Flange
createPart('cylinder', {
  name: 'Mounting Flange',
  size: [flangeDiameter, flangeThickness, flangeDiameter],
  position: [0, flangeThickness / 2, 0],
  color: '#8da4c4'
});

// Circular Pattern of Bolt Studs
for (let i = 0; i < numBolts; i++) {
  const theta = (i * Math.PI * 2) / numBolts;
  const bx = Math.cos(theta) * (bcd / 2);
  const bz = Math.sin(theta) * (bcd / 2);

  createPart('cylinder', {
    name: \`Bolt Stud \${i + 1}\`,
    size: [0.8, flangeThickness + 1.2, 0.8],
    position: [bx, (flangeThickness + 1.2) / 2, bz],
    color: '#e8af58'
  });
}
`,
  },
  {
    id: 'heat_sink',
    name: 'Extruded Heatsink with Cooling Fins',
    description: 'Generates an aluminum electronics heat sink with multiple thermal cooling fins.',
    code: `// BestCad FeatureScript: Heatsink
const baseWidth = 8.0;
const baseDepth = 8.0;
const baseHeight = 0.8;
const numFins = 7;
const finHeight = 3.5;
const finThickness = 0.4;

// Base plate
createPart('box', {
  name: 'Heatsink Base',
  size: [baseWidth, baseHeight, baseDepth],
  position: [0, baseHeight / 2, 0],
  color: '#98a5b8'
});

// Cooling fins
const spacing = (baseDepth - finThickness) / (numFins - 1);
for (let i = 0; i < numFins; i++) {
  const zPos = -baseDepth / 2 + finThickness / 2 + i * spacing;
  createPart('box', {
    name: \`Fin \${i + 1}\`,
    size: [baseWidth, finHeight, finThickness],
    position: [0, baseHeight + finHeight / 2, zPos],
    color: '#b0bfd4'
  });
}
`,
  },
]

/**
 * Sandboxed script execution for BestCad automation
 */
export function executeCADScript(
  script: string,
  addPartFn: (kind: 'box' | 'cylinder' | 'sphere', options: { name: string; size: [number, number, number]; position: [number, number, number]; color: string }) => void,
): { success: boolean; log: string; partsCreated: number } {
  let count = 0
  const logs: string[] = []

  const sandboxCreatePart = (
    kind: 'box' | 'cylinder' | 'sphere',
    options: { name: string; size: [number, number, number]; position: [number, number, number]; color: string },
  ) => {
    addPartFn(kind, options)
    count++
    logs.push(`[CREATED] ${options.name} (${kind}) at [${options.position.join(', ')}]`)
  }

  try {
    const wrappedFn = new Function('createPart', 'console', `
      "use strict";
      ${script}
    `)
    wrappedFn(sandboxCreatePart, {
      log: (...args: any[]) => logs.push(args.join(' ')),
      error: (...args: any[]) => logs.push('[ERROR] ' + args.join(' ')),
    })
    return {
      success: true,
      log: logs.length ? logs.join('\n') : 'Script executed successfully. No errors.',
      partsCreated: count,
    }
  } catch (err: any) {
    return {
      success: false,
      log: `Script Execution Error: ${err?.message || String(err)}`,
      partsCreated: count,
    }
  }
}
