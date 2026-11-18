# BestCad

BestCad is a browser based CAD prototype built with React, TypeScript, and Three.js. It provides a local 3D design workspace with sketch creation, basic solid features, assembly previews, drawings, and export tools. It is an evolving project and does not yet replace a production CAD system.

## Run locally

```sh
npm install
npm run dev
```

Create sketches on standard planes or flat model faces. Draw lines, rectangles, circles, or arcs, then use the Dimension tool to constrain the distance between two sketch points before creating a feature. Extrude closed profiles, or finish and select a sketch on the Front plane to revolve closed profiles around the vertical axis. Reopen a sketch to edit it; linked extrusions and revolves update from their source profile. Use the Solid ribbon for hole, shell, pattern, and Boolean operations.

Documents auto-save in browser local storage. Use Open and Save file to move a `.bestcad.json` document between browsers or computers. Manage snapshots provide named restore points. Existing CloneCad documents remain readable after the rename.

## Current scope

- **Design:** three.js viewport, standard and face based sketch planes, editable sketches with distance constraints, profile extrusion and front-plane revolution, axis-based patterns, approximate fillet/chamfer, shell/hole, and Boolean operations.
- **Assembly:** joint sliders, exploded view, and BOM export prototype.
- **Drawings and exports:** SVG drawings, STL, OBJ, glTF, STEP, and BOM CSV export.
- **Manufacture and simulation:** CAM toolpath preview and approximate static stress visualization.
- **Automation:** script templates and a local script runner.

These workspaces have prototype status. Important capabilities still in development include broader sketch relations and solver diagnostics, loft/sweep and advanced feature types, a robust feature history and dependency graph, general-purpose B-rep operations, production-grade associative drawings and assemblies, validated STEP interchange, engineering-grade simulation and CAM, and cloud collaboration. Simulation results are approximate visual estimates; generated CAM paths and G-code are previews and must not be used to machine parts.

## Build

```sh
npm run build
```

## Checks

Use Node.js 22.15 or newer, then run:

```sh
npm test
npm run lint
npm run build
```

The automated tests cover core sketch math, assembly and BOM calculations, CAM path generation and input validation, approximate simulation output, geometry inspection, drawing SVG generation, automation templates, and box B-rep topology. They do not replace interactive browser checks, validated STEP interoperability, or engineering validation of simulation and machining output.
